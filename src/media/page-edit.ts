import type { EditKind, RailwayRef } from "../types.js";
import { pageNameFromUrl, sha1, titleFromUrl } from "../util/text.js";
import { afterSpans, diffSummary, diffWords, wordCount } from "./diff.js";

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
  /**
   * The same copy, paragraph by paragraph, split into the runs the After shot
   * paints and the runs it leaves plain. This is what the browser stages, so
   * the only words that end up highlighted are the words the page does not
   * have today.
   */
  copy: CopyRun[][];
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
   * pinned to a commit and with no credential in them, because the issue has to
   * still show the pictures next week – see `src/github/artifact.ts`.
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

/** A text as the paragraphs it was written as, blank ones dropped. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** The paragraph a quoted line is on. Corpus text keeps its paragraph breaks. */
export function paragraphWith(pageText: string, claim: string): string | null {
  for (const paragraph of paragraphsOf(pageText)) {
    if (looseSpan(paragraph, claim)) return paragraph;
  }
  return null;
}

/** One run of the proposed copy, and whether the After shot paints it. */
export interface CopyRun {
  text: string;
  /** The page does not say these words today, so this run is the edit. */
  isNew: boolean;
}

/**
 * How short a retained run has to be before the highlight closes over it
 * rather than breaking around it.
 *
 * A replacement usually keeps some of the line it replaces, and those words
 * are the page's rather than the edit's, so they stay plain. But a word or two
 * the copy happens to share with the old line – "a web service", "it", the
 * competitor's name – is not wording anybody recognizes as the page's, and
 * painting around each of them turns one new sentence into confetti. So a
 * short retained run inside new copy is treated as part of it. A run at either
 * end is never absorbed, however short: the words leading into or out of the
 * edit are where the page's own prose picks up again.
 */
const MIN_RETAINED_WORDS = 5;

/**
 * The proposed copy as runs, marked with what the page does not have yet.
 *
 * This is the whole of the delta the After shot points at. Wrapping the copy
 * in one mark is what it used to do, and on a replacement that keeps a
 * sentence of the old line – the common shape, because an edit usually adds to
 * a paragraph rather than rewriting it – that painted the page's own prose as
 * if the bot had written it.
 *
 * Only the paragraph that takes the line's place is measured against it, so a
 * replacement that keeps the sentence it replaces leaves that sentence plain.
 * Everything after it arrives as a new block on the page and is new in full,
 * and so is an insert, which takes nothing off the page at all. That is the
 * same basis the caption's word counts use.
 */
export function copyRuns(claim: string, proposedText: string, editKind: EditKind): CopyRun[][] {
  return paragraphsOf(proposedText).map((paragraph, index) =>
    runsFor(editKind === "insert" || index > 0 ? "" : claim, paragraph),
  );
}

function runsFor(basis: string, paragraph: string): CopyRun[] {
  const runs = afterSpans(basis, paragraph).map((span) => ({
    text: span.text,
    isNew: span.kind === "added",
  }));
  return unpaintEdges(absorbShortRetained(runs));
}

/** Consecutive runs of the same kind are one run, so a mark is never split in two. */
function append(runs: CopyRun[], run: CopyRun): void {
  const last = runs[runs.length - 1];
  if (last && last.isNew === run.isNew) last.text += run.text;
  else runs.push({ ...run });
}

/** Retained wording too short to recognize, when new copy runs either side of it. */
function absorbShortRetained(runs: CopyRun[]): CopyRun[] {
  const absorbed: CopyRun[] = [];
  for (const [index, run] of runs.entries()) {
    const island = index > 0 && index < runs.length - 1;
    const short = wordCount(run.text) < MIN_RETAINED_WORDS;
    append(absorbed, { ...run, isNew: run.isNew || (island && short) });
  }
  return absorbed;
}

/**
 * The space around a run belongs outside the mark. A highlight that closes
 * over the space after its last word is a yellow tab hanging off the end of
 * the sentence.
 */
function unpaintEdges(runs: CopyRun[]): CopyRun[] {
  const tidied: CopyRun[] = [];
  for (const run of runs) {
    if (!run.isNew) {
      append(tidied, run);
      continue;
    }
    const lead = run.text.length - run.text.trimStart().length;
    const trail = run.text.length - run.text.trimEnd().length;
    if (lead > 0) append(tidied, { text: run.text.slice(0, lead), isNew: false });
    const core = run.text.slice(lead, run.text.length - trail);
    if (core !== "") append(tidied, { text: core, isNew: true });
    if (trail > 0) append(tidied, { text: run.text.slice(run.text.length - trail), isNew: false });
  }
  return tidied;
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
    copy: copyRuns(claim, proposed, editKind),
    summary,
    beforeAlt: `${pageNameFromUrl(ref.url)} as it reads today, the quoted line in place`,
    afterAlt: `${name} with the proposed copy in it, highlighted in yellow: ${summary}`,
    beforePath: paths.before,
    afterPath: paths.after,
    capturedOn,
    quotedOnStoredPage: pageText ? paragraphWith(pageText, claim) !== null : false,
  };
}
