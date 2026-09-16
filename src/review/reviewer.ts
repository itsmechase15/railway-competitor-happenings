import { createAnalystRunner, type AnalystRunner } from "../analysis/analyst.js";
import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { buildReviewPrompt, type ReviewInput } from "./prompt.js";
import { parseReview, type ReviewDecision } from "./schema.js";

const log = createLogger("review");

/**
 * The reviewer: one run per filed action, with the same docs corpus on disk the
 * analyst had, and a different model reading it.
 *
 * One run, and never a second one on the same action. The verdict it returns is
 * acted on by code, and the rewrite that a `revise` produces is checked by code.
 * Nothing shows this model its own verdict and asks it again.
 */
export interface ReviewOutcome extends ReviewDecision {
  /** The reviewer's model id, recorded on the analysis row and in the comment. */
  model: string;
  /**
   * Corpus pages the reviewer opened, from its own tool calls. These join the
   * analyst's reads as the coverage a rewrite is re-gated against, so a rewrite
   * may rest on a page the reviewer went and read.
   */
  readUrls: string[];
}

export interface Reviewer {
  readonly model: string;
  readonly description: string;
  review(input: ReviewInput): Promise<ReviewOutcome>;
}

class CursorReviewer implements Reviewer {
  constructor(private readonly runner: AnalystRunner) {}

  get model(): string {
    return this.runner.model;
  }

  get description(): string {
    return this.runner.description;
  }

  async review(input: ReviewInput): Promise<ReviewOutcome> {
    const reply = await this.runner.run({
      prompt: buildReviewPrompt(input),
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

    const decision = parseReview(reply.text);
    log.info(
      `reviewed the ${input.action.type} action: ${decision.verdict} after opening ${readUrls.length} corpus pages`,
    );
    return { ...decision, model: this.runner.model, readUrls };
  }
}

/**
 * Null when there is nothing to review with: no API key, or `SKIP_REVIEW=true`.
 * Either way every action is filed as the analyst wrote it, which is what this
 * bot did before the review existed.
 */
export function createReviewer(config: Config): Reviewer | null {
  if (config.skipReview) {
    log.info("SKIP_REVIEW is set, so nothing is reviewed and every action is filed as written");
    return null;
  }
  const runner = createAnalystRunner(config, { model: config.reviewModel });
  if (!runner) return null;
  log.info(`reviewer: ${runner.description}`);
  return new CursorReviewer(runner);
}
