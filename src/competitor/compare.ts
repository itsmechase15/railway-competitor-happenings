import { COMPETITORS, type CompetitorConfig, type Config } from "../config.js";
import { createLogger } from "../log.js";
import type { CompetitorClaim, CompetitorId } from "../types.js";
import { extractPage } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { normalizeUrl, truncate } from "../util/text.js";

const log = createLogger("competitor-pages");

/** What counts as a mention of Railway on someone else's page. */
const RAILWAY_ALIASES = ["railway"];

/** Short lines on these pages are table cells and nav, not claims. */
const MIN_CLAIM_LENGTH = 40;
const MAX_CLAIM_CHARS = 700;
const MAX_CLAIMS_PER_PAGE = 8;
/** Per competitor, so one long page cannot fill the prompt. */
const MAX_CLAIMS_PER_COMPETITOR = 6;

export function mentionsRailway(text: string): boolean {
  const lower = text.toLowerCase();
  return RAILWAY_ALIASES.some((alias) => lower.includes(alias));
}

/**
 * The paragraphs on a competitor page that talk about Railway, with the
 * heading they sit under. A comparison page repeats itself across a feature
 * matrix, so identical paragraphs are kept once.
 */
export function extractRailwayClaims(
  url: string,
  competitor: CompetitorId,
  blocks: Array<{ heading: string | null; paragraph: string }>,
): CompetitorClaim[] {
  const claims: CompetitorClaim[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.paragraph.length < MIN_CLAIM_LENGTH) continue;
    if (!mentionsRailway(block.paragraph)) continue;
    if (seen.has(block.paragraph)) continue;
    seen.add(block.paragraph);
    claims.push({
      url,
      competitor,
      paragraph: truncate(block.paragraph, MAX_CLAIM_CHARS),
      heading: block.heading,
    });
    if (claims.length === MAX_CLAIMS_PER_PAGE) break;
  }

  return claims;
}

async function fetchPageClaims(
  config: Config,
  competitor: CompetitorConfig,
  url: string,
): Promise<CompetitorClaim[]> {
  const html = await fetchText(url, {
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
    accept: "text/html,application/xhtml+xml",
    attempts: 2,
  });
  return extractRailwayClaims(normalizeUrl(url), competitor.id, extractPage(html).blocks);
}

/**
 * Every configured competitor page for one competitor, read for what it says
 * about Railway. A page that fails costs its claims, never the run: an alert
 * with thinner context is still an alert, and the prompt tells the model not
 * to assume what a page it cannot see claims.
 */
export async function fetchCompareClaims(
  config: Config,
  competitor: CompetitorConfig,
): Promise<CompetitorClaim[]> {
  const claims: CompetitorClaim[] = [];

  for (const url of competitor.comparePages) {
    try {
      claims.push(...(await fetchPageClaims(config, competitor, url)));
    } catch (error) {
      log.warn(`could not read ${url}`, error instanceof Error ? error.message : error);
    }
  }

  return claims.slice(0, MAX_CLAIMS_PER_COMPETITOR);
}

export interface CompareIndex {
  claimsFor(competitor: CompetitorId): Promise<CompetitorClaim[]>;
}

/**
 * The competitor pages for a run, fetched once per competitor. Two competitors
 * is two requests a day, so there is nothing to store: the pages are read when
 * the first item for that competitor is analyzed.
 */
export function createCompareIndex(config: Config): CompareIndex {
  const cache = new Map<CompetitorId, Promise<CompetitorClaim[]>>();

  return {
    async claimsFor(competitor: CompetitorId): Promise<CompetitorClaim[]> {
      let pending = cache.get(competitor);
      if (!pending) {
        pending = fetchCompareClaims(config, COMPETITORS[competitor]).then((claims) => {
          log.info(
            `${COMPETITORS[competitor].label}: ${claims.length} claims about Railway from ${COMPETITORS[competitor].comparePages.length} pages`,
          );
          return claims;
        });
        cache.set(competitor, pending);
      }
      return pending;
    },
  };
}
