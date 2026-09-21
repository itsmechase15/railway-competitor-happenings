import { collapseWhitespace, sentences } from "../util/text.js";

/**
 * An open question is a question.
 *
 * The heading says "Open questions" and what used to land under it read
 * "Whether Headless is generally available and on every plan" – an embedded
 * question with the question taken out of it, which reads as a note to
 * nobody. A reader scanning the section has to be able to see what is being
 * asked, so every line ends in a question mark and opens the way a question
 * opens.
 *
 * Code enforces the shape and never the substance. The forms below are
 * repaired because the repair is mechanical and keeps every word the model
 * wrote: a "whether" clause is already a question with a stem missing, and a
 * line that opens "Does Railway…" and forgets its punctuation is a question
 * with a character missing. Anything else is dropped, because turning a
 * statement into a question means deciding what is being asked, and a question
 * this invented would be one nobody wrote.
 */

/** How an English question opens: an interrogative, an auxiliary, or a modal. */
const QUESTION_OPENERS = new Set([
  "am",
  "are",
  "is",
  "was",
  "were",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "may",
  "might",
  "must",
  "shall",
  "should",
  "will",
  "would",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
]);

/** A question with its stem missing: "whether X" is "do we know whether X". */
const CLAUSE_OPENERS = new Set(["whether", "if"]);

/**
 * The hedges a model puts in front of an embedded question. Stripping one
 * leaves the clause it introduced, which is the question itself.
 */
const HEDGE_LEAD =
  /^(?:it (?:is|'s) )?(?:unclear|unknown|uncertain|not clear|no word|nothing said|open question|tbd)\b[\s:,\u2013-]*(?:on|about)?\s*/i;

function firstWord(text: string): string {
  return text.toLowerCase().match(/^[a-z']+/)?.[0] ?? "";
}

/**
 * The part of a line that has to read as a question: the last sentence, and
 * within it whatever follows the last colon, semicolon, or dash. A line often
 * sets a fact down before it asks – "Nobody has read this page against the
 * launch: what does it say?" – and the asking is the half after the colon.
 */
function finalClause(text: string): string {
  const last = sentences(text).at(-1) ?? text;
  return last.split(/(?:[:;]|\s\u2013)\s+/).at(-1) ?? last;
}

/** Whether a line already asks something. */
export function isQuestion(line: string): boolean {
  const text = collapseWhitespace(line);
  if (!text.endsWith("?")) return false;
  return QUESTION_OPENERS.has(firstWord(finalClause(text)));
}

/** Where the asking starts, so a repair leaves the context in front of it alone. */
function splitLead(text: string): { lead: string; clause: string } {
  const separator = [...text.matchAll(/(?:[:;]|\s\u2013)\s+/g)].at(-1);
  if (separator?.index === undefined) return { lead: "", clause: text };
  const start = separator.index + separator[0].length;
  return { lead: text.slice(0, start), clause: text.slice(start) };
}

function upperFirst(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** One clause as the question it was already most of the way to being. */
function askedForm(clause: string, opensTheLine: boolean): string | null {
  const body = clause.replace(HEDGE_LEAD, "").trim();
  if (!body) return null;

  const opener = firstWord(body);
  if (CLAUSE_OPENERS.has(opener)) {
    const stem = opensTheLine ? "Do we know" : "do we know";
    return `${stem} ${lowerFirst(body)}?`;
  }
  if (QUESTION_OPENERS.has(opener)) {
    return `${opensTheLine ? upperFirst(body) : lowerFirst(body)}?`;
  }
  return null;
}

/** The same line as a question, or null when it cannot be one without being written. */
export function asQuestion(line: string): string | null {
  const text = collapseWhitespace(line);
  if (!text) return null;
  if (isQuestion(text)) return text;

  // Only the asking end of the line is rewritten. Whatever a model put in
  // front of it is context it went and found, and dropping that to make room
  // for a question stem would lose the half of the line worth reading.
  const said = sentences(text.replace(/[\s.?!]+$/, ""));
  const last = said.pop();
  if (!last) return null;

  const { lead, clause } = splitLead(last);
  const asked = askedForm(clause, lead.length === 0);
  if (!asked) return null;

  return [...said, `${lead}${asked}`].join(" ");
}

/**
 * Every line that reaches the "Open questions" heading, as questions. The one
 * place this runs for model output is the schema, so a stored analysis written
 * before the rule is repaired on its way back out too.
 */
export function toOpenQuestions(lines: string[]): string[] {
  const questions: string[] = [];
  for (const line of lines) {
    const question = asQuestion(line);
    if (question && !questions.includes(question)) questions.push(question);
  }
  return questions;
}
