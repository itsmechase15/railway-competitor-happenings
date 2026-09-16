import { z } from "zod";
import {
  ACTIONS,
  EDIT_KINDS,
  IMAGE_ORIGINS,
  IMPACTS,
  REVIEW_VERDICTS,
  type ActionIssue,
  type Analysis,
  type FeatureImage,
  type RecommendedAction,
} from "../types.js";
import { parseDate, sanitizeCopy } from "../util/text.js";

/**
 * A field the model means to leave out but sends as "" instead. Read as
 * absent, because the alternative is throwing away a whole good analysis over
 * one empty string.
 */
function blankAsMissing(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalText = (max: number) =>
  z.preprocess(blankAsMissing, z.string().min(1).max(max).optional());

/** Blank entries are dropped rather than failing the list they are in. */
const lines = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((entry) => typeof entry !== "string" || entry.trim() !== "")
      : value,
  z.array(z.string().min(1)).max(8),
);

/** A rewrite runs longer than the one-line instruction that introduces it. */
const proposed = optionalText(1_600);
const editKind = z.preprocess(blankAsMissing, z.enum(EDIT_KINDS).optional());

const refSchema = z.object({
  url: z.string().min(1),
  claim: z.string().min(1),
  suggested_edit: optionalText(600),
  suggestedEdit: optionalText(600),
  proposed_text: proposed,
  proposedText: proposed,
  replacement_text: proposed,
  replacementText: proposed,
  edit_kind: editKind,
  editKind,
});

/** A citation with no page or no claim says nothing, so it goes rather than throws. */
const refs = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((entry) => {
          if (typeof entry !== "object" || entry === null) return false;
          const ref = entry as { url?: unknown; claim?: unknown };
          return (
            typeof ref.url === "string" &&
            ref.url.trim() !== "" &&
            typeof ref.claim === "string" &&
            ref.claim.trim() !== ""
          );
        })
      : value,
  z.array(refSchema).max(5),
);

const impactToken = z.enum(IMPACTS);
const actionToken = z.enum(ACTIONS);
const detail = optionalText(900);
const feature = optionalText(120);
const gap = optionalText(400);
const quote = optionalText(600);

/**
 * The teams a model named for one action. Kept as it wrote them: the catalog
 * decides which of these are real Railway teams, and it does that at the point
 * something is rendered rather than here.
 */
const teamNames = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string" && entry.trim() !== "")
      : value,
  z.array(z.string().min(1)).max(5).optional(),
);

/** One entry of `actions`, in whichever casing the model reached for. */
const actionSchema = z.object({
  type: actionToken.optional(),
  action: actionToken.optional(),
  detail,
  action_detail: detail,
  actionDetail: detail,
  feature,
  railway_feature: feature,
  railwayFeature: feature,
  teams: teamNames,
  railway_teams: teamNames,
  railwayTeams: teamNames,
  gap,
  gap_today: gap,
  evidence_url: optionalText(500),
  evidenceUrl: optionalText(500),
  evidence_quote: quote,
  evidenceQuote: quote,
});

export const analysisSchema = z.object({
  impact: impactToken.optional(),
  summary: z.string().min(1).max(600),
  key_points: lines.optional(),
  keyPoints: lines.optional(),
  actions: z.array(actionSchema).max(4).optional(),
  no_action_reason: optionalText(600),
  noActionReason: optionalText(600),
  railway_refs: refs.optional(),
  railwayRefs: refs.optional(),
  open_questions: lines.optional(),
  openQuestions: lines.optional(),
  pages_read: lines.optional(),
  pagesRead: lines.optional(),
});

/**
 * Zero to three. The cap is the embed's: a fourth action would not render, and
 * an alert asking for four things is an alert nobody starts.
 */
export const MAX_ACTIONS = 3;

/**
 * Said when an analyst recommends nothing and does not say why. Zero actions
 * is a normal answer, so this is not a failure – but it is not an answer
 * either, and the alert says so rather than going out blank.
 */
export const UNSTATED_NO_ACTION_REASON =
  "The analysis recommended nothing and did not say why, so nothing here has been ruled out.";

/** Every string a model wrote is punctuated our way before anything renders it. */
function clean(value: string): string {
  return sanitizeCopy(value).trim();
}

/** An entry is only usable when it says both what to do and why. */
function toAction(parsed: z.infer<typeof actionSchema>): RecommendedAction | null {
  const type = parsed.type ?? parsed.action;
  const actionDetail = parsed.detail ?? parsed.action_detail ?? parsed.actionDetail;
  if (!type || !actionDetail) return null;

  const named = parsed.feature ?? parsed.railway_feature ?? parsed.railwayFeature;
  const teams = parsed.teams ?? parsed.railway_teams ?? parsed.railwayTeams;
  const namedGap = parsed.gap ?? parsed.gap_today;
  const evidenceUrl = parsed.evidence_url ?? parsed.evidenceUrl;
  const evidenceQuote = parsed.evidence_quote ?? parsed.evidenceQuote;

  return {
    type,
    detail: clean(actionDetail),
    ...(named ? { feature: clean(named) } : {}),
    ...(teams && teams.length > 0 ? { teams: teams.map((team) => team.trim()) } : {}),
    ...(namedGap ? { gap: clean(namedGap) } : {}),
    ...(evidenceUrl ? { evidenceUrl: evidenceUrl.trim() } : {}),
    // Not punctuation-corrected: a quote is checked character by character
    // against the stored page, and rewriting its dashes would fail that check.
    ...(evidenceQuote ? { evidenceQuote: evidenceQuote.trim() } : {}),
  };
}

function readActions(parsed: z.infer<typeof analysisSchema>): RecommendedAction[] {
  const listed = (parsed.actions ?? [])
    .map(toAction)
    .filter((action): action is RecommendedAction => action !== null);
  if (listed.length > 0) return listed.slice(0, MAX_ACTIONS);
  // An empty list is an answer: plenty of launches ask nothing of Railway.
  // Nothing at all under `actions` is a reply that did not answer the field,
  // and only the reason it gives makes the difference readable.
  if (Array.isArray(parsed.actions)) return [];
  if (parsed.no_action_reason ?? parsed.noActionReason) return [];
  throw new Error("analysis is missing its actions list");
}

/** Models drift between snake_case and camelCase; accept both and normalize. */
export function normalizeAnalysis(parsed: z.infer<typeof analysisSchema>): Analysis {
  const actions = readActions(parsed);

  if (!parsed.impact) throw new Error("analysis is missing impact");

  const cited = parsed.railway_refs ?? parsed.railwayRefs ?? [];
  const keyPoints = parsed.key_points ?? parsed.keyPoints ?? [];
  const openQuestions = parsed.open_questions ?? parsed.openQuestions ?? [];
  const pagesRead = parsed.pages_read ?? parsed.pagesRead ?? [];
  const stated = parsed.no_action_reason ?? parsed.noActionReason;
  const noActionReason =
    actions.length > 0 ? undefined : clean(stated ?? UNSTATED_NO_ACTION_REASON);

  return {
    impact: parsed.impact,
    summary: clean(parsed.summary),
    keyPoints: keyPoints.map(clean).filter(Boolean),
    actions,
    ...(noActionReason ? { noActionReason } : {}),
    railwayRefs: cited.map((ref) => {
      const suggestedEdit = ref.suggested_edit ?? ref.suggestedEdit;
      const proposedText =
        ref.proposed_text ?? ref.proposedText ?? ref.replacement_text ?? ref.replacementText;
      const editKind = ref.edit_kind ?? ref.editKind;
      return {
        url: ref.url.trim(),
        claim: clean(ref.claim),
        ...(suggestedEdit ? { suggestedEdit: clean(suggestedEdit) } : {}),
        // Punctuated our way like every other string, and otherwise left
        // alone: this is the copy someone pastes, so its line breaks are part
        // of it and trimming past them would reshape a table row or a bullet.
        ...(proposedText ? { proposedText: sanitizeCopy(proposedText).trim() } : {}),
        ...(editKind ? { editKind } : {}),
      };
    }),
    openQuestions: openQuestions.map(clean).filter(Boolean),
    ...(pagesRead.length > 0 ? { pagesRead: pagesRead.map((url) => url.trim()) } : {}),
  };
}

const imageSchema = z.object({
  url: z.string().min(1),
  altText: z.string().default(""),
  origin: z.enum(IMAGE_ORIGINS).default("page"),
});

const issueSchema = z.object({
  url: z.string().min(1),
  number: z.number().int().nonnegative(),
});

/**
 * The review one action got. Stored so a retry of an analysis that never
 * reached Discord finds the verdict already there and does not review again:
 * the loop runs once per action, not once per attempt to post it.
 */
const reviewSchema = z.object({
  verdict: z.enum(REVIEW_VERDICTS),
  model: z.string().min(1),
  at: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().min(1),
  ),
  reason: z.string().min(1),
  applied: z.boolean().optional(),
});

/** One action's issue, stored in the same order as `actions`. */
const actionIssueSchema = z.object({
  type: actionToken.optional(),
  feature,
  issue: issueSchema.optional().nullable(),
  review: reviewSchema.optional().nullable(),
});

/**
 * What actually goes in `analyses.analysis`: the verdict plus the picture and
 * the issues it was posted with, so a retry re-posts the same alert instead of
 * re-resolving an image and opening a second set of issues.
 */
export const alertPayloadSchema = analysisSchema.extend({
  image: imageSchema.optional().nullable(),
  issues: z.array(actionIssueSchema).max(4).optional().nullable(),
});

export interface StoredAlertPayload {
  analysis: Analysis;
  image: FeatureImage | null;
  /** One entry per action, in order, whether or not an issue was opened for it. */
  issues: ActionIssue[];
}

function readActionIssues(
  parsed: z.infer<typeof alertPayloadSchema>,
  actions: RecommendedAction[],
): ActionIssue[] {
  const stored = parsed.issues ?? null;
  return actions.map((action, index) => {
    const review = stored?.[index]?.review;
    return {
      action,
      issue: stored ? (stored[index]?.issue ?? null) : null,
      ...(review
        ? {
            review: {
              verdict: review.verdict,
              model: review.model,
              at: parseDate(review.at) ?? new Date(0),
              reason: review.reason,
              ...(review.applied === undefined ? {} : { applied: review.applied }),
            },
          }
        : {}),
    };
  });
}

export function parseStoredAlert(raw: unknown): StoredAlertPayload {
  const parsed = alertPayloadSchema.parse(raw);
  const analysis = normalizeAnalysis(parsed);
  return {
    analysis,
    image: parsed.image ?? null,
    issues: readActionIssues(parsed, analysis.actions),
  };
}

export function serializeAlertPayload(
  analysis: Analysis,
  image: FeatureImage | null,
  issues: ActionIssue[],
): Record<string, unknown> {
  return {
    ...analysis,
    image,
    issues: issues.map(({ action, issue, review }) => ({
      type: action.type,
      ...(action.feature ? { feature: action.feature } : {}),
      issue,
      ...(review ? { review: { ...review, at: review.at.toISOString() } } : {}),
    })),
  };
}

/**
 * Agent replies often wrap JSON in prose or fences. Pull out the first
 * balanced JSON object rather than trusting the whole response to parse.
 */
export function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = (fenced?.[1] ?? raw).trim();

  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in model output");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  throw new Error("unterminated JSON object in model output");
}

export function parseAnalysis(raw: string): Analysis {
  const json = JSON.parse(extractJsonObject(raw)) as unknown;
  return normalizeAnalysis(analysisSchema.parse(json));
}
