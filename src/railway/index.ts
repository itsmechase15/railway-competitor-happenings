import { COMPETITORS, COMPETITOR_IDS, type Config } from "../config.js";
import type { Store } from "../db/store.js";
import { createLogger } from "../log.js";
import type { CompetitorId, RailwayClaim, RailwayPage } from "../types.js";
import { extractPage } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { truncate } from "../util/text.js";
import { fetchRailwayPage } from "./docs.js";
import { MARKETING_PAGE_URLS } from "./pages.js";
import { CANONICAL_DOC_URLS } from "./products.js";

const log = createLogger("railway-index");

/** Page text stored per page. Enough for citation, small enough for a jsonb-heavy table. */
const MAX_STORED_TEXT = 40_000;
const MAX_CLAIMS_PER_PAGE = 12;
const MIN_CLAIM_LENGTH = 60;

/**
 * Lower sorts first. The compare and migrate pages lead: they are the only
 * pages an `update_pages` action may target, so a run that can only afford a
 * handful of fetches spends them there. The product docs follow, because they
 * are what a build-or-enhance recommendation is checked against.
 */
export function candidatePriority(url: string): number {
  if (MARKETING_PAGE_URLS.includes(url)) return 0;
  if (CANONICAL_DOC_URLS.includes(url)) return 1;
  return 2;
}

export function detectMentions(text: string): CompetitorId[] {
  const lower = text.toLowerCase();
  return COMPETITOR_IDS.filter((id) =>
    COMPETITORS[id].aliases.some((alias) => lower.includes(alias)),
  );
}

/** Pull out the paragraphs that actually name a competitor, with their heading. */
export function extractClaims(
  url: string,
  blocks: Array<{ heading: string | null; paragraph: string }>,
): RailwayClaim[] {
  const claims: RailwayClaim[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.paragraph.length < MIN_CLAIM_LENGTH) continue;
    for (const competitor of detectMentions(block.paragraph)) {
      const key = `${competitor}|${block.paragraph}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        url,
        competitor,
        paragraph: truncate(block.paragraph, 1_200),
        heading: block.heading,
      });
    }
  }

  return claims.slice(0, MAX_CLAIMS_PER_PAGE);
}

export interface IndexResult {
  fetched: number;
  withMentions: number;
  claims: number;
}

/**
 * Refresh the Railway index: the hand-listed product docs from the catalog,
 * plus the compare, migrate, and pricing pages.
 *
 * Only the marketing pages produce claims. A claim is a sentence about a
 * competitor that an `update_pages` action can cite, and a product docs page
 * that happens to mention Render in a migration note is not a page anyone is
 * being asked to edit.
 */
export async function refreshRailwayIndex(config: Config, store: Store): Promise<IndexResult> {
  const result: IndexResult = { fetched: 0, withMentions: 0, claims: 0 };
  if (config.skipRailwayIndex) {
    log.info("skipping the Railway index (SKIP_RAILWAY_INDEX)");
    return result;
  }

  const candidates = [...new Set([...MARKETING_PAGE_URLS, ...CANONICAL_DOC_URLS])].sort(
    (a, b) => candidatePriority(a) - candidatePriority(b) || a.localeCompare(b),
  );
  const indexed = await store.getIndexedPageUrls();
  const staleBefore = new Date(Date.now() - config.railwayRefreshDays * 24 * 60 * 60 * 1000);

  const neverIndexed: string[] = [];
  const stale: string[] = [];
  for (const url of candidates) {
    const fetchedAt = indexed.get(url);
    if (fetchedAt === undefined) neverIndexed.push(url);
    else if (fetchedAt < staleBefore) stale.push(url);
  }

  // Split the budget so refreshing the compare pages never starves the docs
  // pages we have not looked at yet.
  const refreshBudget = Math.floor(config.railwayMaxPages / 2);
  const refreshing = stale.slice(0, refreshBudget);
  const queue = [
    ...refreshing,
    ...neverIndexed.slice(0, config.railwayMaxPages - refreshing.length),
  ];

  log.info(
    `Railway index: ${candidates.length} pages in the catalog, ${neverIndexed.length} never read, ${stale.length} stale – fetching ${queue.length}`,
  );

  for (const url of queue) {
    try {
      const isMarketing = MARKETING_PAGE_URLS.includes(url);
      const page = await fetchRailwayPage(config, url);
      const mentions = detectMentions(page.text);
      await store.upsertPage({
        ...page,
        text: truncate(page.text, MAX_STORED_TEXT),
        mentions,
      });
      result.fetched += 1;
      if (mentions.length > 0) result.withMentions += 1;

      // Claims only come off the pages an action is allowed to edit.
      if (!isMarketing) continue;
      const claims = mentions.length > 0 ? extractClaims(url, await marketingBlocks(config, url)) : [];
      await store.replaceClaimsForUrl(url, claims);
      result.claims += claims.length;
    } catch (error) {
      log.warn(`failed to index ${url}`, error instanceof Error ? error.message : error);
    }
  }

  log.info(
    `Railway index: read ${result.fetched} pages, ${result.withMentions} mention a competitor, ${result.claims} claims`,
  );
  return result;
}

/**
 * The heading-tagged paragraphs of a marketing page, which markdown does not
 * give us: a claim carries the section it sits under so an editor can find the
 * line, and that means reading the HTML.
 */
async function marketingBlocks(
  config: Config,
  url: string,
): Promise<Array<{ heading: string | null; paragraph: string }>> {
  const html = await fetchText(url, {
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
    accept: "text/html,application/xhtml+xml",
    attempts: 2,
  });
  return extractPage(html).blocks;
}
