import { describe, expect, it } from "vitest";
import { bestExcerpt, sectionOf, terms } from "../src/railway/retrieval.js";
import { corpusIndex, corpusPage } from "./helpers.js";
import { buildCorpusIndex } from "../src/railway/retrieval.js";

/**
 * Retrieval is how the whole corpus becomes usable: a few hundred pages ranked
 * for one launch, so an analysis starts on the pages that could answer it and
 * so the coverage gate can say which pages it should have read.
 */
describe("searching the corpus", () => {
  const index = corpusIndex([
    {
      url: "https://docs.railway.com/deployments/serverless",
      title: "Serverless",
      text: "Serverless stops a service's container when it has no inbound traffic. The container starts again on the next request. Railway bills the minute a container is awake.",
    },
    {
      url: "https://docs.railway.com/networking/cdn",
      title: "CDN",
      text: "Railway caches static assets at the edge and honors cache-control headers. Purge the cache on deploy.",
    },
    {
      url: "https://docs.railway.com/volumes",
      title: "Volumes",
      text: "A volume attaches a persistent disk to exactly one service. Back up a volume on a schedule.",
    },
  ]);

  it("finds the page a launch is about", () => {
    const [top] = index.search("stop a container when it has no inbound traffic");
    expect(top?.url).toBe("https://docs.railway.com/deployments/serverless");
  });

  /**
   * The limitation this whole design is built around.
   *
   * A lexical index matches words, and a competitor names a feature whatever
   * they like: "scale to zero" is the industry's phrase for what Railway's
   * docs call stopping an idle container, and a search for it lands nowhere
   * near the page that answers it. This is why the pre-loaded excerpts are
   * only a starting point, why the analyst gets a list of every page in the
   * corpus, and why it gets grep – and why a gap claim is checked against a
   * second search rather than against the first one.
   */
  it("misses the right page when the launch uses the competitor's words for it", () => {
    const hits = index.search("scale to zero pricing");
    expect(hits.map((hit) => hit.url)).not.toContain(
      "https://docs.railway.com/deployments/serverless",
    );
  });

  it("matches across plurals and tenses, which is what a docs page is written in", () => {
    const [top] = index.search("caching static asset at the edge");
    expect(top?.url).toBe("https://docs.railway.com/networking/cdn");
  });

  it("says which of the query's words a page actually contains", () => {
    const [top] = index.search("persistent disk attached to a service");
    expect(top?.matched).toContain(terms("persistent")[0]);
    expect(top?.matched).toContain(terms("disk")[0]);
  });

  it("comes back with an excerpt that speaks to the query, not just the page's opening", () => {
    const [top] = index.search("back up a volume");
    expect(top?.excerpt).toContain("Back up a volume");
  });

  it("finds nothing for a query the corpus has no words for", () => {
    expect(index.search("a new office in Lisbon")).toEqual([]);
  });

  it("answers whether a citation is a page it holds", () => {
    expect(index.page("https://docs.railway.com/volumes")?.title).toBe("Volumes");
    expect(index.page("https://docs.railway.com/invented")).toBeUndefined();
  });
});

describe("keeping one part of the docs from filling a prompt", () => {
  const networking = ["cdn", "domains", "edge-rules", "waf", "private-networking"].map((slug) => ({
    url: `https://docs.railway.com/networking/${slug}`,
    title: slug,
    text: "Railway routes cached requests at the edge for this surface.",
  }));

  const index = corpusIndex([
    ...networking,
    {
      url: "https://docs.railway.com/deployments/serverless",
      title: "Serverless",
      text: "Railway routes cached requests at the edge for an idle container.",
    },
  ]);

  it("caps how many hits one section can contribute", () => {
    const hits = index.search("cached requests at the edge", { limit: 6, perSection: 2 });
    const sections = hits.map((hit) => sectionOf(hit.url));

    expect(sections.filter((section) => section === "networking")).toHaveLength(2);
    expect(sections).toContain("deployments");
  });
});

describe("ranking a surface's overview page up", () => {
  it("prefers the overview page to a guide that uses the same words", () => {
    const index = buildCorpusIndex([
      corpusPage({
        url: "https://docs.railway.com/guides/cache-headers-cdn",
        title: "Cache headers guide",
        text: "Set a cache-control header so the edge cache holds a static asset.",
      }),
      corpusPage({
        url: "https://docs.railway.com/networking/cdn",
        title: "CDN",
        text: "Set a cache-control header so the edge cache holds a static asset.",
      }),
    ]);

    expect(index.search("edge cache for a static asset")[0]?.url).toBe(
      "https://docs.railway.com/networking/cdn",
    );
  });
});

describe("pulling the part of a page that answers a question", () => {
  it("keeps the lead sentence, which says what the page is", () => {
    const excerpt = bestExcerpt(
      "Serverless stops an idle container. Billing continues while it is awake. Cold starts take a second.",
      terms("cold start"),
    );
    expect(excerpt.startsWith("Serverless stops an idle container.")).toBe(true);
    expect(excerpt).toContain("Cold starts");
  });

  it("returns nothing for a page with no text, rather than throwing", () => {
    expect(bestExcerpt("", terms("anything"))).toBe("");
  });
});

describe("reading the section a page sits in", () => {
  it("takes the first path segment", () => {
    expect(sectionOf("https://docs.railway.com/networking/cdn")).toBe("networking");
    expect(sectionOf("https://railway.com/changelog/2026-09-01")).toBe("changelog");
  });

  it("falls back to something printable for a url it cannot parse", () => {
    expect(sectionOf("not a url")).toBe("other");
  });
});
