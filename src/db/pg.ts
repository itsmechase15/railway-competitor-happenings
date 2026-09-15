import pg from "pg";
import { parseStoredAlert, serializeAlertPayload } from "../analysis/schema.js";
import { createLogger } from "../log.js";
import type {
  CandidateItem,
  CompetitorId,
  DiscoverySource,
  PageKind,
  PageMeta,
  RailwayClaim,
  RailwayPage,
  SourceId,
  StoredItem,
} from "../types.js";
import {
  itemKey,
  type CorpusBookkeeping,
  type PendingPost,
  type RecordAnalysisInput,
  type Store,
} from "./store.js";

const log = createLogger("db");

const PAGE_COLUMNS = `url, title, text, mentions, kind, content_hash, fetched_at,
              changed_at, discovered_from, missing_streak, last_used_at, retired_at`;

interface PageRow {
  url: string;
  title: string | null;
  text: string | null;
  mentions: CompetitorId[] | null;
  kind: string | null;
  content_hash: string | null;
  fetched_at: Date | null;
  changed_at: Date | null;
  discovered_from: string[] | null;
  missing_streak: number | null;
  last_used_at: Date | null;
  retired_at: Date | null;
}

/**
 * A corpus row as the rest of the app reads it. Every column added by
 * migration 003 has a default, so a row written before it applied reads as a
 * docs page with no known hash, which is what makes the next run re-read it.
 */
function toPage(row: PageRow): RailwayPage {
  const fetchedAt = row.fetched_at ?? new Date(0);
  return {
    url: row.url,
    title: row.title ?? "",
    text: row.text ?? "",
    mentions: row.mentions ?? [],
    kind: (row.kind ?? "docs") as PageKind,
    contentHash: row.content_hash ?? "",
    fetchedAt,
    changedAt: row.changed_at ?? fetchedAt,
    discoveredFrom: (row.discovered_from ?? []) as DiscoverySource[],
    missingStreak: row.missing_streak ?? 0,
    lastUsedAt: row.last_used_at,
    retiredAt: row.retired_at,
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

/**
 * Hosted Postgres (Supabase included) requires TLS but often presents a chain
 * the default Node trust store does not recognise, so verification is relaxed
 * unless `DATABASE_SSL_STRICT` asks for it. Local databases get no TLS at all,
 * because they typically do not offer it.
 */
export function sslConfigFor(
  connectionString: string,
  strict = process.env.DATABASE_SSL_STRICT === "true",
): pg.PoolConfig["ssl"] {
  let host = "";
  let sslmode: string | null = null;
  try {
    const url = new URL(connectionString);
    host = url.hostname;
    sslmode = url.searchParams.get("sslmode");
  } catch {
    // Not a URL (e.g. a key/value DSN); fall through to the TLS default.
  }

  if (sslmode === "disable" || LOCAL_HOSTS.has(host)) return false;
  return strict ? true : { rejectUnauthorized: false };
}

/**
 * Failures that mean no session was ever established: DNS, routing, refused
 * sockets, and a TLS handshake that never completed. A query Postgres
 * understood and rejected is not one of these, and neither is a bad password.
 */
const UNREACHABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Whether the database could not be reached at all. Node tries both address
 * families for a dual-stack host and reports the pair as an `AggregateError`,
 * so the causes are walked rather than only the outermost error read.
 */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
  // Connecting to a server with TLS off where TLS is mandatory, and the reverse.
  if (/does not support SSL|server does not support TLS/i.test(error.message)) return true;

  const nested = error instanceof AggregateError ? error.errors : [];
  return [...nested, error.cause].some((inner) => isUnreachable(inner));
}

/**
 * What to change when the database cannot be reached, for the shapes of
 * connection string that have a known answer. Supabase's direct host publishes
 * only an AAAA record and a GitHub Actions runner has no IPv6 route, so every
 * connection there fails before TLS; the pooler host is dual-stack.
 *
 * The host is deliberately left out of the returned text: it is part of
 * `DATABASE_URL`, and Actions masks the whole secret rather than its parts.
 */
export function unreachableHint(connectionString: string): string | null {
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return null;
  }

  if (/^db\.[a-z0-9]+\.supabase\.(co|com)$/i.test(host)) {
    return "DATABASE_URL is a Supabase direct connection, which resolves to IPv6 only. GitHub Actions runners are IPv4-only, so use the Session pooler connection string (host *.pooler.supabase.com) instead";
  }
  return null;
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      ssl: sslConfigFor(connectionString),
    });
  }

  async insertNewItems(items: CandidateItem[]): Promise<StoredItem[]> {
    if (items.length === 0) return [];
    const inserted: StoredItem[] = [];

    for (const item of items) {
      const result = await this.pool.query<{ id: string }>(
        `INSERT INTO items (competitor, source, external_id, title, url, published_at, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (competitor, source, external_id) DO NOTHING
         RETURNING id::text`,
        [
          item.competitor,
          item.source,
          item.externalId,
          item.title,
          item.url,
          item.publishedAt,
          JSON.stringify(item.raw),
        ],
      );
      const row = result.rows[0];
      if (row) inserted.push({ ...item, id: row.id });
    }

    return inserted;
  }

  async findItemId(item: CandidateItem): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id::text
       FROM items
       WHERE competitor = $1 AND source = $2 AND external_id = $3`,
      [item.competitor, item.source, item.externalId],
    );
    return result.rows[0]?.id ?? null;
  }

  async findKnownKeys(items: CandidateItem[]): Promise<Set<string>> {
    if (items.length === 0) return new Set();
    const result = await this.pool.query<{
      competitor: CompetitorId;
      source: SourceId;
      external_id: string;
    }>(
      `SELECT competitor, source, external_id
       FROM items
       WHERE (competitor, source, external_id) IN (
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       )`,
      [
        items.map((item) => item.competitor),
        items.map((item) => item.source),
        items.map((item) => item.externalId),
      ],
    );
    return new Set(
      result.rows.map((row) =>
        itemKey({ competitor: row.competitor, source: row.source, externalId: row.external_id }),
      ),
    );
  }

  async countItems(competitor: CompetitorId, source: SourceId): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM items WHERE competitor = $1 AND source = $2",
      [competitor, source],
    );
    return Number.parseInt(result.rows[0]?.count ?? "0", 10);
  }

  /**
   * The canonical verdict lives in the `analysis` jsonb. The `impact` column
   * is there so the table can be queried without unpacking jsonb; nothing
   * reads it back.
   */
  async recordAnalysis(input: RecordAnalysisInput): Promise<string> {
    const payload = serializeAlertPayload(input.analysis, input.image, input.issues);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO analyses (item_id, impact, analysis, model)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id::text`,
      [input.itemId, input.analysis.impact, JSON.stringify(payload), input.model],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`failed to record analysis for item ${input.itemId}`);
    return id;
  }

  async markPosted(analysisId: string, postedAt: Date): Promise<void> {
    await this.pool.query("UPDATE analyses SET posted_at = $2 WHERE id::text = $1", [
      analysisId,
      postedAt,
    ]);
  }

  async getUnpostedAnalyses(since: Date, limit: number): Promise<PendingPost[]> {
    const result = await this.pool.query<{
      analysis_id: string;
      analysis: unknown;
      model: string;
      item_id: string;
      competitor: CompetitorId;
      source: SourceId;
      external_id: string;
      title: string;
      url: string;
      published_at: Date | null;
      raw: Record<string, unknown> | null;
    }>(
      `SELECT a.id::text AS analysis_id, a.analysis, a.model,
              i.id::text AS item_id, i.competitor, i.source, i.external_id,
              i.title, i.url, i.published_at, i.raw
       FROM analyses a
       JOIN items i ON i.id = a.item_id
       WHERE a.posted_at IS NULL AND a.created_at >= $1
       ORDER BY a.created_at ASC
       LIMIT $2`,
      [since, limit],
    );

    const pending: PendingPost[] = [];
    for (const row of result.rows) {
      try {
        const stored = parseStoredAlert(row.analysis);
        pending.push({
          analysisId: row.analysis_id,
          model: row.model,
          analysis: stored.analysis,
          image: stored.image,
          issues: stored.issues,
          item: {
            id: row.item_id,
            competitor: row.competitor,
            source: row.source,
            externalId: row.external_id,
            title: row.title,
            url: row.url,
            publishedAt: row.published_at,
            raw: row.raw ?? {},
          },
        });
      } catch (error) {
        // A row we cannot parse is not worth failing the run over; it would
        // only ever have produced a malformed alert.
        log.warn(`skipping unreadable analysis ${row.analysis_id}`, error);
      }
    }
    return pending;
  }

  async listPageMeta(): Promise<PageMeta[]> {
    const result = await this.pool.query<PageRow>(
      `SELECT url, title, '' AS text, '{}'::text[] AS mentions, kind, content_hash,
              fetched_at, changed_at, discovered_from, missing_streak, last_used_at, retired_at
       FROM pages`,
    );
    return result.rows.map((row) => {
      const { text: _text, mentions: _mentions, ...meta } = toPage(row);
      return meta;
    });
  }

  async loadCorpus(kinds?: PageKind[]): Promise<RailwayPage[]> {
    const result = await this.pool.query<PageRow>(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       WHERE retired_at IS NULL
         AND ($1::text[] IS NULL OR kind = ANY($1::text[]))
       ORDER BY url`,
      [kinds ?? null],
    );
    return result.rows.map(toPage);
  }

  async getPages(urls: string[]): Promise<RailwayPage[]> {
    if (urls.length === 0) return [];
    const result = await this.pool.query<PageRow>(
      `SELECT ${PAGE_COLUMNS}
       FROM pages
       WHERE url = ANY($1::text[])`,
      [urls],
    );
    return result.rows.map(toPage);
  }

  /**
   * `retired_at` is cleared on purpose: a page we are writing a body for is
   * back, whatever a past run concluded about it.
   */
  async savePage(page: RailwayPage): Promise<void> {
    await this.pool.query(
      `INSERT INTO pages (url, title, text, mentions, kind, content_hash, fetched_at,
                          changed_at, discovered_from, missing_streak, last_used_at, retired_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9::text[], $10, $11, NULL)
       ON CONFLICT (url) DO UPDATE
         SET title = EXCLUDED.title,
             text = EXCLUDED.text,
             mentions = EXCLUDED.mentions,
             kind = EXCLUDED.kind,
             content_hash = EXCLUDED.content_hash,
             fetched_at = EXCLUDED.fetched_at,
             changed_at = EXCLUDED.changed_at,
             discovered_from = EXCLUDED.discovered_from,
             missing_streak = EXCLUDED.missing_streak,
             last_used_at = coalesce(EXCLUDED.last_used_at, pages.last_used_at),
             retired_at = NULL`,
      [
        page.url,
        page.title,
        page.text,
        page.mentions,
        page.kind,
        page.contentHash,
        page.fetchedAt,
        page.changedAt,
        page.discoveredFrom,
        page.missingStreak,
        page.lastUsedAt,
      ],
    );
  }

  async recordCorpusRun(update: CorpusBookkeeping): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const record of update.seen) {
        await client.query(
          "UPDATE pages SET missing_streak = 0, discovered_from = $2::text[] WHERE url = $1",
          [record.url, record.sources],
        );
      }
      if (update.missing.length > 0) {
        await client.query(
          "UPDATE pages SET missing_streak = missing_streak + 1, discovered_from = '{}' WHERE url = ANY($1::text[])",
          [update.missing],
        );
      }
      if (update.retired.length > 0) {
        await client.query(
          "UPDATE pages SET retired_at = $2 WHERE url = ANY($1::text[]) AND retired_at IS NULL",
          [update.retired, update.at],
        );
      }
      if (update.used.length > 0) {
        await client.query("UPDATE pages SET last_used_at = $2 WHERE url = ANY($1::text[])", [
          update.used,
          update.at,
        ]);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceClaimsForUrl(url: string, claims: RailwayClaim[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM claims WHERE url = $1", [url]);
      for (const claim of claims) {
        await client.query(
          "INSERT INTO claims (url, competitor, paragraph, heading) VALUES ($1, $2, $3, $4)",
          [claim.url, claim.competitor, claim.paragraph, claim.heading],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Ranked so the page written about this competitor outranks one that merely
   * name-drops it: a Render alert should cite the compare-to-render page, not
   * whichever page happens to have the longest paragraph.
   */
  async getClaims(competitor: CompetitorId, limit: number): Promise<RailwayClaim[]> {
    const result = await this.pool.query<{
      url: string;
      competitor: CompetitorId;
      paragraph: string;
      heading: string | null;
    }>(
      `SELECT url, competitor, paragraph, heading
       FROM claims
       WHERE competitor = $1
       ORDER BY
         CASE
           WHEN url LIKE '%compare-to-' || $1 THEN 0
           WHEN url LIKE '%migrate-from-' || $1 THEN 1
           WHEN url LIKE '%' || $1 || '%' THEN 2
           ELSE 3
         END,
         length(paragraph) DESC
       LIMIT $2`,
      [competitor, limit],
    );
    return result.rows.map((row) => ({
      url: row.url,
      competitor: row.competitor,
      paragraph: row.paragraph,
      heading: row.heading,
    }));
  }

  async close(): Promise<void> {
    await this.pool.end().catch((error: unknown) => {
      log.warn("failed to close pool cleanly", error);
    });
  }
}
