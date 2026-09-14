import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPETITORS } from "../src/config.js";
import { indexLinksToItems, isArticleUrl, sitemapEntriesToItems } from "../src/sources/blog.js";
import { entryUrl, isAnchoredEntry } from "../src/sources/link.js";
import { changelogExternalId, feedEntriesToItems, parseFeed } from "../src/sources/rss.js";
import { parseSitemap } from "../src/sources/sitemap.js";
import { extractLinks } from "../src/util/html.js";

const renderFeed = readFileSync("test/fixtures/render-changelog.fixture.xml", "utf8");

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
    const items = feedEntriesToItems(COMPETITORS.render, parseFeed(renderFeed));
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
    const [item] = feedEntriesToItems(COMPETITORS.render, [
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
    const [item] = feedEntriesToItems(COMPETITORS.render, parseFeed(renderFeed));
    expect(entryUrl(item!)).toBe(item?.url);
  });
});

describe("the blog sitemap", () => {
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://vercel.com/blog/fluid-compute</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://vercel.com/blog</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://vercel.com/blog/tag/ai</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://vercel.com/docs/functions</loc><lastmod>2026-09-10</lastmod></url>
      <url><loc>https://vercel.com/blog/old-post</loc><lastmod>2020-01-01</lastmod></url>
    </urlset>`;

  it("keeps posts and drops the index, the taxonomy pages, and the docs", () => {
    const items = sitemapEntriesToItems(COMPETITORS.vercel, parseSitemap(sitemap).entries, {
      since: new Date("2026-09-01T00:00:00.000Z"),
      limit: 10,
    });

    expect(items.map((item) => item.url)).toEqual(["https://vercel.com/blog/fluid-compute"]);
    expect(items[0]?.source).toBe("blog");
  });

  it("follows a sitemap index one level down", () => {
    const index = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://vercel.com/blog-sitemap.xml</loc></sitemap>
      </sitemapindex>`;
    expect(parseSitemap(index).children).toEqual(["https://vercel.com/blog-sitemap.xml"]);
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
});

describe("the competitors the plan fixes", () => {
  it("watches Render and Vercel, and nobody else", () => {
    expect(Object.keys(COMPETITORS)).toEqual(["render", "vercel"]);
  });

  it("gives each one a changelog feed and a way to find blog posts", () => {
    for (const competitor of Object.values(COMPETITORS)) {
      expect(competitor.changelogFeed, competitor.label).toMatch(/^https:\/\//);
      expect(
        competitor.sitemaps.length + competitor.blogIndexes.length,
        competitor.label,
      ).toBeGreaterThan(0);
    }
  });

  it("reads each one's own page about Railway, as context only", () => {
    expect(COMPETITORS.render.comparePages).toEqual([
      "https://render.com/docs/migrate-from-railway",
    ]);
    expect(COMPETITORS.vercel.comparePages).toEqual(["https://vercel.com/compare/railway"]);
  });
});
