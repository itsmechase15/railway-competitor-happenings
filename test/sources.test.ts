import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPETITORS, type CompetitorConfig } from "../src/config.js";
import {
  indexCardsToItems,
  indexLinksToItems,
  isArticleUrl,
  sitemapEntriesToItems,
} from "../src/sources/blog.js";
import { entryUrl, isAnchoredEntry } from "../src/sources/link.js";
import { changelogExternalId, feedEntriesToItems, parseFeed } from "../src/sources/rss.js";
import { parseSitemap } from "../src/sources/sitemap.js";
import { extractArticleCards, extractLinks } from "../src/util/html.js";

const renderFeed = readFileSync("test/fixtures/render-changelog.fixture.xml", "utf8");
const RENDER_FEED_URL = "https://render.com/changelog/feed.xml";
const vercelBlog = readFileSync("test/fixtures/vercel-blog.fixture.html", "utf8");

describe("the changelog feed", () => {
  it("reads an Atom feed whose bodies are CDATA HTML", () => {
    const entries = parseFeed(renderFeed);
    expect(entries).toHaveLength(2);

    const [first] = entries;
    expect(first?.title).toBe("See your service's deploys on a new page");
    expect(first?.link).toBe(
      "https://render.com/changelog/see-your-service-s-deploys-on-a-new-page",
    );
    expect(first?.publishedAt?.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    // The body reaches analysis as prose, not as markup.
    expect(first?.body).toContain("Services now have a new Deploys page");
    expect(first?.body).not.toContain("<strong>");
  });

  it("turns entries into candidates the deduplicator can key on", () => {
    const items = feedEntriesToItems(COMPETITORS.render, RENDER_FEED_URL, parseFeed(renderFeed));
    expect(items[0]?.competitor).toBe("render");
    expect(items[0]?.source).toBe("changelog");
    expect(items[0]?.externalId).toBe(
      "https://render.com/changelog/see-your-service-s-deploys-on-a-new-page",
    );
  });

  it("prefers the feed's own guid as the identity", () => {
    expect(
      changelogExternalId({
        title: "x",
        link: "https://render.com/changelog/x",
        entryLink: "https://render.com/changelog/x",
        guid: "guid-1",
        publishedAt: null,
        body: "",
        image: null,
      }),
    ).toBe("guid-1");
  });

  it("hashes an entry with no guid and no link, so it still dedupes", () => {
    const id = changelogExternalId({
      title: "Something shipped",
      link: "",
      entryLink: "",
      guid: null,
      publishedAt: new Date("2026-01-01T00:00:00.000Z"),
      body: "",
      image: null,
    });
    expect(id).toMatch(/^[a-f0-9]{40}$/);
  });

  it("returns nothing for a document that is not a feed", () => {
    expect(parseFeed("<html><body>not a feed</body></html>")).toEqual([]);
  });
});

describe("an entry that is an anchor on a shared page", () => {
  it("keeps the anchor, so the alert links the release rather than the page", () => {
    const [item] = feedEntriesToItems(COMPETITORS.render, RENDER_FEED_URL, [
      {
        title: "Something shipped",
        link: "https://render.com/changelog",
        entryLink: "https://render.com/changelog#something-shipped",
        guid: "guid-1",
        publishedAt: null,
        body: "",
        image: null,
      },
    ]);

    expect(item?.url).toBe("https://render.com/changelog");
    expect(entryUrl(item!)).toBe("https://render.com/changelog#something-shipped");
    expect(isAnchoredEntry(entryUrl(item!))).toBe(true);
  });

  it("falls back to the item's own page when the feed gave no anchor", () => {
    const [item] = feedEntriesToItems(COMPETITORS.render, RENDER_FEED_URL, parseFeed(renderFeed));
    expect(entryUrl(item!)).toBe(item?.url);
  });
});

/**
 * Neither competitor is read this way today – Render publishes no sitemap at
 * the root and Vercel is read from its blog index – so the reader is exercised
 * against a competitor that says it publishes one.
 */
describe("the blog sitemap", () => {
  const publisher: CompetitorConfig = {
    ...COMPETITORS.render,
    sitemaps: ["https://render.com/blog-sitemap.xml"],
  };
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://render.com/blog/build-pipelines</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://render.com/blog</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://render.com/blog/tag/ai</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://render.com/docs/deploys</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://render.com/blog/old-post</loc><lastmod>2020-01-01</lastmod></url>
    </urlset>`;

  it("keeps posts and drops the index, the taxonomy pages, and the docs", () => {
    const items = sitemapEntriesToItems(publisher, parseSitemap(sitemap).entries, {
      since: new Date("2026-09-01T00:00:00.000Z"),
      limit: 10,
    });

    expect(items.map((item) => item.url)).toEqual(["https://render.com/blog/build-pipelines"]);
    expect(items[0]?.source).toBe("blog");
  });

  it("follows a sitemap index one level down", () => {
    const index = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://render.com/blog-sitemap.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemap(index).children).toEqual(["https://render.com/blog-sitemap.xml"]);
  });
});

/**
 * Vercel's changelog is not a source. Its blog index is, and it describes every
 * post it lists, so a candidate off it arrives with the post's own title and
 * its publish date rather than a slug and a null.
 */
describe("the Vercel blog index", () => {
  const cards = () => extractArticleCards(vercelBlog, "https://vercel.com/blog", ["/blog/"]);

  it("reads a title and a date off each card, once per post", () => {
    expect(cards()).toEqual([
      {
        url: "https://vercel.com/blog/introducing-flat-rate-cdn",
        title: "Introducing Flat Rate CDN",
        published: "2026-09-08T00:00-04:00",
      },
      {
        url: "https://vercel.com/blog/how-we-cut-cdn-metadata-lookup-latency-by-91-percent",
        title: "How we cut CDN metadata lookup latency by 91%",
        published: "2026-09-10T00:00+00:00",
      },
      {
        url: "https://vercel.com/blog/fluid-compute-takes-any-shape",
        title: "Compute that takes any shape",
        published: "2026-09-01T00:00-07:00",
      },
    ]);
  });

  it("turns them into dated candidates keyed on the post URL", () => {
    const items = indexCardsToItems(COMPETITORS.vercel, cards(), { limit: 10 });

    expect(items[0]?.competitor).toBe("vercel");
    expect(items[0]?.source).toBe("blog");
    expect(items[0]?.url).toBe("https://vercel.com/blog/introducing-flat-rate-cdn");
    expect(items[0]?.externalId).toBe("https://vercel.com/blog/introducing-flat-rate-cdn");
    expect(items[0]?.title).toBe("Introducing Flat Rate CDN");
    expect(items[0]?.publishedAt?.toISOString()).toBe("2026-09-08T04:00:00.000Z");
    expect(items[0]?.raw).toEqual({
      discoveredVia: "blog-index",
      indexDate: "2026-09-08T00:00-04:00",
    });
  });

  it("names nothing from the changelog", () => {
    const urls = extractLinks(vercelBlog, "https://vercel.com/blog", ["/blog/"]);
    expect(urls.some((url) => url.includes("/changelog"))).toBe(false);
    expect(cards().some((card) => card.url.includes("/changelog"))).toBe(false);
  });

  it("leaves a post the index only links for the bare-link read to find", () => {
    const cardItems = indexCardsToItems(COMPETITORS.vercel, cards(), { limit: 10 });
    const described = new Set(cardItems.map((item) => item.url));
    const links = extractLinks(vercelBlog, "https://vercel.com/blog", ["/blog/"]);
    const items = indexLinksToItems(
      COMPETITORS.vercel,
      links.filter((link) => !described.has(link)),
      { limit: 10 },
    );

    expect(items.map((item) => item.url)).toEqual(["https://vercel.com/blog/an-undescribed-post"]);
    expect(items[0]?.publishedAt).toBeNull();
  });

  it("falls back to the slug when a card names no title", () => {
    const [item] = indexCardsToItems(
      COMPETITORS.vercel,
      [{ url: "https://vercel.com/blog/introducing-run", title: "", published: "" }],
      { limit: 10 },
    );

    expect(item?.title).toBe("Introducing run");
    expect(item?.publishedAt).toBeNull();
    expect(item?.raw).toEqual({ discoveredVia: "blog-index" });
  });
});

/**
 * Render publishes no sitemap at the root, so its blog index is the listing:
 * the URLs on it are compared against the `items` table, and whatever is new
 * is a new post. There is no date on an index at all, which is why a null
 * published date has to survive the rest of the pipeline.
 */
describe("the blog index, for a competitor with no sitemap", () => {
  const html = `<html><body><main>
    <a href="/blog/deploys-page">Deploys page</a>
    <a href="/blog/deploys-page">Deploys page again</a>
    <a href="/blog/feed.rss">RSS</a>
    <a href="/blog">All posts</a>
    <a href="/docs/deploys">Docs</a>
    <a href="https://twitter.com/render/blog/x">Off-site</a>
  </main></body></html>`;

  it("takes only same-origin links under the blog prefix", () => {
    expect(extractLinks(html, "https://render.com/blog", ["/blog/"])).toEqual([
      "https://render.com/blog/deploys-page",
      "https://render.com/blog/feed.rss",
    ]);
  });

  it("turns them into dated-nothing candidates, once each", () => {
    const items = indexLinksToItems(
      COMPETITORS.render,
      extractLinks(html, "https://render.com/blog", ["/blog/"]),
      { limit: 10 },
    );

    expect(items.map((item) => item.url)).toEqual(["https://render.com/blog/deploys-page"]);
    expect(items[0]?.publishedAt).toBeNull();
    expect(items[0]?.title).toBe("Deploys page");
    expect(items[0]?.raw).toEqual({ discoveredVia: "blog-index" });
  });

  it("knows a post from a listing, a feed, and a tag page", () => {
    expect(isArticleUrl("https://render.com/blog/deploys-page", ["/blog/"])).toBe(true);
    expect(isArticleUrl("https://render.com/blog", ["/blog/"])).toBe(false);
    expect(isArticleUrl("https://render.com/blog/feed.rss", ["/blog/"])).toBe(false);
    expect(isArticleUrl("https://render.com/blog/tag/ai", ["/blog/"])).toBe(false);
  });

  it("finds no cards to read, so the bare links stay the whole listing", () => {
    expect(extractArticleCards(html, "https://render.com/blog", ["/blog/"])).toEqual([]);
  });
});

describe("the competitors the plan fixes", () => {
  it("watches Render and Vercel, and nobody else", () => {
    expect(Object.keys(COMPETITORS)).toEqual(["render", "vercel"]);
  });

  it("gives each one a way to find blog posts", () => {
    for (const competitor of Object.values(COMPETITORS)) {
      expect(
        competitor.sitemaps.length + competitor.blogIndexes.length,
        competitor.label,
      ).toBeGreaterThan(0);
    }
  });

  it("reads Render's changelog feed and no changelog for Vercel", () => {
    expect(COMPETITORS.render.changelogFeed).toBe(RENDER_FEED_URL);
    expect(COMPETITORS.vercel.changelogFeed).toBeUndefined();
  });

  it("reads Vercel from its blog index, not a feed and not a sitemap", () => {
    expect(COMPETITORS.vercel.blogIndexes).toEqual(["https://vercel.com/blog"]);
    expect(COMPETITORS.vercel.sitemaps).toEqual([]);
  });

  it("reads each one's own page about Railway, as context only", () => {
    expect(COMPETITORS.render.comparePages).toEqual([
      "https://render.com/docs/migrate-from-railway",
    ]);
    expect(COMPETITORS.vercel.comparePages).toEqual(["https://vercel.com/compare/railway"]);
  });
});
