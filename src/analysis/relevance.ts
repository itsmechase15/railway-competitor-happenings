import { COMPETITORS } from "../config.js";
import { isMarketingTarget } from "../railway/pages.js";
import { matchCapabilities, matchProducts } from "../railway/products.js";
import type { Analysis, RecommendedAction, StoredItem } from "../types.js";
import { firstSentence, stem, WORD_PATTERN } from "../util/text.js";
import { withNoAction } from "./noAction.js";

/**
 * Is a page edit about the thing that shipped?
 *
 * `update_pages` is the action that sends someone to edit a compare page, and
 * the way it goes wrong is not a page that is fine: it is a page edit about
 * something else. A signal about a new compute plan turns into "and while you
 * are on the compare to render page, answer their claim about HIPAA". Both
 * sentences are about the same page, and only one is about this launch, so
 * matching on the page cannot tell them apart.
 *
 * What tells them apart is the vocabulary of the launch itself: what changed,
 * with the surface it changed in taken out.
 */

const WORD = WORD_PATTERN;

/**
 * Words that appear in every competitor alert, so they discriminate nothing.
 * Stemmed at load, because the text they are compared against is.
 */
const GENERIC_WORDS = [
  "the", "and", "for", "but", "with", "from", "into", "this", "that", "these", "those",
  "when", "what", "which", "than", "then", "there", "here", "where", "while", "who",
  "you", "your", "they", "their", "them", "its", "it", "our", "we", "us",
  "are", "was", "were", "been", "being", "has", "have", "had", "does", "did",
  "can", "cannot", "could", "will", "would", "should", "must", "may", "might",
  "now", "new", "also", "just", "only", "still", "already", "yet", "not", "no",
  "all", "any", "one", "two", "more", "most", "some", "each", "every", "both",
  "let", "get", "got", "make", "made", "add", "use", "used", "say", "see", "need",
  "want", "give", "take", "put", "pick", "user", "team", "customer", "people",
  "someone", "product", "feature", "capability", "page", "section", "line", "copy",
  "claim", "launch", "ship", "release", "announce", "available", "availability",
  "general", "support", "way", "thing", "work", "today", "instead", "without",
  "about", "because", "so", "why", "how", "same", "own", "out", "off", "over",
  "under", "before", "after", "again", "very", "much", "competitor", "railway",
  "compare", "comparison", "migrate", "matrix", "row", "update", "edit", "fix",
];

const STOPWORDS = new Set(
  [...GENERIC_WORDS, ...Object.values(COMPETITORS).map((competitor) => competitor.label)].map(
    (word) => stem(word.toLowerCase()),
  ),
);

/** Text as a space-padded run of stems, so a term can be matched whole. */
function stemmed(text: string): string {
  return ` ${(text.toLowerCase().match(WORD) ?? []).map(stem).join(" ")} `;
}

function isDiscriminating(token: string): boolean {
  return token.length >= 3 && !/^\d+$/.test(token) && !STOPWORDS.has(token);
}

/**
 * What one signal is about, in three tiers, sharpest first.
 *
 * `terms` and `phrases` are the launch. `productPhrases` is only the surface
 * it happened in, which is too broad to judge a page edit by and is used only
 * when the launch left nothing sharper behind.
 */
export interface SignalTopic {
  /** Stems from the title and summary, minus the surface's own vocabulary. */
  terms: string[];
  /** Stemmed keywords of the cross-surface capabilities the signal touches. */
  phrases: string[];
  /** The Railway surfaces the signal is about, for the log line. */
  products: string[];
  /** Stemmed surface vocabulary, the last resort. */
  productPhrases: string[];
}

/**
 * The topic of a signal, read from the title and the one-sentence summary.
 * Those two are the launch; key points and action details are commentary on
 * it, and letting them in would let a tangent widen the topic to cover itself.
 */
export function signalTopic(title: string, summary: string): SignalTopic {
  const text = `${title}. ${summary}`;
  const products = matchProducts(text, 3);
  const capabilities = matchCapabilities(text);

  const productVocabulary = products.flatMap((product) => [
    product.label,
    ...(product.aliases ?? []),
    ...product.keywords,
  ]);
  const productStems = new Set(
    productVocabulary.flatMap((entry) => (entry.toLowerCase().match(WORD) ?? []).map(stem)),
  );

  const terms = [
    ...new Set(
      (text.toLowerCase().match(WORD) ?? [])
        .map(stem)
        .filter((token) => isDiscriminating(token) && !productStems.has(token)),
    ),
  ];

  return {
    terms,
    phrases: [
      ...new Set(capabilities.flatMap((capability) => capability.keywords).map(stemPhrase)),
    ],
    products: products.map((product) => product.label),
    productPhrases: [...new Set(productVocabulary.map(stemPhrase))].filter(Boolean),
  };
}

function stemPhrase(phrase: string): string {
  return stemmed(phrase).trim();
}

/**
 * Does this text speak to the launch? A capability the signal is about counts,
 * and so does any word the launch used that the surface did not. When the
 * launch is the surface itself, the surface is all there is to match on, so it
 * is what gets matched.
 */
export function tiesToTopic(text: string, topic: SignalTopic): boolean {
  const haystack = stemmed(text);
  const hits = (needles: string[]): boolean =>
    needles.some((needle) => needle.length > 0 && haystack.includes(` ${needle} `));

  if (hits(topic.phrases) || hits(topic.terms)) return true;
  if (topic.phrases.length > 0 || topic.terms.length > 0) return false;
  // Nothing sharper exists, so an unjudgeable topic keeps the action rather
  // than dropping every page edit a signal like this could ever ask for.
  return topic.productPhrases.length === 0 || hits(topic.productPhrases);
}

/** How the log line names the topic an action missed. */
export function describeTopic(topic: SignalTopic): string {
  const named = topic.terms.slice(0, 4);
  if (named.length > 0) return named.join(", ");
  return topic.products.join(", ") || "this launch";
}

export interface TopicGuard {
  analysis: Analysis;
  /** What was dropped and why, for the run log. Empty when the model stayed on topic. */
  notes: string[];
}

function isPageAction(action: RecommendedAction): boolean {
  return action.type === "update_pages";
}

/**
 * Drop `update_pages` actions that are not about this launch.
 *
 * Dropping beats rewriting. There is no way to rewrite "answer their HIPAA
 * claim" into a page edit about compute plans without inventing the edit, and
 * an alert with one honest action reads better than one with two where the
 * reader has to work out which to trust. An alert can end up with no action at
 * all, which is the right answer for a small change no Railway page speaks to.
 */
export function enforceUpdatePagesTopic(analysis: Analysis, item: StoredItem): TopicGuard {
  const pageActions = analysis.actions.filter(isPageAction);
  if (pageActions.length === 0) return { analysis, notes: [] };

  const topic = signalTopic(item.title, analysis.summary);
  const notes: string[] = [];
  const actions = analysis.actions.filter((action) => {
    if (!isPageAction(action)) return true;
    if (tiesToTopic(actionText(analysis, action, pageActions.length), topic)) return true;
    notes.push(
      `dropped an update_pages action that is not about ${describeTopic(topic)}: "${firstSentence(action.detail, 120)}"`,
    );
    return false;
  });

  if (actions.length === analysis.actions.length) return { analysis, notes: [] };

  if (actions.length > 0) return { analysis: { ...analysis, actions }, notes };

  return {
    analysis: withNoAction(
      { ...analysis, actions },
      {
        kind: "not_a_gap",
        reason: `No Railway page in context is wrong or understated because of this, and the only edit the analysis asked for is about something other than ${describeTopic(topic)}, so there is no page to fix here.`,
        evidence: [],
      },
    ),
    notes,
  };
}

/**
 * Drop page actions whose only suggested edits are product docs pages.
 *
 * The docs are what an action gets checked against, so a model that reads them
 * and then asks for one to be edited has turned its evidence into the job.
 * There is nothing to salvage: the page it wanted changed is not one marketing
 * owns, and picking a different page for it would be inventing the edit.
 */
export function enforcePageTargets(analysis: Analysis): TopicGuard {
  if (!analysis.actions.some(isPageAction)) return { analysis, notes: [] };

  const edits = analysis.railwayRefs.filter((ref) => ref.suggestedEdit);
  if (edits.length === 0 || edits.some((ref) => isMarketingTarget(ref.url))) {
    return { analysis, notes: [] };
  }

  const notes = analysis.actions
    .filter(isPageAction)
    .map(
      (action) =>
        `dropped an update_pages action whose only suggested edits were product docs pages (${edits
          .map((ref) => ref.url)
          .join(", ")}): "${firstSentence(action.detail, 120)}"`,
    );

  const actions = analysis.actions.filter((action) => !isPageAction(action));
  if (actions.length > 0) return { analysis: { ...analysis, actions }, notes };

  return {
    analysis: withNoAction(
      { ...analysis, actions },
      {
        kind: "not_a_gap",
        reason: `The only page edit the analysis asked for lands on ${edits.map((ref) => ref.url).join(" and ")}, which are product docs pages: the docs are evidence of what Railway ships, not copy anyone is asked to change, so there is no page edit here.`,
        evidence: [],
      },
    ),
    notes,
  };
}

/**
 * The words one page action is judged on: its own detail, plus the edits when
 * it is the only page action in the analysis. The edits live on
 * `railway_refs`, not on the action, so with two page actions there is no
 * telling which edit belongs to which, and only the detail is safe to read.
 *
 * The proposed copy counts as much as the instruction above it. It is the edit
 * itself, written in the page's words rather than in the launch's, so it is
 * often where the topic is plainest.
 */
function actionText(analysis: Analysis, action: RecommendedAction, pageActions: number): string {
  if (pageActions > 1) return action.detail;
  const edits = analysis.railwayRefs
    .flatMap((ref) => [ref.suggestedEdit, ref.proposedText])
    .filter((edit): edit is string => Boolean(edit));
  return [action.detail, ...edits].join(" ");
}
