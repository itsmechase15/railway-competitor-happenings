import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  captureEdit,
  stageExpression,
  type StageInput,
  type StageOutcome,
} from "../src/media/live-page.js";
import { planPageEdit } from "../src/media/page-edit.js";
import type { RailwayRef } from "../src/types.js";

/**
 * The browser half of the Before/After, run against fixtures that look like the
 * markup a docs page actually serves.
 *
 * Skipped whole when there is no Chromium on the box, so `npm test` stays green
 * on a bare machine. CI installs one, because this is the part that can be
 * wrong.
 */
const browser: Browser | null = await chromium.launch().catch(() => null);
const withBrowser = browser ? describe : describe.skip;

const CLAIM = "Render keeps a web service running until you scale it down yourself.";
const PROPOSED =
  "Render now bills a web service per request once it goes idle, so a quiet service costs close to nothing between requests.";

/** The shape of the page: a nav, a sidebar, and prose with links and code in it. */
const DOCS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Compare to Render</title>
<style>
  body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
  nav { position: sticky; top: 0; height: 56px; background: #111; color: #fff; }
  aside { position: sticky; top: 56px; float: left; width: 240px; }
  main { margin-left: 260px; padding: 24px 32px; max-width: 720px; }
</style></head>
<body>
<nav>Railway docs</nav>
<aside><ul><li>Compare to Render</li><li>Render keeps a web service running until you scale it down yourself.</li></ul></aside>
<main><article><div class="prose">
<h1>Compare to Render</h1>
<p>Railway and Render both run your containers, but they bill idle time differently.</p>
<div><p id="target">Railway stops an idle container and bills it by the minute. ${CLAIM} See <a href="/pricing">pricing</a> or run <code>railway up</code>.</p></div>
<p>Both platforms give you a managed Postgres with daily backups.</p>
</div></article></main>
</body></html>`;

const ref = (overrides: Partial<RailwayRef> = {}): RailwayRef => ({
  url: "https://docs.railway.com/platform/compare-to-render",
  claim: CLAIM,
  proposedText: PROPOSED,
  ...overrides,
});

const input = (overrides: Partial<StageInput> = {}): StageInput => ({
  action: "locate",
  claim: CLAIM,
  proposedText: PROPOSED,
  editKind: "replace",
  ...overrides,
});

const stage = (page: Page, overrides: Partial<StageInput> = {}): Promise<StageOutcome> =>
  page.evaluate<StageOutcome>(stageExpression(input(overrides)));

withBrowser("finding the line on the live page and putting the copy in", () => {
  let page: Page;

  beforeAll(async () => {
    page = await browser!.newPage({ viewport: { width: 1_280, height: 900 } });
  });

  afterAll(async () => {
    await page?.close().catch(() => undefined);
  });

  const load = async (html = DOCS_PAGE): Promise<void> => {
    await page.setContent(html, { waitUntil: "load" });
  };

  const targetText = (): Promise<string> =>
    page.evaluate(() => document.querySelector("#target")?.textContent ?? "");

  it("puts the copy where the quoted line was, and leaves the rest of the paragraph", async () => {
    await load();
    expect((await stage(page)).status).toBe("ok");
    expect((await stage(page, { action: "apply" })).status).toBe("ok");

    const text = await targetText();
    expect(text).toContain(PROPOSED);
    expect(text).not.toContain(CLAIM);
    expect(text).toContain("Railway stops an idle container");
    // The link and the code sample were never part of the quoted line.
    expect(await page.locator("#target a").count()).toBe(1);
    expect(await page.locator("#target code").innerText()).toBe("railway up");
  });

  it("edits the prose and not the sidebar copy that repeats it", async () => {
    await load();
    await stage(page);
    await stage(page, { action: "apply" });
    expect(await page.locator("aside li").nth(1).innerText()).toContain(CLAIM);
  });

  it("marks the paragraph rather than the div that wraps it", async () => {
    await load();
    await stage(page);
    expect(await page.locator("p[data-happenings-edit]").count()).toBe(1);
  });

  it("matches a line the page punctuates differently", async () => {
    await load();
    const outcome = await stage(page, {
      claim: "Render  keeps a web service running until you scale it down yourself",
    });
    expect(outcome.status).toBe("ok");
  });

  it("leaves the line alone for an insert and puts the copy next to it", async () => {
    await load();
    await stage(page, { editKind: "insert" });
    expect((await stage(page, { action: "apply", editKind: "insert" })).status).toBe("ok");

    expect(await targetText()).toContain(CLAIM);
    const inserted = page.locator("[data-happenings-inserted]");
    expect(await inserted.count()).toBe(1);
    expect(await inserted.innerText()).toBe(PROPOSED);
    expect(await inserted.evaluate((node) => node.tagName)).toBe("P");
  });

  it("gives copy written as two paragraphs two paragraphs on the page", async () => {
    await load();
    const copy = `${PROPOSED}\n\nIt still bills a background worker by the minute.`;
    await stage(page, { proposedText: copy });
    await stage(page, { action: "apply", proposedText: copy });

    expect(await targetText()).toContain(PROPOSED);
    expect(await page.locator("[data-happenings-inserted]").innerText()).toContain(
      "background worker",
    );
  });

  it("says the line is missing when the page does not have it", async () => {
    await load();
    expect((await stage(page, { claim: "Render deletes your database on Friday." })).status).toBe(
      "missing",
    );
  });

  it("refuses to guess when the line runs across two blocks", async () => {
    await load(
      `<main><p>Render keeps a web service running</p><p>until you scale it down yourself.</p></main>`,
    );
    expect((await stage(page)).status).toBe("split");
  });

  it("puts the page back as it was, so a second pair is not taken of a page half edited", async () => {
    await load();
    const original = await targetText();
    await stage(page);
    await stage(page, { action: "apply" });
    expect((await stage(page, { action: "restore" })).status).toBe("ok");

    expect(await targetText()).toBe(original);
    expect(await page.locator("[data-happenings-inserted]").count()).toBe(0);
    expect(await page.locator("[data-happenings-edit]").count()).toBe(0);
  });

  it("will not apply an edit nothing located, and will not restore one nothing applied", async () => {
    await load();
    expect((await stage(page, { action: "apply" })).status).toBe("failed");
    expect((await stage(page, { action: "restore" })).status).toBe("failed");
  });

  it("scrolls the line into the window and reports where, so both shots match", async () => {
    await load();
    const located = await stage(page);
    if (located.status !== "ok") throw new Error(`the line was ${located.status}`);
    const applied = await stage(page, { action: "apply", scrollY: located.scrollY });
    expect(applied).toMatchObject({ status: "ok", scrollY: located.scrollY });
  });

  it("hides a banner sitting on the paragraph, and keeps the sidebar that is not", async () => {
    await load(
      DOCS_PAGE.replace(
        "</body>",
        `<div id="chat" style="position: fixed; left: 300px; top: 100px; width: 400px; height: 400px; background: #f00;">chat</div></body>`,
      ),
    );
    await stage(page);
    expect(await page.locator("#chat").evaluate((node) => node.style.visibility)).toBe("hidden");
    expect(await page.locator("aside").evaluate((node) => node.style.visibility)).toBe("");
  });

  it("measures how far past the window the new copy runs, so the window can grow", async () => {
    await page.setViewportSize({ width: 1_280, height: 300 });
    await load();
    await stage(page);
    const long = Array.from({ length: 60 }, () => "Railway bills a sleeping service nothing.").join(
      " ",
    );
    const applied = await stage(page, { action: "apply", proposedText: long });
    if (applied.status !== "ok") throw new Error(`the copy was ${applied.status}`);
    expect(applied.overflowBy).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1_280, height: 900 });
  });
});

withBrowser("photographing the page before and after", () => {
  let server: Server;
  let origin: string;
  let status = 200;
  let body = DOCS_PAGE;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const capture = (overrides: Partial<RailwayRef> = {}) =>
    captureEdit(browser!, planPageEdit(ref({ url: `${origin}/compare`, ...overrides }), undefined)!, {
      userAgent: "railway-competitor-happenings/0.1 (test)",
    });

  it("comes back with two different pngs of the same page", async () => {
    status = 200;
    body = DOCS_PAGE;
    const result = await capture();

    expect(result.status).toBe("captured");
    if (result.status !== "captured") return;
    for (const png of [result.before, result.after]) {
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.byteLength).toBeGreaterThan(1_000);
    }
    expect(result.before.equals(result.after)).toBe(false);
  });

  it("says the line is missing when the live page has moved on", async () => {
    status = 200;
    body = DOCS_PAGE.replaceAll(CLAIM, "Render bills a web service per request once it goes idle.");
    expect((await capture()).status).toBe("missing");
  });

  it("gives up quietly on a page that answers with an error", async () => {
    status = 503;
    body = "<html><body>down</body></html>";
    const result = await capture();
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") expect(result.reason).toContain("503");
  });
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});
