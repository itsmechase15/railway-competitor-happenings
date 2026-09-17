import { PAGE_REWRITE_RULES, STYLE_RULES } from "../analysis/prompt.js";
import {
  MIN_ADDED_WORDS,
  renderProportion,
  type EditProportion,
} from "../analysis/proportion.js";
import { COMPETITORS } from "../config.js";
import { MAX_ACTION_CHARS } from "../discord/embed.js";
import { actionLabel } from "../labels.js";
import { isMarketingTarget } from "../railway/pages.js";
import { EVIDENCE_LABEL, TOC_FILENAME, type DocsWorkspace } from "../railway/workspace.js";
import type { AnalyzedItem, Impact, RailwayDoc, RailwayRef, RecommendedAction } from "../types.js";
import { EN_DASH, truncate } from "../util/text.js";
import type { ReviewDecision } from "./schema.js";

/**
 * The two prompts of the review pass.
 *
 * This is not the guess-then-fix pass the analyst deliberately does not have.
 * That pass shows one model its own claim and asks it to check itself, which
 * gets a better-argued guess rather than a checked one. This is a different
 * model, reading the same corpus, told what the first one claimed and asked
 * whether the docs bear it out – and whatever it decides, the rewrite goes back
 * through the same evidence checks in code before anyone sees it.
 */

const MAX_EXCERPT_CHARS = 900;
const MAX_DETAIL_CHARS = 1_200;

/**
 * How long each page an action would edit runs, and how much of the copy
 * proposed for it is new, by page URL.
 *
 * Measured against the stored page by `src/analysis/proportion.ts`, the same
 * way the gate measures it. It is in the prompt because proportion is the half
 * of a page edit neither model can judge from an excerpt: a reviewer counting
 * words by eye gets it wrong, and a writer asked for something shorter has to
 * be told how much shorter. Empty when nothing measured it, which reads as no
 * line at all rather than as a page with no size.
 */
export type EditProportions = Map<string, EditProportion>;

export interface ReviewInput {
  /** The alert the action came out of, with the docs it was checked against. */
  alert: AnalyzedItem;
  action: RecommendedAction;
  /** The corpus on disk, which the reviewer searches read-only. Null runs it on the prompt alone. */
  workspace: DocsWorkspace | null;
  /** Corpus excerpts already ranked for this signal, as a starting point. */
  docs: RailwayDoc[];
  proportions?: EditProportions;
}

export interface RewriteInput {
  alert: AnalyzedItem;
  action: RecommendedAction;
  /** What the reviewer decided and what it asked for. */
  review: ReviewDecision;
  proportions?: EditProportions;
  /**
   * Every page the rewrite may quote: the excerpts the analysis was checked
   * against, plus the pages the reviewer opened. A quote from anywhere else
   * fails the evidence check and throws the rewrite away.
   */
  docs: RailwayDoc[];
}

/** A page action's rewrite is copy for a Railway page; a product action's is a claim about the product. */
function isPageAction(action: RecommendedAction): boolean {
  return action.type === "update_pages";
}

function renderDocs(docs: RailwayDoc[]): string {
  if (docs.length === 0) {
    return "(nothing was pre-loaded, so search the workspace yourself)";
  }
  return docs
    .map((doc, index) => {
      const kind = doc.kind && doc.kind !== "docs" ? ` [${EVIDENCE_LABEL[doc.kind]}]` : "";
      return `${index + 1}. ${doc.title}${kind}\n   ${doc.url}\n   "${truncate(doc.excerpt, MAX_EXCERPT_CHARS)}"`;
    })
    .join("\n");
}

/**
 * The page edits this action carries: what the page says now, the copy proposed
 * for it, and the one-line reason. These are the only strings a rewrite may
 * replace, and for an `update_pages` action the proposed copy is the substance
 * of the recommendation, so it is shown in full rather than summarized.
 */
function renderEdits(
  refs: RailwayRef[],
  action: RecommendedAction,
  proportions: EditProportions,
): string {
  // For a page action, every page it could edit is listed whether or not copy
  // came back for it, because a page action with no copy is itself the finding.
  const edits = isPageAction(action)
    ? refs.filter((ref) => isMarketingTarget(ref.url))
    : refs.filter((ref) => ref.suggestedEdit ?? ref.proposedText);
  if (edits.length === 0) return "(none)";
  return edits
    .map((ref) => {
      const lines = [`- ${ref.url}`, `  on the page today: "${ref.claim}"`];
      lines.push(
        ref.proposedText
          ? `  copy proposed for it: "${ref.proposedText}"`
          : "  copy proposed for it: (none, which is a revise on its own for update_pages)",
      );
      if (ref.editKind) lines.push(`  what the copy does: ${ref.editKind}s the line above`);
      if (ref.suggestedEdit) lines.push(`  why: "${ref.suggestedEdit}"`);
      const proportion = proportions.get(ref.url);
      if (proportion) lines.push(`  how much it adds: ${renderProportion(ref.url, proportion)}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** One action exactly as it was filed, so both models judge the same thing. */
export function renderFiledAction(
  alert: AnalyzedItem,
  action: RecommendedAction,
  proportions: EditProportions = new Map(),
): string {
  const competitor = COMPETITORS[alert.item.competitor].label;
  return [
    `Competitor: ${competitor}`,
    `Signal: ${alert.item.title}`,
    `Signal URL: ${alert.item.url}`,
    `Alert summary: ${alert.analysis.summary}`,
    `Alert impact: ${alert.analysis.impact}`,
    "",
    `Action title: ${actionLabel(action)}`,
    `Action type: ${action.type}`,
    `Railway surface named: ${action.feature ?? "(none)"}`,
    `Detail: ${truncate(action.detail, MAX_DETAIL_CHARS)}`,
    `Gap claimed: ${action.gap ?? "(none)"}`,
    `Evidence page: ${action.evidenceUrl ?? "(none)"}`,
    `Evidence quote: ${action.evidenceQuote ? `"${action.evidenceQuote}"` : "(none)"}`,
    `Pages it asks someone to edit:\n${renderEdits(alert.analysis.railwayRefs, action, proportions)}`,
  ].join("\n");
}

function renderWorkspaceRules(workspace: DocsWorkspace | null): string {
  if (!workspace) {
    return `## The Railway docs
You have no searchable copy of Railway's docs this run, only the excerpts below. That limits what you may conclude: without a page in front of you saying Railway does this, you cannot drop the action, and "agree" on excerpts alone is the honest answer when nothing here contradicts it.`;
  }

  return `## The Railway docs, as files you can search
Your working directory holds Railway's whole product docs corpus as markdown, one file per page, plus \`${TOC_FILENAME}\` listing every page in it. You have read-only tools: read a file, grep the text, glob for paths, list a directory. Use them. Reading the docs is the whole job here – the analyst had the same corpus and you are checking what it did with it.

How to work:
1. Grep \`${TOC_FILENAME}\` for the part of the docs this action is about, and for what Railway would call the capability rather than what the competitor calls it. Render's "web service" is Railway's "service", Vercel's "edge functions" land in Railway's networking and runtime docs.
2. Open the cited evidence page and read it. Then open the pages the analyst did not, especially the ones the gap's own words lead to.
3. Only then decide.

Each file opens with a header saying what it is evidence of:
${Object.entries(EVIDENCE_LABEL)
  .map(([kind, label]) => `  - kind: ${kind} ${EN_DASH} ${label}`)
  .join("\n")}

A changelog entry proves Railway shipped something and proves nothing about whether the docs mention it. Railway ships often and the docs lag, so a changelog entry saying Railway does this is enough to drop the action.

Cite the \`url\` from a file's header, never the file path.`;
}

const VERDICT_RULES = `## Your verdict
One of three, and the middle one is the interesting one.

- "agree": it stands. The gap is real, the page it cites says what it is quoted as saying, the type and the named surface are right, and the impact matches what the post shipped.
- "revise": there is real work to file here and part of what was written is wrong in a way somebody can fix. Put each fix in "changes", one line each, specific enough to act on. The ones that come up:
  - The gap claims more than the evidence supports. "Railway sleeps an idle container" is on the page; "Railway has no per-request billing for a sleeping service" is a different and larger claim.
  - The evidence page is real but is not the page this is about, and a better page exists. Name it.
  - The quote is not on the page as stored, or was tidied on the way in.
  - The surface named is the wrong Railway product for the gap.
  - It says consider_building where Railway has an adjacent product to enhance, or consider_enhancing where Railway has nothing in the area at all.
  - The impact label does not match what the post shipped.
  - For an update_pages action: the copy proposed for the page is wrong about what Railway does, or is a note about the edit rather than the words to put on the page, or restates what the page already says, or does not read as if it came off that page. An update_pages action with no proposed copy at all is a revise, not a drop: the recommendation may be right and the writing is missing.
  - For an update_pages action: the copy is out of proportion to the page. Open the page and read it. A paragraph of the competitor's pricing mechanics on a page whose own paragraphs run to two sentences is a revise even when every word of it is true, and so is any detail the page would still be correct without. Ask for the shorter version and say which sentences of it earn their place. The sizes are measured for you under each page below; the rule is that the copy adds at most as many words as the passage it lands in, never more than a fifth of the page, and ${MIN_ADDED_WORDS} words always fit.
- "drop": there is nothing to file. Railway already does this and you can name the pages that show it, or the gap is about what a competitor charges rather than what the product does, or the action asks for documentation to be written.

The bar, which matters more than the list:
- Do not revise for style, for tone, or because you would have written it differently. Revise for something that is wrong.
- Do not drop because you could not confirm the gap. Confirming it is not your job. The analyst read the same corpus, and "I did not find it" is not "Railway ships it". Drop only when you can point at pages that show Railway does this.
- Impact is what the competitor shipped, and nothing else: a brand-new feature is major, a new control on an existing one is notable, a post with no feature in it is minor. Whether Railway has a gap never moves it. Only set "impact" when the label is wrong.
- Only set "action_type" for a swap between consider_building and consider_enhancing. There is no path from a product action into update_pages, or the other way: that sends someone to edit a Railway marketing page, and that is a different recommendation, not a corrected one.
- "agree" is a normal answer and often the right one. An analyst that read the docs and wrote a checked claim usually got it right, and a review that revises everything it touches is a review nobody trusts.`;

const CALIBRATION = `## What a revise looks like
The alert: Render added per-request billing to its web services, so a service that goes idle costs nothing until the next request arrives.

The action filed: consider_enhancing Serverless. "Add per-request billing to Railway's serverless so an idle service costs nothing." Gap: "No per-request billing: Railway bills a sleeping service by the minute and has no request-based meter." Evidence: https://docs.railway.com/reference/pricing/plans quoting "Usage is billed per minute."

Why that is a revise and not an agree or a drop. There is real work here: Render now meters requests and Railway meters time. But the gap sentence is two claims welded together, and the quote only carries one of them. A plans page is pricing copy rather than the page that owns how a service sleeps and wakes, and the claim about a sleeping service being billed is the part that needs the serverless docs behind it. So: keep the type, keep Serverless, narrow the gap to the part the evidence carries, and cite the page that owns it.

The changes that go with it, as they would be written:
- Narrow the gap to what a product docs page supports: Railway meters compute by the minute while a service is awake.
- Move the evidence to the serverless docs, which own how a service sleeps and wakes, and quote the line about what happens while it is asleep.
- Keep the detail's second half, which names Railway's app sleeping. That part is right, and it is what makes this an enhancement rather than something to build.

What the same reply must not do: drop the action because the docs are quiet about request metering, or widen it into "Railway has no serverless" because one page did not answer the question.`;

export const REVIEW_RESPONSE_SHAPE = `{
  "verdict": "agree" | "revise" | "drop",
  "reason": "string (one or two sentences; it is posted as a comment on the issue, so write it for whoever opens it)",
  "pages_checked": ["string (the Railway URLs you opened and read, from the file headers)"],
  "changes": ["string (required for revise: one specific change each, and nothing about style)"],
  "impact": "minor | notable | major (only when the alert's label is wrong)",
  "action_type": "consider_building | consider_enhancing (only when the type is wrong)"
}`;

export function buildReviewPrompt(input: ReviewInput): string {
  return `You are reviewing one recommended action that a Railway competitive-intelligence analyst has already filed as a GitHub issue. A different model wrote it, with the same Railway docs corpus you have.

Your job is to decide whether it is true, not to write a better version of it.

The mistake this review exists to catch is an issue telling Railway to build or improve something Railway already ships. That issue is worse than no alert: it costs a reader's trust in every alert after it, and it is the easy mistake to make, because a competitor's launch is written to sound like a gap and the Railway page that answers it is one of several hundred.

Reply with a single JSON object and nothing else. No prose, no code fences.

${VERDICT_RULES}

${CALIBRATION}

${renderWorkspaceRules(input.workspace)}

## The action as filed
${renderFiledAction(input.alert, input.action, input.proportions ?? new Map())}

## Pre-loaded excerpts the analyst was shown
The pages the analysis was checked against. A starting point, not the answer.
${renderDocs(input.docs)}

${STYLE_RULES}

## Response
Reply with exactly this JSON shape:
${REVIEW_RESPONSE_SHAPE}`;
}

export const REWRITE_RESPONSE_SHAPE = `{
  "type": "consider_building" | "consider_enhancing" (only when the reviewer asked for the type to change),
  "detail": "string (the whole detail, rewritten; omit to keep what was filed)",
  "gap": "string (one line: what Railway does not do today)",
  "feature": "string (the Railway surface name, exactly as Railway writes it)",
  "evidence_url": "string (a Railway docs URL from the excerpts below)",
  "evidence_quote": "string (words copied from that page, verbatim, punctuation untouched)",
  "impact": "minor | notable | major (only when the reviewer said the label is wrong)",
  "page_edits": [
    {
      "url": "string (a page already cited above, and one marketing writes)",
      "proposed_text": "string (the exact copy to put on the page, in the page's own voice)",
      "suggested_edit": "string (one line: what is wrong and what you are changing)",
      "edit_kind": "replace" | "insert"
    }
  ]
}`;

function renderReviewerAsk(review: ReviewDecision, impact: Impact): string {
  const lines = [`Verdict: revise`, `Reason: ${review.reason}`];
  if (review.actionType) lines.push(`The type should be: ${review.actionType}`);
  if (review.impact && review.impact !== impact) {
    lines.push(`The impact should be: ${review.impact}`);
  }
  if (review.pagesChecked.length > 0) {
    lines.push(`Pages it read:\n${review.pagesChecked.map((url) => `- ${url}`).join("\n")}`);
  }
  lines.push(
    review.changes.length > 0
      ? `Changes it asked for:\n${review.changes.map((change) => `- ${change}`).join("\n")}`
      : "Changes it asked for: none listed, so act on the reason above and change nothing else.",
  );
  return lines.join("\n");
}

const PRODUCT_CHECKS = `- "evidence_url" has to be a Railway docs page, and it has to be one of the pages listed below.
- "evidence_quote" has to appear on that page exactly as it is written there. Copy it. Do not paraphrase it, do not tidy its punctuation, do not join two sentences into one.
- "gap" has to be the thing the cited page is actually about. If the gap's own words lead somewhere else in the docs, the cited page is the wrong one.
- "feature" has to be Railway's own name for the surface, e.g. "Serverless", "Databases", "Networking". A name Railway does not use is dropped and the old one kept.
- Never change the type into update_pages, and never out of it. That asks marketing to edit a Railway page, which is a different recommendation.`;

const PAGE_CHECKS = `- "proposed_text" is the words that go on the page, and the check on it is mechanical: copy that opens with say, mention, note that, clarify, call out, reword, or an "add a line about" instruction is thrown out, and so is copy shorter than a sentence or two and copy leaving a placeholder in square brackets or a TODO for somebody else to resolve.
- The length is mechanical too. The copy may add at most as many words as the passage it lands in already runs to, never more than a fifth of the whole page, and ${MIN_ADDED_WORDS} words of new copy always fit. The sizes for this page are under "Pages it asks someone to edit" above, so write to that number: copy over it is thrown away and the issue keeps the version you were asked to shorten.
- Only a page this action already cites, and only one marketing writes: a compare page, a migrate page, pricing, or a features page. A product docs URL is always the wrong answer: the docs are the evidence, never the target.
- "suggested_edit" is the one line saying what is wrong and what you are changing. It never stands in for "proposed_text".
- "edit_kind" is "replace" when your copy takes the place of the line quoted above, or "insert" when it goes in beside it.`;

export function buildRewritePrompt(input: RewriteInput): string {
  const { alert, action, review } = input;
  const pageWork = isPageAction(action);

  return `You are rewriting one recommended action for Railway, after a second model read Railway's own docs and said what is wrong with it.

You are not deciding whether to file it. That is settled: it is being filed, in a corrected form. Apply the changes the reviewer asked for and change nothing else.

Reply with a single JSON object and nothing else. No prose, no code fences. Leave out every field you are not changing.

## What is checked after you write it
Code re-runs the whole evidence gate on your answer before it reaches the issue, and a rewrite that fails it is thrown away with the original left standing. So:
${pageWork ? PAGE_CHECKS : PRODUCT_CHECKS}
- "detail" opens with one sentence under ${MAX_ACTION_CHARS} characters that leads with the work to do, not with what Railway lacks. That sentence is all the Discord embed shows. Good: "Add per-request billing to Serverless so an idle service costs nothing ${EN_DASH} Railway sleeps idle containers, it still bills the minute they wake." Bad: "Railway sleeps idle services but bills them per minute when awake."${
    pageWork
      ? ` For a page action it names the page and what it should say: "On the compare to render page, say Render bills a web service per request once it goes idle."`
      : ""
  }
${pageWork ? `\n${PAGE_REWRITE_RULES}\n` : ""}
## The action as filed
${renderFiledAction(alert, action, input.proportions ?? new Map())}

## What the reviewer said
${renderReviewerAsk(review, alert.analysis.impact)}

## The pages you may quote
Every page here is in Railway's corpus, so a verbatim quote from one of these excerpts passes the check. A quote from anywhere else does not.${
    pageWork
      ? " For the page you are rewriting, this is also where its voice comes from: read the excerpt and write in it."
      : ""
  }
${renderDocs(input.docs)}

${STYLE_RULES}

## Response
Reply with exactly this JSON shape, carrying only the fields you are changing:
${REWRITE_RESPONSE_SHAPE}`;
}
