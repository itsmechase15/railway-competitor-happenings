import { changedWords, diffWords, wordCount } from "../media/diff.js";
import { paragraphWith } from "../media/page-edit.js";
import type { RailwayRef } from "../types.js";

/**
 * How much copy one page edit may add, measured against the page it lands on.
 *
 * `update_pages` exists because a launch can make a Railway page wrong, and the
 * fix for a wrong page is usually a clause, a sentence, or a table row. What it
 * keeps turning into is a write-up of the competitor's launch pasted into
 * whichever paragraph mentioned them: four sentences of somebody else's pricing
 * mechanics on a page whose own paragraph runs to two. The page is then mostly
 * about the competitor, which is not what a comparison page is for, and nobody
 * making the edit can tell which half of it they actually needed.
 *
 * So the size of an edit is checked the way everything else here is checked:
 * against the stored page, in code, before anyone is asked to make it. An edit
 * that adds more than the passage it joins is out of proportion whatever it
 * says, and on a page of two or three paragraphs that leaves room for a
 * sentence or two, which is what a short page can carry.
 *
 * There is no way to shorten it here without writing it, which this file does
 * not do. A page edit that fails is dropped with an open question, exactly like
 * a gap claim whose evidence fails; the analyst is told the rule up front and
 * the review pass can ask for a shorter one, and both of those produce copy a
 * person wrote rather than copy this inferred.
 */

/**
 * The most an edit may add before it stops being an edit, on a page where the
 * passage is short or the page itself is. A sentence or two always fits: the
 * point is to bound what gets added, not to make a real correction unfileable.
 */
export const MIN_ADDED_WORDS = 45;

/** The share of a whole page one edit may add to it, however long the page runs. */
export const MAX_PAGE_SHARE = 0.2;

/** One page edit, in the sizes that decide whether it is in proportion. */
export interface EditProportion {
  /** Words the edit puts on the page that are not on it today. */
  added: number;
  /** The passage the edit lands in, as the page has it today. */
  passage: number;
  /** The whole page, today. */
  page: number;
  /** The most this page should take in one edit. */
  allowed: number;
}

/**
 * What an edit adds, and what the page it lands on can carry.
 *
 * The passage is the local scale and the page is the outer bound: an edit may
 * double the paragraph it joins at most, and never add more than a fifth of the
 * page. Null when there is nothing to measure – no copy, or no stored page to
 * measure it against – because an unmeasurable edit is not an oversized one,
 * and the copy checks catch the missing half.
 */
export function measureEdit(ref: RailwayRef, pageText: string | undefined): EditProportion | null {
  const proposed = ref.proposedText?.trim();
  if (!proposed || !pageText?.trim()) return null;

  const claim = ref.claim.trim();
  // An insert takes nothing off the page, so all of it arrives; a replace is
  // measured against the line it replaces. The same basis the caption under the
  // Before/After counts words on, so the issue and this check agree.
  const basis = ref.editKind === "insert" ? "" : claim;
  const passage = wordCount(paragraphWith(pageText, claim) ?? claim);
  const page = wordCount(pageText);

  return {
    added: changedWords(diffWords(basis, proposed)).added,
    passage,
    page,
    allowed: allowedWords(passage, page),
  };
}

/** The most one edit may add to a passage of this length on a page of that length. */
export function allowedWords(passage: number, page: number): number {
  return Math.max(MIN_ADDED_WORDS, Math.min(passage, Math.round(MAX_PAGE_SHARE * page)));
}

export function isOutOfProportion(proportion: EditProportion): boolean {
  return proportion.added > proportion.allowed;
}

/** The sizes as a clause, for the open question a dropped edit leaves behind. */
export function describeProportion(url: string, proportion: EditProportion): string {
  return `it puts ${proportion.added} words onto a ${proportion.passage}-word passage on ${url}, a ${proportion.page}-word page where ${proportion.allowed} words is the most one edit should add`;
}

/** The same sizes as a line a model is given, so it writes to what the page can take. */
export function renderProportion(url: string, proportion: EditProportion): string {
  return `${url} runs to ${proportion.page} words and the passage this edit lands in runs to ${proportion.passage}, so at most ${proportion.allowed} words of this copy may be words the page does not have today. The copy proposed for it adds ${proportion.added}.`;
}
