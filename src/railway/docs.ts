import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { createLogger } from "../log.js";
import type { RailwayDoc, RailwayPage, RecommendedAction, StoredItem } from "../types.js";
import { extractPage, proseText } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { collapseWhitespace, sentences, titleFromUrl, truncate } from "../util/text.js";
import { docUrlsForText, matchProducts, productForDocUrl, productsForAction } from "./products.js";

const log = createLogger("railway-docs");

/** Per-doc excerpt budget. Enough to show what a surface already does. */
const MAX_EXCERPT_CHARS = 900;
/** How many docs may be fetched live when the index does not have them yet. */
const DEFAULT_MAX_FETCHES = 4;
/** Sentences kept beyond the lead, chosen by relevance to the signal. */
const FOCUS_SENTENCES = 4;

/**
 * Docs fetched during this process, so a run whose page writes go nowhere (a
 * dry run, or an unreachable database) fetches each page once rather than once
 * per item.
 */
const fetched = new Map<string, RailwayPage>();

/** Words too common to tell one surface's docs from another's. */
const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "announcing",
  "available",
  "every",
  "from",
  "introducing",
  "new",
  "now",
  "railway",
  "release",
  "shipped",
  "that",
  "their",
  "them",
  "this",
  "which",
  "with",
  "your",
]);

/** The terms an excerpt should be built around: the signal's own vocabulary. */
export function focusTerms(text: string): string[] {
  const fromKeywords = matchProducts(text, 3).flatMap((product) => product.keywords);
  const fromText = text
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
  return [...new Set([...fromKeywords, ...fromText])];
}

/**
 * Cut a docs page down to the part that speaks to this signal. The lead
 * sentence always survives, because it says what the surface is; the rest is
 * picked by how much of the signal's vocabulary it uses.
 */
export function docExcerpt(text: string, terms: string[], maxChars = MAX_EXCERPT_CHARS): string {
  const all = sentences(text);
  if (all.length === 0) return "";

  const lead = all[0] ?? "";
  const scored = all.slice(1).map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const score = terms.reduce((total, term) => (lower.includes(term) ? total + 1 : total), 0);
    return { sentence, index, score };
  });

  const picked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, FOCUS_SENTENCES)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);

  return truncate([lead, ...picked].join(" ").trim(), maxChars);
}

function toDoc(page: Pick<RailwayPage, "url" | "title" | "text">, terms: string[]): RailwayDoc {
  return {
    url: page.url,
    title: page.title || titleFromUrl(page.url),
    excerpt: docExcerpt(page.text, terms),
  };
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
}

/**
 * The prose out of a docs markdown file: frontmatter title kept, headings and
 * link syntax flattened, code blocks dropped. A fenced block is a config
 * sample, and quoting one back at a model invites it to reason about YAML
 * instead of about what the product does.
 */
export function parseDocMarkdown(markdown: string): ParsedMarkdown {
  let body = markdown;
  let title = "";

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (frontmatter?.[1]) {
    const match = /^title:\s*(.+)$/m.exec(frontmatter[1]);
    title = (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
    body = body.slice(frontmatter[0].length);
  }

  const text = collapseWhitespace(
    body
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_`>]/g, ""),
  );

  return { title, text };
}

export interface DocsContextOptions {
  maxProducts?: number;
  maxUrls?: number;
  maxFetches?: number;
}

/**
 * The Railway docs that belong in front of the model for one signal.
 *
 * Reads the index first, and fetches at most a handful of pages the index does
 * not have yet – storing what it fetches, so the next run reads it instead. A
 * fetch that fails costs an excerpt, never the run: an alert with thinner docs
 * context is still an alert, and the prompt tells the model to hold back on
 * gap claims it cannot verify.
 */
export async function gatherDocsContext(
  config: Config,
  store: Store,
  item: Pick<StoredItem, "title" | "raw">,
  options: DocsContextOptions = {},
): Promise<RailwayDoc[]> {
  const text = signalText(item);
  const urls = docUrlsForText(text, options);
  if (urls.length === 0) return [];

  const terms = focusTerms(text);
  const indexed = new Map((await store.getPages(urls)).map((page) => [page.url, page]));
  const docs: RailwayDoc[] = [];
  let fetches = 0;
  const maxFetches = options.maxFetches ?? DEFAULT_MAX_FETCHES;

  for (const url of urls) {
    const page = indexed.get(url) ?? fetched.get(url);
    if (page && page.text.trim().length > 0) {
      docs.push(toDoc(page, terms));
      continue;
    }

    if (fetches >= maxFetches) continue;
    fetches += 1;
    const live = await fetchDoc(config, store, url);
    if (live) docs.push(toDoc(live, terms));
  }

  log.info(
    `docs context for "${item.title}": ${docs.length} of ${urls.length} pages (${fetches} fetched live)`,
  );
  return docs;
}

/** How many overview pages the top-up may fetch for one verdict. */
const MAX_TOP_UP_FETCHES = 2;

/**
 * The overview pages for surfaces a verdict names but the signal's own words
 * never matched.
 *
 * A signal about dedicated IPs pulls the outbound networking docs, and then
 * the model writes about a surface one step to the side of them. Whatever it
 * named, the catalog knows where that surface is documented, and an action
 * verified against no page at all is the one that ships "Railway has no X"
 * when Railway has X.
 */
export async function topUpDocsForActions(
  config: Config,
  store: Store,
  item: Pick<StoredItem, "title" | "raw">,
  actions: RecommendedAction[],
  docs: RailwayDoc[],
): Promise<RailwayDoc[]> {
  const covered = new Set(
    docs
      .map((doc) => productForDocUrl(doc.url)?.label)
      .filter((label): label is string => Boolean(label)),
  );
  const wanted: string[] = [];
  for (const action of actions) {
    for (const product of productsForAction(action)) {
      const url = product.docs[0];
      if (!url || covered.has(product.label) || wanted.includes(url)) continue;
      wanted.push(url);
    }
  }
  if (wanted.length === 0) return docs;

  const terms = focusTerms(signalText(item));
  const added: RailwayDoc[] = [];
  const indexed = new Map(
    (await store.getPages(wanted).catch(() => [])).map((page) => [page.url, page]),
  );
  let fetches = 0;

  for (const url of wanted) {
    const page = indexed.get(url) ?? fetched.get(url);
    if (page && page.text.trim().length > 0) {
      added.push(toDoc(page, terms));
      continue;
    }
    if (fetches >= MAX_TOP_UP_FETCHES) continue;
    fetches += 1;
    const live = await fetchDoc(config, store, url);
    if (live) added.push(toDoc(live, terms));
  }

  if (added.length > 0) {
    log.info(
      `topped up docs context with ${added.map((doc) => doc.url).join(", ")} for surfaces the verdict named`,
    );
  }
  return [...docs, ...added];
}

/**
 * Read one Railway page. Markdown when the docs host offers it, HTML
 * otherwise, which is how railway.com/pricing and anything outside the docs
 * host is read.
 */
export async function fetchRailwayPage(config: Config, url: string): Promise<RailwayPage> {
  const markdownUrl = markdownUrlFor(url);

  if (markdownUrl) {
    try {
      const markdown = await fetchText(markdownUrl, {
        timeoutMs: config.httpTimeoutMs,
        userAgent: config.userAgent,
        accept: "text/markdown, text/plain, */*",
        attempts: 2,
      });
      const parsed = parseDocMarkdown(markdown);
      if (parsed.text.length > 0) {
        return {
          url,
          title: parsed.title || titleFromUrl(url),
          text: parsed.text,
          mentions: [],
          fetchedAt: new Date(),
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
    url,
    title: extracted.title || titleFromUrl(url),
    text: proseText(extracted.blocks) || extracted.text,
    mentions: [],
    fetchedAt: new Date(),
  };
}

async function fetchDoc(config: Config, store: Store, url: string): Promise<RailwayPage | null> {
  try {
    const page = await fetchRailwayPage(config, url);
    fetched.set(url, page);
    // Written back so this is a one-off cost per page, not a per-run one.
    await store.upsertPage(page).catch((error: unknown) => {
      log.warn(`could not store ${url}`, error instanceof Error ? error.message : error);
    });
    return page;
  } catch (error) {
    log.warn(`could not fetch ${url}`, error instanceof Error ? error.message : error);
    return null;
  }
}

function signalText(item: Pick<StoredItem, "title" | "raw">): string {
  const raw = item.raw as Record<string, unknown>;
  const parts = [item.title, raw.description, raw.body ?? raw.preview ?? raw.text].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return parts.join("\n\n");
}
