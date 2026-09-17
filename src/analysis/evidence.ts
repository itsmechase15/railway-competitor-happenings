import { isMarketingTarget } from "../railway/pages.js";
import { matchProducts } from "../railway/products.js";
import { terms, type CorpusIndex, type RetrievalHit } from "../railway/retrieval.js";
import type {
  Analysis,
  NoAction,
  NoActionEvidence,
  NoActionKind,
  RailwayRef,
  RecommendedAction,
} from "../types.js";
import { firstSentence, truncate } from "../util/text.js";
import { evidenceFor, noActionOf, withNoAction } from "./noAction.js";
import {
  describeProportion,
  isOutOfProportion,
  measureEdit,
  type EditProportion,
} from "./proportion.js";

/**
 * The checks an action has to survive before anyone is asked to do it.
 *
 * All of them exist to stop one mistake: a GitHub issue telling Railway to
 * build or improve something Railway already ships. That issue is worse than
 * no alert. It costs a reader's trust in every alert after it, and it is the
 * easy mistake to make, because a launch is written to sound like a gap and
 * the docs page that answers it is one of several hundred.
 *
 * So a product action carries its evidence: the gap in one line, the corpus
 * page it was read off, and words quoted from that page. Each of those is
 * checked against the stored corpus rather than trusted, and the corpus is
 * then searched again with the gap's own words – because the claim that gets
 * through every other check is the one whose evidence is real and whose
 * counter-evidence sat on a page nobody opened.
 *
 * A failed check is never a correction. There is no way to rewrite a claim
 * whose basis we cannot find without inventing one, so the action is dropped
 * and what it said becomes an open question for a person to settle.
 */

/** Hits examined per gap. Past this, a page is not what the corpus is about. */
const COVERAGE_HITS = 8;
/** Hits allowed per docs section, so one area cannot fill the coverage check. */
const COVERAGE_PER_SECTION = 3;
/** How close to the top hit a page has to score to count as a strong match. */
const STRONG_SCORE_RATIO = 0.55;
/** Query stems a page has to contain to be a strong match, when the query has that many. */
const MIN_MATCHED_TERMS = 2;

/** Phrases that make a gap about what something costs rather than what it does. */
const PACKAGING_PHRASES = [
  "cheaper",
  "more expensive",
  "costs less",
  "costs more",
  "lower price",
  "higher price",
  "price point",
  "plan price",
  "pricing is",
  "free tier",
  "free plan",
  "per-seat",
  "per seat",
  "discount",
  "packaging",
  "included in the plan",
];

/** An action that asks for words about the product rather than a change to it. */
const DOCUMENTATION_LEAD =
  /^(document|documenting|write (up )?(the )?docs|add (a |the )?(docs?|documentation|doc page)|publish (a |the )?docs?|update the docs|create (a |the )?docs?)\b/i;

/**
 * Copy short enough to be a heading fragment rather than an edit. Two clauses
 * of a sentence: below this there is nothing a person could paste.
 */
const MIN_PROPOSED_CHARS = 40;

/**
 * How a page edit reads when it tells somebody to write the copy instead of
 * writing it. Every one of these opens a note about the page rather than a
 * line that belongs on it.
 *
 * The verbs are all qualified, because a migrate page is a how-to and its own
 * copy is full of imperatives. "Add your environment variables to the service"
 * is a line on the page; "Add a line about per-request billing" is a note
 * about it, and only the second one starts on an object of ours.
 */
const INSTRUCTION_LEAD =
  /^(say|says|mention|mentions|note that|state that|clarify|call out|point out|reword|rewrite|revise|reframe|acknowledge|soften|strengthen|make (it|this|that) clear|make sure|ensure|consider|answer (their|the|this)|(update|edit|change|correct|fix|replace|remove|drop|expand) (the|this|that|these)|(add|include) (a|an|the|this) (line|row|bullet|sentence|paragraph|note|section|column|mention|caveat))\b/i;

/**
 * Left for somebody else to fill in, which is the work the copy is supposed to
 * have done. Both bracket rules want whitespace inside, so a markdown link
 * (`[Railway](url)`) and a variable (`${PORT}`) stay copy rather than becoming
 * blanks.
 */
const PLACEHOLDER =
  /\[[^\]]*\s[^\]]*\](?!\()|\{[^}]*\s[^}]*\}|\bTBD\b|\bTODO\b|\bXXX\b|\.\.\.|\u2026/i;

/** A row of a comparison table, which says its piece in far fewer words. */
function isTableRow(copy: string): boolean {
  return copy.startsWith("|") && copy.split("|").length >= 3;
}

/** Why a piece of proposed copy is not something anybody could paste, or not an edit. */
export type CopyFault =
  | "missing"
  | "too_short"
  | "instruction"
  | "placeholder"
  | "out_of_proportion";

/**
 * Which complaint a reader is told when a page action has more than one page to
 * edit and every one of them faulted. Size first: an edit that says too much is
 * the one with a shorter version worth asking for, and "it wrote nothing" is the
 * least useful complaint of the set.
 */
const FAULT_ORDER: CopyFault[] = [
  "out_of_proportion",
  "instruction",
  "placeholder",
  "too_short",
  "missing",
];

/**
 * Is this the edit, or a note asking for the edit?
 *
 * `update_pages` exists to hand marketing a finished line, so the copy is held
 * to being one: long enough to be a sentence, written as the page rather than
 * about it, and with nothing in it for a reader to resolve. The voice it is
 * written in cannot be checked here – that is what reading the page is for –
 * but everything that makes copy unpasteable can be.
 */
export function copyFault(text: string | undefined): CopyFault | null {
  const copy = (text ?? "").trim();
  if (copy.length === 0) return "missing";
  if (copy.length < MIN_PROPOSED_CHARS && !isTableRow(copy)) return "too_short";
  if (INSTRUCTION_LEAD.test(copy)) return "instruction";
  if (PLACEHOLDER.test(copy)) return "placeholder";
  return null;
}

const COPY_FAULT_REASON: Record<CopyFault, string> = {
  missing: "it says what to change but never writes the copy to change it to",
  too_short: "the copy it proposes is too short to be the line it is asking somebody to paste",
  instruction:
    "it proposes an instruction rather than copy: the text has to read as the page reads, not as a note about the page",
  placeholder: "the copy it proposes leaves a placeholder for somebody else to fill in",
  out_of_proportion: "the copy it proposes is out of proportion to the page it goes on",
};

function isProductAction(action: RecommendedAction): boolean {
  return action.type === "consider_enhancing" || action.type === "consider_building";
}

/** Text as words, punctuation folded away, so a quote survives a dash or a comma. */
function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A quoted fragment short enough to appear anywhere proves nothing. */
const MIN_QUOTE_CHARS = 16;

/**
 * Whether a quote really is on the page.
 *
 * Exact, once punctuation is folded away, because the analyst read the same
 * stored text this checks against – the workspace file is the corpus row. An
 * ellipsis splits the quote into parts and every part has to appear, which is
 * how a legitimate "A ... B" citation passes and a paraphrase does not.
 */
export function quoteAppearsOn(quote: string, pageText: string): boolean {
  const haystack = normalizeQuote(pageText);
  if (!haystack) return false;

  const parts = quote
    .split(/\s*(?:\u2026|\.\.\.)\s*/)
    .map(normalizeQuote)
    .filter((part) => part.length >= MIN_QUOTE_CHARS);

  if (parts.length === 0) return false;
  return parts.every((part) => haystack.includes(part));
}

/** The words a gap is searched on: the gap itself, and the surface it names. */
export function gapQuery(action: RecommendedAction): string {
  return [action.gap ?? "", action.feature ?? ""].join(" ").trim();
}

export function isPackagingGap(action: RecommendedAction): boolean {
  const gap = (action.gap ?? "").toLowerCase();
  if (!PACKAGING_PHRASES.some((phrase) => gap.includes(phrase))) return false;
  // A gap that names a product surface is about that surface, whatever it says
  // about the money: "bills an idle container per minute" is a Serverless gap.
  const surfaces = matchProducts(action.gap ?? "", 3).map((product) => product.label);
  return surfaces.length === 0 || surfaces.every((label) => label === "Pricing");
}

export function isDocumentationOnlyAction(action: RecommendedAction): boolean {
  return DOCUMENTATION_LEAD.test(firstSentence(action.detail, 200).trim());
}

export interface CoverageContext {
  index: CorpusIndex;
  /**
   * Corpus URLs this analysis actually had in front of it: the pages the
   * analyst opened, plus the excerpts pre-loaded into its prompt.
   */
  seenUrls: Set<string>;
}

/** A page the corpus ranks highly for a gap that the analysis never read. */
export interface CoverageMiss {
  url: string;
  title: string;
  score: number;
}

/**
 * Search the corpus with the gap's own words and report the pages that outrank
 * everything the analysis read.
 *
 * This is the check that catches the failure the others cannot. Every other
 * check asks whether the evidence offered is real; this one asks whether it
 * was the relevant evidence. A gap claim whose words lead straight to a page
 * nobody opened is a gap claim about a page nobody opened.
 */
export function coverageMisses(
  action: RecommendedAction,
  context: CoverageContext,
  citedUrls: Set<string>,
): { misses: CoverageMiss[]; strong: RetrievalHit[] } {
  const query = gapQuery(action);
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return { misses: [], strong: [] };

  const hits = context.index.search(query, {
    limit: COVERAGE_HITS,
    perSection: COVERAGE_PER_SECTION,
    kinds: ["docs"],
  });
  const top = hits[0]?.score ?? 0;
  if (top <= 0) return { misses: [], strong: [] };

  const needed = Math.min(MIN_MATCHED_TERMS, queryTerms.length);
  const strong = hits.filter(
    (hit) => hit.matched.length >= needed && hit.score >= STRONG_SCORE_RATIO * top,
  );

  const wasRead = (url: string): boolean => context.seenUrls.has(url) || citedUrls.has(url);
  const bestRead = Math.max(0, ...strong.filter((hit) => wasRead(hit.url)).map((hit) => hit.score));

  // A page the analysis read outranking everything it did not is the answer we
  // want: the reasoning started from the page the corpus thinks is about this.
  const misses = strong
    .filter((hit) => !wasRead(hit.url) && hit.score >= Math.max(bestRead, STRONG_SCORE_RATIO * top))
    .map((hit) => ({ url: hit.url, title: hit.title, score: hit.score }));

  return { misses, strong };
}

/**
 * What stopped an action, as a token rather than as a sentence.
 *
 * The sentence says it best to a person and says nothing to code, and the
 * difference between "Railway already ships this" and "we could not check
 * whether Railway ships this" is the whole difference between the two answers
 * an empty alert can give. So every block carries which one it was.
 */
export const BLOCK_CAUSES = [
  /** The corpus holds pages about the gap that the analysis never opened. */
  "covered_elsewhere",
  /** The gap's own words rank other pages above the one it cites. */
  "wrong_page_ranked",
  "packaging",
  "docs_only",
  "no_gap",
  "no_evidence",
  "not_in_corpus",
  "not_docs",
  "no_quote",
  "quote_missing",
  "page_edit_no_page",
  "page_edit_no_edit",
  "page_edit_no_copy",
  "page_edit_unusable",
  /** The copy it proposes adds more than the page it lands on can carry. */
  "page_edit_out_of_proportion",
  "page_edit_stale_claim",
] as const;
export type BlockCause = (typeof BLOCK_CAUSES)[number];

/** One action that will not be filed, and what a reader should be told instead. */
export interface BlockedAction {
  action: RecommendedAction;
  cause: BlockCause;
  /** Why, in the words the open question uses. */
  reason: string;
  /** The pages the cause is about, when it is about pages. */
  urls: string[];
  /** The same, shorter, for the run log. */
  note: string;
}

export interface GateResult {
  analysis: Analysis;
  blocked: BlockedAction[];
  /** For the run log. */
  notes: string[];
}

function block(
  action: RecommendedAction,
  cause: BlockCause,
  reason: string,
  urls: string[] = [],
): BlockedAction {
  return {
    action,
    cause,
    reason,
    urls,
    note: `blocked a ${action.type} action: ${reason} ("${firstSentence(action.detail, 100)}")`,
  };
}

/**
 * The page a product action rests on, checked rather than believed: it has to
 * be a page the corpus holds, it has to be product documentation rather than
 * copy or a changelog entry, and the quote has to be on it.
 */
function checkEvidence(
  action: RecommendedAction,
  context: CoverageContext,
): BlockedAction | null {
  if (!action.gap) {
    return block(
      action,
      "no_gap",
      "it does not say what Railway cannot do today, so there is nothing to check",
    );
  }
  if (!action.evidenceUrl) {
    return block(
      action,
      "no_evidence",
      `it cites no Railway docs page for the gap "${truncate(action.gap, 120)}"`,
    );
  }

  const page = context.index.page(action.evidenceUrl);
  if (!page) {
    return block(
      action,
      "not_in_corpus",
      `it cites ${action.evidenceUrl}, which is not a page in Railway's docs corpus`,
      [action.evidenceUrl],
    );
  }
  if (page.kind !== "docs") {
    const why =
      page.kind === "changelog"
        ? "a changelog entry says something shipped, which is the opposite of evidence for a gap"
        : "marketing copy is written on some past date and is never evidence about the product";
    return block(action, "not_docs", `its evidence is ${action.evidenceUrl}, and ${why}`, [
      action.evidenceUrl,
    ]);
  }
  if (!action.evidenceQuote) {
    return block(
      action,
      "no_quote",
      `it cites ${action.evidenceUrl} without quoting what the page says`,
      [action.evidenceUrl],
    );
  }
  if (!quoteAppearsOn(action.evidenceQuote, page.text)) {
    return block(
      action,
      "quote_missing",
      `its quote is not on ${action.evidenceUrl}: the stored copy of that page does not contain "${truncate(action.evidenceQuote, 120)}"`,
      [action.evidenceUrl],
    );
  }
  return null;
}

/**
 * A page action has to name a page somebody owns, say what it should say, and
 * write the words it should say them in. The claim it quotes has to be on that
 * page, too: a compare page that no longer says the thing being corrected has
 * already been fixed.
 */
function checkPageAction(
  action: RecommendedAction,
  analysis: Analysis,
  context: CoverageContext,
): BlockedAction | null {
  const editable = analysis.railwayRefs.filter((ref) => isMarketingTarget(ref.url));
  if (editable.length === 0) {
    return block(
      action,
      "page_edit_no_page",
      "it names no Railway compare, migrate, pricing, or features page to edit",
    );
  }

  const withEdit = editable.find((ref) => ref.suggestedEdit);
  if (!withEdit) {
    return block(
      action,
      "page_edit_no_edit",
      "it names a page but not what the page should say instead",
      editable.map((ref) => ref.url),
    );
  }

  // The copy is the recommendation. A page edit that arrives as "mention the
  // new thing here" hands the writing back to the person reading the issue,
  // who has none of the context the analysis just spent a whole run building.
  // An edit three times the length of the paragraph it lands in hands them
  // something worse: a page that is now mostly about the competitor.
  const checked = editable.map((ref) => checkCopy(ref, context));
  if (checked.every((entry) => entry.fault !== null)) {
    const worst = FAULT_ORDER.find((fault) => checked.some((entry) => entry.fault === fault));
    const pages = editable.map((ref) => ref.url);
    const oversize = checked.find((entry) => entry.fault === "out_of_proportion");

    if (oversize?.proportion) {
      return block(
        action,
        "page_edit_out_of_proportion",
        `${COPY_FAULT_REASON.out_of_proportion}: ${describeProportion(oversize.ref.url, oversize.proportion)}`,
        pages,
      );
    }
    return block(
      action,
      worst === "missing" ? "page_edit_no_copy" : "page_edit_unusable",
      `${COPY_FAULT_REASON[worst ?? "missing"]} (${pages.join(" or ")})`,
      pages,
    );
  }

  const verified = editable.some((ref) => refClaimHolds(ref, context));
  if (!verified) {
    return block(
      action,
      "page_edit_stale_claim",
      `the copy it quotes is not on ${editable.map((ref) => ref.url).join(" or ")} as stored, so the page may already say something else`,
      editable.map((ref) => ref.url),
    );
  }
  return null;
}

/** One page's proposed copy, and what is wrong with it. */
interface CheckedCopy {
  ref: RailwayRef;
  fault: CopyFault | null;
  /** How the edit compares to the page, when there was a stored page to measure against. */
  proportion: EditProportion | null;
}

/**
 * Both questions about one page's copy: whether it is something a person could
 * paste, and whether the page it goes on can carry that much of it. Neither is
 * about what the copy says, which is what reading the page is for.
 */
function checkCopy(ref: RailwayRef, context: CoverageContext): CheckedCopy {
  const proportion = measureEdit(ref, context.index.page(ref.url)?.text);
  const fault =
    copyFault(ref.proposedText) ??
    (proportion && isOutOfProportion(proportion) ? "out_of_proportion" : null);
  return { ref, fault, proportion };
}

/**
 * Whether a cited page really says what the ref claims. A page the corpus does
 * not hold cannot be checked, and an unverifiable page edit is one someone
 * would go and make on trust.
 */
function refClaimHolds(ref: RailwayRef, context: CoverageContext): boolean {
  const page = context.index.page(ref.url);
  if (!page) return false;
  return quoteAppearsOn(ref.claim, page.text);
}

/**
 * Run every action past every check, and turn what fails into open questions.
 *
 * Order matters only in what a reader is told first: the cheapest, most
 * specific complaint wins, because "it quotes a page that does not say that"
 * is more use to a person than "the corpus knows more about this than the
 * analysis read".
 */
export function gateActions(analysis: Analysis, context: CoverageContext): GateResult {
  const blocked: BlockedAction[] = [];
  const notes: string[] = [];
  const citedUrls = new Set(analysis.railwayRefs.map((ref) => ref.url));

  const kept = analysis.actions.filter((action) => {
    const failure = firstFailure(action);
    if (!failure) return true;
    blocked.push(failure);
    notes.push(failure.note);
    return false;
  });

  if (blocked.length === 0) {
    // The analyst's own verdict is a claim about what Railway ships, so it is
    // checked here too rather than published on trust.
    if (analysis.actions.length > 0) return { analysis, blocked, notes };
    const verdict = checkNoActionEvidence(analysis, context.index);
    return { analysis: verdict.analysis, blocked, notes: verdict.notes };
  }

  // What blocked the last action is the answer to "so why is this empty?", and
  // saying it as the verdict and again as an open question reads as two
  // findings rather than one.
  const openQuestions = [...analysis.openQuestions];
  if (kept.length > 0) {
    for (const entry of blocked) {
      if (openQuestions.length >= 4) break;
      openQuestions.push(entry.reason);
    }
  }

  const gated: Analysis = { ...analysis, actions: kept, openQuestions };

  return {
    analysis: kept.length === 0 ? withNoAction(gated, noActionFrom(blocked, context.index)) : gated,
    blocked,
    notes,
  };

  function firstFailure(action: RecommendedAction): BlockedAction | null {
    if (isDocumentationOnlyAction(action)) {
      return block(
        action,
        "docs_only",
        "it asks for the docs to be written rather than for anything to change, which is not one of this bot's actions",
      );
    }

    // Whether a page edit is about the launch is settled before this, by the
    // topic guard in `relevance.ts`, which has the signal's own words to judge
    // against. What is left here is whether the page and the copy are real.
    if (action.type === "update_pages") return checkPageAction(action, analysis, context);

    if (!isProductAction(action)) return null;

    if (isPackagingGap(action)) {
      return block(
        action,
        "packaging",
        `its gap is about what a competitor charges rather than what Railway can do: "${truncate(action.gap ?? "", 120)}"`,
      );
    }

    const evidence = checkEvidence(action, context);
    if (evidence) return evidence;

    const { misses, strong } = coverageMisses(action, context, citedUrls);
    const cited = action.evidenceUrl ?? "";
    if (strong.length > 0 && !strong.some((hit) => hit.url === cited)) {
      const ranked = strong.slice(0, 2).map((hit) => hit.url);
      return block(
        action,
        "wrong_page_ranked",
        `the gap it names does not lead to the page it cites: searching the docs for "${truncate(action.gap ?? "", 80)}" ranks ${ranked.join(" and ")} above ${cited}`,
        ranked,
      );
    }
    if (misses.length > 0) {
      const unread = misses.slice(0, 3).map((miss) => miss.url);
      return block(
        action,
        "covered_elsewhere",
        `the docs cover this in pages the analysis never opened: ${unread.join(", ")}. Read those before treating "${truncate(action.gap ?? "", 80)}" as a gap`,
        unread,
      );
    }

    return null;
  }
}

/** The kind of verdict one blocked action argues for. */
function kindForCause(cause: BlockCause): NoActionKind {
  switch (cause) {
    case "covered_elsewhere":
    case "wrong_page_ranked":
      return "already_covered";
    case "packaging":
    case "docs_only":
    // Nothing here is unverified: the page is real, the line on it is real, and
    // the answer is that the page does not need this much said on it.
    case "page_edit_out_of_proportion":
      return "not_a_gap";
    case "no_gap":
    case "no_evidence":
    case "not_in_corpus":
    case "not_docs":
    case "no_quote":
    case "quote_missing":
    case "page_edit_no_page":
    case "page_edit_no_edit":
    case "page_edit_no_copy":
    case "page_edit_unusable":
    case "page_edit_stale_claim":
      return "unverified";
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/** What "Railway already does this" rests on, in the words of the check that said so. */
function coveredReason(entry: BlockedAction, evidence: NoActionEvidence[]): string {
  const pages = evidence.map((page) => page.title ?? page.url).join(" and ");
  const gap = truncate(entry.action.gap ?? "", 120);

  if (entry.cause === "wrong_page_ranked") {
    return `Railway documents this already: searching the docs for "${gap}" ranks ${pages} above the page the analysis read it off.`;
  }
  return `Railway documents this already: the docs cover "${gap}" on ${pages}, which the analysis never opened.`;
}

function notAGapReason(blocked: BlockedAction[]): string {
  const packaging = blocked.find((entry) => entry.cause === "packaging");
  if (packaging) {
    return `The only thing recommended was about what a competitor charges rather than what Railway can do ("${truncate(packaging.action.gap ?? "", 120)}"), and pricing is not a capability Railway is missing.`;
  }
  const oversize = blocked.find((entry) => entry.cause === "page_edit_out_of_proportion");
  if (oversize) {
    return `No page edit is filed here: ${oversize.reason}, so it would have turned the page into a write-up of the launch rather than correcting the line the launch makes wrong.`;
  }
  return "The only thing recommended was writing docs about something Railway already ships, which is a docs job rather than a product gap.";
}

/**
 * The verdict, read off what the gate blocked.
 *
 * Coverage wins over everything else, because "Railway already does this" is
 * the answer a reader is looking for and the one the whole bot exists to get
 * right. A run of pricing complaints is not a gap at all. Anything else is a
 * gap somebody claimed and nobody could confirm, which is its own answer and
 * says which check it failed.
 */
export function noActionFrom(blocked: BlockedAction[], index: CorpusIndex): NoAction {
  const covered = blocked.filter((entry) => kindForCause(entry.cause) === "already_covered");
  const evidence = [...new Set(covered.flatMap((entry) => entry.urls))].map((url) =>
    evidenceFor(index, url),
  );

  const first = covered[0];
  if (first && evidence.length > 0) {
    return { kind: "already_covered", reason: coveredReason(first, evidence), evidence };
  }

  if (blocked.every((entry) => kindForCause(entry.cause) === "not_a_gap")) {
    return { kind: "not_a_gap", reason: notAGapReason(blocked), evidence: [] };
  }

  const failed = blocked[0] as BlockedAction;
  const gap = failed.action.gap;
  return {
    kind: "unverified",
    reason: gap
      ? `The analysis claimed "${truncate(gap, 120)}" as a gap, but ${failed.reason}, so nothing here is confirmed.`
      : `The work recommended here did not hold up: ${failed.reason}.`,
    evidence: failed.urls.filter((url) => index.page(url)).map((url) => evidenceFor(index, url)),
  };
}

/**
 * Check an `already_covered` verdict the way a gap claim is checked.
 *
 * "Railway already does this" is a claim about what Railway ships, so it earns
 * nothing for being the comfortable answer: the page has to be in the corpus,
 * it has to be documentation, and the quote has to be on it. Evidence that
 * fails is dropped, and a verdict left with none is downgraded to unverified
 * naming the page that could not be confirmed, because there is no honest way
 * to keep the claim once its basis is gone.
 */
export function checkNoActionEvidence(
  analysis: Analysis,
  index: CorpusIndex,
): { analysis: Analysis; notes: string[] } {
  const verdict = noActionOf(analysis);
  if (verdict.kind !== "already_covered") {
    return { analysis: withNoAction(analysis, verdict), notes: [] };
  }

  const notes: string[] = [];
  const kept: NoActionEvidence[] = [];

  for (const entry of verdict.evidence) {
    const page = index.page(entry.url);
    if (!page) {
      notes.push(`dropped ${entry.url} from the no-action verdict: it is not a page in the corpus`);
      continue;
    }
    if (page.kind !== "docs") {
      notes.push(
        `dropped ${entry.url} from the no-action verdict: it is ${page.kind} rather than product documentation`,
      );
      continue;
    }
    if (entry.quote && !quoteAppearsOn(entry.quote, page.text)) {
      notes.push(
        `dropped ${entry.url} from the no-action verdict: the quote it gives is not on the stored page`,
      );
      continue;
    }
    kept.push({ ...entry, title: entry.title ?? page.title });
  }

  if (kept.length > 0) {
    return { analysis: withNoAction(analysis, { ...verdict, evidence: kept }), notes };
  }

  const failed = verdict.evidence[0]?.url;
  return {
    analysis: withNoAction(analysis, {
      kind: "unverified",
      reason: failed
        ? `The analysis says Railway already covers this and reads it off ${failed}, which could not be confirmed against the stored corpus, so what Railway ships here is unchecked.`
        : "The analysis says Railway already covers this and names no page it read that on, so what Railway ships here is unchecked.",
      evidence: [],
    }),
    notes,
  };
}
