import { XMLParser } from "fast-xml-parser";
import { normalizeUrl, parseDate } from "../util/text.js";

const parser = new XMLParser({ ignoreAttributes: true, trimValues: true });

export interface SitemapEntry {
  url: string;
  lastModified: Date | null;
}

export interface ParsedSitemap {
  /** Child sitemap URLs, when the document is a `<sitemapindex>`. */
  children: string[];
  entries: SitemapEntry[];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function locOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (node && typeof node === "object" && "loc" in node) {
    const loc = (node as { loc?: unknown }).loc;
    if (typeof loc === "string") return loc;
  }
  return "";
}

export function parseSitemap(xml: string): ParsedSitemap {
  const parsed = parser.parse(xml) as Record<string, any>;

  const children = asArray(parsed?.sitemapindex?.sitemap)
    .map(locOf)
    .filter(Boolean)
    .map((url) => normalizeUrl(url));

  const entries = asArray(parsed?.urlset?.url)
    .map((node: unknown): SitemapEntry | null => {
      const loc = locOf(node);
      if (!loc) return null;
      const lastmod =
        node && typeof node === "object" ? (node as { lastmod?: unknown }).lastmod : undefined;
      return { url: normalizeUrl(loc), lastModified: parseDate(lastmod) };
    })
    .filter((entry): entry is SitemapEntry => entry !== null);

  return { children, entries };
}

export function matchesAnyPrefix(url: string, prefixes: string[]): boolean {
  try {
    const { pathname } = new URL(url);
    return prefixes.some((prefix) => pathname.startsWith(prefix));
  } catch {
    return false;
  }
}
