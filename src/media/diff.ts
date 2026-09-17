/**
 * The word-level difference between the copy on a page and the copy proposed
 * for it.
 *
 * A page edit is a paragraph swapped for a paragraph, and two screenshots of
 * nearly the same prose do not say how much of it moved. That is what this is
 * for: the line under the pair reads "18 words added, 13 words removed", which
 * is a size somebody can picture before they open either image.
 *
 * Compared on letters and digits only, so "billing." and "billing" are the same
 * word and a comma is not a change.
 */

/** What happened to a run of words: it stayed, it went, or it arrived. */
export type DiffKind = "same" | "removed" | "added";

export interface DiffSpan {
  kind: DiffKind;
  /** The words as they are written, including the space that followed them. */
  text: string;
}

/**
 * Past this many words on either side, the table the diff is built on stops
 * being worth building: a page edit is a paragraph, and anything an order of
 * magnitude longer is a whole section swap that reads better as one block
 * replaced by another.
 */
const MAX_WORDS = 600;

/** A word as it is compared: letters and digits, folded to lowercase. */
function key(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Text as words, each carrying the whitespace that followed it, so joining the
 * pieces back together returns the original string exactly.
 */
export function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/** Whether a span is a word rather than punctuation that folded away to nothing. */
function counts(word: string): boolean {
  return key(word) !== "";
}

/**
 * How long a common subsequence starts at each pair of positions. Plain dynamic
 * programming: the lists are a paragraph each.
 */
function lcsTable(before: string[], after: string[]): Uint32Array {
  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      const here = row * columns + column;
      table[here] =
        key(before[row]!) === key(after[column]!)
          ? table[(row + 1) * columns + column + 1]! + 1
          : Math.max(table[(row + 1) * columns + column]!, table[here + 1]!);
    }
  }

  return table;
}

/**
 * The longest common subsequence of two word lists, as the moves that turn one
 * into the other.
 */
function commonSubsequence(before: string[], after: string[]): DiffSpan[] {
  const columns = after.length + 1;
  const table = lcsTable(before, after);

  const spans: DiffSpan[] = [];
  let row = 0;
  let column = 0;

  while (row < before.length && column < after.length) {
    if (key(before[row]!) === key(after[column]!)) {
      // The word survived. The page's own spelling of it is the one drawn, so a
      // rewrite that only changed the punctuation shows as unchanged prose.
      push(spans, "same", before[row]!);
      row += 1;
      column += 1;
    } else if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
      push(spans, "removed", before[row]!);
      row += 1;
    } else {
      push(spans, "added", after[column]!);
      column += 1;
    }
  }

  for (; row < before.length; row += 1) push(spans, "removed", before[row]!);
  for (; column < after.length; column += 1) push(spans, "added", after[column]!);

  return spans;
}

/** Consecutive words of the same kind are one span, so a run is counted once. */
function push(spans: DiffSpan[], kind: DiffKind, text: string): void {
  const last = spans[spans.length - 1];
  if (last?.kind === kind) last.text += text;
  else spans.push({ kind, text });
}

/**
 * The proposed copy as spans of its own text, each saying whether the page
 * already had those words.
 *
 * The difference from {@link diffWords} is which side survives. A diff draws
 * both texts, so a removed run is in it and a surviving word is drawn in the
 * page's own spelling. This draws only the copy that is going on the page:
 * joining every span back together returns `after` exactly, character for
 * character, which is what lets the highlight be built out of these.
 */
export function afterSpans(before: string, after: string): DiffSpan[] {
  const from = words(before);
  const to = words(after);

  if (to.length === 0) return [];
  if (from.length === 0 || from.length > MAX_WORDS || to.length > MAX_WORDS) {
    return [{ kind: "added", text: after }];
  }

  const table = lcsTable(from, to);
  const columns = to.length + 1;
  const spans: DiffSpan[] = [];
  let row = 0;
  let column = 0;

  while (row < from.length && column < to.length) {
    if (key(from[row]!) === key(to[column]!)) {
      // The word survived, drawn as the copy writes it rather than as the page
      // does: this is the text that is going in.
      push(spans, "same", to[column]!);
      row += 1;
      column += 1;
    } else if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
      // A word the page loses leaves nothing behind in the copy, so consecutive
      // surviving runs on either side of it read as one.
      row += 1;
    } else {
      push(spans, "added", to[column]!);
      column += 1;
    }
  }

  for (; column < to.length; column += 1) push(spans, "added", to[column]!);

  return spans;
}

/** The two texts as one list of spans, in reading order. */
export function diffWords(before: string, after: string): DiffSpan[] {
  const from = words(before);
  const to = words(after);

  if (from.length === 0 && to.length === 0) return [];
  if (from.length === 0) return [{ kind: "added", text: after }];
  if (to.length === 0) return [{ kind: "removed", text: before }];

  // Too long to diff word by word, so it is said the honest way instead: this
  // block goes, that block arrives.
  if (from.length > MAX_WORDS || to.length > MAX_WORDS) {
    return [
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ];
  }

  return commonSubsequence(from, to);
}

/** How long a text runs, in the words an edit's size is counted in. */
export function wordCount(text: string): number {
  return words(text).filter(counts).length;
}

/**
 * How many words one edit puts on the page and takes off it. The size the
 * caption quotes, and the size the proportion check in
 * `src/analysis/proportion.ts` judges an edit by, so both read the same number.
 */
export function changedWords(spans: DiffSpan[]): { added: number; removed: number } {
  const counted = (kind: DiffKind): number =>
    spans.filter((span) => span.kind === kind).reduce((total, span) => total + wordCount(span.text), 0);

  return { added: counted("added"), removed: counted("removed") };
}

/**
 * What changed, in words, for the line under the image and for anything that
 * cannot show a picture at all. Counted in words rather than characters,
 * because "18 words added" is a size somebody can picture.
 */
export function diffSummary(spans: DiffSpan[]): string {
  const { added, removed } = changedWords(spans);
  const parts = [
    added > 0 ? `${added} ${added === 1 ? "word" : "words"} added` : null,
    removed > 0 ? `${removed} ${removed === 1 ? "word" : "words"} removed` : null,
  ].filter((part): part is string => part !== null);

  // Everything folded away to the same words, which means the edit is a
  // punctuation or casing change. Rare, and worth saying rather than showing a
  // picture of two identical paragraphs with no explanation.
  if (parts.length === 0) return "no words changed, only punctuation or casing";
  return parts.join(", ");
}
