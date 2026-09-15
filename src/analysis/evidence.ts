import { isMarketingTarget } from "../railway/pages.js";
import { matchProducts } from "../railway/products.js";
import { terms, type CorpusIndex, type RetrievalHit } from "../railway/retrieval.js";
import type { Analysis, RailwayRef, RecommendedAction } from "../types.js";
import { firstSentence, truncate } from "../util/text.js";

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

/** One action that will not be filed, and what a reader should be told instead. */
export interface BlockedAction {
  action: RecommendedAction;
  /** Why, in the words the open question uses. */
  reason: string;
  /** The same, shorter, for the run log. */
  note: string;
}

export interface GateResult {
  analysis: Analysis;
  blocked: BlockedAction[];
  /** For the run log. */
  notes: string[];
}

function block(action: RecommendedAction, reason: string): BlockedAction {
  return {
    action,
    reason,
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
      "it does not say what Railway cannot do today, so there is nothing to check",
    );
  }
  if (!action.evidenceUrl) {
    return block(action, `it cites no Railway docs page for the gap "${truncate(action.gap, 120)}"`);
  }

  const page = context.index.page(action.evidenceUrl);
  if (!page) {
    return block(
      action,
      `it cites ${action.evidenceUrl}, which is not a page in Railway's docs corpus`,
    );
  }
  if (page.kind !== "docs") {
    const why =
      page.kind === "changelog"
        ? "a changelog entry says something shipped, which is the opposite of evidence for a gap"
        : "marketing copy is written on some past date and is never evidence about the product";
    return block(action, `its evidence is ${action.evidenceUrl}, and ${why}`);
  }
  if (!action.evidenceQuote) {
    return block(action, `it cites ${action.evidenceUrl} without quoting what the page says`);
  }
  if (!quoteAppearsOn(action.evidenceQuote, page.text)) {
    return block(
      action,
      `its quote is not on ${action.evidenceUrl}: the stored copy of that page does not contain "${truncate(action.evidenceQuote, 120)}"`,
    );
  }
  return null;
}

/**
 * A page action has to name a page somebody owns and say what it should say.
 * The claim it quotes has to be on that page, too: a compare page that no
 * longer says the thing being corrected has already been fixed.
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
      "it names no Railway compare, migrate, pricing, or features page to edit",
    );
  }

  const withEdit = editable.find((ref) => ref.suggestedEdit);
  if (!withEdit) {
    return block(action, "it names a page but not what the page should say instead");
  }

  const verified = editable.some((ref) => refClaimHolds(ref, context));
  if (!verified) {
    return block(
      action,
      `the copy it quotes is not on ${editable.map((ref) => ref.url).join(" or ")} as stored, so the page may already say something else`,
    );
  }
  return null;
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

  if (blocked.length === 0) return { analysis, blocked, notes };

  const openQuestions = [...analysis.openQuestions];
  for (const entry of blocked) {
    if (openQuestions.length >= 4) break;
    openQuestions.push(entry.reason);
  }

  return {
    analysis: {
      ...analysis,
      actions: kept,
      openQuestions,
      ...(kept.length === 0
        ? {
            noActionReason:
              analysis.noActionReason ??
              `Nothing here survived the evidence checks, so this alert asks for no work. The open questions say what could not be verified.`,
          }
        : {}),
    },
    blocked,
    notes,
  };

  function firstFailure(action: RecommendedAction): BlockedAction | null {
    if (isDocumentationOnlyAction(action)) {
      return block(
        action,
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
        `its gap is about what a competitor charges rather than what Railway can do: "${truncate(action.gap ?? "", 120)}"`,
      );
    }

    const evidence = checkEvidence(action, context);
    if (evidence) return evidence;

    const { misses, strong } = coverageMisses(action, context, citedUrls);
    const cited = action.evidenceUrl ?? "";
    if (strong.length > 0 && !strong.some((hit) => hit.url === cited)) {
      return block(
        action,
        `the gap it names does not lead to the page it cites: searching the docs for "${truncate(action.gap ?? "", 80)}" ranks ${strong
          .slice(0, 2)
          .map((hit) => hit.url)
          .join(" and ")} above ${cited}`,
      );
    }
    if (misses.length > 0) {
      return block(
        action,
        `the docs cover this in pages the analysis never opened: ${misses
          .slice(0, 3)
          .map((miss) => miss.url)
          .join(", ")}. Read those before treating "${truncate(action.gap ?? "", 80)}" as a gap`,
      );
    }

    return null;
  }
}
