import { isMarketingTarget } from "../railway/pages.js";
import { productsForAction } from "../railway/products.js";
import type { Analysis, RailwayRef, RecommendedAction } from "../types.js";
import { firstSentence, pageNameFromUrl, titleFromUrl } from "../util/text.js";

/**
 * The embed shows the first sentence of an action's detail and nothing else,
 * so that sentence carries the whole recommendation. It has to lead with the
 * work: what to change, or which page to edit and what it should say. A
 * sentence that only says what Railway lacks leaves the reader to work out
 * what is being asked for.
 *
 * The prompt asks for this shape. This is what happens when the model writes
 * the gap instead, and it only reorders what the model already said.
 */

/** Verbs an action opens with when it leads with the work rather than the gap. */
const WORK_LEAD =
  /^(add|allow|answer|bring|build|close|correct|create|cut|drop|edit|expand|expose|extend|fix|give|introduce|let|link|make|match|mention|move|name|note|offer|open|point|publish|put|raise|remove|rename|replace|say|schedule|ship|show|state|support|surface|swap|track|turn|update|wire|write)\b/i;

/** Words short enough to be anywhere are no evidence that a page was named. */
const MIN_SLUG_WORD = 5;

export interface LeadRewrite {
  analysis: Analysis;
  /** What was rewritten, for the run log. Empty when the model got the shape right. */
  notes: string[];
}

function isPageAction(action: RecommendedAction): boolean {
  return action.type === "update_pages";
}

/** The distinctive words in a page's own URL, e.g. "render", "migrate". */
function slugWords(url: string): string[] {
  return titleFromUrl(url)
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((word) => word.length >= MIN_SLUG_WORD);
}

/**
 * Whether the opening sentence says which page. "The compare page is out of
 * date" does not: a reader cannot open it. Naming the page means the URL, or
 * words the page's own URL is made of.
 */
function namesCitedPage(lead: string, refs: RailwayRef[]): boolean {
  const lower = lead.toLowerCase();
  return refs
    .filter((ref) => isMarketingTarget(ref.url))
    .some(
      (ref) =>
        lower.includes(ref.url.toLowerCase()) ||
        slugWords(ref.url).some((word) => lower.includes(word)),
    );
}

/**
 * The page an action is about: the one it suggests an edit for, else the first
 * cited. Only pages someone would actually edit are candidates, so the
 * sentence the embed shows never opens on a product docs URL.
 */
function pageToName(refs: RailwayRef[]): RailwayRef | undefined {
  const editable = refs.filter((ref) => isMarketingTarget(ref.url));
  return editable.find((ref) => ref.suggestedEdit) ?? editable[0];
}

function productLead(action: RecommendedAction): string {
  if (action.type === "consider_building") return "Build this into Railway";
  const feature = action.feature ?? productsForAction(action)[0]?.label;
  return `Close this gap in ${feature ?? "Railway"}`;
}

/**
 * Rewrite any action whose opening sentence buries the work. Nothing is
 * deleted: the model's own words follow the lead that was put in front of
 * them, so the issue still carries everything it said.
 */
export function enforceActionLead(analysis: Analysis): LeadRewrite {
  const notes: string[] = [];

  const actions = analysis.actions.map((action): RecommendedAction => {
    const detail = action.detail.trim();
    if (!detail) return action;
    const lead = firstSentence(detail, 200);

    if (isPageAction(action)) {
      if (namesCitedPage(lead, analysis.railwayRefs)) return action;
      const ref = pageToName(analysis.railwayRefs);
      if (!ref) return action;

      notes.push(`led an update_pages action with ${ref.url}, which its opening sentence left out`);
      const edit = ref.suggestedEdit ? firstSentence(ref.suggestedEdit, 120) : null;
      return {
        ...action,
        detail: edit
          ? `On ${pageNameFromUrl(ref.url)}: ${edit} ${detail}`
          : `On ${pageNameFromUrl(ref.url)}: ${detail}`,
      };
    }

    if (WORK_LEAD.test(lead)) return action;
    notes.push(`led a ${action.type} action with the change to make rather than the gap`);
    return { ...action, detail: `${productLead(action)}: ${detail}` };
  });

  return { analysis: { ...analysis, actions }, notes };
}
