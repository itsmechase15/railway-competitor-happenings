import { productForDocUrl, productsForAction } from "../railway/products.js";
import type { Analysis, RailwayDoc, RailwayRef, RecommendedAction } from "../types.js";
import { firstSentence, SPACED_EN_DASH, truncate } from "../util/text.js";

/**
 * A model asserting that Railway lacks something. Worth catching because it is
 * the one claim in an alert that a reader acts on without checking, and the one
 * a compare-page snippet cannot support.
 */
const GAP_CLAIM =
  /\brailway\b[^.?!]{0,140}?\b(has no|have no|has nothing|have nothing|does not|doesn't|do not|don't|cannot|can't|lacks|lack|no support for|no way to|is missing|are missing)\b/i;

/** The same claim written the other way round: "there is no Railway equivalent". */
const NO_EQUIVALENT = /\bno\b[^.?!]{0,40}\b(railway\s+)?(equivalent|counterpart|parity)\b/i;

export function claimsGap(detail: string): boolean {
  return GAP_CLAIM.test(detail) || NO_EQUIVALENT.test(detail);
}

export interface DocsVerification {
  analysis: Analysis;
  /** What was corrected, for the run log. Empty when the model got it right. */
  notes: string[];
}

/**
 * Reconcile a model's actions with the docs it was shown.
 *
 * The prompt asks for this and a good model does it, but "Railway can't do X"
 * is the claim that costs the most when it is wrong, so it is also checked
 * here. Two things are enforced:
 *
 * 1. consider_building means Railway has nothing in the area. A docs page in
 *    context for that surface contradicts it outright, so the action becomes
 *    consider_enhancing against that surface and says what already exists.
 * 2. A gap claim has to be checkable. It gets the docs page it should have
 *    cited, or, when no docs page covers it, an open question saying the gap
 *    was never verified.
 *
 * Nothing the model wrote is deleted. A correction is added to the end of the
 * detail, so the reader sees both the claim and the page that qualifies it.
 */
export function verifyAgainstDocs(analysis: Analysis, docs: RailwayDoc[]): DocsVerification {
  const notes: string[] = [];
  const refs: RailwayRef[] = [...analysis.railwayRefs];
  const openQuestions = [...analysis.openQuestions];
  const citedUrls = new Set(refs.map((ref) => ref.url));

  const actions = analysis.actions.map((action): RecommendedAction => {
    const relevant = relevantDocs(action, docs);
    const primary = relevant[0];

    if (action.type === "consider_building" && primary) {
      const feature = productForDocUrl(primary.url)?.label ?? action.feature;
      notes.push(
        `retyped consider_building to consider_enhancing${feature ? ` ${feature}` : ""}: ${primary.url} covers this area`,
      );
      cite(primary);
      return {
        ...action,
        type: "consider_enhancing",
        ...(feature ? { feature } : {}),
        detail: append(
          action.detail,
          `Railway already ships ${feature ?? "something"} here${SPACED_EN_DASH}see ${primary.url}${SPACED_EN_DASH}so this is a gap to close in an existing surface, not a new one to build.`,
        ),
      };
    }

    if (claimsGap(action.detail)) {
      if (primary) {
        if (!citedUrls.has(primary.url)) {
          notes.push(`cited ${primary.url} for a gap claim that named no docs page`);
          cite(primary);
        }
      } else if (openQuestions.length < 3) {
        notes.push("flagged an unverified gap claim as an open question");
        openQuestions.push(
          `This action says what Railway does not do, and no Railway docs page in context confirmed it. Check the docs for ${namedProducts(action) || "the surface involved"} before acting on it.`,
        );
      }
    }

    // A consider_enhancing with no feature renders as a title that names
    // nothing, and the docs say which surface this is about.
    if (action.type === "consider_enhancing" && !action.feature && primary) {
      const feature = productForDocUrl(primary.url)?.label;
      if (feature) {
        notes.push(`named ${feature} as the surface to enhance, from ${primary.url}`);
        return { ...action, feature };
      }
    }

    return action;
  });

  return {
    analysis: { ...analysis, actions, railwayRefs: refs, openQuestions },
    notes,
  };

  function cite(doc: RailwayDoc): void {
    if (citedUrls.has(doc.url)) return;
    citedUrls.add(doc.url);
    refs.push({
      url: doc.url,
      claim: truncate(firstSentence(doc.excerpt, 240) || doc.title, 240),
    });
  }
}

/** One sentence added to a detail, without doubling a period. */
function append(detail: string, sentence: string): string {
  const trimmed = detail.trim();
  const separator = /[.!?]$/.test(trimmed) ? " " : ". ";
  return `${trimmed}${trimmed ? separator : ""}${sentence}`;
}

/**
 * The docs pages that speak to one action: the surface it names in `feature`
 * first, then whatever its own words are about. Order matters, because the
 * first match is the page the correction cites.
 */
export function relevantDocs(action: RecommendedAction, docs: RailwayDoc[]): RailwayDoc[] {
  const wanted = productNames(action);
  if (wanted.length === 0) return [];

  const ranked = docs
    .map((doc) => {
      const product = productForDocUrl(doc.url);
      const rank = product ? wanted.indexOf(product.label) : -1;
      return { doc, rank };
    })
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank);

  return ranked.map((entry) => entry.doc);
}

function productNames(action: RecommendedAction): string[] {
  return productsForAction(action).map((product) => product.label);
}

function namedProducts(action: RecommendedAction): string {
  return productNames(action).slice(0, 2).join(" and ");
}
