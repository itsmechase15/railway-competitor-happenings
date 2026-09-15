import { XMLParser } from "fast-xml-parser";
import type { CompetitorConfig } from "../config.js";
import type { CandidateItem } from "../types.js";
import { extractImageUrls, htmlToText } from "../util/html.js";
import { collapseWhitespace, normalizeUrl, parseDate, sha1, truncate } from "../util/text.js";
import { ENTRY_URL_KEY } from "./link.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
  trimValues: true,
  /**
   * Entry bodies are kept as raw markup rather than parsed into a tree. An
   * Atom `<content type="xhtml">` is real XML, so parsing it hands back nested
   * `div` and `p` nodes with the inline links lifted out of the sentences they
   * sat in: Vercel's feed reads as "Every now includes 64 GB" once the anchor
   * around "sandbox" becomes a sibling of the text. Left as markup, one pass
   * through an HTML reader gets the sentence back.
   */
  stopNodes: ["*.content", "*.summary", "*.description", "*.content:encoded"],
});

/** RSS/Atom nodes arrive as a string, an object, or an array depending on the feed. */
function textOf(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return collapseWhitespace(node);
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    if ("__cdata" in record) return textOf(record.__cdata);
    if ("#text" in record) return textOf(record["#text"]);
    if ("@_href" in record) return textOf(record["@_href"]);
  }
  return "";
}

/**
 * An entry body as markup. A body kept raw by `stopNodes` still arrives with
 * its CDATA wrapper, which is a fact about the XML rather than about the post.
 */
function bodyOf(node: unknown): string {
  return textOf(node)
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export interface FeedEntry {
  title: string;
  link: string;
  /** The link as the feed wrote it, anchor included. */
  entryLink: string;
  guid: string | null;
  publishedAt: Date | null;
  /** Full entry body as plain text, when the feed provides one. */
  body: string;
  /** The entry's own image, if it attached or embedded one. */
  image: string | null;
}

/** An `<enclosure>`, a media extension, or the first real image in the body HTML. */
function imageOf(entry: Record<string, unknown>, bodyHtml: string, link: string): string | null {
  const attached = [
    entry["media:content"],
    entry["media:thumbnail"],
    entry.enclosure,
    entry.image,
  ];
  for (const node of attached) {
    for (const candidate of asArray(node as unknown)) {
      const record = (candidate ?? {}) as Record<string, unknown>;
      const type = textOf(record["@_type"]);
      if (type && !type.startsWith("image/")) continue;
      const url = textOf(record["@_url"]) || textOf(record["@_href"]) || textOf(candidate);
      if (url.startsWith("http")) return url;
    }
  }

  if (!bodyHtml.includes("<")) return null;
  const base = link || "https://example.invalid";
  return extractImageUrls(bodyHtml, base)[0] ?? null;
}

/** Parse an RSS 2.0 or Atom document into a flat list of entries. */
export function parseFeed(xml: string): FeedEntry[] {
  const parsed = parser.parse(xml) as Record<string, any>;
  const channel = parsed?.rss?.channel ?? parsed?.channel;
  const rawEntries = channel ? asArray(channel.item) : asArray(parsed?.feed?.entry);

  return rawEntries
    .map((entry: Record<string, unknown>): FeedEntry => {
      const link = textOf(entry.link);
      const bodyHtml =
        bodyOf(entry["content:encoded"]) ||
        bodyOf(entry.content) ||
        bodyOf(entry.summary) ||
        bodyOf(entry.description);
      const guidNode = entry.guid ?? entry.id;
      const normalizedLink = link ? normalizeUrl(link) : "";
      return {
        title: textOf(entry.title),
        link: normalizedLink,
        entryLink: link ? normalizeUrl(link, { keepFragment: true }) : "",
        guid: textOf(guidNode) || null,
        publishedAt: parseDate(
          textOf(entry.pubDate) || textOf(entry.published) || textOf(entry.updated),
        ),
        body: bodyHtml.includes("<") ? htmlToText(bodyHtml) : collapseWhitespace(bodyHtml),
        image: imageOf(entry, bodyHtml, normalizedLink),
      };
    })
    .filter((entry) => entry.title !== "" || entry.link !== "");
}

/**
 * A changelog entry's identity. Prefers the feed's own guid; falls back to a
 * hash so entries without one (or with a reused link + anchor) still dedupe.
 */
export function changelogExternalId(entry: FeedEntry): string {
  if (entry.guid) return entry.guid;
  if (entry.link) return entry.link;
  return sha1(`${entry.title}|${entry.publishedAt?.toISOString() ?? ""}`);
}

/** `feed` is passed rather than read off the competitor: not every one has one. */
export function feedEntriesToItems(
  competitor: CompetitorConfig,
  feed: string,
  entries: FeedEntry[],
): CandidateItem[] {
  return entries.map((entry) => ({
    competitor: competitor.id,
    source: "changelog" as const,
    externalId: changelogExternalId(entry),
    title: entry.title || competitor.label,
    url: entry.link || feed,
    publishedAt: entry.publishedAt,
    raw: {
      feed,
      guid: entry.guid,
      body: truncate(entry.body, 8_000),
      image: entry.image,
      // Only when it says something the url no longer does, i.e. an anchor.
      ...(entry.entryLink && entry.entryLink !== entry.link
        ? { [ENTRY_URL_KEY]: entry.entryLink }
        : {}),
    },
  }));
}
