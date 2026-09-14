import { z } from "zod";
import {
  ACTIONS,
  IMAGE_ORIGINS,
  IMPACTS,
  type ActionIssue,
  type Analysis,
  type FeatureImage,
  type RecommendedAction,
} from "../types.js";
import { sanitizeCopy } from "../util/text.js";

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

const refSchema = z.object({
  url: z.string().min(1),
  claim: z.string().min(1),
  suggested_edit: optionalText(600),
  suggestedEdit: optionalText(600),
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
});

export const analysisSchema = z.object({
  impact: impactToken.optional(),
  summary: z.string().min(1).max(600),
  key_points: lines.optional(),
  keyPoints: lines.optional(),
  actions: z.array(actionSchema).max(4).optional(),
  railway_refs: refs.optional(),
  railwayRefs: refs.optional(),
  open_questions: lines.optional(),
  openQuestions: lines.optional(),
});

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
  return {
    type,
    detail: clean(actionDetail),
    ...(named ? { feature: clean(named) } : {}),
  };
}

export interface ReadOptions {
  /**
   * Read an actions list that is empty as empty, rather than as a broken
   * reply. A stored alert can genuinely have no action: the relevance guard
   * drops a page edit that was not about the launch, and sometimes that was
   * the only thing the model asked for. A model reply still has to name one.
   */
  allowNoAction?: boolean;
}

function readActions(
  parsed: z.infer<typeof analysisSchema>,
  options: ReadOptions,
): RecommendedAction[] {
  const listed = (parsed.actions ?? [])
    .map(toAction)
    .filter((action): action is RecommendedAction => action !== null);
  if (listed.length > 0) return listed;
  if (options.allowNoAction && Array.isArray(parsed.actions)) return [];
  throw new Error("analysis is missing an action with a detail");
}

/** Models drift between snake_case and camelCase; accept both and normalize. */
export function normalizeAnalysis(
  parsed: z.infer<typeof analysisSchema>,
  options: ReadOptions = {},
): Analysis {
  const actions = readActions(parsed, options);

  if (!parsed.impact) throw new Error("analysis is missing impact");

  const cited = parsed.railway_refs ?? parsed.railwayRefs ?? [];
  const keyPoints = parsed.key_points ?? parsed.keyPoints ?? [];
  const openQuestions = parsed.open_questions ?? parsed.openQuestions ?? [];

  return {
    impact: parsed.impact,
    summary: clean(parsed.summary),
    keyPoints: keyPoints.map(clean).filter(Boolean),
    actions,
    railwayRefs: cited.map((ref) => {
      const suggestedEdit = ref.suggested_edit ?? ref.suggestedEdit;
      return {
        url: ref.url.trim(),
        claim: clean(ref.claim),
        ...(suggestedEdit ? { suggestedEdit: clean(suggestedEdit) } : {}),
      };
    }),
    openQuestions: openQuestions.map(clean).filter(Boolean),
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

/** One action's issue, stored in the same order as `actions`. */
const actionIssueSchema = z.object({
  type: actionToken.optional(),
  feature: feature.optional(),
  issue: issueSchema.optional().nullable(),
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
  return actions.map((action, index) => ({
    action,
    issue: stored ? (stored[index]?.issue ?? null) : null,
  }));
}

export function parseStoredAlert(raw: unknown): StoredAlertPayload {
  const parsed = alertPayloadSchema.parse(raw);
  const analysis = normalizeAnalysis(parsed, { allowNoAction: true });
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
    issues: issues.map(({ action, issue }) => ({
      type: action.type,
      ...(action.feature ? { feature: action.feature } : {}),
      issue,
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
