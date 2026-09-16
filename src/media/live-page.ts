import type { Browser, Page } from "playwright";
import type { EditKind } from "../types.js";
import type { PageEditPlan } from "./page-edit.js";

/**
 * The Before/After of a page edit, photographed on the page itself.
 *
 * An `update_pages` issue already carries the page, the line on it today, and
 * the copy to paste. What it cannot do in text is show what the page looks like
 * with the edit in it, which is the first question anybody asked to make the
 * edit has. So the real page is opened in a headless browser, photographed, the
 * proposed copy is put into that browser's own copy of the document, and the
 * page is photographed again. Two PNGs of the docs site as a visitor sees it:
 * sidebar, header, typography, everything.
 *
 * **Nothing is published by any of this.** The edit lives in one browser tab's
 * in-memory DOM for the second or two between the two screenshots, and the tab
 * is thrown away. No form is submitted, no request is made to Railway beyond
 * the GET that loads the page, and the copy to paste is still the instruction
 * the issue carries. The caption on the After shot says so, because a reader
 * seeing their own page with words they have not written on it deserves to be
 * told which of the two is real.
 *
 * The stored corpus is still what the claim is *checked* against: the evidence
 * gate runs long before this, on the same text the analyst read. This only
 * decides what the picture is of. When the quoted line is on the stored page
 * but not on the live one, that is worth knowing rather than worth papering
 * over – the capture reports it and the issue says so.
 *
 * Every path here gives up quietly. No browser, a page that will not load, a
 * challenge page, a line that is not there any more: each costs the picture and
 * none of them costs the issue, which says the same thing in words.
 */

/** What one page's capture produced, or why it produced nothing. */
export type CaptureResult =
  | { status: "captured"; before: Buffer; after: Buffer }
  /** The quoted line is not on the live page. The corpus, and maybe the action, is stale. */
  | { status: "missing" }
  | { status: "skipped"; reason: string };

export interface CaptureOptions {
  /** The same honest agent string the rest of the app fetches with. */
  userAgent: string;
}

/**
 * Desktop, because the compare pages are read on one and the sidebar is half of
 * what makes the shot look like the docs site rather than a card. Twice the
 * pixels so the type is sharp on the display somebody reviews the issue on.
 */
export const VIEWPORT = { width: 1_280, height: 900 } as const;

/**
 * A grown window for an edit that adds more prose than the shot had room for.
 * Once, and no further: past this the paragraph is small in a tall page and the
 * PNG is a megabyte of whitespace.
 */
const MAX_VIEWPORT_HEIGHT = 1_800;

/** A page that has not answered in this long is not going to be in the picture. */
const NAVIGATION_TIMEOUT_MS = 20_000;

/** The titles a bot check serves instead of the page. Nothing to photograph. */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser/i;

/**
 * What a third party is allowed to contribute to the picture: things that are
 * on it. A screenshot missing the page's webfont or with a broken-image icon
 * where a diagram goes is not what the page looks like.
 */
const PASSIVE_RESOURCES = new Set(["image", "font", "stylesheet", "media"]);

/** Everything the two screenshots have to agree on, passed into the page. */
export interface StageInput {
  action: "locate" | "apply" | "restore";
  claim: string;
  proposedText: string;
  editKind: EditKind;
  /**
   * Where the window was scrolled for the Before shot. The After has to be
   * taken from the same offset or the pair is two pictures of two places.
   */
  scrollY?: number;
}

export type StageOutcome =
  | {
      status: "ok";
      /** Where the window ended up, for the next shot to match. */
      scrollY: number;
      /** How far the edited copy runs past the bottom of the window, in CSS pixels. */
      overflowBy: number;
    }
  /** The folded claim is nowhere on the page. */
  | { status: "missing" }
  /** The claim is on the page but spread across two blocks, so there is no one paragraph to edit. */
  | { status: "split" }
  | { status: "failed"; reason: string };

/**
 * Find the quoted line on the page, put the proposed copy in its place, and
 * scroll to it. Runs **inside the browser**, so it is one self-contained
 * function with no imports: Playwright ships its source into the page.
 *
 * Located by its text and never by a CSS selector. A docs site is redesigned,
 * renamed and re-classed continually and the sentence on it is the thing this
 * bot actually quoted, so the sentence is what is looked for. The same folding
 * the evidence gate uses – letters and digits, lowercased – means a curly
 * apostrophe or a collapsed run of spaces is not a miss.
 *
 * Self-contained to the last line, constants included: what reaches the browser
 * is this function's own source, so anything it reads from the module around it
 * is a `ReferenceError` in the page. {@link stageExpression} is how it gets
 * there.
 */
function stagePageEdit(input: StageInput): StageOutcome {
  const MARKER = "data-happenings-edit";
  const INSERTED = "data-happenings-inserted";
  const BLOCKS = "p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, dd";
  /** How far down the window the edited paragraph is parked. */
  const SCROLL_FRACTION = 0.25;
  const store = window as unknown as { __happeningsOriginal?: string };

  /** Every letter and digit in a string, lowercased, and where each came from. */
  function fold(text: string): { folded: string; at: number[] } {
    let folded = "";
    const at: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]!.toLowerCase();
      if (char >= "a" && char <= "z") {
        folded += char;
        at.push(index);
      } else if (char >= "0" && char <= "9") {
        folded += char;
        at.push(index);
      }
    }
    return { folded, at };
  }

  /** Where a quoted line sits in a string, compared on letters and digits only. */
  function span(haystack: string, needle: string): [number, number] | null {
    const hay = fold(haystack);
    const wanted = fold(needle);
    if (wanted.folded === "" || hay.folded === "") return null;
    const found = hay.folded.indexOf(wanted.folded);
    if (found === -1) return null;

    const start = hay.at[found]!;
    let end = hay.at[found + wanted.folded.length - 1]! + 1;
    // The full stop closing the quoted sentence belongs to the sentence. Left
    // out, it survives the replacement as a stray period.
    while (end < haystack.length && /[^\p{Letter}\p{Number}\s]/u.test(haystack[end]!)) end += 1;
    return [start, end];
  }

  /** Where the page's own prose is, in the order worth trying. */
  function container(): HTMLElement {
    return (
      document.querySelector("main") ??
      document.querySelector("article") ??
      document.body
    ) as HTMLElement;
  }

  /**
   * The block the claim is on: the deepest one that holds all of it, first in
   * the document. Deepest, so a wrapping `<div>` full of paragraphs loses to
   * the paragraph; first, so a table of contents further down the page cannot
   * win against the prose.
   */
  function locate(): HTMLElement | "missing" | "split" {
    const root = container();
    const wanted = fold(input.claim).folded;
    if (wanted === "") return "missing";

    const matches = Array.from(root.querySelectorAll<HTMLElement>(BLOCKS)).filter((element) =>
      fold(element.textContent ?? "").folded.includes(wanted),
    );
    const deepest = matches.filter(
      (element) => !matches.some((other) => other !== element && element.contains(other)),
    );
    if (deepest.length > 0) return deepest[0]!;

    // On the page, but not inside one block: the sentence runs across a
    // heading and a paragraph, or across two list items. There is no honest
    // single-element edit to make, so nothing is guessed at.
    return fold(root.textContent ?? "").folded.includes(wanted) ? "split" : "missing";
  }

  /** The claim as a Range over the element's own text nodes. */
  function rangeFor(element: HTMLElement): Range | null {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Node; start: number }> = [];
    let text = "";
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push({ node, start: text.length });
      text += node.nodeValue ?? "";
    }
    if (nodes.length === 0) return null;

    const found = span(text, input.claim);
    if (!found) return null;

    const at = (offset: number, isEnd: boolean): { node: Node; offset: number } => {
      for (const entry of nodes) {
        const length = (entry.node.nodeValue ?? "").length;
        const inside = isEnd ? offset <= entry.start + length : offset < entry.start + length;
        if (inside) return { node: entry.node, offset: offset - entry.start };
      }
      const last = nodes[nodes.length - 1]!;
      return { node: last.node, offset: (last.node.nodeValue ?? "").length };
    };

    const start = at(found[0], false);
    const end = at(found[1], true);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  /** The proposed copy as the paragraphs it was written as. */
  function paragraphs(): string[] {
    return input.proposedText
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
  }

  /**
   * Put the copy in. A replace swaps the quoted run and leaves the links and
   * code around it alone; an insert leaves the line where it is and puts the
   * new copy next to it. Extra paragraphs are shallow clones of the element
   * they follow, so they inherit the page's own styling for a paragraph.
   */
  function applyEdit(element: HTMLElement): boolean {
    const copy = paragraphs();
    if (copy.length === 0) return false;

    store.__happeningsOriginal = element.innerHTML;
    let anchor: Element = element;
    let rest = copy;

    if (input.editKind !== "insert") {
      const range = rangeFor(element);
      if (!range) return false;
      range.deleteContents();
      range.insertNode(document.createTextNode(copy[0]!));
      rest = copy.slice(1);
    }

    for (const extra of rest) {
      const sibling = element.cloneNode(false) as HTMLElement;
      sibling.textContent = extra;
      sibling.setAttribute(INSERTED, "");
      anchor.after(sibling);
      anchor = sibling;
    }
    return true;
  }

  /**
   * Anything floating over the paragraph, hidden. A sticky header or a chat
   * bubble sitting on the words is in both shots and in the way of both. The
   * sidebar and the header that are not over it stay, because they are what
   * makes this a picture of the docs site.
   */
  function hideOverlays(element: HTMLElement): void {
    const target = element.getBoundingClientRect();
    for (const node of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const { position } = window.getComputedStyle(node);
      if (position !== "fixed" && position !== "sticky") continue;
      if (node.contains(element)) continue;
      const rect = node.getBoundingClientRect();
      const overlaps =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left < target.right &&
        rect.right > target.left &&
        rect.top < target.bottom &&
        rect.bottom > target.top;
      if (overlaps) node.style.visibility = "hidden";
    }
  }

  /** Park the paragraph a quarter of the way down the window. */
  function place(element: HTMLElement): number {
    const top = element.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, Math.round(top - window.innerHeight * SCROLL_FRACTION)));
    return window.scrollY;
  }

  /** How far the edited copy runs past the bottom of the window. */
  function overflowBy(element: HTMLElement): number {
    let bottom = element.getBoundingClientRect().bottom;
    for (const sibling of Array.from(document.querySelectorAll<HTMLElement>(`[${INSERTED}]`))) {
      bottom = Math.max(bottom, sibling.getBoundingClientRect().bottom);
    }
    return Math.max(0, Math.round(bottom - window.innerHeight));
  }

  const marked = document.querySelector<HTMLElement>(`[${MARKER}]`);

  if (input.action === "restore") {
    if (!marked || store.__happeningsOriginal === undefined) {
      return { status: "failed", reason: "nothing was staged to restore" };
    }
    marked.innerHTML = store.__happeningsOriginal;
    for (const sibling of Array.from(document.querySelectorAll(`[${INSERTED}]`))) sibling.remove();
    delete store.__happeningsOriginal;
    marked.removeAttribute(MARKER);
    return { status: "ok", scrollY: window.scrollY, overflowBy: 0 };
  }

  if (input.action === "apply") {
    if (!marked) return { status: "failed", reason: "the line was never located" };
    if (!applyEdit(marked)) return { status: "failed", reason: "the copy would not go in" };
    if (input.scrollY !== undefined) window.scrollTo(0, input.scrollY);
    return { status: "ok", scrollY: window.scrollY, overflowBy: overflowBy(marked) };
  }

  const found = locate();
  if (found === "missing" || found === "split") return { status: found };
  found.setAttribute(MARKER, "");
  const scrollY = place(found);
  hideOverlays(found);
  return { status: "ok", scrollY, overflowBy: 0 };
}

/**
 * Everything the page needs to ask for, and nothing that only watches it. The
 * site's own requests, plus anybody's fonts, images and stylesheets; a third
 * party's script, which is what an analytics tag, a chat bubble and a cookie
 * banner all are, gets nothing.
 */
export function allowed(pageHost: string, requestHost: string, resourceType: string): boolean {
  if (PASSIVE_RESOURCES.has(resourceType)) return true;
  const site = pageHost.split(".").slice(-2).join(".");
  return requestHost === pageHost || requestHost === site || requestHost.endsWith(`.${site}`);
}

/**
 * One call to {@link stagePageEdit}, as a source string the page evaluates.
 *
 * Handing Playwright the function itself is the obvious way and it breaks in
 * production only. Playwright ships a function by calling `toString()` on it,
 * and the app runs through `tsx`, whose bundler rewrites every nested function
 * declaration as `__name(fn, "fn")` to keep names in stack traces. That helper
 * lives in the module and not in the page, so the browser throws `__name is not
 * defined` – on a morning run, never under the test runner, whose transform
 * does not add it. A no-op `__name` in the closure the call is made from costs
 * a line and makes both run the same way.
 *
 * The argument is baked into the source because a string expression is
 * evaluated and not called: Playwright passes arguments to a function it was
 * given as a function, and to nothing else.
 *
 * Exported so a test drives the same path a morning run does.
 */
export function stageExpression(input: StageInput): string {
  return `(() => { const __name = (fn) => fn; return (${stagePageEdit.toString()})(${JSON.stringify(input)}); })()`;
}

async function stage(page: Page, input: StageInput): Promise<StageOutcome> {
  return page.evaluate<StageOutcome>(stageExpression(input));
}

/**
 * Photograph one page edit: the page as it reads today, then the same page with
 * the proposed copy in the browser's copy of the document.
 *
 * The shots are of the **window**, not of the document, so what comes back is
 * the page as a visitor has it on screen – navigation, sidebar, the real type –
 * rather than a strip of prose. Both are taken at the same scroll offset, so
 * flipping between them in an issue moves only the words that changed.
 */
export async function captureEdit(
  browser: Browser,
  plan: PageEditPlan,
  options: CaptureOptions,
): Promise<CaptureResult> {
  const context = await browser.newContext({
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 2,
    // A signed-out visitor on a default machine sees the light theme, and so
    // does whoever opens the issue. A dark shot of a light page is a picture of
    // somebody else's browser.
    colorScheme: "light",
    reducedMotion: "reduce",
    userAgent: options.userAgent,
  });

  try {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("theme", "light");
      } catch {
        // A page that forbids storage keeps whatever theme it defaults to.
      }
    });

    const pageHost = new URL(plan.pageUrl).hostname;
    await context.route("**/*", async (route) => {
      let host: string;
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        await route.abort();
        return;
      }
      // Analytics, chat widgets and ad pixels change what the page looks like
      // between two runs and none of them are the page.
      if (allowed(pageHost, host, route.request().resourceType())) await route.continue();
      else await route.abort();
    });

    const page = await context.newPage();
    const response = await page.goto(plan.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    if (!response) return { status: "skipped", reason: "the page never answered" };
    if (!response.ok()) {
      return { status: "skipped", reason: `the page answered ${response.status()}` };
    }
    if (new URL(page.url()).hostname !== pageHost) {
      return { status: "skipped", reason: `it redirected to ${page.url()}` };
    }
    if (CHALLENGE_TITLE.test(await page.title())) {
      return { status: "skipped", reason: "a bot check was served instead of the page" };
    }

    // A shot taken while the webfont is still loading is a shot of the fallback
    // face, and an animation caught mid-way is a shot that differs every run.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.addStyleTag({
      content:
        "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; } html { scroll-behavior: auto !important; }",
    });

    let height: number = VIEWPORT.height;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const located = await stage(page, { action: "locate", ...edit(plan) });
      if (located.status === "missing") return { status: "missing" };
      if (located.status === "split") {
        return {
          status: "skipped",
          reason: "the quoted line runs across two blocks, so there is no one paragraph to edit",
        };
      }
      if (located.status === "failed") return { status: "skipped", reason: located.reason };

      const before = await page.screenshot({ type: "png" });
      const applied = await stage(page, {
        action: "apply",
        ...edit(plan),
        scrollY: located.scrollY,
      });
      if (applied.status !== "ok") {
        return {
          status: "skipped",
          reason: applied.status === "failed" ? applied.reason : applied.status,
        };
      }

      // The new copy runs off the bottom of the window, so the After would cut
      // it off. Grow the window once and take the pair again, both at the new
      // size: a Before and an After of two different windows is worse than no
      // picture at all.
      const grown = Math.min(MAX_VIEWPORT_HEIGHT, height + applied.overflowBy + 48);
      if (applied.overflowBy > 0 && attempt === 0 && grown > height) {
        const restored = await stage(page, { action: "restore", ...edit(plan) });
        if (restored.status !== "ok") {
          return { status: "skipped", reason: "the page could not be put back for a second try" };
        }
        height = grown;
        await page.setViewportSize({ width: VIEWPORT.width, height });
        continue;
      }

      return { status: "captured", before, after: await page.screenshot({ type: "png" }) };
    }

    return { status: "skipped", reason: "the page would not hold still" };
  } catch (error) {
    return { status: "skipped", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** The three things the browser side needs off a plan. */
function edit(plan: PageEditPlan): Pick<StageInput, "claim" | "proposedText" | "editKind"> {
  return { claim: plan.claim, proposedText: plan.proposedText, editKind: plan.editKind };
}
