import type {
  ActionIssue,
  Analysis,
  CandidateItem,
  CompetitorId,
  FeatureImage,
  RailwayClaim,
  RailwayPage,
  SourceId,
  StoredItem,
} from "../types.js";

export interface RecordAnalysisInput {
  itemId: string;
  analysis: Analysis;
  model: string;
  /** Stored with the analysis so a retry re-posts the same picture. */
  image: FeatureImage | null;
  /** One per action, stored so a retry links those issues instead of opening more. */
  issues: ActionIssue[];
}

export interface PendingPost {
  analysisId: string;
  item: StoredItem;
  analysis: Analysis;
  model: string;
  image: FeatureImage | null;
  /** One per action. */
  issues: ActionIssue[];
}

/**
 * Everything the pipeline needs from persistence. Backed by Postgres in
 * production and by an in-memory implementation for dry runs, so a dry run
 * works with no `DATABASE_URL` at all.
 */
export interface Store {
  /**
   * Insert items, skipping ones already stored under the same
   * (competitor, source, external_id). Returns only the rows that were new.
   */
  insertNewItems(items: CandidateItem[]): Promise<StoredItem[]>;

  /**
   * The id an item is already stored under, or null. Single-item mode uses it
   * to re-post something the deduplicator has seen before.
   */
  findItemId(item: CandidateItem): Promise<string | null>;

  /**
   * Which of these items are already stored, as `competitor|source|externalId`
   * keys. Lets a dry run answer "what is new?" without writing anything.
   */
  findKnownKeys(items: CandidateItem[]): Promise<Set<string>>;

  /** How many items already exist for a competitor+source pair. */
  countItems(competitor: CompetitorId, source: SourceId): Promise<number>;

  recordAnalysis(input: RecordAnalysisInput): Promise<string>;

  markPosted(analysisId: string, postedAt: Date): Promise<void>;

  /**
   * Analyses that were recorded but never reached Discord. An item is only
   * deduped once, so without this a transient Discord failure would lose the
   * alert permanently.
   */
  getUnpostedAnalyses(since: Date, limit: number): Promise<PendingPost[]>;

  /** URLs already indexed, mapped to when they were last fetched. */
  getIndexedPageUrls(): Promise<Map<string, Date>>;

  /**
   * Indexed pages for these exact URLs, in whatever order they come back.
   * Analysis uses it to read the canonical product docs without re-fetching.
   */
  getPages(urls: string[]): Promise<RailwayPage[]>;

  upsertPage(page: RailwayPage): Promise<void>;

  replaceClaimsForUrl(url: string, claims: RailwayClaim[]): Promise<void>;

  /** Claims for a competitor, most useful pages first, capped at `limit`. */
  getClaims(competitor: CompetitorId, limit: number): Promise<RailwayClaim[]>;

  close(): Promise<void>;
}

export function itemKey(item: Pick<CandidateItem, "competitor" | "source" | "externalId">): string {
  return `${item.competitor}|${item.source}|${item.externalId}`;
}
