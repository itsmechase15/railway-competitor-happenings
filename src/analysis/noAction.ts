import type { CorpusIndex } from "../railway/retrieval.js";
import type { Analysis, NoAction, NoActionEvidence, NoActionKind } from "../types.js";
import { pageNameFromUrl, SPACED_EN_DASH, truncate } from "../util/text.js";

/**
 * Zero actions, rendered as an answer.
 *
 * The line this replaces was true and told a reader nothing: it named no
 * capability, no page, and nobody could tell it apart from a bug. So the
 * verdict has a kind, a sentence about this launch, and the pages it rests on,
 * every surface renders the same three things, and this is the only place that
 * decides what they look like.
 *
 * Discord and GitHub write bold and links the same way, so there is one
 * rendering rather than one per surface. What differs is what each surface has
 * to escape and how much room it has, and both of those are arguments.
 */

/**
 * Said when an analysis recommends nothing and offers no verdict at all. It is
 * not a failure – zero actions is a normal answer – but it is not an answer
 * either, so it says which part is missing rather than filling the space.
 */
export const UNSTATED_NO_ACTION_REASON =
  "The analysis recommended nothing and cited no Railway page, so nothing here has been checked against what Railway ships.";

/** What the verdict is called, by kind. The product is named where it reads better. */
export function noActionTitle(kind: NoActionKind, product = "Railway"): string {
  switch (kind) {
    case "already_covered":
      return `None${SPACED_EN_DASH}${product} already does this`;
    case "not_a_gap":
      return `None${SPACED_EN_DASH}not a product gap`;
    case "unverified":
      return `None${SPACED_EN_DASH}the gap could not be confirmed`;
    case "dropped_on_review":
      return `None${SPACED_EN_DASH}dropped on review`;
    case "unanalyzed":
      return `None${SPACED_EN_DASH}not analyzed this run`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Enough pages to show the verdict is real. Past this it is a reading list. */
export const MAX_NO_ACTION_LINKS = 3;

export interface NoActionRenderOptions {
  /**
   * What the surface has to do to every string before it renders it. Discord
   * passes its markdown escaper; a GitHub issue body needs none.
   */
  escape?: (text: string) => string;
  /** Characters the reason is cut to. An embed field stops at 1024. */
  maxChars?: number;
  product?: string;
}

/** Long enough for a docs page title, short enough not to fill the block. */
const MAX_LABEL_CHARS = 140;

/** The label on an evidence link: the page's own title, or its path. */
export function evidenceLabel(evidence: NoActionEvidence): string {
  return truncate(evidence.title?.trim() || pageNameFromUrl(evidence.url), MAX_LABEL_CHARS);
}

/**
 * The verdict as one block of text.
 *
 * Title, reason, then the pages, in that order, because the title is what gets
 * read on a phone and the pages are what settle an argument about it. A URL is
 * never escaped: escaping one breaks the link it is inside.
 */
export function renderNoAction(noAction: NoAction, options: NoActionRenderOptions = {}): string {
  const escape = options.escape ?? ((text: string) => text);
  const title = noActionTitle(noAction.kind, options.product);
  const reason = options.maxChars ? truncate(noAction.reason, options.maxChars) : noAction.reason;

  const links = noAction.evidence
    .filter((entry) => /^https?:\/\//i.test(entry.url))
    .slice(0, MAX_NO_ACTION_LINKS)
    .map((entry) => `[${escape(evidenceLabel(entry))}](${entry.url})`);

  const lines = [`**${escape(title)}**`, escape(reason)];
  if (links.length > 0) lines.push(`See: ${links.join(", ")}`);
  return lines.join("\n");
}

/**
 * The verdict to render for an analysis that recommends nothing.
 *
 * A row stored before the verdict had a shape carries the sentence and nothing
 * else, which is an unverified verdict with no pages under it: that is what it
 * was, so that is what it renders as.
 */
export function noActionOf(analysis: Analysis): NoAction {
  if (analysis.noAction) return analysis.noAction;
  return {
    kind: "unverified",
    reason: analysis.noActionReason?.trim() || UNSTATED_NO_ACTION_REASON,
    evidence: [],
  };
}

/**
 * Put a verdict on an analysis, both ways round. Every writer goes through
 * here, so the string and the structure can never disagree.
 */
export function withNoAction(analysis: Analysis, noAction: NoAction): Analysis {
  return { ...analysis, noAction, noActionReason: noAction.reason };
}

/** A page named by URL, with the title the corpus holds for it when it holds one. */
export function evidenceFor(index: CorpusIndex, url: string, quote?: string): NoActionEvidence {
  const page = index.page(url);
  return {
    url,
    ...(page?.title ? { title: page.title } : {}),
    ...(quote ? { quote } : {}),
  };
}
