import { createHash } from "node:crypto";

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Shorten to `max` characters, ellipsis included. The cut lands on the last
 * word boundary, so a trimmed sentence reads as a sentence that stops rather
 * than one that breaks mid-word. A run of text with no space near the limit –
 * a URL, a long identifier – is cut where the limit falls.
 */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  const head = input.slice(0, Math.max(0, max - 1)).trimEnd();
  const boundary = head.lastIndexOf(" ");
  const cut = boundary > max * 0.6 ? head.slice(0, boundary) : head;
  return `${cut.replace(/[\s,;:\u2013\u2014-]+$/, "")}…`;
}

export const EN_DASH = "\u2013";
export const SPACED_EN_DASH = ` ${EN_DASH} `;

/**
 * Punctuation applied to every string on its way to Discord or an issue: en
 * dashes instead of em dashes, straight quotes instead of curly ones. A model
 * that reaches for an em dash cannot ship one.
 */
export function sanitizeCopy(input: string): string {
  return input
    .replace(/[ \t]*[\u2014\u2015][ \t]*/g, SPACED_EN_DASH)
    // A dash between words takes spaces; a range like 2024–2025 keeps none.
    .replace(/(?<!\d)[ \t]*\u2013[ \t]*(?!\d)/g, SPACED_EN_DASH)
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
}

/**
 * Split prose into sentences. Abbreviations and decimals would fool a bare
 * split on ".", so a boundary also needs whitespace and a capital or digit
 * after it.
 */
export function sentences(input: string): string[] {
  return collapseWhitespace(input)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** The first sentence, for the places that are allowed exactly one. */
export function firstSentence(input: string, max = 240): string {
  const [first] = sentences(input);
  return truncate(first ?? collapseWhitespace(input), max);
}

/** Word characters, for every reader that wants a text as a bag of words. */
export const WORD_PATTERN = /[a-z0-9]+/g;

/**
 * Fold a word to a stem crude enough to be predictable: cache, caches, cached,
 * and caching all have to land on the same token, and scaling has to land on
 * scale. Plurals go first, so plans and plan meet rather than parting.
 *
 * Shared by the topic guard, which decides whether a page edit is about this
 * launch, and by corpus retrieval, which has to match a launch's words against
 * a docs page written years earlier in the plural.
 */
export function stem(word: string): string {
  let stemmed = singular(word);
  if (stemmed.length > 4 && stemmed.endsWith("ing")) stemmed = stemmed.slice(0, -3);
  else if (stemmed.length > 4 && stemmed.endsWith("ed")) stemmed = stemmed.slice(0, -2);
  if (stemmed.length > 4 && stemmed.endsWith("e")) stemmed = stemmed.slice(0, -1);
  // "shipping" and "shipped" lose a doubled consonant that "ship" never had.
  return stemmed.replace(/([bdgklmnprt])\1$/, "$1");
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** A text as its stems, in order, with everything that is not a word dropped. */
export function stems(text: string): string[] {
  return (text.toLowerCase().match(WORD_PATTERN) ?? []).map(stem);
}

/**
 * Parse a date from a feed or API payload. Returns null rather than an
 * Invalid Date so callers can treat "no date" and "bad date" the same way.
 */
export function parseDate(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (typeof input !== "string" && typeof input !== "number") return null;
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function daysAgo(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Drop tracking params and fragments so the same page always dedupes to one
 * URL. `keepFragment` is for the callers that need the anchor back: a
 * changelog whose entries are `#anchors` on one page loses which entry it was
 * talking about the moment the hash goes.
 */
export function normalizeUrl(raw: string, options: { keepFragment?: boolean } = {}): string {
  try {
    const url = new URL(raw.trim());
    if (!options.keepFragment) url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key.toLowerCase() === "ref") {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

/**
 * How a page is named inside a sentence: "the compare to render page". Used
 * where a reader has to be told which page an action is about and a bare URL
 * would eat the whole line.
 */
export function pageNameFromUrl(raw: string): string {
  const title = titleFromUrl(raw);
  return title === raw ? raw : `the ${title.toLowerCase()} page`;
}

/** Turn a slug like "static-outbound-ips" into "Static outbound ips". */
export function titleFromUrl(raw: string): string {
  try {
    const { pathname } = new URL(raw);
    const slug = pathname.split("/").filter(Boolean).pop() ?? pathname;
    const words = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
    if (!words) return raw;
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return raw;
  }
}
