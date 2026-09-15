import type { PageKind, RailwayPage } from "../types.js";
import { sentences, stems, titleFromUrl, truncate } from "../util/text.js";
import { isCatalogOverviewUrl } from "./products.js";

/**
 * Lexical retrieval over the stored corpus.
 *
 * BM25 rather than embeddings, on purpose. The question being asked is "does
 * any Railway page talk about this?", and the thing being matched is a
 * competitor's launch vocabulary against Railway's docs vocabulary – the same
 * words, mostly, because both write about the same industry. A lexical index
 * is also the one the coverage gate can be honest about: a page it ranks
 * highly for a gap claim is a page somebody can open and read, and a miss is
 * reproducible in a test rather than a property of a model nobody pinned.
 */

/** Standard BM25 constants. `k1` damps term repetition, `b` normalizes length. */
const K1 = 1.5;
const B = 0.75;

/** The title is what a page is about, so its words count for several mentions. */
const TITLE_WEIGHT = 3;

/** A surface's overview page beats a guide that happens to use the same words. */
const OVERVIEW_BOOST = 1.2;

/** Words too common in this corpus to tell one page from another. */
const STOP_WORDS = new Set(
  [
    "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been",
    "but", "by", "can", "do", "does", "for", "from", "has", "have", "how", "if", "in", "into",
    "is", "it", "its", "more", "need", "new", "no", "not", "of", "on", "one", "only", "or",
    "other", "our", "out", "over", "railway", "see", "set", "so", "some", "than", "that", "the",
    "their", "them", "then", "there", "these", "this", "those", "to", "up", "use", "used",
    "using", "want", "was", "we", "what", "when", "where", "which", "who", "will", "with",
    "would", "you", "your",
  ].map((word) => stems(word)[0] ?? word),
);

/** The stems worth indexing or searching on. */
export function terms(text: string): string[] {
  return stems(text).filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/**
 * The docs section a page sits in, read off its first path segment. Used to
 * stop one area of the docs filling a prompt on its own.
 */
export function sectionOf(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const [first] = pathname.split("/").filter(Boolean);
    return first ?? hostname;
  } catch {
    return "other";
  }
}

interface IndexedDoc {
  url: string;
  title: string;
  kind: PageKind;
  section: string;
  text: string;
  frequencies: Map<string, number>;
  length: number;
}

export interface RetrievalHit {
  url: string;
  title: string;
  kind: PageKind;
  section: string;
  score: number;
  /** The part of the page that speaks to the query. */
  excerpt: string;
  /** Distinct query stems this page actually contains, for explaining a block. */
  matched: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Hits allowed from any one docs section. */
  perSection?: number;
  kinds?: PageKind[];
  /** Characters of excerpt per hit. */
  excerptChars?: number;
}

export interface CorpusIndex {
  readonly size: number;
  search(query: string, options?: SearchOptions): RetrievalHit[];
  page(url: string): { url: string; title: string; kind: PageKind; text: string } | undefined;
  /** Every indexed URL, for the checks that ask whether a citation is in the corpus. */
  urls(): string[];
}

function countTerms(doc: Pick<RailwayPage, "title" | "text">): Map<string, number> {
  const counted = new Map<string, number>();
  const add = (token: string, weight: number): void => {
    counted.set(token, (counted.get(token) ?? 0) + weight);
  };
  for (const token of terms(doc.title)) add(token, TITLE_WEIGHT);
  for (const token of terms(doc.text)) add(token, 1);
  return counted;
}

/**
 * Pull out the part of a page that answers the query: the lead sentence, which
 * says what the page is, plus the sentences that use the most of the query's
 * own words.
 */
export function bestExcerpt(text: string, queryTerms: string[], maxChars = 700): string {
  const all = sentences(text);
  if (all.length === 0) return "";

  const wanted = new Set(queryTerms);
  const lead = all[0] ?? "";
  const scored = all.slice(1).map((sentence, index) => {
    const hits = new Set(terms(sentence).filter((token) => wanted.has(token)));
    return { sentence, index, score: hits.size };
  });

  const picked = scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);

  return truncate([lead, ...picked].join(" ").trim(), maxChars);
}

/**
 * Build the index for one run. Every page is tokenized once, and every query
 * for every item that run reads the same index: a corpus of a few hundred
 * pages costs a few hundred milliseconds here and nothing afterwards.
 */
export function buildCorpusIndex(pages: RailwayPage[]): CorpusIndex {
  const docs: IndexedDoc[] = pages
    .filter((page) => page.text.trim().length > 0)
    .map((page) => {
      const frequencies = countTerms(page);
      let length = 0;
      for (const count of frequencies.values()) length += count;
      return {
        url: page.url,
        title: page.title || titleFromUrl(page.url),
        kind: page.kind,
        section: sectionOf(page.url),
        text: page.text,
        frequencies,
        length,
      };
    });

  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const token of doc.frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const averageLength = docs.length > 0 ? docs.reduce((t, d) => t + d.length, 0) / docs.length : 1;
  const byUrl = new Map(docs.map((doc) => [doc.url, doc]));

  function idf(token: string): number {
    const df = documentFrequency.get(token) ?? 0;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  }

  return {
    size: docs.length,

    urls() {
      return docs.map((doc) => doc.url);
    },

    page(url) {
      const doc = byUrl.get(url);
      return doc ? { url: doc.url, title: doc.title, kind: doc.kind, text: doc.text } : undefined;
    },

    search(query, options = {}) {
      const queryTerms = [...new Set(terms(query))];
      if (queryTerms.length === 0) return [];

      const scored: RetrievalHit[] = [];
      for (const doc of docs) {
        if (options.kinds && !options.kinds.includes(doc.kind)) continue;

        let score = 0;
        const matched: string[] = [];
        for (const token of queryTerms) {
          const frequency = doc.frequencies.get(token);
          if (!frequency) continue;
          matched.push(token);
          const denominator =
            frequency + K1 * (1 - B + (B * doc.length) / (averageLength || 1));
          score += idf(token) * ((frequency * (K1 + 1)) / denominator);
        }
        if (score <= 0) continue;

        scored.push({
          url: doc.url,
          title: doc.title,
          kind: doc.kind,
          section: doc.section,
          score: isCatalogOverviewUrl(doc.url) ? score * OVERVIEW_BOOST : score,
          excerpt: "",
          matched,
        });
      }

      scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

      const limit = options.limit ?? 10;
      const perSection = options.perSection ?? limit;
      const used = new Map<string, number>();
      const picked: RetrievalHit[] = [];

      for (const hit of scored) {
        const taken = used.get(hit.section) ?? 0;
        if (taken >= perSection) continue;
        used.set(hit.section, taken + 1);
        picked.push({
          ...hit,
          excerpt: bestExcerpt(
            byUrl.get(hit.url)?.text ?? "",
            queryTerms,
            options.excerptChars ?? 700,
          ),
        });
        if (picked.length >= limit) break;
      }

      return picked;
    },
  };
}
