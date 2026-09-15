import { COMPETITORS, COMPETITOR_IDS, type Config } from "../config.js";
import type { CorpusBookkeeping, DiscoveryRecord, Store } from "../db/store.js";
import { createLogger } from "../log.js";
import type {
  CompetitorId,
  DiscoverySource,
  PageKind,
  PageMeta,
  RailwayClaim,
  RailwayPage,
} from "../types.js";
import { extractPage } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { sha1, truncate } from "../util/text.js";
import {
  addDiscoverySource,
  canonicalCorpusUrl,
  classifyCorpusUrl,
  discoverCorpusUrls,
  isGone,
  type Discovery,
} from "./discover.js";
import { fetchRailwayPage } from "./fetch.js";
import { MARKETING_PAGE_URLS } from "./pages.js";

const log = createLogger("railway-corpus");

/** Page text stored per page. Enough to quote from, small enough for a jsonb-heavy table. */
const MAX_STORED_TEXT = 40_000;
const MAX_CLAIMS_PER_PAGE = 12;
const MIN_CLAIM_LENGTH = 60;

/**
 * How many runs in a row a URL may be absent from every discovery source
 * before it leaves the corpus. Two, because one sitemap that lags a deploy is
 * a bad reason to forget a page we can still read.
 */
export const RETIRE_AFTER_MISSING_RUNS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export function detectMentions(text: string): CompetitorId[] {
  const lower = text.toLowerCase();
  return COMPETITOR_IDS.filter((id) =>
    COMPETITORS[id].aliases.some((alias) => lower.includes(alias)),
  );
}

/** Pull out the paragraphs that actually name a competitor, with their heading. */
export function extractClaims(
  url: string,
  blocks: Array<{ heading: string | null; paragraph: string }>,
): RailwayClaim[] {
  const claims: RailwayClaim[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (block.paragraph.length < MIN_CLAIM_LENGTH) continue;
    for (const competitor of detectMentions(block.paragraph)) {
      const key = `${competitor}|${block.paragraph}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({
        url,
        competitor,
        paragraph: truncate(block.paragraph, 1_200),
        heading: block.heading,
      });
    }
  }

  return claims.slice(0, MAX_CLAIMS_PER_PAGE);
}

/**
 * When a page is due another read.
 *
 * Two tiers, because the cost of a stale page is not the same everywhere. A
 * page an analyst read lately is a page recommendations are resting on, so it
 * is kept close to current; the rest of the corpus is there to be searched and
 * a fortnight-old copy answers "does Railway do this at all" just as well.
 * A URL nothing has ever read is due now, whatever tier it would land in.
 */
export function isDue(page: PageMeta, config: Config, now: Date): boolean {
  if (page.contentHash === "") return true;
  const usedRecently =
    page.lastUsedAt !== null &&
    now.getTime() - page.lastUsedAt.getTime() <= config.docsHotRefreshDays * DAY_MS;
  const maxAgeDays = usedRecently ? config.docsHotRefreshDays : config.railwayRefreshDays;
  return now.getTime() - page.fetchedAt.getTime() > maxAgeDays * DAY_MS;
}

export interface RefreshPlan {
  /** URLs the corpus has never held. Always this run: a new page is why we looked. */
  fresh: string[];
  /** Known URLs whose copy is past its tier's age. */
  due: string[];
  /** What was wanted but did not fit inside the fetch budget. */
  deferred: number;
}

/**
 * Decide what to read this run.
 *
 * New URLs lead. A launch is usually the reason a new docs page exists, so the
 * run that first sees the URL is the run that needs its body – the alternative
 * is reasoning about a page we know the name of and nothing else.
 */
export function planRefresh(
  discoveries: Discovery[],
  meta: Map<string, PageMeta>,
  config: Config,
  now: Date,
): RefreshPlan {
  const fresh: string[] = [];
  const due: string[] = [];

  for (const discovery of discoveries) {
    const known = meta.get(discovery.url);
    if (!known) fresh.push(discovery.url);
    else if (isDue(known, config, now)) due.push(discovery.url);
  }

  // Oldest copy first, so a budget that cannot cover the tier still spends
  // itself on the pages furthest from the truth.
  due.sort(
    (a, b) =>
      (meta.get(a)?.fetchedAt.getTime() ?? 0) - (meta.get(b)?.fetchedAt.getTime() ?? 0),
  );

  const wanted = fresh.length + due.length;
  const budget = config.railwayMaxPages;
  const keptFresh = fresh.slice(0, budget);
  const keptDue = due.slice(0, Math.max(0, budget - keptFresh.length));

  return {
    fresh: keptFresh,
    due: keptDue,
    deferred: Math.max(0, wanted - keptFresh.length - keptDue.length),
  };
}

export interface CorpusRefreshResult {
  /** The live corpus this run reasons against: what is stored, plus what it just read. */
  pages: RailwayPage[];
  fetched: number;
  /** Of those, how many came back with a body different from the stored one. */
  changed: number;
  retired: number;
  gone: number;
  discovered: number;
  claims: number;
  notes: string[];
}

interface FetchOutcome {
  page: RailwayPage | null;
  /** Links the page carries, for the crawl input. */
  links: string[];
  /** The page answered 404 or 410, so it is not coming back. */
  gone: boolean;
  changed: boolean;
}

async function readPage(
  config: Config,
  url: string,
  kind: PageKind,
  sources: DiscoverySource[],
  previousHash: string | undefined,
  now: Date,
): Promise<FetchOutcome> {
  try {
    const body = await fetchRailwayPage(config, url);
    const text = truncate(body.text, MAX_STORED_TEXT);
    const contentHash = sha1(text);
    const changed = previousHash !== contentHash;

    return {
      page: {
        url,
        title: body.title,
        text,
        mentions: detectMentions(text),
        kind,
        contentHash,
        fetchedAt: now,
        // A body that hashes the same has not changed, whatever the server
        // said about it. Keeping the old date is what makes "changed lately"
        // mean something the next time this page is ranked or refreshed.
        changedAt: changed ? now : new Date(0),
        discoveredFrom: sources,
        missingStreak: 0,
        lastUsedAt: null,
        retiredAt: null,
      },
      links: body.links,
      gone: false,
      changed,
    };
  } catch (error) {
    if (isGone(error)) {
      log.info(`${url} is gone (${error instanceof Error ? error.message : error})`);
      return { page: null, links: [], gone: true, changed: false };
    }
    log.warn(`could not read ${url}`, error instanceof Error ? error.message : error);
    return { page: null, links: [], gone: false, changed: false };
  }
}

/**
 * Refresh the corpus: discover what Railway publishes, read what is new or
 * stale, and retire what has gone.
 *
 * The `pages` table is the source of truth this produces. Everything
 * downstream – the workspace the analyst searches, the excerpts pre-loaded
 * into its prompt, and the coverage gate that decides whether a gap claim was
 * ever checked – reads the corpus and nothing else.
 */
export async function refreshDocsCorpus(
  config: Config,
  store: Store,
  now = new Date(),
): Promise<CorpusRefreshResult> {
  const result: CorpusRefreshResult = {
    pages: [],
    fetched: 0,
    changed: 0,
    retired: 0,
    gone: 0,
    discovered: 0,
    claims: 0,
    notes: [],
  };

  if (config.skipRailwayIndex) {
    log.info("skipping the corpus refresh (SKIP_RAILWAY_INDEX)");
    result.pages = await store.loadCorpus();
    result.notes.push(`corpus: refresh skipped, reasoning against ${result.pages.length} stored pages`);
    return result;
  }

  const meta = new Map((await store.listPageMeta()).map((page) => [page.url, page]));
  const seeded = await seedFromLlmsFull(config, store, meta, now);
  if (seeded > 0) result.notes.push(`corpus: seeded ${seeded} pages from llms-full.txt`);

  const discovery = await discoverCorpusUrls(config);
  result.notes.push(...discovery.notes);
  let discoveries = discovery.discoveries;

  const plan = planRefresh(discoveries, meta, config, now);
  log.info(
    `corpus: ${discoveries.length} urls discovered, ${meta.size} held, reading ${plan.fresh.length} new and ${plan.due.length} due${plan.deferred > 0 ? ` (${plan.deferred} deferred past the budget)` : ""}`,
  );

  const kinds = new Map(discoveries.map((entry) => [entry.url, entry]));
  const readThisRun = new Map<string, RailwayPage>();
  const gone: string[] = [];
  const crawled: string[] = [];

  const read = async (urls: string[]): Promise<void> => {
    for (const url of urls) {
      const entry = kinds.get(url);
      if (!entry || readThisRun.has(url)) continue;
      const outcome = await readPage(
        config,
        url,
        entry.kind,
        entry.sources,
        meta.get(url)?.contentHash,
        now,
      );
      crawled.push(...outcome.links);
      if (outcome.gone) {
        gone.push(url);
        continue;
      }
      if (!outcome.page) continue;
      readThisRun.set(url, outcome.page);
      result.fetched += 1;
      if (outcome.changed) result.changed += 1;
      await store.savePage(outcome.page).catch((error: unknown) => {
        log.warn(`could not store ${url}`, error instanceof Error ? error.message : error);
      });
    }
  };

  await read([...plan.fresh, ...plan.due]);

  // The links the pages we just read carry are the third discovery input, and
  // they can only be read after the bodies are. A page reached only from
  // another page's prose gets in on this pass.
  const withCrawl = addDiscoverySource(discoveries, "crawl", crawled);
  const newlyLinked = withCrawl
    .filter((entry) => !meta.has(entry.url) && !readThisRun.has(entry.url) && !gone.includes(entry.url))
    .map((entry) => entry.url);
  if (newlyLinked.length > 0) {
    const room = Math.max(0, config.railwayMaxPages - result.fetched);
    log.info(
      `corpus: ${newlyLinked.length} urls found only as links on pages read this run, reading ${Math.min(room, newlyLinked.length)}`,
    );
    for (const entry of withCrawl) kinds.set(entry.url, entry);
    await read(newlyLinked.slice(0, room));
  }
  discoveries = withCrawl;
  result.discovered = discoveries.length;

  result.claims = await refreshClaims(config, store, readThisRun);

  const bookkeeping = planBookkeeping(discoveries, meta, gone, now);
  result.retired = bookkeeping.retired.length;
  result.gone = gone.length;
  await store.recordCorpusRun(bookkeeping).catch((error: unknown) => {
    log.warn("could not record corpus bookkeeping", error instanceof Error ? error.message : error);
  });

  result.pages = mergeCorpus(await store.loadCorpus(), readThisRun, new Set(bookkeeping.retired));
  log.info(
    `corpus: ${result.pages.length} live pages, read ${result.fetched} (${result.changed} changed), retired ${result.retired}`,
  );
  result.notes.push(
    `corpus: ${result.pages.length} live pages, ${result.fetched} read, ${result.changed} changed, ${result.retired} retired`,
  );
  return result;
}

/**
 * The freshness bookkeeping for a run: which known URLs a source still
 * offers, which it does not, and which have run out of chances.
 */
export function planBookkeeping(
  discoveries: Discovery[],
  meta: Map<string, PageMeta>,
  gone: string[],
  now: Date,
): CorpusBookkeeping {
  const offered = new Map(discoveries.map((entry) => [entry.url, entry.sources]));
  const seen: DiscoveryRecord[] = [];
  const missing: string[] = [];
  const retired = new Set(gone);

  for (const [url, page] of meta) {
    const sources = offered.get(url);
    if (sources) {
      seen.push({ url, sources });
      continue;
    }
    missing.push(url);
    if (page.missingStreak + 1 >= RETIRE_AFTER_MISSING_RUNS) retired.add(url);
  }

  return { seen, missing, retired: [...retired], used: [], at: now };
}

/** The stored corpus with this run's reads layered over it, retirements dropped. */
function mergeCorpus(
  stored: RailwayPage[],
  readThisRun: Map<string, RailwayPage>,
  retired: Set<string>,
): RailwayPage[] {
  const merged = new Map<string, RailwayPage>();
  for (const page of stored) {
    if (!retired.has(page.url)) merged.set(page.url, page);
  }
  // A dry run's writes went nowhere, so the pages it read are layered back on
  // here rather than lost: the run reasons against what it actually fetched.
  for (const [url, page] of readThisRun) merged.set(url, page);
  return [...merged.values()].sort((a, b) => a.url.localeCompare(b.url));
}

/**
 * The heading-tagged paragraphs of a marketing page, which markdown does not
 * give us: a claim carries the section it sits under so an editor can find the
 * line, and that means reading the HTML.
 */
async function refreshClaims(
  config: Config,
  store: Store,
  readThisRun: Map<string, RailwayPage>,
): Promise<number> {
  let claims = 0;

  for (const url of MARKETING_PAGE_URLS) {
    const page = readThisRun.get(canonicalCorpusUrl(url));
    if (!page) continue;

    try {
      const html = await fetchText(url, {
        timeoutMs: config.httpTimeoutMs,
        userAgent: config.userAgent,
        accept: "text/html,application/xhtml+xml",
        attempts: 2,
      });
      const found =
        page.mentions.length > 0 ? extractClaims(page.url, extractPage(html).blocks) : [];
      await store.replaceClaimsForUrl(page.url, found);
      claims += found.length;
    } catch (error) {
      log.warn(`could not read claims off ${url}`, error instanceof Error ? error.message : error);
    }
  }

  return claims;
}

/**
 * Seed an empty corpus from a single file that carries every page's body.
 *
 * Run once, on a corpus with nothing in it, because filling a few hundred
 * pages one request at a time takes days of runs to catch up. After that the
 * file is never read again: it is a vendor's export, which means it is as
 * current as whenever they last generated it, and freshness here is decided by
 * re-downloading a page and hashing what comes back.
 */
async function seedFromLlmsFull(
  config: Config,
  store: Store,
  meta: Map<string, PageMeta>,
  now: Date,
): Promise<number> {
  if (!config.docsLlmsFullTxt || meta.size > 0) return 0;

  let bundle: string;
  try {
    bundle = await fetchText(config.docsLlmsFullTxt, {
      timeoutMs: config.httpTimeoutMs,
      userAgent: config.userAgent,
      accept: "text/plain, */*",
      attempts: 2,
    });
  } catch (error) {
    log.warn(
      `could not seed from ${config.docsLlmsFullTxt}`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }

  const sections = splitLlmsFull(bundle);
  if (sections.length === 0) {
    log.warn(
      `${config.docsLlmsFullTxt} carried no page URLs to anchor its sections on, so the corpus fills a page at a time instead`,
    );
    return 0;
  }

  let seeded = 0;
  for (const section of sections) {
    const kind = classifyCorpusUrl(section.url);
    if (kind === null || section.text.length < MIN_CLAIM_LENGTH) continue;
    const text = truncate(section.text, MAX_STORED_TEXT);
    const page: RailwayPage = {
      url: canonicalCorpusUrl(section.url),
      title: section.title,
      text,
      mentions: detectMentions(text),
      kind,
      contentHash: sha1(text),
      fetchedAt: now,
      changedAt: now,
      discoveredFrom: ["llms"],
      missingStreak: 0,
      lastUsedAt: null,
      retiredAt: null,
    };
    await store.savePage(page).catch(() => undefined);
    const { text: _text, mentions: _mentions, ...seededMeta } = page;
    meta.set(page.url, seededMeta);
    seeded += 1;
  }

  log.info(`corpus: seeded ${seeded} pages from ${config.docsLlmsFullTxt}`);
  return seeded;
}

export interface LlmsFullSection {
  url: string;
  title: string;
  text: string;
}

const SECTION_URL = /^(?:source:\s*)?(https?:\/\/\S+)\s*$/im;

/**
 * Split an `llms-full.txt` into pages.
 *
 * There is no standard for the file, so the only thing worth anchoring on is a
 * line that is a URL and nothing else, which is how every generator so far
 * marks where a page starts. A file that carries none yields nothing, and the
 * caller falls back to reading pages one at a time – which is the honest
 * outcome for a format nobody has specified.
 */
export function splitLlmsFull(bundle: string): LlmsFullSection[] {
  const lines = bundle.split(/\r?\n/);
  const sections: LlmsFullSection[] = [];
  let current: LlmsFullSection | null = null;
  let lastHeading = "";

  for (const line of lines) {
    const urlMatch = SECTION_URL.exec(line.trim());
    if (urlMatch?.[1]) {
      if (current) sections.push(current);
      current = { url: urlMatch[1], title: lastHeading, text: "" };
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      lastHeading = heading[1];
      if (current && !current.title) current.title = heading[1];
    }
    if (current) current.text += `${line.replace(/^\s{0,3}#{1,6}\s+/, "")}\n`;
  }
  if (current) sections.push(current);

  return sections.map((section) => ({
    ...section,
    text: section.text.replace(/\s+/g, " ").trim(),
  }));
}
