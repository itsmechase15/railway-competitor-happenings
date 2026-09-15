import type { CompetitorConfig } from "../config.js";
import type { CandidateItem } from "../types.js";
import type { ArticleCard } from "../util/html.js";
import { normalizeUrl, parseDate, titleFromUrl } from "../util/text.js";
import { matchesAnyPrefix, type SitemapEntry } from "./sitemap.js";

/** Paths that are listings or taxonomy pages rather than posts. */
const NON_ARTICLE_SEGMENTS = new Set([
  "page",
  "tag",
  "tags",
  "category",
  "categories",
  "author",
  "authors",
  "feed",
  "feed.rss",
  "rss",
]);

export function isArticleUrl(url: string, prefixes: string[]): boolean {
  if (!matchesAnyPrefix(url, prefixes)) return false;
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    // A bare prefix like /blog is the index, not a post.
    if (segments.length < 2) return false;
    return !segments.some((segment) => NON_ARTICLE_SEGMENTS.has(segment.toLowerCase()));
  } catch {
    return false;
  }
}

export interface BlogCandidateOptions {
  /** Ignore entries last modified before this. */
  since: Date;
  /** Cap on candidates handed to the deduplicator. */
  limit: number;
}

/**
 * Turn sitemap entries into blog candidates. `lastmod` is only a pre-filter to
 * keep the candidate list small: some sites bump it on every site-wide
 * re-render, so novelty is decided by URL dedupe against the `items` table.
 */
export function sitemapEntriesToItems(
  competitor: CompetitorConfig,
  entries: SitemapEntry[],
  options: BlogCandidateOptions,
): CandidateItem[] {
  return entries
    .filter((entry) => isArticleUrl(entry.url, competitor.blogPathPrefixes))
    .filter((entry) => entry.lastModified !== null && entry.lastModified >= options.since)
    .sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0))
    .slice(0, options.limit)
    .map((entry) => {
      const url = normalizeUrl(entry.url);
      return {
        competitor: competitor.id,
        source: "blog" as const,
        externalId: url,
        title: titleFromUrl(url),
        url,
        publishedAt: entry.lastModified,
        raw: {
          discoveredVia: "sitemap",
          lastmod: entry.lastModified?.toISOString() ?? null,
        },
      };
    });
}

/**
 * Turn the cards on a blog index into candidates. A listing that names and
 * dates its own posts is the whole read: the title is the one the post was
 * published under rather than its slug with the hyphens taken out, and the
 * date is there without fetching every post to find out whether it is recent.
 * A card with no date still becomes a candidate, because a missing date is not
 * evidence of staleness.
 */
export function indexCardsToItems(
  competitor: CompetitorConfig,
  cards: ArticleCard[],
  options: Pick<BlogCandidateOptions, "limit">,
): CandidateItem[] {
  const seen = new Set<string>();

  return cards
    .filter((card) => isArticleUrl(card.url, competitor.blogPathPrefixes))
    .map((card) => ({ ...card, url: normalizeUrl(card.url) }))
    .filter((card) => {
      if (seen.has(card.url)) return false;
      seen.add(card.url);
      return true;
    })
    .slice(0, options.limit)
    .map((card) => ({
      competitor: competitor.id,
      source: "blog" as const,
      externalId: card.url,
      title: card.title || titleFromUrl(card.url),
      url: card.url,
      publishedAt: parseDate(card.published),
      raw: {
        discoveredVia: "blog-index",
        ...(card.published ? { indexDate: card.published } : {}),
      },
    }));
}

/**
 * Turn the bare links on a blog index into candidates. Render publishes no
 * sitemap at the root and describes nothing on its index, so the links are the
 * listing: every post URL on it is a candidate, and the `items` table decides
 * which of them is new. There is no date here at all, which is why a null
 * `publishedAt` has to survive the lookback filter – a missing date is not
 * evidence of staleness.
 */
export function indexLinksToItems(
  competitor: CompetitorConfig,
  links: string[],
  options: Pick<BlogCandidateOptions, "limit">,
): CandidateItem[] {
  const seen = new Set<string>();

  return links
    .filter((url) => isArticleUrl(url, competitor.blogPathPrefixes))
    .map((url) => normalizeUrl(url))
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, options.limit)
    .map((url) => ({
      competitor: competitor.id,
      source: "blog" as const,
      externalId: url,
      title: titleFromUrl(url),
      url,
      publishedAt: null,
      raw: { discoveredVia: "blog-index" },
    }));
}
