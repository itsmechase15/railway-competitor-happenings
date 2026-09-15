import { describe, expect, it } from "vitest";
import {
  isDue,
  planBookkeeping,
  planRefresh,
  RETIRE_AFTER_MISSING_RUNS,
  splitLlmsFull,
} from "../src/railway/corpus.js";
import {
  addDiscoverySource,
  canonicalCorpusUrl,
  changelogEntryUrls,
  classifyCorpusUrl,
  mergeDiscoveries,
  urlsFromLlmsTxt,
  urlsFromSitemap,
} from "../src/railway/discover.js";
import { CANONICAL_DOC_URLS, CATALOG_OVERVIEW_URLS } from "../src/railway/products.js";
import type { Config } from "../src/config.js";
import type { PageMeta } from "../src/types.js";
import { corpusPage } from "./helpers.js";

/**
 * The corpus is what every recommendation is checked against, so what counts
 * as part of it is the most load-bearing decision in the bot. A page wrongly
 * left out is a gap claim nobody can contradict; a page wrongly let in is
 * marketing copy quoted as if it were the product.
 */
describe("what belongs in the corpus", () => {
  it("holds a docs page as product documentation", () => {
    expect(classifyCorpusUrl("https://docs.railway.com/deployments/scaling")).toBe("docs");
  });

  it("holds the compare and migrate pages as copy, not as docs", () => {
    expect(classifyCorpusUrl("https://docs.railway.com/platform/compare-to-render")).toBe(
      "marketing",
    );
    expect(classifyCorpusUrl("https://railway.com/pricing")).toBe("marketing");
  });

  /**
   * Railway publishes a compare page per competitor, and only four of them are
   * pages this bot may ask anyone to edit. Every one of them is sales copy,
   * so every one of them is held as copy: a gap read off compare-to-northflank
   * is a gap read off marketing.
   */
  it("holds a compare page for a competitor this bot does not watch as copy too", () => {
    expect(classifyCorpusUrl("https://docs.railway.com/platform/compare-to-northflank")).toBe(
      "marketing",
    );
    expect(classifyCorpusUrl("https://docs.railway.com/platform/migrate-from-heroku")).toBe(
      "marketing",
    );
    expect(classifyCorpusUrl("https://docs.railway.com/platform/railway-metal")).toBe("docs");
  });

  it("holds Railway's own changelog, which is its own kind of evidence", () => {
    expect(classifyCorpusUrl("https://railway.com/changelog/2026-09-01")).toBe("changelog");
    expect(classifyCorpusUrl("https://railway.com/changelog")).toBe("changelog");
  });

  it("refuses somebody else's site, a file, and nonsense", () => {
    expect(classifyCorpusUrl("https://render.com/docs/migrate-from-railway")).toBeNull();
    expect(classifyCorpusUrl("https://docs.railway.com/sitemap.xml")).toBeNull();
    expect(classifyCorpusUrl("https://docs.railway.com/llms.txt")).toBeNull();
    expect(classifyCorpusUrl("not a url")).toBeNull();
  });

  it("reads a page and its markdown twin as one page", () => {
    expect(canonicalCorpusUrl("https://docs.railway.com/volumes.md")).toBe(
      "https://docs.railway.com/volumes",
    );
    expect(canonicalCorpusUrl("https://docs.railway.com/volumes/?utm_source=x#mounting")).toBe(
      "https://docs.railway.com/volumes",
    );
  });

  /**
   * The catalog no longer decides which pages exist, but the surfaces it can
   * name still have to be in the corpus: an action naming Serverless is
   * checked against the Serverless docs, and a corpus without them is a
   * corpus that cannot contradict anything.
   */
  it("keeps every page the catalog names as corpus material", () => {
    for (const url of CANONICAL_DOC_URLS) {
      expect(classifyCorpusUrl(url), url).toBe("docs");
    }
  });

  it("pins every catalog overview page into the corpus, whatever a sitemap lists", () => {
    const discovered = mergeDiscoveries([
      { source: "sitemap", urls: ["https://docs.railway.com/deployments"] },
      { source: "catalog", urls: CANONICAL_DOC_URLS },
    ]);
    const urls = new Set(discovered.map((entry) => entry.url));

    for (const url of CATALOG_OVERVIEW_URLS) {
      expect(urls.has(url), url).toBe(true);
    }
  });
});

describe("discovering what Railway publishes", () => {
  it("keeps every source that named a URL, so a page nobody lists any more shows up", () => {
    const merged = mergeDiscoveries([
      { source: "sitemap", urls: ["https://docs.railway.com/volumes"] },
      {
        source: "llms",
        urls: ["https://docs.railway.com/volumes", "https://docs.railway.com/cdn"],
      },
    ]);

    expect(merged.map((entry) => entry.url)).toEqual([
      "https://docs.railway.com/cdn",
      "https://docs.railway.com/volumes",
    ]);
    expect(merged.find((entry) => entry.url.endsWith("volumes"))?.sources).toEqual([
      "sitemap",
      "llms",
    ]);
    expect(merged.find((entry) => entry.url.endsWith("cdn"))?.sources).toEqual(["llms"]);
  });

  /**
   * llms.txt is one input. It is a file the vendor curates for some other
   * purpose than ours, so a page missing from it is not a page that does not
   * exist – which is exactly how a six-URL allowlist once hid a whole privacy
   * section from an analysis.
   */
  it("reads llms.txt as one input among several", () => {
    const urls = urlsFromLlmsTxt(
      [
        "# Railway docs",
        "- [Volumes](https://docs.railway.com/volumes): persistent disks",
        "- [CDN](https://docs.railway.com/networking/cdn)",
        "See also https://docs.railway.com/pricing.",
      ].join("\n"),
    );

    expect(urls).toContain("https://docs.railway.com/volumes");
    expect(urls).toContain("https://docs.railway.com/networking/cdn");
    expect(urls).toContain("https://docs.railway.com/pricing");
  });

  it("reads a sitemap's urls and its children separately", () => {
    const parsed = urlsFromSitemap(
      `<?xml version="1.0"?><urlset><url><loc>https://docs.railway.com/volumes</loc></url></urlset>`,
    );
    expect(parsed.urls).toEqual(["https://docs.railway.com/volumes"]);

    const index = urlsFromSitemap(
      `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://docs.railway.com/sitemap-0.xml</loc></sitemap></sitemapindex>`,
    );
    expect(index.children).toEqual(["https://docs.railway.com/sitemap-0.xml"]);
  });

  it("finds changelog entries on the changelog index", () => {
    const html = `<a href="/changelog/2026-09-01-metal">Metal</a><a href="/pricing">Pricing</a>`;
    expect(changelogEntryUrls(html, "https://railway.com/changelog")).toEqual([
      "https://railway.com/changelog/2026-09-01-metal",
    ]);
  });

  it("adds the links a fetched page carries, without losing what found it first", () => {
    const withCrawl = addDiscoverySource(
      mergeDiscoveries([{ source: "sitemap", urls: ["https://docs.railway.com/volumes"] }]),
      "crawl",
      ["https://docs.railway.com/volumes", "https://docs.railway.com/volumes/backups"],
    );

    expect(withCrawl.find((entry) => entry.url.endsWith("volumes"))?.sources).toEqual([
      "sitemap",
      "crawl",
    ]);
    expect(withCrawl.find((entry) => entry.url.endsWith("backups"))?.sources).toEqual(["crawl"]);
  });
});

const config = {
  railwayMaxPages: 3,
  railwayRefreshDays: 14,
  docsHotRefreshDays: 3,
} as Config;

function meta(overrides: Partial<PageMeta> = {}): PageMeta {
  const { text: _text, mentions: _mentions, ...rest } = corpusPage(overrides);
  return rest;
}

const now = new Date("2026-09-15T00:00:00.000Z");

/**
 * Freshness is a content hash, not a clock: a re-download that hashes the same
 * leaves the page's change date alone. The two tiers exist because the cost of
 * a stale page is not the same everywhere – the pages recommendations rest on
 * are worth re-reading often, and the rest of the corpus answers "does Railway
 * do this at all" just as well a fortnight old.
 */
describe("deciding what to re-read", () => {
  it("reads a page nothing has ever read", () => {
    expect(isDue(meta({ contentHash: "" }), config, now)).toBe(true);
  });

  it("re-reads a page an analyst used lately every few days", () => {
    const used = meta({
      fetchedAt: new Date("2026-09-10T00:00:00.000Z"),
      lastUsedAt: new Date("2026-09-14T00:00:00.000Z"),
    });
    expect(isDue(used, config, now)).toBe(true);
  });

  it("leaves a page nothing has reasoned against alone for a fortnight", () => {
    const cold = meta({ fetchedAt: new Date("2026-09-10T00:00:00.000Z"), lastUsedAt: null });
    expect(isDue(cold, config, now)).toBe(false);
    expect(isDue(meta({ fetchedAt: new Date("2026-08-01T00:00:00.000Z") }), config, now)).toBe(
      true,
    );
  });

  it("puts new urls first and spends the oldest copies next", () => {
    const held = new Map<string, PageMeta>([
      [
        "https://docs.railway.com/a",
        meta({ url: "https://docs.railway.com/a", fetchedAt: new Date("2026-07-01") }),
      ],
      [
        "https://docs.railway.com/b",
        meta({ url: "https://docs.railway.com/b", fetchedAt: new Date("2026-06-01") }),
      ],
    ]);

    const plan = planRefresh(
      [
        { url: "https://docs.railway.com/new", kind: "docs", sources: ["sitemap"] },
        { url: "https://docs.railway.com/a", kind: "docs", sources: ["sitemap"] },
        { url: "https://docs.railway.com/b", kind: "docs", sources: ["sitemap"] },
      ],
      held,
      config,
      now,
    );

    expect(plan.fresh).toEqual(["https://docs.railway.com/new"]);
    expect(plan.due).toEqual(["https://docs.railway.com/b", "https://docs.railway.com/a"]);
    expect(plan.deferred).toBe(0);
  });

  it("defers what will not fit in the fetch budget rather than dropping the run", () => {
    const plan = planRefresh(
      ["a", "b", "c", "d", "e"].map((slug) => ({
        url: `https://docs.railway.com/${slug}`,
        kind: "docs" as const,
        sources: ["sitemap" as const],
      })),
      new Map(),
      config,
      now,
    );

    expect(plan.fresh).toHaveLength(3);
    expect(plan.deferred).toBe(2);
  });
});

describe("retiring a page that has gone", () => {
  it("gives a url missing from every source one run of grace", () => {
    const held = new Map([["https://docs.railway.com/old", meta({ url: "https://docs.railway.com/old" })]]);
    const first = planBookkeeping([], held, [], now);

    expect(first.missing).toEqual(["https://docs.railway.com/old"]);
    expect(first.retired).toEqual([]);
    expect(RETIRE_AFTER_MISSING_RUNS).toBe(2);
  });

  it("retires it the second run in a row", () => {
    const held = new Map([
      [
        "https://docs.railway.com/old",
        meta({ url: "https://docs.railway.com/old", missingStreak: 1 }),
      ],
    ]);
    expect(planBookkeeping([], held, [], now).retired).toEqual(["https://docs.railway.com/old"]);
  });

  it("retires a 404 outright, without waiting for a second run", () => {
    const held = new Map([
      ["https://docs.railway.com/gone", meta({ url: "https://docs.railway.com/gone" })],
    ]);
    const plan = planBookkeeping(
      [{ url: "https://docs.railway.com/gone", kind: "docs", sources: ["sitemap"] }],
      held,
      ["https://docs.railway.com/gone"],
      now,
    );
    expect(plan.retired).toEqual(["https://docs.railway.com/gone"]);
  });

  it("resets the streak for a url a source still offers", () => {
    const held = new Map([
      [
        "https://docs.railway.com/volumes",
        meta({ url: "https://docs.railway.com/volumes", missingStreak: 1 }),
      ],
    ]);
    const plan = planBookkeeping(
      [{ url: "https://docs.railway.com/volumes", kind: "docs", sources: ["llms"] }],
      held,
      [],
      now,
    );

    expect(plan.seen).toEqual([{ url: "https://docs.railway.com/volumes", sources: ["llms"] }]);
    expect(plan.missing).toEqual([]);
    expect(plan.retired).toEqual([]);
  });
});

/**
 * Seeding from a single bundled file is a one-off convenience for an empty
 * corpus, and there is no standard for the format, so the parse anchors on the
 * one thing every generator emits: a line that is a URL and nothing else. A
 * file with none yields nothing, and the corpus fills a page at a time instead.
 */
describe("seeding an empty corpus from one bundled file", () => {
  it("splits it into pages on the url each section is anchored by", () => {
    const sections = splitLlmsFull(
      [
        "# Volumes",
        "https://docs.railway.com/volumes",
        "A volume attaches a persistent disk to one service.",
        "",
        "# CDN",
        "Source: https://docs.railway.com/networking/cdn",
        "Railway caches static assets at the edge.",
      ].join("\n"),
    );

    expect(sections).toHaveLength(2);
    expect(sections[0]?.url).toBe("https://docs.railway.com/volumes");
    expect(sections[0]?.title).toBe("Volumes");
    expect(sections[0]?.text).toContain("persistent disk");
    expect(sections[1]?.url).toBe("https://docs.railway.com/networking/cdn");
  });

  it("yields nothing from a file with no page urls in it", () => {
    expect(splitLlmsFull("# Railway docs\n\nSome prose and no urls at all.")).toEqual([]);
  });
});
