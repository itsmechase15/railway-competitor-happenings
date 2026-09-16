import type { EditKind, RailwayRef } from "../types.js";
import { pageNameFromUrl, sha1, titleFromUrl } from "../util/text.js";
import { diffSummary, diffWords } from "./diff.js";

/**
 * What there is to photograph about one page edit: which page, which line on
 * it, the copy that replaces the line, and how much that moves.
 *
 * The picture itself is two screenshots of the live page taken by
 * [`live-page.ts`](./live-page.ts) – the page as it reads today, and the same
 * page with the proposed copy staged in the browser and published nowhere.
 * This file is the part that needs no browser: finding the line, counting what
 * changed, and naming the files the PNGs go in.
 *
 * The stored corpus is still what the claim is checked against – the evidence
 * gate has already done that, on the text the analyst read. It is only not what
 * the picture is *of* any more. A reader looking at an issue about their own
 * docs page should be looking at their own docs page.
 */

/** Everything needed to photograph one page edit, and nothing that needs a network. */
export interface PageEditPlan {
  pageUrl: string;
  /** The page as a heading reads it: "Compare to render". */
  pageName: string;
  editKind: EditKind;
  /** The line on the page today, verbatim, as the evidence gate checked it. */
  claim: string;
  /** The copy the issue asks somebody to put there. */
  proposedText: string;
  /** What changed, in words. Shown under the pair and in the issue body. */
  summary: string;
  beforeAlt: string;
  afterAlt: string;
  /** Where the two PNGs go, relative to the repo root. */
  beforePath: string;
  afterPath: string;
  /** The day the pair is taken on, which is the day the Before is true for. */
  capturedOn: string;
  /**
   * Whether the stored copy of the page still has the quoted line on it. It is
   * what makes a line the live page does not have worth saying out loud: the
   * page has moved on since the corpus read it, and the recommendation may
   * have moved with it.
   */
  quotedOnStoredPage: boolean;
}

/** A Before/After pair an issue body can embed, once something has published the PNGs. */
export interface PageShots {
  /**
   * Where the reader's browser fetches each image from. `github.com` addresses
   * with no credential in them, because this repo is private and the issue has
   * to still show the pictures next week – see `src/github/artifact.ts`.
   */
  beforeUrl: string;
  afterUrl: string;
  beforeAlt: string;
  afterAlt: string;
}

/**
 * What the capture had to say about one page, for the issue to show.
 *
 * Two shots is the normal outcome. `shots: null` with `copyMissingLive` set is
 * the other one worth reporting: the line this action quotes is on the stored
 * page and is not on the live page any more, which the person opening the issue
 * needs to know before they go and edit it.
 */
export interface PageVisual {
  pageUrl: string;
  shots: PageShots | null;
  /** What changed, in words. */
  summary: string;
  /** The date the live page was read, as `YYYY-MM-DD`. */
  capturedOn: string;
  /** The quoted line was not found on the live page that day. */
  copyMissingLive: boolean;
}

/** Where every one of these lands in the repo, so they are one folder to prune. */
export const VISUAL_DIR = "artifacts/update-pages";

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
 * Where a quoted line sits inside a longer text, compared on letters and digits
 * only.
 *
 * The quote is verbatim off the page and the evidence gate has already checked
 * that, but it checks the same forgiving way: a claim can differ from the
 * stored text by a curly apostrophe or a collapsed run of spaces and still be
 * the same line. A plain `indexOf` misses those. The browser-side locator in
 * [`live-page.ts`](./live-page.ts) folds the same way, so a line this finds in
 * the corpus is a line that is looked for the same way on the page.
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
  // sentence would be left outside it. Punctuation that trails the match
  // belongs to it; the whitespace after it does not.
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

/** Today, as the date a capture is stamped and filed under. */
export function captureDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The two files one edit's pair goes in. The hash covers the page, both sides
 * of the edit **and the day**, so the same recommendation drawn twice in one
 * morning reuses the files, and a re-run next week photographs the page as it
 * is next week rather than reusing a Before that has gone stale.
 */
export function visualPaths(ref: RailwayRef, capturedOn: string): { before: string; after: string } {
  const digest = sha1(
    `${ref.url}\n${ref.claim}\n${ref.proposedText ?? ""}\n${capturedOn}`,
  ).slice(0, 10);
  const stem = `${VISUAL_DIR}/${pathSlug(ref.url)}-${digest}`;
  return { before: `${stem}-before.png`, after: `${stem}-after.png` };
}

/**
 * Plan the pair for one page edit, or return null when there is nothing honest
 * to photograph: no proposed copy means no After, and no quoted line means
 * nothing to find on the page.
 */
export function planPageEdit(
  ref: RailwayRef,
  pageText: string | undefined,
  capturedOn = captureDate(),
): PageEditPlan | null {
  const proposed = ref.proposedText?.trim();
  const claim = ref.claim.trim();
  if (!proposed || !claim) return null;

  const editKind = ref.editKind ?? "replace";
  // An insert removes nothing, so the whole of the proposed copy is what
  // arrives; a replace is measured against the line it replaces.
  const summary = diffSummary(diffWords(editKind === "insert" ? "" : claim, proposed));
  const name = pageNameFromUrl(ref.url);
  const paths = visualPaths(ref, capturedOn);

  return {
    pageUrl: ref.url,
    pageName: titleFromUrl(ref.url),
    editKind,
    claim,
    proposedText: proposed,
    summary,
    beforeAlt: `${pageNameFromUrl(ref.url)} as it reads today, the quoted line in place`,
    afterAlt: `${name} with the proposed copy in it, highlighted in yellow: ${summary}`,
    beforePath: paths.before,
    afterPath: paths.after,
    capturedOn,
    quotedOnStoredPage: pageText ? paragraphWith(pageText, claim) !== null : false,
  };
}
