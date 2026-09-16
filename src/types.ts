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
  /** Why there is nothing to do. Set whenever `actions` is empty. */
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
