import { findRailwayProduct, productReferenceUrl } from "./railway/products.js";
import type { Action, ActionOwner, Impact, RecommendedAction, SourceId } from "./types.js";

/** Everything user-facing says "impact", never "severity". */
export const IMPACT_LABEL: Record<Impact, string> = {
  minor: "Minor",
  notable: "Notable",
  major: "Major",
};

/**
 * What each level means, in one line. Impact is decided by what the post
 * shipped and nothing else, so anywhere with the room to say so says it.
 */
export const IMPACT_MEANING: Record<Impact, string> = {
  minor: "no new feature or enhancement in the post",
  notable: "an enhancement of a feature they already had",
  major: "a brand-new feature that did not exist before",
};

/** The embed's left border, so impact reads before the word does. */
export const IMPACT_COLOR: Record<Impact, number> = {
  minor: 0x5865f2,
  notable: 0xf0a020,
  major: 0xe0245e,
};

export const ACTION_LABEL: Record<Action, string> = {
  consider_enhancing: "Consider enhancing",
  consider_building: "Consider building",
  update_pages: "Update pages",
};

/**
 * Who owns each action. Marketing writes the compare, migrate, pricing, and
 * features pages; product decides what gets built.
 */
export const ACTION_OWNER: Record<Action, ActionOwner> = {
  consider_enhancing: "product",
  consider_building: "product",
  update_pages: "marketing",
};

export function actionOwner(action: RecommendedAction): ActionOwner {
  return ACTION_OWNER[action.type];
}

/** An action title, kept in two pieces so the embed can link the surface name. */
export interface ActionTitle {
  label: string;
  /** Present only when the title names a Railway surface. `url` when we know its docs page. */
  feature?: { label: string; url?: string };
}

/**
 * The title split at the feature. "Consider enhancing" on its own names
 * nothing, so the feature is part of the title; the other two actions read
 * fine without one. A feature the catalog recognizes gets Railway's own
 * casing, so "serverless" from a model still reads as "Serverless".
 */
export function actionTitleParts(action: RecommendedAction): ActionTitle {
  const label = ACTION_LABEL[action.type];
  if (action.type !== "consider_enhancing" || !action.feature) return { label };
  const product = findRailwayProduct(action.feature);
  return {
    label,
    feature: {
      label: product?.label ?? action.feature,
      url: product ? productReferenceUrl(product) : undefined,
    },
  };
}

/** The whole title as one string, for everywhere that cannot carry a link. */
export function actionLabel(action: RecommendedAction): string {
  const { label, feature } = actionTitleParts(action);
  return feature ? `${label} ${feature.label}` : label;
}

/**
 * What the review left behind, as a label anyone can filter on.
 *
 * `agreed`, `revised`, and `dropped` are the three verdicts. `unconfirmed` is a
 * revise that was written and then could not survive the evidence checks, so
 * the issue still says what the analyst wrote – the label is there because
 * "reviewed and left alone" and "reviewed, rewritten, and the rewrite failed"
 * are different things to a reader. `skipped` is no review at all: the run was
 * over its budget, or the reviewer model refused the run.
 */
export const REVIEW_LABEL = {
  agreed: "review:agreed",
  revised: "review:revised",
  dropped: "review:dropped",
  unconfirmed: "review:unconfirmed",
  skipped: "review:skipped",
} as const;

/**
 * The label that makes the loop run once.
 *
 * Every verdict writes it, in the same request that writes the verdict's own
 * label, and the review entry point refuses any issue that already carries it.
 * An edit never calls the reviewer, so there is no path back in – this is the
 * belt to that braces.
 */
export const REVIEW_PASS_DONE = "review-pass:done";

/**
 * The short tag for where an item came from, used everywhere the source is
 * named as a tag rather than in a sentence: the link on the KNOW line, the
 * embed footer, and the issue. It names the thing you land on, so a page on
 * the competitor's own website is an article, whether it sits under /blog/ or
 * anywhere else they publish.
 */
export const SOURCE_LABEL: Record<SourceId, string> = {
  changelog: "changelog",
  blog: "article",
  x: "tweet",
  newsletter: "newsletter",
};
