import { COMPETITORS } from "../config.js";
import type {
  Analysis,
  Impact,
  RailwayClaim,
  RailwayDoc,
  RecommendedAction,
  StoredItem,
} from "../types.js";
import { firstSentence, pageNameFromUrl, sentences, truncate } from "../util/text.js";

export const FALLBACK_MODEL = "fallback-heuristic";

/**
 * Impact is decided by what the post shipped: a brand-new feature is major, an
 * enhancement of an existing one is notable, and a post with neither is minor.
 * The heuristic cannot read a post the way the model does, so it matches the
 * words each kind of post is written with, and a new-feature word wins.
 */
const NEW_FEATURE_SIGNALS = [
  "introduc",
  "launch",
  "new feature",
  "new product",
  "brand new",
  "now available",
  "general availability",
  "generally available",
  "announcing",
  "meet ",
  "say hello to",
];

const ENHANCEMENT_SIGNALS = [
  "you can now",
  "now you can",
  "now supports",
  "now support",
  "improv",
  "enhanc",
  "expand",
  "extend",
  "upgrad",
  "faster",
  "reduced",
  "more control",
  "added support",
  "support for",
  "new option",
  "new setting",
  "new plan",
  "new region",
  "raised",
  "increased",
];

function bodyOf(item: StoredItem): string {
  const raw = item.raw as Record<string, unknown>;
  const candidate = raw.body ?? raw.preview ?? raw.text ?? "";
  return typeof candidate === "string" ? candidate : "";
}

/** The page's own summary beats its first paragraph, which is often a byline. */
function leadOf(item: StoredItem): string {
  const description = (item.raw as Record<string, unknown>).description;
  if (typeof description === "string" && description.trim().length > 0) {
    return truncate(stripLeadingLabel(description.trim()), 280);
  }
  return firstSentences(bodyOf(item), 280);
}

/** Changelogs often open with a bold "Description:" label that reads as noise. */
const LEADING_LABEL = /^\s*(description|summary|overview|what's new|tl;dr)\s*[:\u2013\u2014-]\s*/i;

function stripLeadingLabel(text: string): string {
  return text.replace(LEADING_LABEL, "");
}

function firstSentences(text: string, max: number): string {
  const trimmed = stripLeadingLabel(text.trim());
  if (!trimmed) return "";
  return truncate(sentences(trimmed).slice(0, 2).join(" ") || trimmed, max);
}

export function heuristicImpact(haystack: string): Impact {
  const lower = haystack.toLowerCase();
  if (NEW_FEATURE_SIGNALS.some((signal) => lower.includes(signal))) return "major";
  if (ENHANCEMENT_SIGNALS.some((signal) => lower.includes(signal))) return "notable";
  return "minor";
}

/**
 * The embed wants one sentence up top and short lines below it, so the
 * source's own lead is split rather than repeated in both places.
 */
function pointsFrom(lead: string, item: StoredItem): string[] {
  const rest = sentences(lead).slice(1);
  const source = rest.length > 0 ? rest : sentences(stripLeadingLabel(bodyOf(item))).slice(1, 4);
  return source
    .map((sentence) => truncate(sentence.trim(), 160))
    .filter((sentence) => sentence.length > 0)
    .slice(0, 3);
}

/**
 * Deterministic stand-in used when `CURSOR_API_KEY` is unset. It never invents
 * product facts. It restates the source and points at the pages we already
 * indexed, so a run without a key is honest about being unanalyzed.
 */
export function heuristicAnalysis(
  item: StoredItem,
  claims: RailwayClaim[],
  docs: RailwayDoc[] = [],
): Analysis {
  const competitor = COMPETITORS[item.competitor];
  const haystack = `${item.title} ${bodyOf(item)}`;
  const lead = leadOf(item);

  const seenUrls = new Set<string>();
  const refs = claims
    .filter((claim) => {
      if (seenUrls.has(claim.url)) return false;
      seenUrls.add(claim.url);
      return true;
    })
    .slice(0, 2)
    .map((claim) => ({ url: claim.url, claim: truncate(claim.paragraph, 240) }));

  // The docs pages this signal touches, so whoever picks the issue up can read
  // what Railway already ships instead of taking the heuristic's word for it.
  const docRefs = docs.slice(0, 2).map((doc) => ({
    url: doc.url,
    claim: truncate(firstSentence(doc.excerpt, 240) || doc.title, 240),
  }));

  const summary = lead
    ? `${competitor.label}: ${firstSentence(lead, 240)}`
    : `${competitor.label} published "${item.title}".`;

  return {
    impact: heuristicImpact(haystack),
    summary,
    keyPoints: pointsFrom(lead, item),
    actions: [
      fallbackAction(
        competitor.label,
        // Failing that, this competitor's own compare page: an unassessed
        // Vercel launch has no business sending anyone to read about Render.
        refs[0]?.url ?? `https://docs.railway.com/platform/compare-to-${competitor.id}`,
        docRefs[0]?.url,
      ),
    ],
    railwayRefs: [...refs, ...docRefs],
    openQuestions: [],
  };
}

/**
 * The heuristic knows no Railway product facts, so it never recommends
 * enhancing or building anything: those actions have to name a surface or a
 * gap, and guessing one would be an invented fact. It points at page coverage
 * instead, which is the one thing the indexed claims actually tell us.
 *
 * The embed shows the first sentence and nothing else, so that sentence names
 * the page and the job. That the run was unassessed is the second sentence.
 */
function fallbackAction(
  label: string,
  page: string,
  closestDoc: string | undefined,
): RecommendedAction {
  const caveat = "No model analysis ran, so this is unassessed.";
  const docHint = closestDoc
    ? ` What Railway ships in this area is documented at ${closestDoc}; read it before treating anything here as a gap.`
    : "";

  return {
    type: "update_pages",
    detail: `On ${pageNameFromUrl(page)}, check whether this makes anything it says about ${label} wrong, and edit it only if it does. ${caveat} The page is ${page}.${docHint}`,
  };
}
