import { relevantDocs } from "../analysis/verify.js";
import { COMPETITORS, type Config } from "../config.js";
import { actionLabel, actionOwner, IMPACT_LABEL, IMPACT_MEANING, SOURCE_LABEL } from "../labels.js";
import { createLogger } from "../log.js";
import type { PageVisual } from "../media/page-edit.js";
import { isDocsUrl, isMarketingTarget } from "../railway/pages.js";
import { findProductByName, productForDocUrl, productsForAction } from "../railway/products.js";
import { RAILWAY_ABOUT_URL } from "../railway/teams.js";
import { entryUrl } from "../sources/link.js";
import { relatedTeams, relatedTeamsLabel } from "../teams.js";
import {
  IMPACTS,
  type AnalyzedItem,
  type EditKind,
  type FeatureImage,
  type Impact,
  type IssueRef,
  type RailwayRef,
  type RecommendedAction,
} from "../types.js";
import { SPACED_EN_DASH, truncate } from "../util/text.js";

const log = createLogger("github");

export const GITHUB_API_BASE = "https://api.github.com";

/** GitHub rejects titles far longer than this, and nobody reads them anyway. */
const MAX_TITLE_CHARS = 120;

export interface IssueDraft {
  title: string;
  body: string;
  labels: string[];
}

/**
 * What a review verdict changes on an issue that already exists.
 *
 * `labels` replaces the whole set rather than adding to it, which is what
 * GitHub's PATCH does. That is why the labels an issue was opened with are
 * carried alongside it: a verdict adds its own label to that list and sends
 * the result, so one request records the whole outcome.
 */
export interface IssuePatch {
  title?: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  stateReason?: "completed" | "not_planned" | "reopened";
}

/** One action's issue, kept next to the action so the caller can pair them up. */
export interface ActionIssueDraft {
  action: RecommendedAction;
  draft: IssueDraft;
}

interface IssueResponse {
  number?: number;
  html_url?: string;
  message?: string;
}

/** A label GitHub accepts: lowercase, no spaces, no punctuation to escape. */
function labelSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Marketing owns page work, so `update_pages` is the one that routes there. */
function isPageAction(action: RecommendedAction): boolean {
  return action.type === "update_pages";
}

/**
 * Labels for one action's issue. Beyond the alert's own labels, the action
 * type and the owner are what a marketing or product filter actually queries,
 * the `team:` labels name the Railway teams the work is for so a filter can be
 * one team rather than a whole org, and the surface label is added whenever the
 * action names one we recognize.
 */
export function buildIssueLabels(alert: AnalyzedItem, action: RecommendedAction): string[] {
  const { item, analysis } = alert;
  // Only a surface the catalog recognizes earns a label. A model's own
  // phrasing for something we hold no docs for would mint a label nobody ever
  // queries again, and a repo full of one-off labels is worse than none.
  const product = action.feature ? findProductByName(action.feature) : undefined;

  return [
    "competitor-happenings",
    item.competitor,
    `source:${item.source}`,
    `impact:${analysis.impact}`,
    `action:${labelSlug(action.type)}`,
    `owner:${actionOwner(action)}`,
    ...relatedTeams(action).map((team) => `team:${team.slug}`),
    ...(product ? [`${product.kind}:${labelSlug(product.label)}`] : []),
  ];
}

/**
 * Competitor and feature first, so issues from one launch sit together, then
 * the action, so a list of three issues reads as three different jobs.
 */
export function buildIssueTitle(alert: AnalyzedItem, action: RecommendedAction): string {
  const label = COMPETITORS[alert.item.competitor].label;
  const suffix = `${SPACED_EN_DASH}${actionLabel(action)}`;
  const head = `${label}: ${alert.item.title}`;
  return `${truncate(head, Math.max(24, MAX_TITLE_CHARS - suffix.length))}${suffix}`;
}

/** A product docs page says what Railway ships; a compare page is copy. */
function isDocsRef(ref: RailwayRef): boolean {
  return isDocsUrl(ref.url);
}

/**
 * The refs that back one action.
 *
 * A page action is the page work, so it gets every page someone could edit,
 * with the edits suggested for them: the product docs are evidence, never a
 * target, so they are left off the list of pages to change. A product action
 * is a claim about what Railway ships, and only the docs support that.
 */
function supportingRefs(alert: AnalyzedItem, action: RecommendedAction): RailwayRef[] {
  const refs = alert.analysis.railwayRefs;
  if (isPageAction(action)) return refs.filter((ref) => isMarketingTarget(ref.url));

  const wanted = new Set(productsForAction(action).map((product) => product.label));

  return refs.filter((ref) => {
    if (ref.suggestedEdit || ref.proposedText || !isDocsRef(ref)) return false;
    const product = productForDocUrl(ref.url);
    if (!product) return true;
    return wanted.size === 0 || wanted.has(product.label);
  });
}

/** What the proposed copy does to the line quoted above it. */
const EDIT_KIND_LABEL: Record<EditKind, string> = {
  replace: "Replace the copy above with this, word for word:",
  insert: "Add this next to the copy above, word for word:",
};

/**
 * One page to edit: what it says now, what the edit is for, and the copy to
 * paste.
 *
 * The copy is the point of the section. A marketing issue reading "mention the
 * new thing on the compare page" hands the writing to whoever opens it, who
 * has read neither the launch nor the page, so the analysis writes the line
 * itself and this puts it in a code block somebody can copy without picking
 * the prose back out of a sentence about it.
 */
function pageEdit(ref: RailwayRef, visual: PageVisual | undefined): string {
  const lines = [`### ${ref.url}`];
  // The picture goes above the words. It answers the first question anybody
  // asked to make the edit has – what does the paragraph look like with this in
  // it – and it answers it before they have read a line.
  if (visual) {
    lines.push(
      `![${visual.altText}](${visual.imageUrl})`,
      `_Before and after, drawn from the stored copy of this page${SPACED_EN_DASH}${visual.summary}._`,
      "",
    );
  }
  lines.push(`- **Copy today:** ${ref.claim}`);
  if (ref.suggestedEdit) lines.push(`- **What the edit does:** ${ref.suggestedEdit}`);

  if (ref.proposedText) {
    lines.push(`\n${EDIT_KIND_LABEL[ref.editKind ?? "replace"]}`, "```text", ref.proposedText, "```");
  } else {
    lines.push(
      "\n_No exact copy was written for this page, so somebody has to word the edit themselves._",
    );
  }
  return lines.join("\n");
}

/**
 * The cited pages. Marketing gets the pages to edit with the copy to paste,
 * because editing the page is the job; product gets the docs that speak to the
 * action it is being asked to take, and nothing else.
 */
function pagesSection(
  alert: AnalyzedItem,
  action: RecommendedAction,
  visuals: PageVisual[],
): string {
  const heading = isPageAction(action)
    ? "## Railway pages to update"
    : "## Railway docs for context";
  const refs = supportingRefs(alert, action);

  if (refs.length === 0) {
    const empty = isPageAction(action)
      ? "No indexed Railway compare or migrate page covers this yet, which is itself worth a look."
      : "No Railway docs page in context speaks to this action, so nothing here has been checked against what Railway ships.";
    return `${heading}\n_${empty}_`;
  }

  if (isPageAction(action)) {
    const note =
      "_The copy below is written to go straight onto the page, in that page's own voice. Read the page around it before you paste, and edit it if the page has moved on._";
    const byPage = new Map(visuals.map((visual) => [visual.pageUrl, visual]));
    const edits = refs.map((ref) => pageEdit(ref, byPage.get(ref.url))).join("\n\n");
    return `${heading}\n${note}\n\n${edits}`;
  }

  const pages = refs.map((ref) => `### ${ref.url}\n- **Claim today:** ${ref.claim}`).join("\n\n");

  return `${heading}\n${pages}`;
}

/** Enough to name the pages, short enough that nobody scrolls past it. */
const MAX_DOCS_THAT_CHANGE = 6;

/**
 * The docs pages this recommendation was checked against, which are the pages
 * that stop being true the day it ships.
 *
 * Nothing new is looked up for this. These are the same pages the action was
 * verified against and cites, read a second way: as evidence they say what
 * Railway does today, and as a list they say what someone has to rewrite when
 * Railway does something else. Page actions have no use for it.
 */
function docsThatWouldChange(alert: AnalyzedItem, action: RecommendedAction): string[] {
  if (isPageAction(action)) return [];
  const verified = relevantDocs(action, alert.docs ?? []).map((doc) => doc.url);
  const cited = supportingRefs(alert, action)
    .filter(isDocsRef)
    .map((ref) => ref.url);
  return [...new Set([...verified, ...cited])].slice(0, MAX_DOCS_THAT_CHANGE);
}

function docsThatWouldChangeSection(
  alert: AnalyzedItem,
  action: RecommendedAction,
): string | null {
  const urls = docsThatWouldChange(alert, action);
  if (urls.length === 0) return null;
  return `## Docs that would change if this ships\n${urls.map((url) => `- ${url}`).join("\n")}`;
}

/**
 * The gap, and the page it was read off, quoted.
 *
 * This is what the issue is standing on, so it goes near the top: the reader's
 * first question about "Railway should build X" is "are we sure we don't?", and
 * the answer is a line from Railway's own docs with a link to the page it is
 * on. An action with no gap named is a page edit, which carries its evidence
 * further down as the copy to change.
 */
function evidenceSection(action: RecommendedAction): string | null {
  if (!action.gap) return null;

  const lines = [`## The gap this closes\n${action.gap}`];
  if (action.evidenceUrl) {
    const quote = action.evidenceQuote
      ? `\n> ${action.evidenceQuote.replace(/\n+/g, " ")}`
      : "";
    lines.push(`\nChecked against ${action.evidenceUrl}${quote}`);
  }
  return lines.join("\n");
}

/**
 * The whole scale as a task list, each level with what it means, so a reader
 * who does not carry the rule in their head can see where this one sits and
 * why. The embed keeps the single label; an issue has the room.
 */
function impactScale(impact: Impact): string {
  return IMPACTS.map(
    (level) =>
      `- [${level === impact ? "x" : " "}] ${IMPACT_LABEL[level]}${SPACED_EN_DASH}${IMPACT_MEANING[level]}`,
  ).join("\n");
}

/**
 * The teams this issue is for, and where the names came from.
 *
 * Railway publishes no team pages, only the about page's grid of people and
 * their titles, so the link is to that page rather than to a page per team. It
 * is there because a reader who has not met these names before should be able
 * to see what they were read off, and reroute the issue when the read was
 * wrong.
 */
function teamsSection(action: RecommendedAction): string {
  const names = relatedTeamsLabel(action);
  return `${names}${SPACED_EN_DASH}inferred from the titles on [railway.com/about](${RAILWAY_ABOUT_URL})`;
}

function bullets(values: string[], empty: string): string {
  if (values.length === 0) return `_${empty}_`;
  return values.map((value) => `- ${value}`).join("\n");
}

/**
 * The long form of one recommended action. Everything the embed cannot carry –
 * the full detail, page citations, suggested edits, open questions – lives
 * here, scoped to the one job this issue is asking for.
 *
 * The order is what a reader needs in the order they need it: what happened,
 * then what to do about it, then who it is for. Somebody who reads that far and
 * closes the tab has the whole point of the issue, so everything that justifies
 * the action – the gap, the impact scale, the cited pages – comes after all
 * three rather than between them.
 */
export function buildIssueBody(
  alert: AnalyzedItem,
  image: FeatureImage | null,
  action: RecommendedAction,
  visuals: PageVisual[] = [],
): string {
  const { item, analysis, model } = alert;
  const competitor = COMPETITORS[item.competitor];
  const published = item.publishedAt?.toISOString().slice(0, 10) ?? "unknown";

  const sections = [
    `**${competitor.label}** · ${SOURCE_LABEL[item.source]} · published ${published} · impact **${IMPACT_LABEL[analysis.impact]}** · owned by **${actionOwner(action)}**`,
    image ? `<img src="${image.url}" alt="${image.altText}" width="720" />` : null,
    `## What you need to know\n${analysis.summary}`,
    `## Recommended action\n**${actionLabel(action)}**${SPACED_EN_DASH}${action.detail}`,
    `## Related team(s)\n${teamsSection(action)}`,
    evidenceSection(action),
    `## Impact\n${impactScale(analysis.impact)}`,
    `## More detail\n${bullets(analysis.keyPoints, "The source gave nothing beyond the summary above.")}`,
    pagesSection(alert, action, visuals),
    docsThatWouldChangeSection(alert, action),
    `## Open questions\n${bullets(analysis.openQuestions, "None raised.")}`,
    `## Sources\n- [${competitor.label} ${SOURCE_LABEL[item.source]}](${entryUrl(item)})${
      image ? `\n- Feature image (${image.origin}): ${image.url}` : ""
    }`,
    `---\nOpened by railway-competitor-happenings. Analyzed with \`${model}\`.`,
  ];

  return sections.filter((section): section is string => section !== null).join("\n\n");
}

export function buildIssueDraft(
  alert: AnalyzedItem,
  image: FeatureImage | null,
  action: RecommendedAction,
  visuals: PageVisual[] = [],
): IssueDraft {
  return {
    title: buildIssueTitle(alert, action),
    body: buildIssueBody(alert, image, action, visuals),
    labels: buildIssueLabels(alert, action),
  };
}

/**
 * The Before/After pictures already drawn for each action, keyed by the action
 * itself. Keyed by identity rather than by index because the drawing and the
 * drafting are two passes over the same action objects, and an index that
 * silently slipped would put one page's picture on another page's issue.
 */
export type ActionVisuals = ReadonlyMap<RecommendedAction, PageVisual[]>;

/**
 * One draft per recommended action. An alert that says "enhance Serverless,
 * enhance the CDN, and fix the compare page" is three issues, so nobody has to
 * read someone else's work to find their own.
 */
export function buildIssueDrafts(
  alert: AnalyzedItem,
  image: FeatureImage | null,
  visuals?: ActionVisuals,
): ActionIssueDraft[] {
  return alert.analysis.actions.map((action) => ({
    action,
    draft: buildIssueDraft(alert, image, action, visuals?.get(action) ?? []),
  }));
}

export interface IssueCreator {
  readonly description: string;
  /** Returns null when no issue could be opened; the caller keeps going regardless. */
  create(draft: IssueDraft): Promise<IssueRef | null>;
}

interface GitHubRequest {
  method: "POST" | "PATCH";
  path: string;
  token: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
}

/** One call to the issues API. Throws with the status in the message, which is what the label retry reads. */
async function githubRequest(request: GitHubRequest): Promise<IssueResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(`${GITHUB_API_BASE}${request.path}`, {
      method: request.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${request.token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(request.payload),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => ({}))) as IssueResponse;
    if (!response.ok) {
      throw new Error(
        `${request.method} ${request.path} returned ${response.status}: ${body.message ?? "no detail"}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export class GitHubIssueCreator implements IssueCreator {
  readonly description: string;

  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.description = `issues in ${repo}`;
  }

  private async post(draft: IssueDraft, labels: string[]): Promise<IssueResponse> {
    return githubRequest({
      method: "POST",
      path: `/repos/${this.repo}/issues`,
      token: this.token,
      timeoutMs: this.timeoutMs,
      payload: { title: draft.title, body: draft.body, labels },
    });
  }

  async create(draft: IssueDraft): Promise<IssueRef | null> {
    try {
      let body: IssueResponse;
      try {
        body = await this.post(draft, draft.labels);
      } catch (error) {
        // A label the repo has never seen is a 422. The issue itself matters
        // more than its labels, so try again without them.
        if (!(error instanceof Error) || !error.message.includes("422")) throw error;
        log.warn(`retrying without labels: ${error.message}`);
        body = await this.post(draft, []);
      }

      if (!body.html_url || body.number === undefined) {
        throw new Error("GitHub accepted the issue but returned no url");
      }
      log.info(`opened ${body.html_url}`);
      return { url: body.html_url, number: body.number };
    } catch (error) {
      log.error(
        `could not open an issue for "${draft.title}"`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}

/** Used when there is no token, or when a dry run must not write anything. */
export class DisabledIssueCreator implements IssueCreator {
  readonly description: string;

  constructor(readonly reason: string) {
    this.description = `skipped (${reason})`;
  }

  async create(draft: IssueDraft): Promise<IssueRef | null> {
    log.info(`[${this.reason}] would open an issue: ${draft.title}`);
    return null;
  }
}

export function createIssueCreator(config: Config): IssueCreator {
  if (config.dryRun) return new DisabledIssueCreator("dry run");
  if (!config.githubToken) return new DisabledIssueCreator("GITHUB_TOKEN is not set");
  return new GitHubIssueCreator(config.githubRepo, config.githubToken, config.httpTimeoutMs);
}

/**
 * Changing an issue that already exists, which is what a review verdict does.
 *
 * Every method takes an issue that may be null, because the pipeline reviews an
 * action whether or not an issue was opened for it: a dry run and a run with no
 * token both review and both have nothing to write to. That is deliberate – the
 * disabled editor says what it would have done, so a dry run shows the whole
 * verdict rather than the half of it that needs no credentials.
 *
 * Nothing here fails a run. An issue that cannot be edited is an issue that
 * still says what the analyst wrote, which is worse than the reviewed version
 * and better than a run that stopped.
 */
export interface IssueEditor {
  readonly description: string;
  /** Returns whether the edit landed. */
  update(issue: IssueRef | null, patch: IssuePatch): Promise<boolean>;
  comment(issue: IssueRef | null, body: string): Promise<boolean>;
  /**
   * Close it, with the labels the verdict leaves behind. One request, so an
   * issue is never briefly closed and unlabelled.
   */
  close(
    issue: IssueRef | null,
    reason: "completed" | "not_planned",
    labels?: string[],
  ): Promise<boolean>;
}

export class GitHubIssueEditor implements IssueEditor {
  readonly description: string;

  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.description = `edits issues in ${repo}`;
  }

  async update(issue: IssueRef | null, patch: IssuePatch): Promise<boolean> {
    if (!issue) return false;
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.body !== undefined) payload.body = patch.body;
    if (patch.labels !== undefined) payload.labels = patch.labels;
    if (patch.state !== undefined) payload.state = patch.state;
    if (patch.stateReason !== undefined) payload.state_reason = patch.stateReason;

    // A label the repo has never seen is a 422, same as on create, and the rest
    // of the edit matters more than the label that came with it.
    const withoutLabels =
      payload.labels !== undefined && Object.keys(payload).length > 1
        ? Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "labels"))
        : undefined;

    return this.send(
      `/repos/${this.repo}/issues/${issue.number}`,
      "PATCH",
      payload,
      issue,
      withoutLabels,
    );
  }

  async comment(issue: IssueRef | null, body: string): Promise<boolean> {
    if (!issue) return false;
    return this.send(`/repos/${this.repo}/issues/${issue.number}/comments`, "POST", { body }, issue);
  }

  async close(
    issue: IssueRef | null,
    reason: "completed" | "not_planned",
    labels?: string[],
  ): Promise<boolean> {
    return this.update(issue, {
      state: "closed",
      stateReason: reason,
      ...(labels ? { labels } : {}),
    });
  }

  private async send(
    path: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
    issue: IssueRef,
    withoutLabels?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      try {
        await githubRequest({ method, path, token: this.token, timeoutMs: this.timeoutMs, payload });
      } catch (error) {
        const rejectedLabel =
          withoutLabels !== undefined && error instanceof Error && error.message.includes("422");
        if (!rejectedLabel) throw error;
        log.warn(`retrying without labels: ${(error as Error).message}`);
        await githubRequest({
          method,
          path,
          token: this.token,
          timeoutMs: this.timeoutMs,
          payload: withoutLabels,
        });
      }
      return true;
    } catch (error) {
      log.error(`could not edit ${issue.url}`, error instanceof Error ? error.message : error);
      return false;
    }
  }
}

/** Used when there is no token, or when a dry run must not write anything. */
export class DisabledIssueEditor implements IssueEditor {
  readonly description: string;

  constructor(readonly reason: string) {
    this.description = `skipped (${reason})`;
  }

  async update(issue: IssueRef | null, patch: IssuePatch): Promise<boolean> {
    const changed = [
      patch.title ? "title" : null,
      patch.body ? "body" : null,
      patch.labels ? `labels ${patch.labels.join(", ")}` : null,
      patch.state ? `state ${patch.state}` : null,
      patch.stateReason ? `reason ${patch.stateReason}` : null,
    ].filter(Boolean);
    log.info(`[${this.reason}] would edit ${describeIssue(issue)}: ${changed.join(" · ")}`);
    return false;
  }

  async comment(issue: IssueRef | null, body: string): Promise<boolean> {
    log.info(`[${this.reason}] would comment on ${describeIssue(issue)}: ${firstLine(body)}`);
    return false;
  }

  async close(
    issue: IssueRef | null,
    reason: "completed" | "not_planned",
    labels?: string[],
  ): Promise<boolean> {
    return this.update(issue, {
      state: "closed",
      stateReason: reason,
      ...(labels ? { labels } : {}),
    });
  }
}

function describeIssue(issue: IssueRef | null): string {
  return issue ? `#${issue.number}` : "the issue it never opened";
}

function firstLine(body: string): string {
  return truncate(body.split("\n").find((line) => line.trim() !== "") ?? "", 160);
}

export function createIssueEditor(config: Config): IssueEditor {
  if (config.dryRun) return new DisabledIssueEditor("dry run");
  if (!config.githubToken) return new DisabledIssueEditor("GITHUB_TOKEN is not set");
  return new GitHubIssueEditor(config.githubRepo, config.githubToken, config.httpTimeoutMs);
}
