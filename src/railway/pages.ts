/**
 * Which Railway pages this bot may ask someone to edit.
 *
 * `update_pages` is marketing's work: the compare pages, the migrate pages,
 * pricing, and the features pages. Railway's product docs are a different
 * thing entirely. They are the evidence an alert is checked against – what
 * Railway ships today – and a docs page is only ever wrong in the sense that
 * the product changed, which is not something a competitor's launch tells us.
 *
 * So a product docs URL is never a page target. A model that cites one has
 * cited its own evidence as the thing to fix, and sending marketing to edit
 * the Serverless docs because Render shipped scale-to-zero is work nobody
 * asked for.
 *
 * The awkward part is that Railway's compare and migrate pages live on
 * docs.railway.com too, so the rule cannot be "docs host bad, marketing host
 * good". It is an explicit path allowlist instead.
 */

/** The compare and migrate pages for the two competitors this bot watches. */
export const COMPARE_AND_MIGRATE_PATHS = [
  "/platform/compare-to-render",
  "/platform/compare-to-vercel",
  "/platform/migrate-from-render",
  "/platform/migrate-from-vercel",
] as const;

/** Paths on railway.com a page action may target when the launch is about them. */
const RAILWAY_COM_ALLOWED_PREFIXES = ["/pricing", "/features"];

const DOCS_HOSTS = new Set(["docs.railway.com", "docs.railway.app"]);
const SITE_HOSTS = new Set(["railway.com", "www.railway.com", "railway.app", "www.railway.app"]);

interface ParsedUrl {
  host: string;
  path: string;
}

function parse(url: string): ParsedUrl | null {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    return { host: hostname.toLowerCase(), path };
  } catch {
    return null;
  }
}

function underPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * A page that says what Railway ships. Everything on the docs host except the
 * compare and migrate pages, which are sales copy that happens to be hosted
 * there.
 */
export function isDocsUrl(url: string): boolean {
  const parsed = parse(url);
  if (parsed === null || !DOCS_HOSTS.has(parsed.host)) return false;
  return !underPrefix(parsed.path, COMPARE_AND_MIGRATE_PATHS);
}

/**
 * A page an `update_pages` action may name. The four compare and migrate
 * pages, plus pricing and the features pages on railway.com. Nothing else,
 * and never a product docs page.
 */
export function isMarketingTarget(url: string): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  if (DOCS_HOSTS.has(parsed.host)) return underPrefix(parsed.path, COMPARE_AND_MIGRATE_PATHS);
  if (SITE_HOSTS.has(parsed.host)) return underPrefix(parsed.path, RAILWAY_COM_ALLOWED_PREFIXES);
  return false;
}

/** The compare and migrate pages as absolute URLs, for the index and the prompt. */
export const MARKETING_PAGE_URLS: string[] = [
  ...COMPARE_AND_MIGRATE_PATHS.map((path) => `https://docs.railway.com${path}`),
  "https://railway.com/pricing",
];
