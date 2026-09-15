import type { DocsWorkspace } from "../railway/workspace.js";
import type {
  Analysis,
  CompetitorClaim,
  RailwayClaim,
  RailwayDoc,
  StoredItem,
} from "../types.js";

/** Everything one analysis gets to see. */
export interface AnalyzerInput {
  item: StoredItem;
  /** Railway's own copy about this competitor, from the compare and migrate pages. */
  claims: RailwayClaim[];
  /** Corpus excerpts pre-loaded as a starting point, ranked for this signal. */
  docs: RailwayDoc[];
  /** What the competitor says about Railway on their own pages. */
  compareClaims: CompetitorClaim[];
  /**
   * The corpus on disk, which the analyst may search read-only, and which is
   * also where the table of contents in its prompt comes from. Null when no
   * corpus was written this run.
   */
  workspace: DocsWorkspace | null;
}

export interface AnalyzerOutput {
  analysis: Analysis;
  /**
   * Corpus URLs the analyst opened, resolved from the files it read. The
   * coverage gate rests on this, so it is observed rather than self-reported.
   */
  readUrls: string[];
}

export interface Analyzer {
  /** Recorded on the analysis row and shown in the embed footer. */
  readonly model: string;
  analyze(input: AnalyzerInput): Promise<AnalyzerOutput>;
}
