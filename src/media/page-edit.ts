import type { EditKind, RailwayRef } from "../types.js";
import { pageNameFromUrl, sha1, titleFromUrl, truncate } from "../util/text.js";
import { diffSummary, diffWords, panelSpans, type DiffSpan } from "./diff.js";

/**
 * A Before/After picture of one page edit, drawn from the corpus and never from
 * the live page.
 *
 * An `update_pages` issue already carries the page, the line on it today, and
 * the copy to paste. What it cannot do in text is show a reader what the
 * paragraph looks like with the edit in it, which is the question anybody asked
 * to make the edit has first. So the paragraph is rendered twice, side by side,
 * with the words that changed marked.
 *
 * Two things this deliberately does not do:
 *
 * - **It does not touch the live page.** The Before panel is the paragraph as
 *   the stored corpus copy has it, which is the same text the analyst read and
 *   the same text the evidence gate checked the quote against. Loading
 *   railway.com and editing the DOM would be a picture of a page that no longer
 *   matches the copy anybody reviewed, and it would put this bot's browser on
 *   Railway's own site every morning.
 * - **It never becomes the recommendation.** The picture is an illustration of
 *   an edit that has already survived every check. A run that cannot draw it
 *   files the issue in text, unchanged.
 */

/** One panel of the picture: unchanged prose, the changed run, unchanged prose. */
export interface VisualPanel {
  /** The paragraph before the edit lands. Empty when the edit is the whole paragraph. */
  lead: string;
  /** The part that differs, word by word. */
  spans: DiffSpan[];
  /** The rest of the paragraph after it. */
  tail: string;
}

/** Everything needed to draw one page edit, and nothing that needs a network. */
export interface PageEditPlan {
  pageUrl: string;
  /** The page as the picture's own heading reads it: "Compare to render". */
  pageName: string;
  editKind: EditKind;
  before: VisualPanel;
  after: VisualPanel;
  /** What changed, in words. Shown under the image and in the issue body. */
  summary: string;
  altText: string;
  /**
   * Where the PNG goes, relative to the repo root. Derived from the page and
   * the copy, so re-running a day later writes the same file rather than a
   * second copy of it.
   */
  path: string;
  /**
   * Whether the paragraph around the edit came off the stored page. False when
   * the corpus had nothing for this URL, in which case the panels show the
   * quoted line alone and the picture says so.
   */
  fromCorpus: boolean;
}

/** A Before/After the issue body can embed, once something has published the PNG. */
export interface PageVisual {
  pageUrl: string;
  /** The raw URL GitHub renders the image from. */
  imageUrl: string;
  altText: string;
  summary: string;
}

/** Where every one of these lands in the repo, so they are one folder to prune. */
export const VISUAL_DIR = "artifacts/update-pages";

/**
 * Long enough for the paragraph an edit sits in, short enough that the picture
 * stays one screenshot. A page edit longer than this is drawn truncated rather
 * than not drawn.
 */
const MAX_PANEL_CHARS = 1_200;

/** Indices of every letter and digit in a string, and those characters folded. */
function fold(text: string): { folded: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!.toLowerCase();
    if (/[a-z0-9]/.test(char)) {
      folded += char;
      at.push(index);
    }
  }
  return { folded, at };
}

/**
 * Where a quoted line sits inside a paragraph, compared on letters and digits
 * only.
 *
 * The quote is verbatim off the page and the evidence gate has already checked
 * that, but it checks the same forgiving way: a claim can differ from the stored
 * text by a curly apostrophe or a collapsed run of spaces and still be the same
 * line. A plain `indexOf` misses those, and missing one would draw the whole
 * paragraph as replaced.
 */
export function looseSpan(haystack: string, needle: string): [number, number] | null {
  const hay = fold(haystack);
  const wanted = fold(needle);
  if (wanted.folded === "" || hay.folded === "") return null;

  const found = hay.folded.indexOf(wanted.folded);
  if (found === -1) return null;

  const start = hay.at[found]!;
  let end = hay.at[found + wanted.folded.length - 1]! + 1;

  // The match ends on the last letter, so the full stop that closes the quoted
  // sentence would be left outside it and drawn as unchanged text after the
  // replacement, which reads as a stray period. Punctuation that trails the
  // match belongs to it; the whitespace after it does not.
  while (end < haystack.length && /[^\p{Letter}\p{Number}\s]/u.test(haystack[end]!)) end += 1;

  return [start, end];
}

/** The paragraph a quoted line is on. Corpus text keeps its paragraph breaks. */
export function paragraphWith(pageText: string, claim: string): string | null {
  for (const paragraph of pageText.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed && looseSpan(trimmed, claim)) return trimmed;
  }
  return null;
}

/** The page's own path as a file name fragment: "platform-compare-to-render". */
function pathSlug(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return (
    path
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page"
  );
}

/**
 * The file one edit's picture goes in. The hash is of the page and both sides of
 * the edit, so the same recommendation lands on the same path however many times
 * it is drawn, and a rewritten edit gets a file of its own rather than
 * overwriting the picture an already-open issue points at.
 */
export function visualPath(ref: RailwayRef): string {
  const digest = sha1(`${ref.url}\n${ref.claim}\n${ref.proposedText ?? ""}`).slice(0, 10);
  return `${VISUAL_DIR}/${pathSlug(ref.url)}-${digest}.png`;
}

/**
 * Plan the picture for one page edit, or return null when there is nothing
 * honest to draw: no proposed copy means no After panel, and an edit is not
 * worth a picture of the copy that is already in the issue.
 */
export function planPageEdit(ref: RailwayRef, pageText: string | undefined): PageEditPlan | null {
  const proposed = ref.proposedText?.trim();
  if (!proposed || !ref.claim.trim()) return null;

  const paragraph = pageText ? paragraphWith(pageText, ref.claim) : null;
  const context = paragraph ?? ref.claim.trim();
  const span = looseSpan(context, ref.claim) ?? [0, context.length];

  const lead = truncate(context.slice(0, span[0]), MAX_PANEL_CHARS);
  const tail = truncate(context.slice(span[1]), MAX_PANEL_CHARS);
  const quoted = context.slice(span[0], span[1]);
  const editKind = ref.editKind ?? "replace";

  // An insert removes nothing, so there is no word-level diff to draw: the line
  // stays and the new copy arrives next to it.
  const spans: DiffSpan[] =
    editKind === "insert"
      ? [
          { kind: "same", text: quoted },
          { kind: "added", text: `\n\n${proposed}` },
        ]
      : diffWords(quoted, proposed);

  const summary = diffSummary(spans);

  return {
    pageUrl: ref.url,
    pageName: titleFromUrl(ref.url),
    editKind,
    before: { lead, spans: panelSpans(spans, "before"), tail },
    after: { lead, spans: panelSpans(spans, "after"), tail },
    summary,
    altText: `Before and after of ${pageNameFromUrl(ref.url)}: ${summary}`,
    path: visualPath(ref),
    fromCorpus: paragraph !== null,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A paragraph break in the copy is a paragraph break in the picture. */
function withBreaks(text: string): string {
  return escapeHtml(text).replace(/\n{2,}/g, "<br /><br />").replace(/\n/g, "<br />");
}

/**
 * One span, with any whitespace at its edges left outside the highlight. A
 * marked-up run that ends in a space draws a coloured box hanging off the last
 * word, and a run that starts with a paragraph break draws an empty coloured
 * block above itself.
 */
function renderSpan(span: DiffSpan): string {
  if (span.kind === "same") return withBreaks(span.text);

  const [, lead = "", body = "", tail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(span.text) ?? [];
  if (!body) return withBreaks(span.text);

  return `${withBreaks(lead)}<mark class="${span.kind}">${withBreaks(body)}</mark>${withBreaks(tail)}`;
}

function renderPanel(panel: VisualPanel): string {
  const spans = panel.spans.map(renderSpan).join("");
  return `${withBreaks(panel.lead)}${spans}${withBreaks(panel.tail)}`;
}

const EDIT_KIND_NOTE: Record<EditKind, string> = {
  replace: "replaces the highlighted line",
  insert: "goes in next to the highlighted line",
};

/**
 * The picture as a page a browser can screenshot.
 *
 * Kept as one self-contained document with no network of its own: no webfont, no
 * stylesheet, no image. A screenshot that waits on a font is a screenshot that
 * sometimes renders in a fallback face and sometimes times out, and neither is
 * worth a nicer heading.
 */
export function visualHtml(plan: PageEditPlan): string {
  const source = plan.fromCorpus
    ? "Rendered from the stored corpus copy of this page, not from the live page."
    : "The corpus held no copy of this page, so only the quoted line is shown.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px;
    width: 1200px;
    background: #0d1117;
    color: #e6edf3;
    font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  header { margin-bottom: 18px; }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .url { font-size: 13px; color: #7d8590; word-break: break-all; }
  .panels { display: flex; gap: 16px; align-items: stretch; }
  section {
    flex: 1 1 0;
    min-width: 0;
    border: 1px solid #30363d;
    border-radius: 8px;
    background: #161b22;
    overflow: hidden;
  }
  h2 {
    margin: 0;
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #7d8590;
    border-bottom: 1px solid #30363d;
    background: #0d1117;
  }
  .copy { padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; }
  mark { padding: 1px 2px; border-radius: 3px; color: #e6edf3; }
  mark.removed { background: rgba(248, 81, 73, 0.28); text-decoration: line-through; text-decoration-color: rgba(248, 81, 73, 0.9); }
  mark.added { background: rgba(63, 185, 80, 0.28); }
  footer { margin-top: 16px; font-size: 12px; color: #7d8590; display: flex; gap: 18px; flex-wrap: wrap; }
  .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: baseline; }
  .swatch.removed { background: rgba(248, 81, 73, 0.6); }
  .swatch.added { background: rgba(63, 185, 80, 0.6); }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(plan.pageName)}${" \u2013 "}the proposed copy ${EDIT_KIND_NOTE[plan.editKind]}</h1>
  <div class="url">${escapeHtml(plan.pageUrl)}</div>
</header>
<div class="panels">
  <section>
    <h2>Before ${"\u00b7"} the page today</h2>
    <div class="copy">${renderPanel(plan.before)}</div>
  </section>
  <section>
    <h2>After ${"\u00b7"} with this edit</h2>
    <div class="copy">${renderPanel(plan.after)}</div>
  </section>
</div>
<footer>
  <span><span class="swatch removed"></span>removed</span>
  <span><span class="swatch added"></span>added</span>
  <span>${escapeHtml(plan.summary)}</span>
  <span>${escapeHtml(source)}</span>
</footer>
</body>
</html>`;
}
