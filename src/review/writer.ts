import { createAnalystRunner, type AnalystRunner } from "../analysis/analyst.js";
import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { buildRewritePrompt, type RewriteInput } from "./prompt.js";
import { parseRevision, type Revision } from "./schema.js";

const log = createLogger("review");

/**
 * The writer: one text-only run that rewrites a single action the reviewer
 * asked to revise.
 *
 * Text only, and no workspace. It is not going to check anything – the reviewer
 * has been, and the pages it may quote are in its prompt. Giving it the corpus
 * would invite it to find new evidence for a claim it was told to narrow, which
 * is the failure mode the whole design avoids.
 *
 * It never runs on an agree or a drop, so a run's cost is one reviewer per filed
 * action and one writer per action that needed correcting.
 */
export interface ActionWriter {
  readonly model: string;
  readonly description: string;
  rewrite(input: RewriteInput): Promise<Revision>;
}

class CursorActionWriter implements ActionWriter {
  constructor(private readonly runner: AnalystRunner) {}

  get model(): string {
    return this.runner.model;
  }

  get description(): string {
    return this.runner.description;
  }

  async rewrite(input: RewriteInput): Promise<Revision> {
    const reply = await this.runner.run({
      prompt: buildRewritePrompt(input),
      workspaceDir: null,
    });
    return parseRevision(reply.text);
  }
}

/** Null when there is no API key, which is also when there is no reviewer. */
export function createActionWriter(config: Config): ActionWriter | null {
  const runner = createAnalystRunner(config, { model: config.updaterModel });
  if (!runner) return null;
  log.info(`review writer: ${runner.description}`);
  return new CursorActionWriter(runner);
}
