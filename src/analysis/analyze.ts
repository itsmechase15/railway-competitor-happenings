import { Agent } from "@cursor/sdk";
import { createCompareIndex, type CompareIndex } from "../competitor/compare.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import { createLogger } from "../log.js";
import { gatherDocsContext, topUpDocsForActions } from "../railway/docs.js";
import type {
  Analysis,
  AnalyzedItem,
  CompetitorClaim,
  RailwayClaim,
  RailwayDoc,
  StoredItem,
} from "../types.js";
import type { Analyzer } from "./analyzer.js";
import { FALLBACK_MODEL, heuristicAnalysis } from "./fallback.js";
import { enforceActionLead } from "./lead.js";
import { buildAnalysisPrompt } from "./prompt.js";
import { enforcePageTargets, enforceUpdatePagesTopic } from "./relevance.js";
import { parseAnalysis } from "./schema.js";
import { verifyAgainstDocs } from "./verify.js";

const log = createLogger("analysis");

/** How many indexed claims to put in front of the model per competitor. */
const CLAIMS_PER_PROMPT = 8;
/** Claims from any single page, so one long compare page cannot crowd out the rest. */
const CLAIMS_PER_PAGE = 2;
const ANALYSIS_ATTEMPTS = 2;

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

class CursorAnalyzer implements Analyzer {
  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly runtime: "local" | "cloud",
  ) {}

  async analyze(
    item: StoredItem,
    claims: RailwayClaim[],
    docs: RailwayDoc[],
    compareClaims: CompetitorClaim[],
  ): Promise<Analysis> {
    const prompt = buildAnalysisPrompt(item, claims, docs, compareClaims);
    let lastError: unknown;

    for (let attempt = 1; attempt <= ANALYSIS_ATTEMPTS; attempt += 1) {
      try {
        const run = await Agent.prompt(prompt, {
          apiKey: this.apiKey,
          model: { id: this.model },
          ...(this.runtime === "cloud"
            ? { cloud: { repos: [] } }
            : // No repo to reason about: text in, JSON out.
              { tools: [], local: { cwd: process.cwd() } }),
        });

        if (run.status !== "finished") {
          throw new Error(`agent run ${run.status}: ${run.error?.message ?? "no detail"}`);
        }
        if (!run.result) throw new Error("agent run returned no text");

        return parseAnalysis(run.result);
      } catch (error) {
        lastError = error;
        log.warn(
          `analysis attempt ${attempt}/${ANALYSIS_ATTEMPTS} failed for ${item.url}`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error("analysis failed");
  }
}

class HeuristicAnalyzer implements Analyzer {
  readonly model = FALLBACK_MODEL;

  async analyze(item: StoredItem, claims: RailwayClaim[], docs: RailwayDoc[]): Promise<Analysis> {
    return heuristicAnalysis(item, claims, docs);
  }
}

/**
 * The analyzer that cannot fail: it restates the source instead of assessing
 * it, and every alert it produces says so.
 */
export function createFallbackAnalyzer(): Analyzer {
  return new HeuristicAnalyzer();
}

export function createAnalyzer(config: Config): Analyzer {
  if (!config.cursorApiKey) {
    log.warn(
      "CURSOR_API_KEY is not set – falling back to a labeled restatement that does not assess the change",
    );
    return new HeuristicAnalyzer();
  }
  return new CursorAnalyzer(config.cursorModel, config.cursorApiKey, config.cursorRuntime);
}

export type { Analyzer };

/**
 * Analyze each new item against three kinds of context: Railway's indexed
 * claims about the competitor, which find stale compare copy; the Railway docs
 * for what it touches, which are the only evidence for what Railway does or
 * does not do; and the competitor's own page about Railway, which is where a
 * claim that Railway cannot do something turns up. Every verdict is then
 * reconciled with the docs, so an action cannot claim a gap the docs
 * contradict, page edits that wandered off this launch's topic are dropped,
 * and each surviving action is made to open with the work it asks for. A
 * failed analysis drops that item and leaves the rest alone.
 */
export async function analyzeItems(
  items: StoredItem[],
  store: Store,
  analyzer: Analyzer,
  config: Config,
  compare: CompareIndex = createCompareIndex(config),
): Promise<AnalyzedItem[]> {
  const claimsByCompetitor = new Map<string, RailwayClaim[]>();
  const analyzed: AnalyzedItem[] = [];

  for (const item of items) {
    let claims = claimsByCompetitor.get(item.competitor);
    if (!claims) {
      const ranked = await store.getClaims(item.competitor, CLAIMS_PER_PROMPT * 4);
      claims = diversifyClaims(ranked, CLAIMS_PER_PROMPT);
      claimsByCompetitor.set(item.competitor, claims);
    }

    // Per item, not per competitor: which docs matter depends on what shipped.
    const docs = await gatherDocsContext(config, store, item).catch((error: unknown) => {
      log.warn(
        `docs context failed for ${item.url}`,
        error instanceof Error ? error.message : error,
      );
      return [] as RailwayDoc[];
    });

    // Per competitor, and cached: what they claim about Railway is the same
    // whichever of their launches we are reading.
    const compareClaims = await compare.claimsFor(item.competitor).catch((error: unknown) => {
      log.warn(
        `competitor pages failed for ${item.competitor}`,
        error instanceof Error ? error.message : error,
      );
      return [] as CompetitorClaim[];
    });

    try {
      const reply = await analyzer.analyze(item, claims, docs, compareClaims);
      // A verdict often names a surface one step to the side of what the
      // signal's own words matched, and an action checked against no page at
      // all is the one that gets what Railway ships wrong.
      const grounded = await topUpDocsForActions(
        config,
        store,
        item,
        reply.actions,
        docs,
      ).catch((error: unknown) => {
        log.warn(
          `docs top-up failed for ${item.url}`,
          error instanceof Error ? error.message : error,
        );
        return docs;
      });
      const verified = verifyAgainstDocs(reply, grounded);
      // Page edits that are not about this launch, and page edits pointed at
      // the product docs, both go before the sentences are shaped, so nothing
      // is spent on an action that is about to be dropped. The heuristic is
      // exempt from the topic guard: its one action says outright that nothing
      // was assessed and asks someone to check the closest page, which is a
      // sentence about no launch in particular by design.
      const targeted = enforcePageTargets(verified.analysis);
      const scoped =
        analyzer.model === FALLBACK_MODEL
          ? { analysis: targeted.analysis, notes: [] as string[] }
          : enforceUpdatePagesTopic(targeted.analysis, item);
      // The docs pass can retype an action and name its feature, so the
      // sentence the embed shows is shaped after it, not before.
      const led = enforceActionLead(scoped.analysis);
      for (const note of [
        ...verified.notes,
        ...targeted.notes,
        ...scoped.notes,
        ...led.notes,
      ]) {
        log.warn(`corrected ${item.url}: ${note}`);
      }
      const analysis = led.analysis;
      analyzed.push({ item, analysis, model: analyzer.model, docs: grounded });
      const actions =
        analysis.actions.map((action) => action.type).join(", ") || "no action worth taking";
      log.info(
        `analyzed ${item.competitor}/${item.source} "${item.title}" against ${grounded.length} docs pages → ${actions}`,
      );
    } catch (error) {
      log.error(
        `giving up on ${item.url}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return analyzed;
}
