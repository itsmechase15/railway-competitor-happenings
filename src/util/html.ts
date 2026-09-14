import * as cheerio from "cheerio";
import { collapseWhitespace, normalizeUrl } from "./text.js";

const NON_CONTENT = "script, style, noscript, template, svg, iframe, nav, footer, header, form";

export interface ExtractedPage {
  title: string;
  /** The page's own summary, when it declares one. Usually cleaner than the first paragraph. */
  description: string;
  /** What the page declares as its publish date, verbatim. Empty when it declares none. */
  published: string;
  /** Readable body text with the chrome removed. */
  text: string;
  /** Body paragraphs, each tagged with the nearest preceding heading. */
  blocks: Array<{ heading: string | null; paragraph: string }>;
}

/** Meta tags a blog uses to say when a post went out, best first. */
const PUBLISHED_SELECTORS = [
  "meta[property='article:published_time']",
  "meta[property='og:article:published_time']",
  "meta[itemprop='datePublished']",
  "meta[name='publish_date']",
  "meta[name='date']",
];

function pickRoot($: cheerio.CheerioAPI): cheerio.Cheerio<never> {
  for (const selector of ["main", "article", "[role=main]", "body"]) {
    const found = $(selector).first();
    if (found.length > 0) return found as unknown as cheerio.Cheerio<never>;
  }
  return $.root() as unknown as cheerio.Cheerio<never>;
}

/** Strip an HTML document down to a title, readable text, and heading-tagged paragraphs. */
export function extractPage(html: string): ExtractedPage {
  const $ = cheerio.load(html);
  $(NON_CONTENT).remove();

  const title = collapseWhitespace(
    $("meta[property='og:title']").attr("content") ?? $("title").first().text() ?? "",
  );
  const description = collapseWhitespace(
    $("meta[property='og:description']").attr("content") ??
      $("meta[name='description']").attr("content") ??
      "",
  );

  let published = "";
  for (const selector of PUBLISHED_SELECTORS) {
    published = collapseWhitespace($(selector).first().attr("content") ?? "");
    if (published) break;
  }
  if (!published) {
    published = collapseWhitespace($("time[datetime]").first().attr("datetime") ?? "");
  }

  const root = $(pickRoot($));
  const blocks: ExtractedPage["blocks"] = [];
  let heading: string | null = null;

  root.find("h1, h2, h3, h4, p, li, blockquote").each((_, element) => {
    const node = $(element);
    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? "";
    const text = collapseWhitespace(node.text());
    if (!text) return;

    if (tag.startsWith("h")) {
      heading = text;
      return;
    }
    // One-word list items are almost always nav leftovers, not claims.
    if (text.split(" ").length < 4) return;
    blocks.push({ heading, paragraph: text });
  });

  const text = collapseWhitespace(
    blocks.length > 0 ? blocks.map((block) => block.paragraph).join("\n\n") : root.text(),
  );

  return { title, description, published, text, blocks };
}

/**
 * A block that reads as a sentence rather than a link in an in-page contents
 * list. Docs pages open with a stack of section links, and glued together by
 * whitespace collapsing they read as one long fragment that says nothing.
 */
function isProse(paragraph: string): boolean {
  return /[.!?]["')\]]?$/.test(paragraph) && paragraph.split(" ").length >= 6;
}

/**
 * The page's prose, with its contents list dropped. Stored for the pages that
 * are quoted back to a model, where a run of section titles is noise standing
 * where the page's first real sentence should be.
 */
export function proseText(blocks: ExtractedPage["blocks"]): string {
  const prose = blocks.map((block) => block.paragraph).filter(isProse);
  return collapseWhitespace(prose.join(" "));
}

/** Social-preview tags first: a page's og:image is the picture it chose for itself. */
const META_IMAGE_SELECTORS = [
  "meta[property='og:image:secure_url']",
  "meta[property='og:image']",
  "meta[property='og:image:url']",
  "meta[name='twitter:image']",
  "meta[name='twitter:image:src']",
  "meta[itemprop='image']",
];

/** Sprites, avatars, and tracking pixels are images, but they are not the feature. */
const DECORATIVE_IMAGE =
  /(logo|icon|favicon|sprite|avatar|profile_image|badge|spacer|placeholder|pixel|1x1|blank|loading|emoji|social-share)/i;

function absolute(src: string, baseUrl: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("data:")) return null;
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The largest candidate in a `srcset`, which is usually the last entry. */
function widestFromSrcset(srcset: string): string | undefined {
  const entries = srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .filter((parts) => parts[0])
    .map((parts) => ({
      url: parts[0] as string,
      width: Number.parseInt(parts[1]?.replace(/\D/g, "") ?? "0", 10) || 0,
    }));
  if (entries.length === 0) return undefined;
  return entries.sort((a, b) => b.width - a.width)[0]?.url;
}

/**
 * Every image on a page that could plausibly show the feature, best first:
 * the page's own social preview, then in-content images with the obvious
 * chrome filtered out. SVGs are skipped because Discord will not render them
 * in an embed.
 */
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];

  const add = (raw: string | undefined): void => {
    if (!raw) return;
    const url = absolute(raw, baseUrl);
    if (!url || url.toLowerCase().split("?")[0]?.endsWith(".svg")) return;
    if (!found.includes(url)) found.push(url);
  };

  for (const selector of META_IMAGE_SELECTORS) {
    add($(selector).first().attr("content"));
  }
  add($("link[rel='image_src']").first().attr("href"));

  $("script, style, noscript, nav, footer, header").remove();
  const root = $(pickRoot($));

  root.find("img, source").each((_, element) => {
    const node = $(element);
    const src = node.attr("src") ?? widestFromSrcset(node.attr("srcset") ?? "");
    if (!src || DECORATIVE_IMAGE.test(src)) return;
    // Explicitly tiny images are decoration whatever they are named.
    const width = Number.parseInt(node.attr("width") ?? "0", 10);
    if (width > 0 && width < 200) return;
    add(src);
  });

  return found;
}

/** Blocks whose end is a sentence boundary once the tags are gone. */
const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|td|th|blockquote|section|article|pre)>/gi;

/**
 * Convert a feed entry's markup into plain text. The block boundaries become
 * spaces first: reading the text straight off the tree glues the end of one
 * paragraph to the start of the next, and "property.The additional space"
 * is one sentence to every sentence splitter that reads it afterwards.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html.replace(BLOCK_END, "$& "));
  $(NON_CONTENT).remove();
  return collapseWhitespace($.root().text());
}

/**
 * Every same-origin link on a page whose path starts with one of `prefixes`,
 * deduplicated and normalized. This is how a blog with no sitemap is read:
 * the index is the listing, and novelty comes from diffing these URLs against
 * the `items` table rather than from a `lastmod` nobody publishes.
 */
export function extractLinks(html: string, baseUrl: string, prefixes: string[]): string[] {
  const $ = cheerio.load(html);
  const origin = new URL(baseUrl).origin;
  const found: string[] = [];

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (url.origin !== origin) return;
    if (!prefixes.some((prefix) => url.pathname.startsWith(prefix))) return;
    const normalized = normalizeUrl(url.toString());
    if (!found.includes(normalized)) found.push(normalized);
  });

  return found;
}
