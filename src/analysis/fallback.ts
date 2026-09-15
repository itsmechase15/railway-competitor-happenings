import { COMPETITORS } from "../config.js";
import type { Analysis, Impact, RailwayClaim, RailwayDoc, StoredItem } from "../types.js";
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
 * product facts. It restates the source and points at the pages already in the
 * corpus, so a run without a key is honest about being unanalyzed.
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

  // Failing an indexed claim, this competitor's own compare page: an
  // unassessed Vercel launch has no business sending anyone to read about
  // Render.
  const page = refs[0]?.url ?? `https://docs.railway.com/platform/compare-to-${competitor.id}`;

  return {
    impact: heuristicImpact(haystack),
    summary,
    keyPoints: pointsFrom(lead, item),
    actions: [],
    noActionReason: NO_ANALYSIS_REASON,
    railwayRefs: [...refs, ...docRefs],
    openQuestions: unverifiedQuestions(competitor.label, page, docRefs[0]?.url),
  };
}

/**
 * Why an unanalyzed run recommends nothing.
 *
 * The heuristic knows no Railway product facts. It cannot say Railway is
 * missing something, because that needs a docs page it has not read, and it
 * cannot ask for a page edit either, because a page is only worth editing when
 * something on it is wrong and nothing here has established that. What it can
 * do is say plainly that nobody assessed this, and name the pages a person
 * would start from.
 */
export const NO_ANALYSIS_REASON =
  "No model analysis ran, so nothing has been assessed and nothing is recommended. The open questions name where to start.";

function unverifiedQuestions(
  label: string,
  page: string,
  closestDoc: string | undefined,
): string[] {
  const questions = [
    `Does this change anything ${pageNameFromUrl(page)} says about ${label}? Nobody has checked: ${page}.`,
  ];
  if (closestDoc) {
    questions.push(
      `What does Railway already ship here? ${closestDoc} is the closest page in the corpus, and it has not been read against this launch.`,
    );
  }
  return questions;
}
