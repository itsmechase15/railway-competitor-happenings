import { chromium } from "playwright";
import type { Config } from "../config.js";
import { carriesCredential, createArtifactWriter, type ArtifactWriter } from "../github/artifact.js";
import { createLogger } from "../log.js";
import { isMarketingTarget } from "../railway/pages.js";
import type { CorpusIndex } from "../railway/retrieval.js";
import type { AnalyzedItem, RecommendedAction } from "../types.js";
import { planPageEdit, visualHtml, type PageEditPlan, type PageVisual } from "./page-edit.js";

const log = createLogger("page-visual");

/**
 * The Before/After picture on an `update_pages` issue, end to end: plan it from
 * the corpus, draw it in a headless browser, commit the PNG, hand back the URL
 * the issue embeds.
 *
 * Only page actions get one. `consider_enhancing` and `consider_building` are
 * asking for a feature, and there is no before and after of a feature that does
 * not exist yet – a picture of one would be an invention, which is the failure
 * mode this whole repo is built against.
 *
 * Every step fails soft, and the whole thing is one `try`. A browser that will
 * not launch, a page that will not screenshot, a commit the token cannot make:
 * each costs the picture and none of them costs the issue, which already says
 * the same thing in words. That is why this runs and is never awaited for its
 * verdict: `make` returns an empty list rather than throwing.
 */
export interface PageVisualMaker {
  readonly description: string;
  /** Never throws. Empty when there was nothing to draw, or nothing could draw it. */
  make(alert: AnalyzedItem, action: RecommendedAction): Promise<PageVisual[]>;
}

/**
 * Two pictures is the cap. One page edit is the normal shape of an
 * `update_pages` action, a second happens when a launch breaks the same claim on
 * a compare page and a migrate page, and a third is a screenful of images above
 * the copy somebody came to paste.
 */
const MAX_VISUALS = 2;

/**
 * The picture's width. The height is whatever the paragraph needs, which is why
 * the shot is of the document body rather than of the viewport: a full-page
 * screenshot never comes back shorter than the window, and a two-line edit in a
 * 640-pixel window is a card with an empty screen under it.
 */
const VIEWPORT = { width: 1_200, height: 640 } as const;

/** A browser that will not start inside a minute is not going to. */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * The page edits worth drawing: the ones on a page marketing writes, that carry
 * finished copy. An `update_pages` action that reached this point has already
 * been through the evidence gate, so its copy is copy and its claim is on the
 * stored page; this is only picking which of its refs is the edit.
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
 * Draw each picture. One browser for the batch, closed whichever way this ends.
 *
 * The HTML is set on the page directly rather than served, so nothing here
 * touches the network: no navigation, no webfont, no live Railway page. The
 * screenshot is full-page because the paragraph decides the height.
 */
export async function renderVisuals(plans: PageEditPlan[]): Promise<Array<Buffer | null>> {
  if (plans.length === 0) return [];

  const browser = await chromium.launch({ timeout: LAUNCH_TIMEOUT_MS });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      // Nothing in the document asks for a resource, so a run that somehow does
      // is a bug rather than a slow load. Fail rather than wait on it.
      offline: true,
    });
    const page = await context.newPage();

    const shots: Array<Buffer | null> = [];
    for (const plan of plans) {
      try {
        await page.setContent(visualHtml(plan), { waitUntil: "load" });
        shots.push(await page.locator("body").screenshot({ type: "png" }));
      } catch (error) {
        log.warn(
          `could not draw the edit for ${plan.pageUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
        shots.push(null);
      }
    }
    return shots;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export class BrowserPageVisualMaker implements PageVisualMaker {
  readonly description: string;

  constructor(
    private readonly index: CorpusIndex,
    private readonly artifacts: ArtifactWriter,
  ) {
    this.description = `renders update_pages before/after images, ${artifacts.description}`;
  }

  async make(alert: AnalyzedItem, action: RecommendedAction): Promise<PageVisual[]> {
    const plans = plansFor(alert, action, this.index);
    if (plans.length === 0) return [];

    try {
      const shots = await renderVisuals(plans);
      const visuals: PageVisual[] = [];

      for (const [index, plan] of plans.entries()) {
        const png = shots[index];
        if (!png) continue;
        const imageUrl = await this.artifacts.write(plan.path, png, commitMessage(alert, plan));
        if (!imageUrl) continue;
        // The last gate before a URL reaches an issue body. A signed URL renders
        // while its signature lasts and 404s for everyone who reads the issue
        // afterwards, which is a broken image where the explanation should be:
        // worse than the text-only issue this falls back to.
        if (carriesCredential(imageUrl)) {
          log.warn(`refusing to embed ${plan.path}: the writer returned a URL that expires`);
          continue;
        }
        visuals.push({
          pageUrl: plan.pageUrl,
          imageUrl,
          altText: plan.altText,
          summary: plan.summary,
        });
      }

      if (visuals.length > 0) {
        log.info(`drew ${visuals.length} before/after image(s) for ${alert.item.url}`);
      }
      return visuals;
    } catch (error) {
      // The commonest one by far: no browser on the box. It is a log line and
      // not an error, because the issue is fine without the picture.
      log.warn(
        `no before/after image for ${alert.item.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}

/**
 * A commit message that says what the file is for, because these land on the
 * default branch and somebody reading the log deserves better than "add png".
 * `[skip ci]` because a picture is not a code change and a CI run per morning's
 * artifacts is noise that teaches people to ignore the badge.
 */
export function commitMessage(alert: AnalyzedItem, plan: PageEditPlan): string {
  return `Add a before/after for ${plan.pageName} [skip ci]\n\nDrawn for the ${alert.item.competitor} signal ${alert.item.url}.\nThe edit ${plan.editKind === "insert" ? "adds copy next to" : "replaces"} a line on ${plan.pageUrl}: ${plan.summary}.`;
}

/** Used when nothing should draw anything: the switch is off. */
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
  return new BrowserPageVisualMaker(index, createArtifactWriter(config));
}
