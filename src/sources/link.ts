import type { CandidateItem } from "../types.js";

/**
 * Some changelogs are one page with an `#anchor` per release. `item.url` has
 * the hash stripped, because dedupe and the Railway index want one URL per
 * page, so the item alone can no longer say which release it was about.
 * Sources that know the anchor keep it here.
 */
export const ENTRY_URL_KEY = "entryUrl";

/**
 * The URL of the exact thing that changed: the anchored entry when the feed
 * gave one, the item's own page otherwise. This is what a reader should open
 * and what a screenshot should show.
 */
export function entryUrl(item: Pick<CandidateItem, "url" | "raw">): string {
  const stored = (item.raw as Record<string, unknown>)[ENTRY_URL_KEY];
  return typeof stored === "string" && stored.trim().length > 0 ? stored.trim() : item.url;
}

/** True when the entry is one section of a page that holds many of them. */
export function isAnchoredEntry(url: string): boolean {
  try {
    return new URL(url).hash.length > 1;
  } catch {
    return false;
  }
}
