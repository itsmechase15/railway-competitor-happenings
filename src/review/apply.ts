import { checkAction } from "../analysis/analyze.js";
import { gapQuery, type CoverageContext } from "../analysis/evidence.js";
import { evidenceFor, renderNoAction, withNoAction } from "../analysis/noAction.js";
import { measureEdit } from "../analysis/proportion.js";
import type { Config } from "../config.js";
import {
  buildIssueBody,
  buildIssueLabels,
  buildIssueTitle,
  type IssueEditor,
} from "../github/issue.js";
import { actionLabel, REVIEW_LABEL, REVIEW_PASS_DONE } from "../labels.js";
import { createLogger } from "../log.js";
import type { PageVisualMaker } from "../media/visual.js";
import { topUpDocsForActions } from "../railway/docs.js";
import { isMarketingTarget } from "../railway/pages.js";
import { bestExcerpt, terms, type CorpusIndex } from "../railway/retrieval.js";
import type { DocsWorkspace } from "../railway/workspace.js";
import type {
  ActionIssue,
  ActionReview,
  Analysis,
  AnalyzedItem,
  FeatureImage,
  IssueRef,
  NoAction,
  RailwayDoc,
  RailwayRef,
  RecommendedAction,
} from "../types.js";
import { SPACED_EN_DASH } from "../util/text.js";
import type { EditProportions } from "./prompt.js";
import type { Reviewer, ReviewOutcome } from "./reviewer.js";
import { mergeRevision } from "./schema.js";
import type { ActionWriter } from "./writer.js";

const log = createLogger("review");

/**
 * The review pass: one reviewer run per filed action, one rewrite for the ones
 * it asks to revise, and code deciding what reaches the issue.
 *
 * It runs after the issues are opened and before the Discord post. That order is
 * the design: the issue exists, so a verdict has something to write to and the
 * whole outcome is in the issue's own history, and Discord has not gone out yet,
 * so an action the reviewer drops is simply not in the message. The embed is
 * never edited after the fact.
 *
 * The loop runs once. There is no path from an edit back into the reviewer:
 * `reviewActions` is called from one place, an edit is a function call rather
 * than a webhook, every verdict labels its issue `review-pass:done`, this
 * function refuses an action that already carries that label or a stored
 * review, and the verdict is stored on the analysis row so a retry finds it.
 */

/** How many pages a rewrite may be shown. Past this it is a reading list, not evidence. */
const MAX_REWRITE_DOCS = 8;

export interface ReviewBudget {
  /** Reviews left in this run. Shared across every item the run analyzed. */
  remaining: number;
}

export function createReviewBudget(config: Config): ReviewBudget {
  return { remaining: config.reviewMaxPerRun };
}

/** One filed action, with the issue it went to and the labels that issue carries. */
export interface ReviewTarget {
  action: RecommendedAction;
  /** Null in a dry run and in a run with no token. The review still happens. */
  issue: IssueRef | null;
  /**
   * The labels the issue was opened with. GitHub's PATCH replaces the whole set,
   * so a verdict adds its label to this list and sends the result: one request
   * per verdict, and no issue is ever briefly unlabelled.
   */
  labels: string[];
  /**
   * The body the issue was opened with. A dropped issue keeps it under the
   * outcome, so the verdict can be prepended without reading GitHub back.
   */
  body?: string;
  /** A review already recorded for this action, which refuses a second pass. */
  review?: ActionReview;
}

export interface ReviewPassInput {
  alert: AnalyzedItem;
  image: FeatureImage | null;
  targets: ReviewTarget[];
  editor: IssueEditor;
  /** Null when there is nothing to review with, which files every action as written. */
  reviewer: Reviewer | null;
  /** Null for the same reason. A revise with no writer is left as an unconfirmed review. */
  writer: ActionWriter | null;
  /**
   * Takes the Before/After a rewritten page edit needs. A revise that changes
   * the proposed copy leaves the pictures on the issue showing copy nobody is
   * proposing any more, so the page is photographed again from the rewrite.
   * Absent in a caller that takes none, which leaves the rewritten issue in
   * text.
   */
  visualMaker?: PageVisualMaker;
  index: CorpusIndex;
  workspace: DocsWorkspace | null;
  budget: ReviewBudget;
}

export interface ReviewPassResult {
  /** The analysis as the alert should now be read: dropped actions gone, revised ones in place. */
  analysis: Analysis;
  /** One entry per surviving action, in order, each carrying its review. */
  issues: ActionIssue[];
  /** For the run log. */
  notes: string[];
}

export async function reviewActions(input: ReviewPassInput): Promise<ReviewPassResult> {
  const notes: string[] = [];
  const surviving: ActionIssue[] = [];
  const dropped: DroppedAction[] = [];

  // The running analysis: a revise can replace a page edit and a reviewer can
  // move the impact, and the actions after it are judged against the result.
  let analysis = input.alert.analysis;

  for (const target of input.targets) {
    const outcome = await reviewOne(input, target, analysis, notes);
    analysis = outcome.analysis;

    if (outcome.kept) surviving.push(outcome.kept);
    else if (outcome.dropped) dropped.push(outcome.dropped);
  }

  const actions = surviving.map((entry) => entry.action);
  const reviewed: Analysis = { ...analysis, actions };

  return {
    analysis:
      actions.length === 0 && dropped.length > 0
        ? withNoAction(reviewed, droppedVerdict(dropped, input.reviewer?.model, input.index))
        : reviewed,
    issues: surviving,
    notes,
  };
}

/** One action the reviewer closed, and what it read before closing it. */
interface DroppedAction {
  reason: string;
  pages: string[];
}

/** What one action's review left behind. */
interface OneOutcome {
  analysis: Analysis;
  /** The action as it should now be read, with its issue and its review. Absent when dropped. */
  kept?: ActionIssue;
  dropped?: DroppedAction;
}

async function reviewOne(
  input: ReviewPassInput,
  target: ReviewTarget,
  analysis: Analysis,
  notes: string[],
): Promise<OneOutcome> {
  const keep = (review?: ActionReview): OneOutcome => ({
    analysis,
    kept: { action: target.action, issue: target.issue, ...(review ? { review } : {}) },
  });

  if (!input.reviewer) return keep();

  if (target.review || target.labels.includes(REVIEW_PASS_DONE)) {
    notes.push(
      `review: left the ${target.action.type} action alone, because it has already been past a reviewer`,
    );
    return keep(target.review);
  }

  if (input.budget.remaining <= 0) {
    notes.push(`review: skipped the ${target.action.type} action, over the budget for this run`);
    await input.editor.update(target.issue, {
      labels: withLabels(target.labels, REVIEW_LABEL.skipped),
    });
    return keep();
  }

  const alert: AnalyzedItem = { ...input.alert, analysis };
  const proportions = measureEdits(analysis.railwayRefs, input.index);
  let outcome: ReviewOutcome;
  try {
    input.budget.remaining -= 1;
    outcome = await input.reviewer.review({
      alert,
      action: target.action,
      workspace: input.workspace,
      docs: alert.docs ?? [],
      proportions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`the reviewer could not read the ${target.action.type} action`, message);
    notes.push(`review: skipped the ${target.action.type} action (${message})`);
    await input.editor.update(target.issue, {
      labels: withLabels(target.labels, REVIEW_LABEL.skipped),
    });
    return keep();
  }

  const review: ActionReview = {
    verdict: outcome.verdict,
    model: outcome.model,
    at: new Date(),
    reason: outcome.reason,
  };

  if (outcome.verdict === "agree") {
    notes.push(`review: agreed with the ${target.action.type} action`);
    await input.editor.comment(target.issue, agreedComment(outcome));
    await input.editor.update(target.issue, {
      labels: withLabels(target.labels, REVIEW_LABEL.agreed, REVIEW_PASS_DONE),
    });
    return keep(review);
  }

  if (outcome.verdict === "drop") {
    notes.push(`review: dropped the ${target.action.type} action ${SPACED_EN_DASH}${outcome.reason}`);
    const pages = reviewedPages(outcome);
    const verdict: NoAction = {
      kind: "dropped_on_review",
      reason: outcome.reason,
      evidence: pages.map((url) => evidenceFor(input.index, url)),
    };

    await input.editor.comment(target.issue, droppedComment(outcome, verdict));
    // The comment says why and the body is what a reader lands on, so the
    // verdict goes on both. Rebuilt from the body the issue was opened with,
    // because nothing here reads GitHub back.
    if (target.body) {
      await input.editor.update(target.issue, {
        body: `## Outcome\n${renderNoAction(verdict)}\n\n${target.body}`,
      });
    }
    await input.editor.close(
      target.issue,
      "not_planned",
      withLabels(target.labels, REVIEW_LABEL.dropped, REVIEW_PASS_DONE),
    );
    return { analysis, dropped: { reason: outcome.reason, pages } };
  }

  return revise(input, target, alert, outcome, review, notes, proportions);
}

/**
 * How long each page an action would edit runs, against how much its copy
 * adds. Both models are shown this, because proportion is what neither of them
 * can count off an excerpt, and the gate drops an edit that is over.
 */
function measureEdits(refs: RailwayRef[], index: CorpusIndex): EditProportions {
  const measured: EditProportions = new Map();
  for (const ref of refs) {
    if (!isMarketingTarget(ref.url)) continue;
    const proportion = measureEdit(ref, index.page(ref.url)?.text);
    if (proportion) measured.set(ref.url, proportion);
  }
  return measured;
}

/**
 * Apply one `revise`: rewrite the action, then put the rewrite through the same
 * checks the original went through.
 *
 * A rewrite that fails them is thrown away rather than filed with a caveat.
 * There is no third pass and no negotiation: the original issue stands, the
 * comment says what the reviewer wanted and why the rewrite could not be
 * confirmed, and `review:unconfirmed` says a person should settle it.
 */
async function revise(
  input: ReviewPassInput,
  target: ReviewTarget,
  alert: AnalyzedItem,
  outcome: ReviewOutcome,
  review: ActionReview,
  notes: string[],
  proportions: EditProportions,
): Promise<OneOutcome> {
  const unconfirmed = async (why: string): Promise<OneOutcome> => {
    notes.push(`review: could not confirm a rewrite of the ${target.action.type} action (${why})`);
    await input.editor.comment(target.issue, unconfirmedComment(outcome, why));
    await input.editor.update(target.issue, {
      labels: withLabels(target.labels, REVIEW_LABEL.unconfirmed, REVIEW_PASS_DONE),
    });
    return {
      analysis: alert.analysis,
      kept: {
        action: target.action,
        issue: target.issue,
        review: { ...review, applied: false },
      },
    };
  };

  if (!input.writer) return unconfirmed("there is no writer configured to rewrite it");

  const docs = rewriteDocs(
    input.index,
    target.action,
    alert.analysis.railwayRefs,
    alert.docs ?? [],
    outcome.readUrls,
  );

  let merged;
  try {
    const revision = await input.writer.rewrite({
      alert,
      action: target.action,
      review: outcome,
      docs,
      proportions,
    });
    merged = mergeRevision(
      target.action,
      alert.analysis.railwayRefs,
      revision,
      outcome,
      alert.analysis.impact,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unconfirmed(`the rewrite failed: ${message}`);
  }

  for (const note of merged.notes) notes.push(`review: ${note}`);

  // The coverage a rewrite is judged on is everything either model read: the
  // excerpts the analysis was given, the pages the analyst opened, and the pages
  // the reviewer went and opened. A rewrite may rest on a page the reviewer
  // found, which is the point of having sent it looking.
  const grounded = topUpDocsForActions(input.index, alert.item, [merged.action], docs);
  const coverage: CoverageContext = {
    index: input.index,
    seenUrls: new Set([
      ...grounded.map((doc) => doc.url),
      ...(alert.analysis.pagesRead ?? []),
      ...outcome.readUrls,
    ]),
  };

  const checked = checkAction({
    analysis: alert.analysis,
    action: merged.action,
    refs: merged.refs,
    impact: merged.impact,
    docs: grounded,
    item: alert.item,
    coverage,
  });

  if (!checked.action) {
    return unconfirmed(
      checked.notes[0] ?? "the rewrite did not pass the checks the original was filed against",
    );
  }

  const revised: Analysis = {
    ...alert.analysis,
    impact: merged.impact,
    railwayRefs: merged.refs,
  };
  const revisedAlert: AnalyzedItem = { ...alert, analysis: revised };
  // Taken from the rewrite, never carried over. The pictures on the issue are
  // of the copy the issue asks for, and a revise usually changes exactly that.
  const visuals = (await input.visualMaker?.make(revisedAlert, checked.action)) ?? [];

  const landed = await input.editor.update(target.issue, {
    title: buildIssueTitle(revisedAlert, checked.action),
    body: buildIssueBody(revisedAlert, input.image, checked.action, visuals),
    labels: withLabels(
      buildIssueLabels(revisedAlert, checked.action),
      REVIEW_LABEL.revised,
      REVIEW_PASS_DONE,
    ),
  });
  await input.editor.comment(
    target.issue,
    revisedComment(outcome, input.writer.model, target.action, checked.action, revised, alert),
  );

  notes.push(`review: revised the ${target.action.type} action ${SPACED_EN_DASH}${outcome.reason}`);
  if (merged.impact !== alert.analysis.impact) {
    // The alert and the rewritten issue carry the corrected label. Any sibling
    // issue was opened before the correction and keeps the old one, which is the
    // price of opening issues before the review rather than after it.
    notes.push(
      `review: moved impact from ${alert.analysis.impact} to ${merged.impact} on the reviewer's word`,
    );
  }

  return {
    analysis: revised,
    kept: {
      action: checked.action,
      issue: target.issue,
      review: { ...review, applied: landed || target.issue === null },
    },
  };
}

/**
 * The pages a rewrite may quote: the excerpts the analysis was checked against,
 * every page the reviewer opened, and, for a page action, the pages it is being
 * asked to rewrite. Each is cut down to the part that speaks to the gap.
 *
 * The gate checks a quote against the whole stored page, so anything verbatim
 * from one of these excerpts passes. The page being rewritten is here for a
 * different reason: replacement copy has to read as if it came off that page,
 * and a model that has not seen the page writes copy in its own voice.
 */
export function rewriteDocs(
  index: CorpusIndex,
  action: RecommendedAction,
  refs: RailwayRef[],
  docs: RailwayDoc[],
  readUrls: string[],
): RailwayDoc[] {
  const query = terms(gapQuery(action) || action.detail);
  const seen = new Set(docs.map((doc) => doc.url));
  const found: RailwayDoc[] = [];

  const targets =
    action.type === "update_pages"
      ? refs.filter((ref) => isMarketingTarget(ref.url)).map((ref) => ref.url)
      : [];

  for (const url of [...targets, ...readUrls]) {
    if (seen.has(url)) continue;
    const page = index.page(url);
    if (!page) continue;
    seen.add(url);
    found.push({
      url: page.url,
      title: page.title,
      excerpt: bestExcerpt(page.text, query),
      kind: page.kind,
    });
  }

  return [...found, ...docs].slice(0, MAX_REWRITE_DOCS);
}

/**
 * The labels an outcome leaves behind: what the issue was opened with, plus what
 * this outcome adds. Every verdict adds `REVIEW_PASS_DONE` alongside its own
 * label, in one request. A skip adds only its own, because nobody reviewed it and
 * a later run should be free to.
 */
export function withLabels(labels: string[], ...added: string[]): string[] {
  return [...new Set([...labels, ...added])];
}

/** Every page one review names, whether it opened it or cited it. */
function reviewedPages(outcome: ReviewOutcome): string[] {
  return [...new Set([...outcome.readUrls, ...outcome.pagesChecked])];
}

function pagesLine(outcome: ReviewOutcome, heading: string): string {
  const pages = reviewedPages(outcome);
  if (pages.length === 0) return `${heading} none. It read no page it could name.`;
  return `${heading}\n${pages.map((url) => `- ${url}`).join("\n")}`;
}

function agreedComment(outcome: ReviewOutcome): string {
  return [
    `Reviewed by \`${outcome.model}\`: agreed${SPACED_EN_DASH}${outcome.reason}`,
    "",
    pagesLine(outcome, "Pages checked:"),
    "",
    "The recommendation above is unchanged. A second model read Railway's docs corpus and found nothing that contradicts it.",
  ].join("\n");
}

function droppedComment(outcome: ReviewOutcome, verdict: NoAction): string {
  return [
    `Reviewed by \`${outcome.model}\`: dropped${SPACED_EN_DASH}${outcome.reason}`,
    "",
    renderNoAction(verdict),
    "",
    pagesLine(outcome, "Pages the reviewer read:"),
    "",
    "Closed as not planned, and left out of the Discord alert. If the pages above are out of date, that is a docs fix rather than a reason to reopen this.",
  ].join("\n");
}

function unconfirmedComment(outcome: ReviewOutcome, why: string): string {
  return [
    `Reviewed by \`${outcome.model}\`: asked for a revision${SPACED_EN_DASH}${outcome.reason}`,
    "",
    outcome.changes.length > 0
      ? `What it asked for:\n${outcome.changes.map((change) => `- ${change}`).join("\n")}`
      : "It listed no specific change.",
    "",
    pagesLine(outcome, "Pages checked:"),
    "",
    `The rewrite was not applied: ${why}`,
    "",
    "So this issue still says what the analyst wrote. Nothing was rewritten on a claim that could not be checked, because there is no way to correct a claim whose basis we cannot find without inventing one. Somebody should settle it by hand.",
  ].join("\n");
}

/**
 * One side of the before/after, as fields.
 *
 * A page action's substance is the copy proposed for the page, which lives on
 * the refs rather than on the action, so it is shown here: the point of the
 * comment is that a reader can see what changed, and for an `update_pages`
 * revise the copy is usually the only thing that did.
 */
function fields(action: RecommendedAction, refs: RailwayRef[], impact: string): string {
  const lines = [
    `- Title: ${actionLabel(action)}`,
    `- Type: ${action.type}`,
    `- Impact: ${impact}`,
  ];

  if (action.type === "update_pages") {
    for (const ref of refs.filter((entry) => isMarketingTarget(entry.url))) {
      lines.push(
        `- Page: ${ref.url}`,
        `- Copy for it: ${ref.proposedText ? `"${ref.proposedText}"` : "(none proposed)"}`,
      );
    }
  } else {
    lines.push(
      `- Surface: ${action.feature ?? "(none)"}`,
      `- Gap: ${action.gap ?? "(none)"}`,
      `- Evidence: ${action.evidenceUrl ?? "(none)"}`,
      `- Quote: ${action.evidenceQuote ? `"${action.evidenceQuote}"` : "(none)"}`,
    );
  }

  lines.push(`- Detail: ${action.detail}`);
  return lines.join("\n");
}

function revisedComment(
  outcome: ReviewOutcome,
  writerModel: string,
  before: RecommendedAction,
  after: RecommendedAction,
  revised: Analysis,
  alert: AnalyzedItem,
): string {
  return [
    `Reviewed by \`${outcome.model}\`: revised${SPACED_EN_DASH}${outcome.reason}`,
    "",
    outcome.changes.length > 0
      ? `What it asked for:\n${outcome.changes.map((change) => `- ${change}`).join("\n")}`
      : "It listed no specific change, so only the reason above was acted on.",
    "",
    pagesLine(outcome, "Pages checked:"),
    "",
    `**Before**\n${fields(before, alert.analysis.railwayRefs, alert.analysis.impact)}`,
    "",
    `**After**\n${fields(after, revised.railwayRefs, revised.impact)}`,
    "",
    `Rewritten with \`${writerModel}\`, then re-checked against the stored docs corpus by code: for a product action the cited page is in the corpus, it is product documentation, the quote is on it, and the gap's own words do not lead to a page neither model opened; for a page edit the copy it replaces is still on the page and the replacement is copy rather than a note about it. A rewrite that failed any of those would have been thrown away with the original left standing.`,
  ].join("\n");
}

/**
 * Why an alert whose every action was dropped asks for nothing.
 *
 * The reviewer's own words, not a summary of them. It read the corpus and said
 * why it closed each issue, and asserting some other reason on its behalf – this
 * used to say "because Railway already covers this" whatever the reviewer had
 * found – is exactly the platitude the verdict exists to stop.
 */
function droppedVerdict(
  dropped: DroppedAction[],
  model: string | undefined,
  index: CorpusIndex,
): NoAction {
  const by = model ? `\`${model}\`` : "The reviewer";
  const what =
    dropped.length === 1 ? "the one action filed here" : `all ${dropped.length} actions filed here`;
  const pages = [...new Set(dropped.flatMap((entry) => entry.pages))];

  return {
    kind: "dropped_on_review",
    reason: `${by} read Railway's docs and closed ${what}. ${dropped.map((entry) => entry.reason).join(" ")}`,
    evidence: pages.map((url) => evidenceFor(index, url)),
  };
}
