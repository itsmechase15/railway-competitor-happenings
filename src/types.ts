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

/** A Railway page an action cites, with the edit it asks for when there is one. */
export interface RailwayRef {
  url: string;
  claim: string;
  suggestedEdit?: string;
}

export interface Analysis {
  impact: Impact;
  /** One sentence. The embed shows it under "What you need to KNOW". */
  summary: string;
  /** The elaboration, as short lines under "More detail". */
  keyPoints: string[];
  /**
   * In the order they should be read. Usually one to three, and empty when the
   * only thing the model asked for was a page edit about something other than
   * this launch, which the relevance guard drops.
   */
  actions: RecommendedAction[];
  railwayRefs: RailwayRef[];
  /** What we could not tell from the source, for whoever picks the issue up. */
  openQuestions: string[];
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
}

/** An analyzed item with everything Discord needs: a picture and an issue per action. */
export interface Alert extends AnalyzedItem {
  image: FeatureImage;
  /** One entry per recommended action, in the order the actions are read. */
  issues: ActionIssue[];
  /** Why there are no issue links. Dry runs only – a real run either links or stays quiet. */
  issueNote?: string;
}

/** A Railway page we have read: a docs page, a compare page, or a migrate page. */
export interface RailwayPage {
  url: string;
  title: string;
  text: string;
  mentions: CompetitorId[];
  fetchedAt: Date;
}

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
 * A Railway product docs page, cut down to what it says about one signal. This
 * is the evidence an action is checked against before it may claim Railway
 * cannot do something.
 */
export interface RailwayDoc {
  url: string;
  title: string;
  excerpt: string;
}
