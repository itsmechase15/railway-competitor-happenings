import type {
  Analysis,
  CompetitorClaim,
  RailwayClaim,
  RailwayDoc,
  StoredItem,
} from "../types.js";

export interface Analyzer {
  /** Recorded on the analysis row and shown in the embed footer. */
  readonly model: string;
  /**
   * `claims` is Railway's own copy about the competitor, `docs` is what
   * Railway ships, and `compareClaims` is what the competitor says about
   * Railway.
   */
  analyze(
    item: StoredItem,
    claims: RailwayClaim[],
    docs: RailwayDoc[],
    compareClaims: CompetitorClaim[],
  ): Promise<Analysis>;
}
