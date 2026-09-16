import { chromium } from "playwright";
import type { Config } from "../config.js";
import { carriesCredential, createArtifactWriter, type ArtifactWriter } from "../github/artifact.js";
import { createLogger } from "../log.js";
import { isMarketingTarget } from "../railway/pages.js";
import type { CorpusIndex } from "../railway/retrieval.js";
import type { AnalyzedItem, RecommendedAction } from "../types.js";
import { captureEdit, type CaptureResult } from "./live-page.js";
import { planPageEdit, type PageEditPlan, type PageShots, type PageVisual } from "./page-edit.js";

const log = createLogger("page-visual");

/**
 * The Before/After on an `update_pages` issue, end to end: work out what the
 * edit is, open the real page in a headless browser, photograph it before and
 * with the copy staged in the browser only, commit both PNGs, hand back the
 * URLs the issue embeds.
 *
 * Only page actions get a pair. `consider_enhancing` and `consider_building`
 * are asking for a feature, and there is no before and after of a feature that
 * does not exist yet – a picture of one would be an invention, which is the
 * failure mode this whole repo is built against.
 *
 * Every step fails soft, and the whole thing is one `try`. A browser that will
 * not launch, a page that will not load, a commit the token cannot make: each
 * costs the picture and none of them costs the issue, which already says the
 * same thing in words. That is why this runs and is never awaited for its
 * verdict: `make` returns an empty list rather than throwing.
 */
export interface PageVisualMaker {
  readonly description: string;
  /** Never throws. Empty when there was nothing to photograph, or nothing could. */
  make(alert: AnalyzedItem, action: RecommendedAction): Promise<PageVisual[]>;
}

/**
 * Two pages is the cap. One page edit is the normal shape of an `update_pages`
 * action, a second happens when a launch breaks the same claim on a compare
 * page and a migrate page, and a third is four screenshots above the copy
 * somebody came to paste.
 */
const MAX_VISUALS = 2;

/** A browser that will not start inside a minute is not going to. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The page edits worth photographing: the ones on a page marketing writes, that
 * carry finished copy. An `update_pages` action that reached this point has
 * already been through the evidence gate, so its copy is copy and its claim is
 * on the stored page; this is only picking which of its refs is the edit.
 */
export function plansFor(
  alert: AnalyzedItem,
  action: RecommendedAction,
  index: CorpusIndex,
): PageEditPlan[] {
  if (action.type !== "update_pages") return [];

  const plans: PageEditPlan[] = [];
  for (const ref of alert.analysis.railwayRefs) {
    if (!isMarketingTarget(ref.url) || !ref.proposedText) continue;
    const plan = planPageEdit(ref, index.page(ref.url)?.text);
    if (plan) plans.push(plan);
    if (plans.length >= MAX_VISUALS) break;
  }
  return plans;
}

/**
 * Photograph each page. One browser for the batch, a fresh context per page so
 * nothing one page sets carries into the next, and the browser closed whichever
 * way this ends.
 */
export async function captureAll(
  plans: PageEditPlan[],
  userAgent: string,
): Promise<CaptureResult[]> {
  if (plans.length === 0) return [];

  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
  try {
    const results: CaptureResult[] = [];
    for (const plan of plans) {
      results.push(await captureEdit(browser, plan, { userAgent }));
    }
    return results;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export class BrowserPageVisualMaker implements PageVisualMaker {
  readonly description: string;

  constructor(
    private readonly index: CorpusIndex,
    private readonly artifacts: ArtifactWriter,
    private readonly userAgent: string,
  ) {
    this.description = `photographs the live page before and after, ${artifacts.description}`;
  }

  async make(alert: AnalyzedItem, action: RecommendedAction): Promise<PageVisual[]> {
    const plans = plansFor(alert, action, this.index);
    if (plans.length === 0) return [];

    try {
      const captures = await captureAll(plans, this.userAgent);
      const visuals: PageVisual[] = [];

      for (const [index, plan] of plans.entries()) {
        const capture = captures[index];
        if (!capture) continue;
        const visual = await publishCapture(this.artifacts, alert, plan, capture);
        if (visual) visuals.push(visual);
      }

      const shot = visuals.filter((visual) => visual.shots !== null).length;
      if (shot > 0) log.info(`photographed ${shot} live page edit(s) for ${alert.item.url}`);
      return visuals;
    } catch (error) {
      // The commonest one by far: no browser on the box. It is a log line and
      // not an error, because the issue is fine without the picture.
      log.warn(
        `no before/after for ${alert.item.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

}

/**
 * Commit one page's pair, or say what there is to say instead.
 *
 * **Both or neither.** A Before with no After is a screenshot of a page with
 * nothing to compare it to, captioned as half of a comparison; it reads as a
 * broken issue. When one of the two commits is refused, the pair is dropped and
 * the issue is the text-only one.
 */
export async function publishCapture(
  artifacts: ArtifactWriter,
  alert: AnalyzedItem,
  plan: PageEditPlan,
  capture: CaptureResult,
): Promise<PageVisual | null> {
  const base: PageVisual = {
    pageUrl: plan.pageUrl,
    shots: null,
    summary: plan.summary,
    capturedOn: plan.capturedOn,
    copyMissingLive: false,
  };

  switch (capture.status) {
    case "missing": {
      // The stored page has the line and the live page does not, which means
      // the page has changed since the corpus read it and the edit may already
      // have been made. Worth one line in the issue; nothing else here knows it.
      if (!plan.quotedOnStoredPage) {
        log.warn(`the quoted line is on neither the live nor the stored ${plan.pageUrl}`);
        return null;
      }
      log.warn(`the quoted line is no longer on ${plan.pageUrl}, so there is nothing to show`);
      return { ...base, copyMissingLive: true };
    }
    case "skipped": {
      log.warn(`no before/after of ${plan.pageUrl}: ${capture.reason}`);
      return null;
    }
    case "captured": {
      const shots = await commitPair(artifacts, alert, plan, capture.before, capture.after);
      return shots ? { ...base, shots } : null;
    }
    default: {
      const exhaustive: never = capture;
      return exhaustive;
    }
  }
}

async function commitPair(
  artifacts: ArtifactWriter,
  alert: AnalyzedItem,
  plan: PageEditPlan,
  before: Buffer,
  after: Buffer,
): Promise<PageShots | null> {
  // Both are written even when the first one fails, because a dry run's writer
  // returns null for each and still puts the PNG in a temp file, and the pair
  // is what somebody previewing a dry run wants to look at.
  const beforeUrl = await artifacts.write(
    plan.beforePath,
    before,
    commitMessage(alert, plan, "before"),
  );
  const afterUrl = await artifacts.write(plan.afterPath, after, commitMessage(alert, plan, "after"));
  if (!beforeUrl || !afterUrl) return null;

  // The last gate before a URL reaches an issue body. A signed URL renders
  // while its signature lasts and 404s for everyone who reads the issue
  // afterwards, which is a broken image where the explanation should be: worse
  // than the text-only issue this falls back to.
  if (carriesCredential(beforeUrl) || carriesCredential(afterUrl)) {
    log.warn(`refusing to embed ${plan.beforePath}: the writer returned a URL that expires`);
    return null;
  }

  return { beforeUrl, afterUrl, beforeAlt: plan.beforeAlt, afterAlt: plan.afterAlt };
}

/**
 * A commit message that says what the file is for, because these land on the
 * default branch and somebody reading the log deserves better than "add png".
 * `[skip ci]` because a picture is not a code change and a CI run per morning's
 * artifacts is noise that teaches people to ignore the badge.
 */
export function commitMessage(
  alert: AnalyzedItem,
  plan: PageEditPlan,
  side: "before" | "after",
): string {
  const staged =
    side === "before"
      ? `${plan.pageUrl} as it read on ${plan.capturedOn}`
      : `${plan.pageUrl} with the proposed copy staged in a headless browser, published nowhere`;
  return `Add the ${side} of ${plan.pageName} [skip ci]\n\nPhotographed for the ${alert.item.competitor} signal ${alert.item.url}.\nThis is ${staged}. The edit ${plan.editKind === "insert" ? "adds copy next to" : "replaces"} a line there: ${plan.summary}.`;
}

/** Used when nothing should photograph anything: the switch is off. */
export class DisabledPageVisualMaker implements PageVisualMaker {
  readonly description: string;

  constructor(readonly reason: string) {
    this.description = `off (${reason})`;
  }

  async make(): Promise<PageVisual[]> {
    return [];
  }
}

export function createPageVisualMaker(config: Config, index: CorpusIndex): PageVisualMaker {
  if (config.skipPageVisuals) return new DisabledPageVisualMaker("SKIP_PAGE_VISUALS is set");
  return new BrowserPageVisualMaker(index, createArtifactWriter(config), config.userAgent);
}
