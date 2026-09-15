import { COMPETITORS, COMPETITOR_IDS, type CompetitorConfig, type Config } from "../config.js";
import { createLogger } from "../log.js";
import type { CandidateItem, CompetitorId, SourceId } from "../types.js";
import { type ArticleCard, extractArticleCards, extractLinks } from "../util/html.js";
import { fetchJson, fetchText } from "../util/http.js";
import { daysAgo, normalizeUrl } from "../util/text.js";
import { indexCardsToItems, indexLinksToItems, sitemapEntriesToItems } from "./blog.js";
import { feedEntriesToItems, parseFeed } from "./rss.js";
import { parseSitemap, type SitemapEntry } from "./sitemap.js";
import {
  postsToItems,
  timelineUrl,
  userLookupUrl,
  type XTimelineResponse,
  type XUserResponse,
} from "./x.js";

const log = createLogger("sources");

/** Candidates handed to the deduplicator per competitor+source, before caps. */
const CANDIDATE_LIMIT = 200;
/** How many child sitemaps to follow from a sitemap index. */
const MAX_CHILD_SITEMAPS = 4;
const X_POSTS_PER_ACCOUNT = 10;

export interface CollectionResult {
  candidates: CandidateItem[];
  /** Per-source notes surfaced in the run summary, e.g. why X was skipped. */
  notes: string[];
}

function http(config: Config) {
  return { timeoutMs: config.httpTimeoutMs, userAgent: config.userAgent };
}

async function collectChangelog(
  config: Config,
  competitor: CompetitorConfig,
  feed: string,
): Promise<CandidateItem[]> {
  const xml = await fetchText(feed, {
    ...http(config),
    accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
  });
  const entries = parseFeed(xml);
  log.info(`${competitor.label} changelog: ${entries.length} feed entries`);
  return feedEntriesToItems(competitor, feed, entries).slice(0, CANDIDATE_LIMIT);
}

async function readSitemap(config: Config, url: string): Promise<SitemapEntry[]> {
  const xml = await fetchText(url, { ...http(config), accept: "application/xml, text/xml, */*" });
  const parsed = parseSitemap(xml);
  if (parsed.entries.length > 0 || parsed.children.length === 0) return parsed.entries;

  const entries: SitemapEntry[] = [];
  for (const child of parsed.children.slice(0, MAX_CHILD_SITEMAPS)) {
    try {
      const childXml = await fetchText(child, {
        ...http(config),
        accept: "application/xml, text/xml, */*",
      });
      entries.push(...parseSitemap(childXml).entries);
    } catch (error) {
      log.warn(`failed to read child sitemap ${child}`, error);
    }
  }
  return entries;
}

/**
 * Blog posts, however this competitor publishes them. A sitemap with dates on
 * it is the cheapest read, so it wins where there is one. Otherwise the blog
 * index is the listing and dedupe against `items` is the diff: Vercel
 * describes each post on it, so those candidates arrive with a real title and
 * a real date, and Render publishes bare links, so its candidates arrive with
 * neither and `enrichArticles` fills them in.
 */
async function collectBlog(config: Config, competitor: CompetitorConfig): Promise<CandidateItem[]> {
  if (competitor.sitemaps.length > 0) {
    const entries: SitemapEntry[] = [];
    for (const sitemap of competitor.sitemaps) {
      entries.push(...(await readSitemap(config, sitemap)));
    }
    const items = sitemapEntriesToItems(competitor, entries, {
      since: daysAgo(config.lookbackDays),
      limit: CANDIDATE_LIMIT,
    });
    log.info(
      `${competitor.label} blog: ${entries.length} sitemap URLs, ${items.length} recent candidates`,
    );
    return items;
  }

  const cards: ArticleCard[] = [];
  const links: string[] = [];
  for (const index of competitor.blogIndexes) {
    const html = await fetchText(index, {
      ...http(config),
      accept: "text/html,application/xhtml+xml",
    });
    cards.push(...extractArticleCards(html, index, competitor.blogPathPrefixes));
    links.push(...extractLinks(html, index, competitor.blogPathPrefixes));
  }

  const described = indexCardsToItems(competitor, cards, { limit: CANDIDATE_LIMIT });
  const known = new Set(described.map((item) => item.url));
  const bare = indexLinksToItems(
    competitor,
    links.filter((link) => !known.has(normalizeUrl(link))),
    { limit: CANDIDATE_LIMIT - described.length },
  );

  const items = [...described, ...bare];
  log.info(
    `${competitor.label} blog: ${links.length} index links, ${described.length} described, ${items.length} candidates`,
  );
  return items;
}

async function collectX(config: Config, competitor: CompetitorConfig): Promise<CandidateItem[]> {
  const token = config.xBearerToken;
  if (!token) throw new Error("unreachable: X collection requires a bearer token");

  const headers = { authorization: `Bearer ${token}` };
  const user = await fetchJson<XUserResponse>(userLookupUrl(competitor.xUsername), {
    ...http(config),
    headers,
  });
  if (!user.data) {
    throw new Error(
      `X user lookup for @${competitor.xUsername} returned no data: ${JSON.stringify(user.errors ?? [])}`,
    );
  }

  const timeline = await fetchJson<XTimelineResponse>(
    timelineUrl(user.data.id, X_POSTS_PER_ACCOUNT),
    { ...http(config), headers },
  );
  const posts = timeline.data ?? [];
  log.info(`${competitor.label} X: ${posts.length} recent posts from @${competitor.xUsername}`);
  return postsToItems(competitor, posts, competitor.xUsername, timeline.includes?.media ?? []);
}

/**
 * Run every configured fetcher. A source that fails or is unconfigured is
 * logged and skipped – one broken feed must never take down the daily run.
 */
export async function collectCandidates(config: Config): Promise<CollectionResult> {
  const candidates: CandidateItem[] = [];
  const notes: string[] = [];

  const run = async (label: string, task: () => Promise<CandidateItem[]>): Promise<void> => {
    try {
      candidates.push(...(await task()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`source ${label} failed: ${message}`);
      notes.push(`${label}: failed (${message})`);
    }
  };

  for (const id of COMPETITOR_IDS) {
    const competitor = COMPETITORS[id];
    // A competitor with no changelog feed is not a broken source: Vercel is
    // read from its blog and nothing else, so there is nothing to note.
    const feed = competitor.changelogFeed;
    if (feed) await run(`${id}/changelog`, () => collectChangelog(config, competitor, feed));
    await run(`${id}/blog`, () => collectBlog(config, competitor));

    if (config.xBearerToken) {
      await run(`${id}/x`, () => collectX(config, competitor));
    }
  }

  if (!config.xBearerToken) {
    const note = "X: skipped, X_BEARER_TOKEN is not set";
    log.warn(note);
    notes.push(note);
  }

  // Newsletters are phase 2: the inbox they arrive in does not exist yet, and
  // a source with no inbox behind it would only ever log that it was skipped.
  return { candidates, notes };
}

export interface SourceGroup {
  competitor: CompetitorId;
  source: SourceId;
  items: CandidateItem[];
}

export function groupBySourceKey(items: CandidateItem[]): Map<string, SourceGroup> {
  const groups = new Map<string, SourceGroup>();
  for (const item of items) {
    const key = `${item.competitor}|${item.source}`;
    const group = groups.get(key) ?? {
      competitor: item.competitor,
      source: item.source,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  return groups;
}
