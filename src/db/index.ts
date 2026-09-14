import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { MemoryStore } from "./memory.js";
import { isUnreachable, PostgresStore, unreachableHint } from "./pg.js";
import { itemKey, type Store } from "./store.js";

const log = createLogger("db");

export interface CreateStoreOptions {
  /**
   * Permit the in-memory store when `DATABASE_URL` is unset, or when the
   * database it names cannot be reached. On by default for dry runs and
   * single-item verification; off for the daily run, where a missing database
   * would silently re-alert everything tomorrow.
   */
  allowMemoryFallback?: boolean;
}

export function createStore(config: Config, options: CreateStoreOptions = {}): Store {
  if (!config.databaseUrl) {
    if (!config.dryRun && !options.allowMemoryFallback) {
      throw new Error("DATABASE_URL is required unless DRY_RUN=true");
    }
    log.warn("DATABASE_URL is unset – using an in-memory store, nothing will persist");
    return new MemoryStore();
  }

  const postgres = config.dryRun
    ? new ReadOnlyStore(new PostgresStore(config.databaseUrl))
    : new PostgresStore(config.databaseUrl);
  if (config.dryRun) log.info("dry run: reading from Postgres, writes are skipped");

  if (!options.allowMemoryFallback) return postgres;
  return new UnreachableDatabaseFallback(postgres, unreachableHint(config.databaseUrl));
}

/**
 * Keeps a run going when the database turns out to be unreachable, at the cost
 * of persistence. Single-item mode exists to get one named announcement into
 * Discord, and refusing to post it because a dedupe row could not be written
 * would defeat the point – so the message goes out and the log says plainly
 * that nothing was recorded.
 *
 * Only reachability is forgiven. A query Postgres understood and rejected is
 * a bug, and it still fails the run.
 */
class UnreachableDatabaseFallback implements Store {
  private readonly memory = new MemoryStore();
  /** Null once the database has been given up on. */
  private postgres: Store | null;

  constructor(
    postgres: Store,
    private readonly hint: string | null,
  ) {
    this.postgres = postgres;
  }

  private async attempt<T>(call: (store: Store) => Promise<T>): Promise<T> {
    const postgres = this.postgres;
    if (!postgres) return call(this.memory);

    try {
      return await call(postgres);
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      this.postgres = null;
      log.error(
        `Postgres is unreachable – continuing on an in-memory store, so this run records no dedupe trace and may re-alert this item later: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (this.hint) log.error(this.hint);
      await postgres.close().catch(() => {
        // Already unreachable; there is nothing to salvage from a failed close.
      });
      return call(this.memory);
    }
  }

  insertNewItems(...args: Parameters<Store["insertNewItems"]>) {
    return this.attempt((store) => store.insertNewItems(...args));
  }

  findItemId(...args: Parameters<Store["findItemId"]>) {
    return this.attempt((store) => store.findItemId(...args));
  }

  findKnownKeys(...args: Parameters<Store["findKnownKeys"]>) {
    return this.attempt((store) => store.findKnownKeys(...args));
  }

  countItems(...args: Parameters<Store["countItems"]>) {
    return this.attempt((store) => store.countItems(...args));
  }

  recordAnalysis(...args: Parameters<Store["recordAnalysis"]>) {
    return this.attempt((store) => store.recordAnalysis(...args));
  }

  markPosted(...args: Parameters<Store["markPosted"]>) {
    return this.attempt((store) => store.markPosted(...args));
  }

  getUnpostedAnalyses(...args: Parameters<Store["getUnpostedAnalyses"]>) {
    return this.attempt((store) => store.getUnpostedAnalyses(...args));
  }

  getIndexedPageUrls() {
    return this.attempt((store) => store.getIndexedPageUrls());
  }

  getPages(...args: Parameters<Store["getPages"]>) {
    return this.attempt((store) => store.getPages(...args));
  }

  upsertPage(...args: Parameters<Store["upsertPage"]>) {
    return this.attempt((store) => store.upsertPage(...args));
  }

  replaceClaimsForUrl(...args: Parameters<Store["replaceClaimsForUrl"]>) {
    return this.attempt((store) => store.replaceClaimsForUrl(...args));
  }

  getClaims(...args: Parameters<Store["getClaims"]>) {
    return this.attempt((store) => store.getClaims(...args));
  }

  async close() {
    const postgres = this.postgres;
    this.postgres = null;
    if (postgres) await postgres.close();
  }
}

/**
 * Wraps a store so a dry run can read real dedupe and index state without
 * leaving anything behind. Writes are dropped; inserted items get throwaway
 * ids so the rest of the pipeline still runs end to end.
 */
class ReadOnlyStore implements Store {
  constructor(private readonly inner: Store) {}

  async insertNewItems(items: Parameters<Store["insertNewItems"]>[0]) {
    if (items.length === 0) return [];
    const known = await this.inner.findKnownKeys(items);
    return items
      .filter((item) => {
        const key = itemKey(item);
        if (known.has(key)) return false;
        known.add(key);
        return true;
      })
      .map((item, index) => ({ ...item, id: `dry-run-${index + 1}` }));
  }

  findItemId(...args: Parameters<Store["findItemId"]>) {
    return this.inner.findItemId(...args);
  }

  findKnownKeys(...args: Parameters<Store["findKnownKeys"]>) {
    return this.inner.findKnownKeys(...args);
  }

  countItems(...args: Parameters<Store["countItems"]>) {
    return this.inner.countItems(...args);
  }

  async recordAnalysis() {
    return "dry-run-analysis";
  }

  async markPosted() {
    // No-op in dry run.
  }

  getUnpostedAnalyses(...args: Parameters<Store["getUnpostedAnalyses"]>) {
    return this.inner.getUnpostedAnalyses(...args);
  }

  getIndexedPageUrls() {
    return this.inner.getIndexedPageUrls();
  }

  getPages(...args: Parameters<Store["getPages"]>) {
    return this.inner.getPages(...args);
  }

  async upsertPage() {
    // No-op in dry run.
  }

  async replaceClaimsForUrl() {
    // No-op in dry run.
  }

  getClaims(...args: Parameters<Store["getClaims"]>) {
    return this.inner.getClaims(...args);
  }

  close() {
    return this.inner.close();
  }
}

export { MemoryStore, PostgresStore };
export type { Store };
