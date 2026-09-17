import {
  analyzeItems,
  createAnalyzer,
  createFallbackAnalyzer,
  type RunContext,
} from "./analysis/analyze.js";
import type { Config } from "./config.js";
import { createStore } from "./db/index.js";
import { itemKey, type PendingPost, type Store } from "./db/store.js";
import { buildDiscordMessage, type DiscordMessage } from "./discord/embed.js";
import { BotPoster, ConsolePoster, type DiscordPoster } from "./discord/post.js";
import { postQuietDay } from "./discord/quiet-day.js";
import {
  buildIssueDrafts,
  createIssueCreator,
  createIssueEditor,
  type IssueCreator,
  type IssueEditor,
} from "./github/issue.js";
import { createLogger } from "./log.js";
import { resolveFeatureImage } from "./media/image.js";
import type { PageVisual } from "./media/page-edit.js";
import { createPageVisualMaker, type PageVisualMaker } from "./media/visual.js";
import { refreshDocsCorpus } from "./railway/corpus.js";
import { buildCorpusIndex } from "./railway/retrieval.js";
import { writeDocsWorkspace } from "./railway/workspace.js";
import {
  createReviewBudget,
  reviewActions,
  type ReviewBudget,
  type ReviewTarget,
} from "./review/apply.js";
import { createReviewer, type Reviewer } from "./review/reviewer.js";
import { createActionWriter, type ActionWriter } from "./review/writer.js";
import { enrichArticles } from "./sources/enrich.js";
import { collectCandidates, groupBySourceKey } from "./sources/index.js";
import { entryUrl } from "./sources/link.js";
import type {
  Alert,
  AnalyzedItem,
  CandidateItem,
  RecommendedAction,
  StoredItem,
} from "./types.js";
import { daysAgo, normalizeUrl, SPACED_EN_DASH } from "./util/text.js";

const log = createLogger("pipeline");

/** How far back to look for analyses that never reached Discord. */
const RETRY_WINDOW_DAYS = 3;

/**
 * Build the corpus and everything that reads it: the search index, and the
 * markdown copy on disk the analyst opens files in.
 *
 * A failure here costs evidence, never the run. An analysis with an empty
 * corpus can still say what shipped and how big it is; what it cannot do is
 * claim Railway is missing something, and the gate sees to that by dropping
 * every gap claim it cannot check. That is the right trade: a thinner alert
 * beats a confident wrong one, and beats no alert at all.
 */
async function prepareCorpus(config: Config, store: Store): Promise<{
  context: RunContext;
  notes: string[];
}> {
  const notes: string[] = [];

  try {
    const corpus = await refreshDocsCorpus(config, store);
    notes.push(...corpus.notes);
    const index = buildCorpusIndex(corpus.pages);

    let workspace = null;
    try {
      workspace = await writeDocsWorkspace(config.docsWorkspaceDir, corpus.pages);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`could not write the docs workspace: ${message}`);
      notes.push(`docs-workspace: failed (${message})`);
    }

    return { context: { index, workspace }, notes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`corpus refresh failed: ${message}`);
    notes.push(`corpus: failed (${message})`);
    return { context: { index: buildCorpusIndex([]), workspace: null }, notes };
  }
}

export interface RunSummary {
  candidates: number;
  newItems: number;
  seeded: number;
  analyzed: number;
  /** Analyses from an earlier run that failed to post and were tried again. */
  retried: number;
  issuesOpened: number;
  /** Issues the reviewer closed as not planned, having read the docs behind them. */
  issuesClosed: number;
  posted: number;
  /** Whether this run told the channel there was nothing to tell it. */
  quietDay: boolean;
  notes: string[];
}

/**
 * A bot token is the only delivery path. There is no webhook fallback on
 * purpose: a webhook carries its own channel, cannot be retargeted without a
 * new secret, and answers a refused post with a bare HTTP status.
 */
export function createPoster(config: Config): DiscordPoster {
  if (config.dryRun) return new ConsolePoster("dry run");
  if (!config.discordBotToken) return new ConsolePoster("DISCORD_BOT_TOKEN is not set");
  if (!config.discordChannelId) {
    throw new Error(
      "DISCORD_CHANNEL_ID is not set, and a bot token has to be told where to post. In Discord, turn on Settings → Advanced → Developer Mode, right-click the channel, and Copy Channel ID into DISCORD_CHANNEL_ID",
    );
  }
  return new BotPoster(config.discordBotToken, config.discordChannelId, config.httpTimeoutMs);
}

/**
 * Everything the review pass needs, built once per run.
 *
 * The budget is shared across every item the run analyzed, because the cost it
 * caps is a run's cost: twelve reviews is twelve reviews whether they came off
 * one busy launch day or four quiet ones.
 */
interface ReviewServices {
  editor: IssueEditor;
  reviewer: Reviewer | null;
  writer: ActionWriter | null;
  budget: ReviewBudget;
}

function createReviewServices(config: Config): ReviewServices {
  const editor = createIssueEditor(config);
  const reviewer = createReviewer(config);
  // No reviewer means nothing ever asks for a rewrite, so there is nothing for a
  // writer to do. They share the API key, so they are absent together anyway.
  const writer = reviewer ? createActionWriter(config) : null;

  log.info(
    reviewer
      ? `action review: ${reviewer.description}, rewrites with ${writer?.description ?? "nothing"}, ${config.reviewMaxPerRun} per run`
      : "action review: off, so every action is filed as the analyst wrote it",
  );
  log.info(`GitHub issue edits: ${editor.description}`);

  return { editor, reviewer, writer, budget: createReviewBudget(config) };
}

/**
 * Turn a verdict into something postable: find the feature image, open one issue
 * per recommended action, then have a second model check each of those actions
 * against the same docs corpus before any of it reaches Discord.
 *
 * Three actions is three issues, because a compare-page fix and a feature gap
 * are two teams' work. A dry run and a run with no token both come back with no
 * issues, and only the dry run says so in the embed.
 *
 * The review sits between the issues and the Discord post on purpose. The issue
 * exists, so a verdict has somewhere to write itself and the whole exchange is
 * in the issue's own history. Discord has not gone out, so an action the reviewer
 * drops is simply absent from the message rather than corrected in it: the embed
 * is never edited after the fact, and an alert whose every action was dropped
 * shows **None** with the reason.
 */
async function prepareAlert(
  config: Config,
  issues: IssueCreator,
  review: ReviewServices,
  visualMaker: PageVisualMaker,
  analyzed: AnalyzedItem,
  context: RunContext,
): Promise<PreparedAlert> {
  const image = await resolveFeatureImage(config, analyzed.item);

  // Drawn before the drafts, because a page edit's issue embeds its picture and
  // an issue body cannot be given one after it is opened without a second write.
  const visuals = new Map<RecommendedAction, PageVisual[]>();
  for (const action of analyzed.analysis.actions) {
    visuals.set(action, await visualMaker.make(analyzed, action));
  }

  const targets: ReviewTarget[] = [];
  for (const { action, draft } of buildIssueDrafts(analyzed, image, visuals)) {
    targets.push({
      action,
      issue: await issues.create(draft),
      labels: draft.labels,
      body: draft.body,
    });
  }

  const reviewed = await reviewActions({
    alert: analyzed,
    image,
    targets,
    editor: review.editor,
    reviewer: review.reviewer,
    writer: review.writer,
    visualMaker,
    index: context.index,
    workspace: context.workspace,
    budget: review.budget,
  });
  for (const note of reviewed.notes) log.info(note);

  const opened = targets.filter((target) => target.issue !== null).length;
  const noneOpened = reviewed.issues.every((entry) => entry.issue === null);

  return {
    alert: {
      ...analyzed,
      analysis: reviewed.analysis,
      image,
      issues: reviewed.issues,
      ...(noneOpened && config.dryRun
        ? { issueNote: `GitHub issues not created${SPACED_EN_DASH}${issues.description}` }
        : {}),
    },
    opened,
    // An issue the reviewer closed was still opened, so the summary counts it in
    // both columns rather than quietly losing it out of the first.
    closed: opened - reviewed.issues.filter((entry) => entry.issue !== null).length,
  };
}

interface PreparedAlert {
  alert: Alert;
  /** Issues actually opened, whether or not the review later closed one. */
  opened: number;
  closed: number;
}

/** Items with no date are kept: a missing date is not evidence of staleness. */
function withinLookback(item: CandidateItem, since: Date): boolean {
  return item.publishedAt === null || item.publishedAt >= since;
}

/**
 * Decide which new items to analyze. The first time we see a competitor+source
 * pair its whole backlog looks new, so that batch is recorded and skipped
 * instead of being fired at the channel all at once.
 */
async function selectForAnalysis(
  config: Config,
  store: Store,
  candidates: CandidateItem[],
): Promise<{ toAnalyze: StoredItem[]; seeded: number; newItems: number }> {
  const since = daysAgo(config.lookbackDays);
  const known = await store.findKnownKeys(candidates);
  const seenThisRun = new Set<string>();

  const unseen = candidates.filter((item) => {
    const key = itemKey(item);
    if (known.has(key) || seenThisRun.has(key)) return false;
    seenThisRun.add(key);
    return true;
  });

  const toAnalyze: StoredItem[] = [];
  let seeded = 0;
  let newItems = 0;

  for (const group of groupBySourceKey(unseen).values()) {
    const existing = await store.countItems(group.competitor, group.source);
    const isSeedRun = existing === 0 && !config.forceAnalyze;

    const accepted = isSeedRun
      ? group.items
      : group.items
          .filter((item) => withinLookback(item, since))
          .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
          .slice(0, config.maxItemsPerSource);

    // Seed runs never reach analysis, so there is nothing to enrich for.
    const prepared = isSeedRun ? accepted : await enrichArticles(config, accepted);
    const stored = await store.insertNewItems(prepared);
    newItems += stored.length;

    if (isSeedRun) {
      seeded += stored.length;
      log.info(
        `${group.competitor}/${group.source}: first run, recorded ${stored.length} existing items without alerting`,
      );
      continue;
    }

    toAnalyze.push(...stored);
  }

  toAnalyze.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));

  if (toAnalyze.length > config.maxItemsPerRun) {
    log.warn(
      `capping this run at ${config.maxItemsPerRun} of ${toAnalyze.length} new items (MAX_ITEMS_PER_RUN)`,
    );
  }

  return { toAnalyze: toAnalyze.slice(0, config.maxItemsPerRun), seeded, newItems };
}

/**
 * Run one named item through the whole pipeline, ignoring dedupe and the
 * first-run seed guard. Built for verifying a specific announcement end to end
 * – the item still has to exist in a live feed, so this cannot manufacture one.
 */
export async function runSingleItem(config: Config, targetUrl: string): Promise<DiscordMessage> {
  const store = createStore(config, { allowMemoryFallback: true });
  const poster = createPoster(config);
  const issues = createIssueCreator(config);
  log.info(`Discord delivery: ${poster.description}`);
  log.info(`GitHub issues: ${issues.description}`);
  const review = createReviewServices(config);

  try {
    const { context } = await prepareCorpus(config, store);
    const visualMaker = createPageVisualMaker(config, context.index);
    log.info(`update_pages before/after images: ${visualMaker.description}`);

    const { candidates } = await collectCandidates(config);
    const wanted = normalizeUrl(targetUrl);
    const wantedEntry = normalizeUrl(targetUrl, { keepFragment: true });
    // The anchor first: a changelog whose entries share one page URL would
    // otherwise post whichever of them the feed happened to list first.
    const match =
      candidates.find((candidate) => entryUrl(candidate) === wantedEntry) ??
      candidates.find(
        (candidate) =>
          normalizeUrl(candidate.url) === wanted || normalizeUrl(candidate.externalId) === wanted,
      );
    if (!match) {
      throw new Error(
        `no live feed item matches ${targetUrl} – found ${candidates.length} candidates, none with that URL`,
      );
    }
    log.info(`matched ${match.competitor}/${match.source} "${match.title}"`);

    const [prepared = match] = await enrichArticles(config, [match]);
    const [inserted] = await store.insertNewItems([prepared]);
    // An item already in the dedupe table keeps its row; this mode re-posts it
    // rather than refusing, which is the whole point of naming a URL by hand.
    const id = inserted?.id ?? (await store.findItemId(prepared));
    if (!id) throw new Error(`failed to store ${targetUrl}`);
    if (!inserted) log.info(`${targetUrl} is already stored – re-posting it`);
    const stored: StoredItem = { ...prepared, id };

    let [analyzed] = await analyzeItems([stored], store, createAnalyzer(config), config, context);
    if (!analyzed) {
      log.warn(`analysis failed for ${targetUrl} – falling back to a labeled restatement`);
      [analyzed] = await analyzeItems(
        [stored],
        store,
        createFallbackAnalyzer(),
        config,
        context,
      );
    }
    if (!analyzed) throw new Error(`analysis produced nothing for ${targetUrl}`);

    const { alert } = await prepareAlert(config, issues, review, visualMaker, analyzed, context);
    const message = buildDiscordMessage(alert);
    const analysisId = await store.recordAnalysis({
      itemId: stored.id,
      analysis: alert.analysis,
      model: alert.model,
      image: alert.image,
      issues: alert.issues,
    });
    await poster.post(message);
    await store.markPosted(analysisId, new Date());

    return message;
  } finally {
    await store.close();
  }
}

export async function runCycle(config: Config): Promise<RunSummary> {
  const store = createStore(config);
  const poster = createPoster(config);
  const issues = createIssueCreator(config);
  log.info(`Discord delivery: ${poster.description}`);
  log.info(`GitHub issues: ${issues.description}`);
  const review = createReviewServices(config);
  const summary: RunSummary = {
    candidates: 0,
    newItems: 0,
    seeded: 0,
    analyzed: 0,
    retried: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    posted: 0,
    quietDay: false,
    notes: [],
  };

  try {
    const corpus = await prepareCorpus(config, store);
    summary.notes.push(...corpus.notes);
    const visualMaker = createPageVisualMaker(config, corpus.context.index);
    log.info(`update_pages before/after images: ${visualMaker.description}`);

    const collection = await collectCandidates(config);
    summary.candidates = collection.candidates.length;
    summary.notes.push(...collection.notes);
    log.info(`collected ${collection.candidates.length} candidates`);

    const selection = await selectForAnalysis(config, store, collection.candidates);
    summary.newItems = selection.newItems;
    summary.seeded = selection.seeded;
    log.info(`${selection.toAnalyze.length} new items to analyze`);

    const analyzer = createAnalyzer(config);
    const analyzed = await analyzeItems(
      selection.toAnalyze,
      store,
      analyzer,
      config,
      corpus.context,
    );
    summary.analyzed = analyzed.length;

    const pending = await store.getUnpostedAnalyses(
      daysAgo(RETRY_WINDOW_DAYS),
      config.maxItemsPerRun,
    );
    if (pending.length > 0) {
      log.info(`retrying ${pending.length} analyses that never reached Discord`);
      summary.retried = pending.length;
    }

    const fresh: PendingPost[] = [];
    for (const entry of analyzed) {
      const prepared = await prepareAlert(
        config,
        issues,
        review,
        visualMaker,
        entry,
        corpus.context,
      );
      const alert = prepared.alert;
      summary.issuesOpened += prepared.opened;
      summary.issuesClosed += prepared.closed;
      fresh.push({
        analysisId: await store.recordAnalysis({
          itemId: entry.item.id,
          analysis: alert.analysis,
          model: alert.model,
          image: alert.image,
          issues: alert.issues,
        }),
        item: alert.item,
        analysis: alert.analysis,
        model: alert.model,
        image: alert.image,
        issues: alert.issues,
      });
    }

    for (const entry of [...pending, ...fresh]) {
      try {
        // A retry of an analysis stored without an image finds one now.
        const image = entry.image ?? (await resolveFeatureImage(config, entry.item));
        await poster.post(buildDiscordMessage({ ...entry, image }));
        await store.markPosted(entry.analysisId, new Date());
        summary.posted += 1;
      } catch (error) {
        // Left unstamped on purpose: the next run picks it up again.
        log.error(
          `failed to post ${entry.item.url} to Discord`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Once, at the end, because the channel is owed an answer on a morning
    // when neither competitor shipped anything. Every reason not to send it is
    // in `quietDayMessage`, and each one is a run that should stay quiet.
    summary.quietDay = await postQuietDay(poster, {
      alerts: pending.length + fresh.length,
      newItems: summary.newItems,
      sourcesRead: collection.sourcesRead,
      unread: collection.unread,
    });

    return summary;
  } finally {
    await store.close();
  }
}
