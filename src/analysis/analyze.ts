import { createCompareIndex, type CompareIndex } from "../competitor/compare.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { createLogger } from "../log.js";
import { contextForSignal, topUpDocsForActions } from "../railway/docs.js";
import type { CorpusIndex } from "../railway/retrieval.js";
import type { DocsWorkspace } from "../railway/workspace.js";
import type { Analysis, AnalyzedItem, RailwayClaim, RailwayDoc, StoredItem } from "../types.js";
import { createAnalystRunner, type AnalystRunner } from "./analyst.js";
import type { Analyzer, AnalyzerInput, AnalyzerOutput } from "./analyzer.js";
import { gateActions, type CoverageContext } from "./evidence.js";
import { FALLBACK_MODEL, heuristicAnalysis } from "./fallback.js";
import { enforceActionLead } from "./lead.js";
import { buildAnalysisPrompt } from "./prompt.js";
import { enforcePageTargets, enforceUpdatePagesTopic } from "./relevance.js";
import { parseAnalysis } from "./schema.js";
import { verifyAgainstDocs } from "./verify.js";

const log = createLogger("analysis");

/** How many indexed claims to put in front of the analyst per competitor. */
const CLAIMS_PER_PROMPT = 8;
/** Claims from any single page, so one long compare page cannot crowd out the rest. */
const CLAIMS_PER_PAGE = 2;

/**
 * Spread the claim budget across pages. `getClaims` ranks by page importance
 * then paragraph length, which otherwise returns the same page eight times.
 */
export function diversifyClaims(claims: RailwayClaim[], limit: number): RailwayClaim[] {
  const perUrl = new Map<string, number>();
  const picked: RailwayClaim[] = [];

  for (const claim of claims) {
    const used = perUrl.get(claim.url) ?? 0;
    if (used >= CLAIMS_PER_PAGE) continue;
    perUrl.set(claim.url, used + 1);
    picked.push(claim);
    if (picked.length === limit) break;
  }

  return picked;
}

/**
 * The analyst: one run per signal, with the docs corpus under it.
 *
 * One run, not two. There is no second pass that reads the first reply and
 * corrects it, because a model shown its own unsupported claim will argue for
 * it better rather than go and check. What replaces that pass is this run
 * having the corpus in front of it and every claim it makes being checked
 * against the same corpus afterwards, by code.
 */
class AnalystAnalyzer implements Analyzer {
  constructor(private readonly runner: AnalystRunner) {}

  get model(): string {
    return this.runner.model;
  }

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    const prompt = buildAnalysisPrompt(input.item, {
      claims: input.claims,
      docs: input.docs,
      compareClaims: input.compareClaims,
      toc: input.workspace?.toc,
    });

    const reply = await this.runner.run({
      prompt,
      workspaceDir: input.workspace?.dir ?? null,
    });

    const readUrls = input.workspace
      ? [
          ...new Set(
            reply.readPaths
              .map((path) => input.workspace?.urlForPath(path))
              .filter((url): url is string => Boolean(url)),
          ),
        ]
      : [];

    return { analysis: parseAnalysis(reply.text), readUrls };
  }
}

class HeuristicAnalyzer implements Analyzer {
  readonly model = FALLBACK_MODEL;

  async analyze(input: AnalyzerInput): Promise<AnalyzerOutput> {
    return {
      analysis: heuristicAnalysis(input.item, input.claims, input.docs),
      readUrls: [],
    };
  }
}

/**
 * The analyzer that cannot fail: it restates the source instead of assessing
 * it, recommends nothing, and every alert it produces says so.
 */
export function createFallbackAnalyzer(): Analyzer {
  return new HeuristicAnalyzer();
}

export function createAnalyzer(config: Config): Analyzer {
  const runner = createAnalystRunner(config);
  if (!runner) {
    log.warn(
      "CURSOR_API_KEY is not set – falling back to a labeled restatement that does not assess the change",
    );
    return new HeuristicAnalyzer();
  }
  log.info(`analyst: ${runner.description}`);
  return new AnalystAnalyzer(runner);
}

export type { Analyzer };

/** What every item in a run shares: the corpus, and the copy of it on disk. */
export interface RunContext {
  index: CorpusIndex;
  workspace: DocsWorkspace | null;
}

/**
 * Analyze each new item against the corpus, then check the answer against the
 * same corpus before any of it is allowed to become work.
 *
 * The order is the point:
 *
 * 1. Retrieval ranks the corpus for this signal and pre-loads the top
 *    excerpts, so the analyst starts somewhere sensible.
 * 2. One analyst run, with the whole corpus searchable on disk and a list of
 *    every page in it. What it opens is recorded.
 * 3. The docs pass reconciles what it wrote with the pages it was shown, page
 *    edits aimed at the wrong page or the wrong topic are dropped, and each
 *    surviving action is made to open with the work it asks for.
 * 4. The evidence gate checks every product action's page, quote, and gap
 *    against the stored corpus, and searches the corpus again with the gap's
 *    own words. Anything that fails becomes an open question.
 *
 * What comes out is zero to three actions, each of which somebody can check,
 * and a reason when there are none. A failed analysis drops that item and
 * leaves the rest alone.
 */
export async function analyzeItems(
  items: StoredItem[],
  store: Store,
  analyzer: Analyzer,
  config: Config,
  context: RunContext,
  compare: CompareIndex = createCompareIndex(config),
): Promise<AnalyzedItem[]> {
  const claimsByCompetitor = new Map<string, RailwayClaim[]>();
  const analyzed: AnalyzedItem[] = [];
  const usedUrls = new Set<string>();

  for (const item of items) {
    let claims = claimsByCompetitor.get(item.competitor);
    if (!claims) {
      const ranked = await store.getClaims(item.competitor, CLAIMS_PER_PROMPT * 4);
      claims = diversifyClaims(ranked, CLAIMS_PER_PROMPT);
      claimsByCompetitor.set(item.competitor, claims);
    }

    // Per item, not per competitor: which pages matter depends on what shipped.
    const docs = contextForSignal(context.index, item, {
      limit: config.retrievalTopK,
      perSection: config.retrievalPerSection,
    });

    // Per competitor, and cached: what they claim about Railway is the same
    // whichever of their launches we are reading.
    const compareClaims = await compare.claimsFor(item.competitor).catch((error: unknown) => {
      log.warn(
        `competitor pages failed for ${item.competitor}`,
        error instanceof Error ? error.message : error,
      );
      return [];
    });

    try {
      const reply = await analyzer.analyze({
        item,
        claims,
        docs,
        compareClaims,
        workspace: context.workspace,
      });

      const grounded = topUpDocsForActions(
        context.index,
        item,
        reply.analysis.actions,
        docs,
      );
      const analysis = checkAnalysis(reply, grounded, item, context, (note) =>
        log.warn(`corrected ${item.url}: ${note}`),
      );

      for (const url of [...docs.map((doc) => doc.url), ...reply.readUrls]) usedUrls.add(url);
      analyzed.push({ item, analysis, model: analyzer.model, docs: grounded });

      const actions = analysis.actions.map((action) => action.type).join(", ");
      log.info(
        `analyzed ${item.competitor}/${item.source} "${item.title}" against ${context.index.size} corpus pages, ${reply.readUrls.length} read by the analyst → ${actions || "no action"}`,
      );
    } catch (error) {
      log.error(`giving up on ${item.url}`, error instanceof Error ? error.message : String(error));
    }
  }

  // The pages this run reasoned against are the ones worth keeping current, so
  // they move into the short refresh tier.
  if (usedUrls.size > 0) {
    await store
      .recordCorpusRun({ seen: [], missing: [], retired: [], used: [...usedUrls], at: new Date() })
      .catch((error: unknown) => {
        log.warn("could not stamp the pages this run used", error instanceof Error ? error.message : error);
      });
  }

  return analyzed;
}

/**
 * Every check one reply goes through, in order. Split out so a test can run
 * the whole chain on a hand-written reply without a model or a network.
 */
export function checkAnalysis(
  reply: AnalyzerOutput,
  docs: RailwayDoc[],
  item: StoredItem,
  context: RunContext,
  onNote: (note: string) => void,
): Analysis {
  const verified = verifyAgainstDocs(reply.analysis, docs);
  // Page edits pointed at the product docs, and page edits about some other
  // capability, both go before the sentences are shaped, so nothing is spent
  // on an action that is about to be dropped.
  const targeted = enforcePageTargets(verified.analysis);
  const scoped = enforceUpdatePagesTopic(targeted.analysis, item);

  const coverage: CoverageContext = {
    index: context.index,
    seenUrls: new Set([...docs.map((doc) => doc.url), ...reply.readUrls]),
  };
  const gated = gateActions(scoped.analysis, coverage);

  // The gate can retype nothing and drop plenty, so the sentence the embed
  // shows is shaped after it rather than before.
  const led = enforceActionLead(gated.analysis);

  for (const note of [
    ...verified.notes,
    ...targeted.notes,
    ...scoped.notes,
    ...gated.notes,
    ...led.notes,
  ]) {
    onNote(note);
  }

  return {
    ...led.analysis,
    ...(reply.readUrls.length > 0 ? { pagesRead: reply.readUrls } : {}),
  };
}
