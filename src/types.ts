export type CompetitorId = "render" | "vercel";

export type SourceId = "changelog" | "blog" | "x" | "newsletter";

export const IMPACTS = ["minor", "notable", "major"] as const;
export type Impact = (typeof IMPACTS)[number];

/**
 * One thing Railway should do about a competitor signal. An alert often needs
 * more than one: a compare page that is now wrong, and a feature gap behind it.
 */
export const ACTIONS = ["consider_enhancing", "consider_building", "update_pages"] as const;
export type Action = (typeof ACTIONS)[number];

export interface RecommendedAction {
  type: Action;
  /** Full reasoning. The embed shows its first sentence; the GitHub issue gets all of it. */
  detail: string;
  /**
   * The Railway feature the action is about, e.g. "Serverless". Required for
   * consider_enhancing, where the label on its own names nothing to enhance.
   */
  feature?: string;
  /**
   * The Railway teams the model thinks are most involved, by name. Read as a
   * suggestion: every name is looked up in the catalog before anything renders
   * it, so a team that is not on railway.com/about is dropped. See
   * `src/teams.ts`.
   */
  teams?: string[];
  /**
   * What Railway does not do today, in one line. Required for the two product
   * actions: an enhancement with no gap named is a suggestion nobody can check.
   */
  gap?: string;
  /** The corpus page the gap was read off. Checked against the stored corpus. */
  evidenceUrl?: string;
  /** Words quoted from `evidenceUrl`. Checked against the stored page body. */
  evidenceQuote?: string;
}

/** A competitor signal before it has been written to the database. */
export interface CandidateItem {
  competitor: CompetitorId;
  source: SourceId;
  /** Stable per-source identity used for deduplication. */
  externalId: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  /** Source payload kept verbatim so analysis can be re-run without re-fetching. */
  raw: Record<string, unknown>;
}

/** A candidate item after it has been persisted (or simulated) and given an id. */
export interface StoredItem extends CandidateItem {
  id: string;
}

/**
 * Whether the copy an action proposes takes the place of the line it quotes,
 * or goes in beside it. A page that says the wrong thing needs a replacement;
 * a page that is silent on the launch needs a new line.
 */
export const EDIT_KINDS = ["replace", "insert"] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

/** A Railway page an action cites, with the edit it asks for when there is one. */
export interface RailwayRef {
  url: string;
  /** The copy on the page today, quoted verbatim. Checked against the stored page. */
  claim: string;
  /** One line saying what the edit has to achieve. */
  suggestedEdit?: string;
  /**
   * The edit itself, as finished copy a person pastes onto the page without
   * writing anything of their own, in that page's own voice. An `update_pages`
   * action with no proposed copy is dropped: an instruction to go and write
   * something is the work, not the recommendation.
   */
  proposedText?: string;
  /** What to do with `proposedText`. Defaults to replacing the quoted claim. */
  editKind?: EditKind;
}

/**
 * Why an alert recommends nothing.
 *
 * `already_covered` is Railway shipping the thing, which is the answer a reader
 * most wants and the only one that has to carry docs pages. `not_a_gap` is a
 * launch that asks nothing of the product: pricing, company news, a capability
 * Railway chose not to build. `unverified` is a gap claim that could not be
 * checked, which is not the same as no gap and says so. `dropped_on_review` is
 * the second model closing every issue the first one filed, and `unanalyzed` is
 * a run with no model behind it.
 */
export const NO_ACTION_KINDS = [
  "already_covered",
  "not_a_gap",
  "unverified",
  "dropped_on_review",
  "unanalyzed",
] as const;
export type NoActionKind = (typeof NO_ACTION_KINDS)[number];

/** A page the verdict rests on, so a reader can go and read it. */
export interface NoActionEvidence {
  url: string;
  /** The page's own title, which is what a link is labelled with. */
  title?: string;
  /** Words from the page, checked against the stored copy like any other quote. */
  quote?: string;
}

/**
 * Zero actions as an answer rather than a blank.
 *
 * The kind picks the title, the reason is the sentence under it, and the
 * evidence is the pages under that. A reason that names nothing concrete is the
 * failure this replaces, so `already_covered` is only allowed to say Railway
 * ships something when it can name the page that says so.
 */
export interface NoAction {
  kind: NoActionKind;
  /** One sentence: what the launch does, and what Railway ships or why it does not matter. */
  reason: string;
  /**
   * The pages the verdict rests on, docs unless the answer is a page Railway
   * publishes. Non-empty for `already_covered`, which is downgraded without
   * them rather than published as a claim nobody can check.
   */
  evidence: NoActionEvidence[];
}

export interface Analysis {
  impact: Impact;
  /** One sentence. The embed shows it under "What you need to KNOW". */
  summary: string;
  /** The elaboration, as short lines under "More detail". */
  keyPoints: string[];
  /**
   * Zero to three, in the order they should be read. Empty is a normal answer,
   * not a failure: plenty of launches are worth knowing about and ask nothing
   * of Railway, and an action that cannot survive the evidence checks is
   * dropped rather than filed.
   */
  actions: RecommendedAction[];
  /** Why there is nothing to do, in full. Set whenever `actions` is empty. */
  noAction?: NoAction;
  /**
   * The same verdict as one string. Written alongside `noAction` so a row
   * stored before the verdict had a shape still reads, and never the thing a
   * surface renders: the title and the links come off `noAction`.
   */
  noActionReason?: string;
  railwayRefs: RailwayRef[];
  /** What we could not tell from the source, for whoever picks the issue up. */
  openQuestions: string[];
  /**
   * Corpus pages the analyst actually read, as URLs. Recorded from its own
   * tool calls, so the coverage gate can tell a checked claim from a guess.
   */
  pagesRead?: string[];
}

export interface AnalyzedItem {
  item: StoredItem;
  analysis: Analysis;
  model: string;
  /**
   * The docs pages this verdict was checked against. Carried so an issue can
   * name the pages that stop being true if the recommendation ships, without
   * looking anything up a second time. Absent on an analysis replayed from the
   * database, which is past the point where issues are opened.
   */
  docs?: RailwayDoc[];
}

/** Where a feature image came from, in the order we try them. */
export const IMAGE_ORIGINS = ["feed", "page", "x", "screenshot", "generated"] as const;
export type ImageOrigin = (typeof IMAGE_ORIGINS)[number];

/** The picture on every alert. Discord renders it from a public URL. */
export interface FeatureImage {
  url: string;
  altText: string;
  origin: ImageOrigin;
}

export interface IssueRef {
  url: string;
  number: number;
}

/** Who picks the work up. Marketing owns the pages, product owns the roadmap. */
export const ACTION_OWNERS = ["marketing", "product"] as const;
export type ActionOwner = (typeof ACTION_OWNERS)[number];

/**
 * One recommended action and the issue opened for it. Every action gets its
 * own issue, because a page fix and a feature gap land on different desks.
 */
export interface ActionIssue {
  action: RecommendedAction;
  /** Null when no issue could be opened, e.g. a dry run or a missing token. */
  issue: IssueRef | null;
  /** Absent until a reviewer has been past this action. Set once, never twice. */
  review?: ActionReview;
}

/**
 * What a reviewer can say about one filed action. `agree` files it as written,
 * `revise` sends it to be rewritten once, `drop` closes the issue.
 */
export const REVIEW_VERDICTS = ["agree", "revise", "drop"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * The review one action got, stored on the analysis row.
 *
 * This is what makes the loop run once. A retry that finds a review here does
 * not review again, whatever the issue's labels say, so a Discord failure
 * cannot turn into a second reviewer run and a second rewrite of the same
 * issue.
 */
export interface ActionReview {
  verdict: ReviewVerdict;
  /** The reviewer's model id, which is not the analyst's. */
  model: string;
  at: Date;
  /** Why, in the reviewer's own words. The issue comment carries the same line. */
  reason: string;
  /**
   * Whether a `revise` verdict reached the issue. False when the rewrite could
   * not survive the evidence checks, which leaves the original filed.
   */
  applied?: boolean;
}

/** An analyzed item with everything Discord needs: a picture and an issue per action. */
export interface Alert extends AnalyzedItem {
  image: FeatureImage;
  /** One entry per recommended action, in the order the actions are read. */
  issues: ActionIssue[];
  /** Why there are no issue links. Dry runs only – a real run either links or stays quiet. */
  issueNote?: string;
}

/**
 * What a corpus page is for.
 *
 * `docs` is what Railway ships, and the only evidence a gap claim may rest on.
 * `marketing` is copy: the compare, migrate, and pricing pages, which are the
 * only pages an action may ask anyone to edit. `changelog` is Railway's own
 * changelog, which is evidence that something shipped and no evidence at all
 * that it is documented.
 */
export const PAGE_KINDS = ["docs", "marketing", "changelog"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/**
 * Where a corpus URL came from. A URL that no source offers any more is on its
 * way out, so the union is kept per page rather than collapsed to a boolean.
 *
 * `catalog` pins the overview pages `products.ts` routes to, so the surfaces
 * this bot reasons about cannot fall out of the corpus. Everything else is
 * discovered: `sitemap` is the vendor's own list, `llms` is one input and
 * never the whole truth, and `crawl` is the docs links found on pages already
 * fetched.
 */
export const DISCOVERY_SOURCES = ["sitemap", "llms", "crawl", "catalog", "changelog"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/** A Railway page as it comes off the network, before it is compared to what is stored. */
export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  mentions: CompetitorId[];
  fetchedAt: Date;
  kind: PageKind;
}

/**
 * A Railway page as the `pages` table holds it, which is this bot's source of
 * truth for what Railway documents.
 *
 * `contentHash` is what freshness is decided on: a re-download whose hash
 * matches leaves `changedAt` alone, so "we looked" and "it moved" stay
 * separate facts. `lastUsedAt` is the last time the page reached an analyst,
 * which is what puts it in the every-three-days tier instead of the
 * every-fortnight one.
 */
export interface RailwayPage extends FetchedPage {
  contentHash: string;
  changedAt: Date;
  discoveredFrom: DiscoverySource[];
  /** Consecutive runs this URL was offered by no discovery source. Two retires it. */
  missingStreak: number;
  lastUsedAt: Date | null;
  /** Set once the page is gone: retired pages stay on the row and leave the corpus. */
  retiredAt: Date | null;
}

/** A corpus row without its body, for deciding what to re-fetch. */
export type PageMeta = Omit<RailwayPage, "text" | "mentions">;

/** A competitor-mentioning paragraph lifted out of a Railway compare or migrate page. */
export interface RailwayClaim {
  url: string;
  competitor: CompetitorId;
  paragraph: string;
  heading: string | null;
}

/**
 * A paragraph about Railway lifted out of a competitor's own page. Where they
 * say Railway cannot do something Railway does, Railway's pages have a claim
 * to answer.
 */
export interface CompetitorClaim {
  url: string;
  competitor: CompetitorId;
  paragraph: string;
  heading: string | null;
}

/**
 * A corpus page, cut down to what it says about one signal. This is the
 * evidence an action is checked against before it may claim Railway cannot do
 * something.
 */
export interface RailwayDoc {
  url: string;
  title: string;
  excerpt: string;
  /**
   * What the page is evidence of. Absent on an excerpt assembled before the
   * corpus knew: read as product documentation, which is the common case.
   */
  kind?: PageKind;
}
