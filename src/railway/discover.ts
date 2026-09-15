import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { parseSitemap } from "../sources/sitemap.js";
import type { DiscoverySource, PageKind } from "../types.js";
import { extractLinks } from "../util/html.js";
import { fetchText, HttpError } from "../util/http.js";
import { normalizeUrl } from "../util/text.js";
import { COMPARE_AND_MIGRATE_PATHS, MARKETING_PAGE_URLS } from "./pages.js";
import { CANONICAL_DOC_URLS } from "./products.js";

const log = createLogger("railway-discover");

const DOCS_HOSTS = new Set(["docs.railway.com", "docs.railway.app"]);
const SITE_HOSTS = new Set(["railway.com", "www.railway.com", "railway.app", "www.railway.app"]);

/**
 * Railway publishes a compare page per competitor and a migrate guide per
 * platform, and only four of them are pages this bot may ask anyone to edit.
 * All of them are sales copy, though, so all of them are held as copy: an
 * action that read a gap off compare-to-northflank read it off marketing.
 */
const DOCS_MARKETING_PATTERN = /^\/platform\/(compare-to|migrate-from)-/;

/** Paths on railway.com worth holding: the pages an action may edit, and the changelog. */
const SITE_MARKETING_PREFIXES = ["/pricing", "/features"];
const SITE_CHANGELOG_PREFIX = "/changelog";

/** A URL that serves a file rather than a page nobody would quote a sentence from. */
const NOT_A_PAGE = /\.(xml|txt|json|png|jpe?g|gif|svg|webp|ico|css|js|pdf|zip|mp4|webm)$/i;

/**
 * Docs paths that are indexes or machinery rather than prose about the
 * product. A changelog page carries its own label; these carry nothing.
 */
const DOCS_EXCLUDED_PREFIXES = ["/llms", "/search", "/_next", "/api/og"];

function underPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * The canonical form of a corpus URL: no fragment, no query, no trailing
 * slash, and no `.md` suffix. The docs host serves `/x` and `/x.md` as the
 * same page, and storing both would double the corpus and split its history.
 */
export function canonicalCorpusUrl(raw: string): string {
  const normalized = normalizeUrl(raw);
  try {
    const url = new URL(normalized);
    url.search = "";
    url.hash = "";
    if (url.pathname.endsWith(".md")) url.pathname = url.pathname.slice(0, -3);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return normalized;
  }
}

/**
 * What a URL is worth holding as, or null when it is not corpus material.
 *
 * This is the one place that decides what "the docs" means, and it is
 * deliberately wider than the catalog: the corpus is every page Railway
 * publishes about the product, and the catalog is a route into it.
 */
export function classifyCorpusUrl(raw: string): PageKind | null {
  let url: URL;
  try {
    url = new URL(canonicalCorpusUrl(raw));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (NOT_A_PAGE.test(url.pathname)) return null;

  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (DOCS_HOSTS.has(host)) {
    if (underPrefix(path, COMPARE_AND_MIGRATE_PATHS) || DOCS_MARKETING_PATTERN.test(path)) {
      return "marketing";
    }
    if (underPrefix(path, DOCS_EXCLUDED_PREFIXES)) return null;
    if (path === "/") return null;
    return "docs";
  }

  if (SITE_HOSTS.has(host)) {
    if (underPrefix(path, [SITE_CHANGELOG_PREFIX])) return "changelog";
    if (underPrefix(path, SITE_MARKETING_PREFIXES)) return "marketing";
  }

  return null;
}

/** One discovered URL, with every source that offered it this run. */
export interface Discovery {
  url: string;
  kind: PageKind;
  sources: DiscoverySource[];
}

interface SourceUrls {
  source: DiscoverySource;
  urls: string[];
}

/**
 * Fold the sources into one list, keeping every source that named each URL.
 *
 * The union is the point. No single input is trusted to be complete: a sitemap
 * can lag, `llms.txt` is a curated subset, and a crawl only reaches what
 * something already linked. A URL any of them names is a page we hold.
 */
export function mergeDiscoveries(groups: SourceUrls[]): Discovery[] {
  const found = new Map<string, Discovery>();

  for (const group of groups) {
    for (const raw of group.urls) {
      const kind = classifyCorpusUrl(raw);
      if (kind === null) continue;
      const url = canonicalCorpusUrl(raw);
      const existing = found.get(url);
      if (existing) {
        if (!existing.sources.includes(group.source)) existing.sources.push(group.source);
        continue;
      }
      found.set(url, { url, kind, sources: [group.source] });
    }
  }

  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * Fold one more source into a list already merged. Used for the crawl input,
 * which cannot be collected until the pages it comes off have been read.
 */
export function addDiscoverySource(
  existing: Discovery[],
  source: DiscoverySource,
  urls: string[],
): Discovery[] {
  const found = new Map(
    existing.map((entry) => [entry.url, { ...entry, sources: [...entry.sources] }]),
  );

  for (const raw of urls) {
    const kind = classifyCorpusUrl(raw);
    if (kind === null) continue;
    const url = canonicalCorpusUrl(raw);
    const entry = found.get(url);
    if (!entry) {
      found.set(url, { url, kind, sources: [source] });
      continue;
    }
    if (!entry.sources.includes(source)) entry.sources.push(source);
  }

  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/** Every URL in a sitemap or sitemap index, without following the children. */
export function urlsFromSitemap(xml: string): { urls: string[]; children: string[] } {
  const parsed = parseSitemap(xml);
  return { urls: parsed.entries.map((entry) => entry.url), children: parsed.children };
}

const BARE_URL = /https?:\/\/[^\s)<>"']+/g;
const LLMS_LINK = /\[[^\]]*\]\((https?:\/\/[^)\s]+)/g;

/**
 * The URLs an `llms.txt` lists.
 *
 * It is read as one input and never as the corpus. It is a file the vendor
 * curates for model consumption, which means it is a subset chosen for some
 * other purpose than ours, and a page missing from it is not a page that does
 * not exist. The Amplitude consent miss came from trusting a short list.
 */
export function urlsFromLlmsTxt(text: string): string[] {
  const found: string[] = [];
  const add = (url: string): void => {
    const trimmed = url.replace(/[.,;:]+$/, "");
    if (!found.includes(trimmed)) found.push(trimmed);
  };
  for (const match of text.matchAll(LLMS_LINK)) {
    if (match[1]) add(match[1]);
  }
  for (const match of text.matchAll(BARE_URL)) {
    add(match[0]);
  }
  return found;
}

/** Links on a changelog index that point at its own entries. */
export function changelogEntryUrls(html: string, indexUrl: string): string[] {
  return extractLinks(html, indexUrl, [SITE_CHANGELOG_PREFIX]);
}

export interface DiscoveryResult {
  discoveries: Discovery[];
  /** One line per input, for the run summary. */
  notes: string[];
}

async function text(config: Config, url: string): Promise<string | null> {
  try {
    return await fetchText(url, {
      timeoutMs: config.httpTimeoutMs,
      userAgent: config.userAgent,
      accept: "text/plain, application/xml, text/html, */*",
      attempts: 2,
    });
  } catch (error) {
    log.warn(`could not read ${url}`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** How deep a sitemap index is followed. One level is what vendors publish. */
const MAX_SITEMAP_CHILDREN = 6;

async function fromSitemaps(config: Config, notes: string[]): Promise<string[]> {
  const urls: string[] = [];

  for (const sitemapUrl of config.docsSitemaps) {
    const xml = await text(config, sitemapUrl);
    if (xml === null) {
      notes.push(`sitemap ${sitemapUrl}: unreadable`);
      continue;
    }
    const top = urlsFromSitemap(xml);
    urls.push(...top.urls);

    for (const child of top.children.slice(0, MAX_SITEMAP_CHILDREN)) {
      const childXml = await text(config, child);
      if (childXml === null) continue;
      urls.push(...urlsFromSitemap(childXml).urls);
    }
    notes.push(`sitemap ${sitemapUrl}: ${top.urls.length} urls, ${top.children.length} children`);
  }

  return urls;
}

/**
 * Discover what the corpus should hold, from the union of every input.
 *
 * `knownLinks` are the docs links found on pages already stored, which is how
 * a page reached only from another page's prose gets in. It is passed in
 * rather than crawled here: the refresh already has those bodies, and a crawl
 * of its own would fetch the whole site twice.
 */
export async function discoverCorpusUrls(
  config: Config,
  knownLinks: string[] = [],
): Promise<DiscoveryResult> {
  const notes: string[] = [];

  const sitemapUrls = await fromSitemaps(config, notes);

  const llms = config.docsLlmsTxt ? await text(config, config.docsLlmsTxt) : null;
  const llmsUrls = llms === null ? [] : urlsFromLlmsTxt(llms);
  if (config.docsLlmsTxt) notes.push(`llms.txt: ${llmsUrls.length} urls`);

  const changelogUrls: string[] = [];
  if (config.railwayChangelogIndex) {
    const html = await text(config, config.railwayChangelogIndex);
    if (html !== null) {
      changelogUrls.push(
        config.railwayChangelogIndex,
        ...changelogEntryUrls(html, config.railwayChangelogIndex),
      );
    }
    notes.push(`railway changelog: ${changelogUrls.length} urls`);
  }

  const discoveries = mergeDiscoveries([
    { source: "sitemap", urls: sitemapUrls },
    { source: "llms", urls: llmsUrls },
    { source: "crawl", urls: knownLinks },
    { source: "changelog", urls: changelogUrls },
    // Last, so the catalog only ever adds a source to a URL the real inputs
    // already found. It pins the overview pages the bot routes to; it does not
    // decide what the corpus contains.
    { source: "catalog", urls: [...CANONICAL_DOC_URLS, ...MARKETING_PAGE_URLS] },
  ]);

  log.info(
    `discovery: ${discoveries.length} corpus urls (${discoveries.filter((entry) => entry.kind === "docs").length} docs, ${discoveries.filter((entry) => entry.kind === "marketing").length} marketing, ${discoveries.filter((entry) => entry.kind === "changelog").length} changelog)`,
  );
  return { discoveries, notes };
}

/** A page that is gone rather than merely unreachable. */
export function isGone(error: unknown): boolean {
  return error instanceof HttpError && (error.status === 404 || error.status === 410);
}
