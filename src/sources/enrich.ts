import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import type { CandidateItem } from "../types.js";
import { extractImageUrls, extractPage } from "../util/html.js";
import { fetchText } from "../util/http.js";
import { parseDate, truncate } from "../util/text.js";

const log = createLogger("enrich");

const MAX_BODY_CHARS = 8_000;

/**
 * Discovery only yields a URL, so a blog item reaches analysis with nothing but
 * its slug. Fetch the article itself for the handful of items that are actually
 * new, and use its real title, body, and published date. A blog index gives no
 * date at all, and without one an item sorts last in a capped run however
 * fresh it is.
 */
export async function enrichArticles(
  config: Config,
  items: CandidateItem[],
): Promise<CandidateItem[]> {
  const enriched: CandidateItem[] = [];

  for (const item of items) {
    if (item.source !== "blog") {
      enriched.push(item);
      continue;
    }

    try {
      const html = await fetchText(item.url, {
        timeoutMs: config.httpTimeoutMs,
        userAgent: config.userAgent,
        accept: "text/html,application/xhtml+xml",
        attempts: 2,
      });
      const page = extractPage(html);
      enriched.push({
        ...item,
        title: page.title || item.title,
        publishedAt: item.publishedAt ?? parseDate(page.published),
        raw: {
          ...item.raw,
          description: page.description,
          body: truncate(page.text, MAX_BODY_CHARS),
          // We already have the HTML here, so the alert's image comes free.
          image: extractImageUrls(html, item.url)[0] ?? null,
        },
      });
    } catch (error) {
      log.warn(
        `could not fetch article body for ${item.url}`,
        error instanceof Error ? error.message : error,
      );
      enriched.push(item);
    }
  }

  return enriched;
}
