import { COMPETITORS, type Config } from "../config.js";
import { createLogger } from "../log.js";
import { entryUrl, isAnchoredEntry } from "../sources/link.js";
import type { CandidateItem, FeatureImage, StoredItem } from "../types.js";
import { extractImageUrls } from "../util/html.js";
import { fetchContentType, fetchText } from "../util/http.js";
import { truncate } from "../util/text.js";

const log = createLogger("image");

/** How many candidates from one page we are willing to probe before giving up. */
const MAX_CANDIDATES = 4;

/**
 * Some sites hand every page the same og:image, which is a brand card rather
 * than the feature. A screenshot of the actual page beats that, so these sort
 * last.
 */
const GENERIC_PREVIEW = /(default[-_.]?(seo|og|share|social)|(og|seo|share|social)[-_.]?default)/i;

export function isGenericPreview(url: string): boolean {
  return GENERIC_PREVIEW.test(url);
}

/** Alt text is for screen readers and for the issue's own `<img>` tag. */
function altTextFor(item: Pick<CandidateItem, "competitor" | "title">): string {
  return truncate(`${COMPETITORS[item.competitor].label}: ${item.title}`, 140);
}

/**
 * Renders the page and serves the result as an image, so the last resort is a
 * real screenshot of the competitor's feature page without shipping a browser
 * into the daily job. Swappable via `SCREENSHOT_URL_TEMPLATE`.
 *
 * `{encodedUrl}` is the placeholder to use when the page URL carries a
 * fragment: a raw `#` in a URL is a fragment of the *screenshot* URL, so
 * neither our HEAD probe nor Discord ever sends it to the renderer.
 */
export function screenshotUrl(template: string, pageUrl: string): string {
  if (template.includes("{encodedUrl}")) {
    return template.replace("{encodedUrl}", encodeURIComponent(pageUrl));
  }
  return template.includes("{url}")
    ? template.replace("{url}", pageUrl)
    : `${template}${pageUrl}`;
}

/**
 * A generated card naming the competitor and the feature. Never pretty, but an
 * alert always has to carry a valid image, and this one cannot 404.
 */
export function generatedCardUrl(item: Pick<CandidateItem, "competitor" | "title">): string {
  const label = COMPETITORS[item.competitor].label;
  const text = encodeURIComponent(truncate(`${label}\n${item.title}`, 90));
  return `https://placehold.co/1200x630/13111c/c04cfd/png?text=${text}&font=source-sans-pro`;
}

/** The image URL a source handed us directly, if it gave one. */
export function imageFromRaw(item: Pick<StoredItem, "raw">): string | null {
  const candidate = (item.raw as Record<string, unknown>).image;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

async function servesAnImage(config: Config, url: string): Promise<boolean> {
  const contentType = await fetchContentType(url, {
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
    accept: "image/*",
  });
  if (contentType === null) return false;
  return contentType.toLowerCase().startsWith("image/");
}

async function candidatesFromPage(config: Config, url: string): Promise<string[]> {
  try {
    const html = await fetchText(url, {
      timeoutMs: config.httpTimeoutMs,
      userAgent: config.userAgent,
      accept: "text/html,application/xhtml+xml",
      attempts: 2,
    });
    return extractImageUrls(html, url).slice(0, MAX_CANDIDATES);
  } catch (error) {
    log.debug(`could not read ${url} for images: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/** The first renderer that gives us a picture of `pageUrl`, if any does. */
async function firstWorkingScreenshot(config: Config, pageUrl: string): Promise<string | null> {
  for (const template of config.screenshotUrlTemplates) {
    const shot = screenshotUrl(template, pageUrl);
    if (await servesAnImage(config, shot)) return shot;
    log.debug(`${template} could not render ${pageUrl}`);
  }
  return null;
}

/**
 * Find the picture for an alert: whatever the feed or tweet attached, then the
 * page's own og:image or an in-content screenshot, then a rendered screenshot
 * of the page, and finally a generated card. The last step cannot fail,
 * because an alert without an image does not get posted.
 *
 * An entry that is an `#anchor` on a shared page skips the page's own images
 * entirely: a changelog that holds every release on one page has an og:image
 * belonging to the page, not to the entry, and in-page pictures belonging to
 * other releases. The anchor is exactly what a renderer needs to scroll to the
 * entry that did change.
 */
export async function resolveFeatureImage(config: Config, item: StoredItem): Promise<FeatureImage> {
  const altText = altTextFor(item);
  const fromSource = imageFromRaw(item);

  if (fromSource && (await servesAnImage(config, fromSource))) {
    return { url: fromSource, altText, origin: item.source === "x" ? "x" : "feed" };
  }

  const target = entryUrl(item);
  const sharedPage = isAnchoredEntry(target);

  const candidates = sharedPage ? [] : await candidatesFromPage(config, item.url);
  const specific = candidates.filter((url) => !isGenericPreview(url));
  const generic = candidates.filter(isGenericPreview);

  for (const candidate of specific) {
    if (await servesAnImage(config, candidate)) {
      return { url: candidate, altText, origin: "page" };
    }
  }

  const shot = await firstWorkingScreenshot(config, target);
  if (shot) return { url: shot, altText, origin: "screenshot" };

  // A brand card is still better than a card we generated ourselves.
  for (const candidate of generic) {
    if (await servesAnImage(config, candidate)) {
      return { url: candidate, altText, origin: "page" };
    }
  }

  log.warn(`no usable image for ${target} – falling back to a generated card`);
  return { url: generatedCardUrl(item), altText, origin: "generated" };
}
