import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { extractPage, proseText } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { collapseWhitespace, normalizeUrl, titleFromUrl } from "../util/text.js";

const log = createLogger("railway-fetch");

/** One Railway page as it came off the network. */
export interface FetchedBody {
  title: string;
  text: string;
  /**
   * Absolute URLs this page links to, before any filtering. Discovery reads
   * them to find pages no sitemap and no index file mentions.
   */
  links: string[];
}

/**
 * docs.railway.com serves every page as markdown when `.md` is appended, and
 * markdown is the better read: no nav, no in-page contents list, no cookie
 * banner standing where the page's first real sentence should be.
 */
export function markdownUrlFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "docs.railway.com") return null;
    if (parsed.pathname.endsWith(".md")) return url;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}.md${parsed.search}`;
  } catch {
    return null;
  }
}

interface ParsedMarkdown {
  title: string;
  text: string;
  links: string[];
}

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

/** Every link target in a markdown body, resolved against the page it sits on. */
export function markdownLinks(markdown: string, baseUrl: string): string[] {
  const found: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK)) {
    const target = match[1];
    if (!target || target.startsWith("#")) continue;
    try {
      const resolved = normalizeUrl(new URL(target, baseUrl).toString());
      if (!found.includes(resolved)) found.push(resolved);
    } catch {
      // A link target that is not a URL is a link nobody can follow.
    }
  }
  return found;
}

/**
 * The prose out of a docs markdown file: frontmatter title kept, headings and
 * link syntax flattened, code blocks dropped. A fenced block is a config
 * sample, and quoting one back at a model invites it to reason about YAML
 * instead of about what the product does.
 *
 * Links are read off the source before any of that, because the flattened
 * text is where a page's own map of the docs site goes to die.
 */
export function parseDocMarkdown(markdown: string, baseUrl = ""): ParsedMarkdown {
  let body = markdown;
  let title = "";

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (frontmatter?.[1]) {
    const match = /^title:\s*(.+)$/m.exec(frontmatter[1]);
    title = (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
    body = body.slice(frontmatter[0].length);
  }

  const links = baseUrl ? markdownLinks(body, baseUrl) : [];

  const text = collapseWhitespace(
    body
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>]/g, ""),
  );

  return { title, text, links };
}

/** Every same-document `href` on an HTML page, as absolute URLs. */
function htmlLinks(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    const target = match[1];
    if (!target) continue;
    try {
      const resolved = normalizeUrl(new URL(target, baseUrl).toString());
      if (!found.includes(resolved)) found.push(resolved);
    } catch {
      // Not a URL.
    }
  }
  return found;
}

/**
 * Read one Railway page. Markdown when the docs host offers it, HTML
 * otherwise, which is how railway.com/pricing, the changelog, and anything
 * outside the docs host is read.
 */
export async function fetchRailwayPage(config: Config, url: string): Promise<FetchedBody> {
  const markdownUrl = markdownUrlFor(url);

  if (markdownUrl) {
    try {
      const markdown = await fetchText(markdownUrl, {
        timeoutMs: config.httpTimeoutMs,
        userAgent: config.userAgent,
        accept: "text/markdown, text/plain, */*",
        attempts: 2,
      });
      const parsed = parseDocMarkdown(markdown, url);
      if (parsed.text.length > 0) {
        return {
          title: parsed.title || titleFromUrl(url),
          text: parsed.text,
          links: parsed.links,
        };
      }
    } catch (error) {
      log.debug(`no markdown for ${url}: ${error instanceof Error ? error.message : error}`);
    }
  }

  const html = await fetchText(url, {
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
    accept: "text/html,application/xhtml+xml",
    attempts: 2,
  });
  const extracted = extractPage(html);
  return {
    title: extracted.title || titleFromUrl(url),
    text: proseText(extracted.blocks) || extracted.text,
    links: htmlLinks(html, url),
  };
}
