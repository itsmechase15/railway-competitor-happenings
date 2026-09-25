import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/db/memory.js";
import { corpusPage } from "./helpers.js";

const now = new Date("2026-09-15T00:00:00.000Z");

/**
 * The corpus contract, on the store a dry run uses. Postgres implements the
 * same four calls, so what is pinned here is the meaning rather than the SQL:
 * a page that is back is live again, a page that is gone leaves the corpus,
 * and the pages a run reasoned against are the ones worth re-reading soonest.
 */
describe("keeping the corpus", () => {
  it("hands back the live pages, with their bodies, in url order", async () => {
    const store = new MemoryStore();
    await store.savePage(corpusPage({ url: "https://docs.railway.com/volumes" }));
    await store.savePage(corpusPage({ url: "https://docs.railway.com/cdn" }));

    const corpus = await store.loadCorpus();
    expect(corpus.map((page) => page.url)).toEqual([
      "https://docs.railway.com/cdn",
      "https://docs.railway.com/volumes",
    ]);
    expect(corpus[0]?.text).not.toBe("");
  });

  it("filters the corpus by what a page is evidence of", async () => {
    const store = new MemoryStore();
    await store.savePage(corpusPage({ url: "https://docs.railway.com/volumes" }));
    await store.savePage(
      corpusPage({ url: "https://railway.com/changelog/metal", kind: "changelog" }),
    );

    expect((await store.loadCorpus(["docs"])).map((page) => page.url)).toEqual([
      "https://docs.railway.com/volumes",
    ]);
  });

  it("leaves the bodies out of the list the refresh plans against", async () => {
    const store = new MemoryStore();
    await store.savePage(corpusPage());

    const [meta] = await store.listPageMeta();
    expect(meta?.contentHash).toBe("hash");
    expect(meta && "text" in meta).toBe(false);
  });

  it("drops a retired page out of the corpus but keeps its row", async () => {
    const store = new MemoryStore();
    await store.savePage(corpusPage({ url: "https://docs.railway.com/gone" }));
    await store.recordCorpusRun({
      seen: [],
      missing: [],
      retired: ["https://docs.railway.com/gone"],
      used: [],
      at: now,
    });

    expect(await store.loadCorpus()).toEqual([]);
    expect((await store.listPageMeta())[0]?.retiredAt).toEqual(now);
  });

  it("brings a page back the moment it has a body again", async () => {
    const store = new MemoryStore();
    await store.savePage(corpusPage({ url: "https://docs.railway.com/back" }));
    await store.recordCorpusRun({
      seen: [],
      missing: [],
      retired: ["https://docs.railway.com/back"],
      used: [],
      at: now,
    });
    await store.savePage(corpusPage({ url: "https://docs.railway.com/back" }));

    expect((await store.loadCorpus()).map((page) => page.url)).toEqual([
      "https://docs.railway.com/back",
    ]);
  });

  it("counts the runs a page went unlisted, and resets the count when it is listed again", async () => {
    const store = new MemoryStore();
    const url = "https://docs.railway.com/volumes";
    await store.savePage(corpusPage({ url }));

    const bookkeeping = { seen: [], missing: [url], retired: [], used: [], at: now };
    await store.recordCorpusRun(bookkeeping);
    await store.recordCorpusRun(bookkeeping);
    expect((await store.listPageMeta())[0]?.missingStreak).toBe(2);

    await store.recordCorpusRun({
      seen: [{ url, sources: ["sitemap"] }],
      missing: [],
      retired: [],
      used: [],
      at: now,
    });
    const [meta] = await store.listPageMeta();
    expect(meta?.missingStreak).toBe(0);
    expect(meta?.discoveredFrom).toEqual(["sitemap"]);
  });

  it("stamps the pages a run reasoned against, which is what shortens their refresh", async () => {
    const store = new MemoryStore();
    const url = "https://docs.railway.com/volumes";
    await store.savePage(corpusPage({ url }));
    await store.recordCorpusRun({ seen: [], missing: [], retired: [], used: [url], at: now });

    expect((await store.listPageMeta())[0]?.lastUsedAt).toEqual(now);
  });

  it("does not forget when a page was last used just because it was re-read", async () => {
    const store = new MemoryStore();
    const url = "https://docs.railway.com/volumes";
    await store.savePage(corpusPage({ url }));
    await store.recordCorpusRun({ seen: [], missing: [], retired: [], used: [url], at: now });
    await store.savePage(corpusPage({ url, contentHash: "second" }));

    expect((await store.listPageMeta())[0]?.lastUsedAt).toEqual(now);
  });
});

/**
 * The quiet-day line has no item to dedupe on, so the day is what it is
 * deduped on. Postgres does this with a primary key and an insert that may
 * conflict; what both implementations owe the caller is the same answer:
 * exactly one run of a morning is told it may speak.
 */
describe("claiming a morning", () => {
  it("hands the day to the first run that asks and to no other", async () => {
    const store = new MemoryStore();

    expect(await store.claimQuietDay("2026-09-24")).toBe(true);
    expect(await store.claimQuietDay("2026-09-24")).toBe(false);
  });

  it("hands out the next day regardless", async () => {
    const store = new MemoryStore();
    await store.claimQuietDay("2026-09-24");

    expect(await store.claimQuietDay("2026-09-25")).toBe(true);
  });
});
