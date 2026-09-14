import { randomUUID } from "node:crypto";
import type {
  CandidateItem,
  CompetitorId,
  RailwayClaim,
  RailwayPage,
  SourceId,
  StoredItem,
} from "../types.js";
import { itemKey, type PendingPost, type RecordAnalysisInput, type Store } from "./store.js";

/**
 * Non-persistent store used when `DATABASE_URL` is unset. It lets a dry run
 * exercise the whole pipeline with no live secrets – at the cost of treating
 * every item as new, since nothing survives the process.
 */
export class MemoryStore implements Store {
  private readonly items = new Map<string, StoredItem>();
  private readonly pages = new Map<string, RailwayPage>();
  private readonly claims: RailwayClaim[] = [];

  async insertNewItems(items: CandidateItem[]): Promise<StoredItem[]> {
    const inserted: StoredItem[] = [];
    for (const item of items) {
      const key = itemKey(item);
      if (this.items.has(key)) continue;
      const stored: StoredItem = { ...item, id: randomUUID() };
      this.items.set(key, stored);
      inserted.push(stored);
    }
    return inserted;
  }

  async findItemId(item: CandidateItem): Promise<string | null> {
    return this.items.get(itemKey(item))?.id ?? null;
  }

  async findKnownKeys(items: CandidateItem[]): Promise<Set<string>> {
    return new Set(items.map(itemKey).filter((key) => this.items.has(key)));
  }

  async countItems(competitor: CompetitorId, source: SourceId): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.competitor === competitor && item.source === source) count += 1;
    }
    return count;
  }

  async recordAnalysis(_input: RecordAnalysisInput): Promise<string> {
    return randomUUID();
  }

  async markPosted(_analysisId: string, _postedAt: Date): Promise<void> {
    // Nothing to persist.
  }

  async getUnpostedAnalyses(): Promise<PendingPost[]> {
    // Analyses are never persisted here, so there is never a backlog.
    return [];
  }

  async getIndexedPageUrls(): Promise<Map<string, Date>> {
    return new Map([...this.pages.values()].map((page) => [page.url, page.fetchedAt]));
  }

  async getPages(urls: string[]): Promise<RailwayPage[]> {
    return urls
      .map((url) => this.pages.get(url))
      .filter((page): page is RailwayPage => page !== undefined);
  }

  async upsertPage(page: RailwayPage): Promise<void> {
    this.pages.set(page.url, page);
  }

  async replaceClaimsForUrl(url: string, claims: RailwayClaim[]): Promise<void> {
    for (let index = this.claims.length - 1; index >= 0; index -= 1) {
      if (this.claims[index]?.url === url) this.claims.splice(index, 1);
    }
    this.claims.push(...claims);
  }

  async getClaims(competitor: CompetitorId, limit: number): Promise<RailwayClaim[]> {
    const rank = (url: string): number => {
      if (url.endsWith(`compare-to-${competitor}`)) return 0;
      if (url.endsWith(`migrate-from-${competitor}`)) return 1;
      if (url.includes(competitor)) return 2;
      return 3;
    };
    return this.claims
      .filter((claim) => claim.competitor === competitor)
      .sort((a, b) => rank(a.url) - rank(b.url) || b.paragraph.length - a.paragraph.length)
      .slice(0, limit);
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
