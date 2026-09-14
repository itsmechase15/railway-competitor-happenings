import { relevantDocs } from "../analysis/verify.js";
import { COMPETITORS, type Config } from "../config.js";
import { actionLabel, actionOwner, IMPACT_LABEL, IMPACT_MEANING, SOURCE_LABEL } from "../labels.js";
import { createLogger } from "../log.js";
import { isDocsUrl, isMarketingTarget } from "../railway/pages.js";
import { findProductByName, productForDocUrl, productsForAction } from "../railway/products.js";
import { entryUrl } from "../sources/link.js";
import {
  IMPACTS,
  type AnalyzedItem,
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
 * and the surface label is added whenever the action names one we recognize.
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
    if (ref.suggestedEdit || !isDocsRef(ref)) return false;
    const product = productForDocUrl(ref.url);
    if (!product) return true;
    return wanted.size === 0 || wanted.has(product.label);
  });
}

/**
 * The cited pages. Marketing gets the pages to edit with the suggested edits,
 * because editing the page is the job; product gets the docs that speak to the
 * action it is being asked to take, and nothing else.
 */
function pagesSection(alert: AnalyzedItem, action: RecommendedAction): string {
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

  const pages = refs
    .map((ref) => {
      const lines = [`### ${ref.url}`, `- **Claim today:** ${ref.claim}`];
      if (ref.suggestedEdit && isPageAction(action)) {
        lines.push(`- **Suggested edit:** ${ref.suggestedEdit}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

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

function bullets(values: string[], empty: string): string {
  if (values.length === 0) return `_${empty}_`;
  return values.map((value) => `- ${value}`).join("\n");
}

/**
 * The long form of one recommended action. Everything the embed cannot carry –
 * the full detail, page citations, suggested edits, open questions – lives
 * here, scoped to the one job this issue is asking for.
 */
export function buildIssueBody(
  alert: AnalyzedItem,
  image: FeatureImage | null,
  action: RecommendedAction,
): string {
  const { item, analysis, model } = alert;
  const competitor = COMPETITORS[item.competitor];
  const published = item.publishedAt?.toISOString().slice(0, 10) ?? "unknown";

  const sections = [
    `**${competitor.label}** · ${SOURCE_LABEL[item.source]} · published ${published} · impact **${IMPACT_LABEL[analysis.impact]}** · owned by **${actionOwner(action)}**`,
    image ? `<img src="${image.url}" alt="${image.altText}" width="720" />` : null,
    `## Recommended action\n**${actionLabel(action)}**${SPACED_EN_DASH}${action.detail}`,
    `## What you need to know\n${analysis.summary}`,
    `## Impact\n${impactScale(analysis.impact)}`,
    `## More detail\n${bullets(analysis.keyPoints, "The source gave nothing beyond the summary above.")}`,
    pagesSection(alert, action),
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
): IssueDraft {
  return {
    title: buildIssueTitle(alert, action),
    body: buildIssueBody(alert, image, action),
    labels: buildIssueLabels(alert, action),
  };
}

/**
 * One draft per recommended action. An alert that says "enhance Serverless,
 * enhance the CDN, and fix the compare page" is three issues, so nobody has to
 * read someone else's work to find their own.
 */
export function buildIssueDrafts(
  alert: AnalyzedItem,
  image: FeatureImage | null,
): ActionIssueDraft[] {
  return alert.analysis.actions.map((action) => ({
    action,
    draft: buildIssueDraft(alert, image, action),
  }));
}

export interface IssueCreator {
  readonly description: string;
  /** Returns null when no issue could be opened; the caller keeps going regardless. */
  create(draft: IssueDraft): Promise<IssueRef | null>;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${GITHUB_API_BASE}/repos/${this.repo}/issues`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ title: draft.title, body: draft.body, labels }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as IssueResponse;
      if (!response.ok) {
        throw new Error(`POST /issues returned ${response.status}: ${body.message ?? "no detail"}`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
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
