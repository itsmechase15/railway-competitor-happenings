import { Agent } from "@cursor/sdk";
import type { Config } from "../config.js";
import { createLogger } from "../log.js";

const log = createLogger("analyst");

/**
 * What the analyst may do in the workspace: open a file, search the text, list
 * what is there. No writes, no shell, no network, no subagents.
 *
 * The workspace is a directory of markdown copies of Railway's docs, so these
 * four are the whole job: find the pages that might speak to a launch, read
 * them, and quote what they say. Anything else is a way to change the evidence
 * or to go and find some more of it, and both defeat the point of a corpus.
 */
export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls"] as const;

/**
 * How many times one analysis is attempted. Two, and the second attempt is the
 * same prompt asked again after the first failed to come back or came back
 * unparseable. It is never a correction round: nothing tells the analyst what
 * the first reply got wrong, because a model told its guess was wrong will
 * produce a better-argued guess rather than a checked one.
 */
const ATTEMPTS = 2;

export interface AnalystRequest {
  prompt: string;
  /**
   * Directory the analyst searches, read-only. Null runs it on the prompt
   * alone, which is the cloud path and the fallback when no corpus was built.
   */
  workspaceDir: string | null;
}

export interface AnalystReply {
  /** The raw reply text, for the schema to read. */
  text: string;
  /**
   * Files the analyst opened, as its own tool calls reported them. This is
   * observed behaviour rather than self-report: the coverage gate rests on it,
   * and a model asked which pages it read will name the ones it should have.
   */
  readPaths: string[];
}

export interface AnalystRunner {
  readonly model: string;
  readonly description: string;
  run(request: AnalystRequest): Promise<AnalystReply>;
}

/**
 * The file path out of one conversation step, when the step is a file read.
 *
 * Grep and ls are not reads: knowing that a page exists is not knowing what it
 * says, and an action citing a page the analyst only listed is exactly the
 * claim the coverage gate is there to stop.
 */
export function readPathFrom(step: unknown): string | null {
  if (typeof step !== "object" || step === null) return null;
  const outer = step as { type?: unknown; message?: unknown };
  if (outer.type !== "toolCall") return null;

  const message = outer.message;
  if (typeof message !== "object" || message === null) return null;
  const call = message as { type?: unknown; args?: unknown };
  if (call.type !== "read") return null;

  const args = call.args;
  if (typeof args !== "object" || args === null) return null;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path.trim() !== "" ? path : null;
}

class CursorAnalyst implements AnalystRunner {
  readonly description: string;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly runtime: "local" | "cloud",
  ) {
    this.description = `${model} via cursor ${runtime}`;
  }

  async run(request: AnalystRequest): Promise<AnalystReply> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        return request.workspaceDir && this.runtime === "local"
          ? await this.searchingRun(request.prompt, request.workspaceDir)
          : await this.textOnlyRun(request.prompt);
      } catch (error) {
        lastError = error;
        log.warn(
          `analyst attempt ${attempt}/${ATTEMPTS} failed`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    throw lastError instanceof Error ? lastError : new Error("the analyst returned nothing");
  }

  /**
   * One run with the docs workspace under it. The agent opens what it wants
   * and we keep the list, so what it read is a fact about the run rather than
   * a claim in its reply.
   */
  private async searchingRun(prompt: string, workspaceDir: string): Promise<AnalystReply> {
    const readPaths: string[] = [];
    const agent = await Agent.create({
      apiKey: this.apiKey,
      model: { id: this.model },
      tools: [...READ_ONLY_TOOLS],
      local: { cwd: workspaceDir },
    });

    try {
      const run = await agent.send(prompt, {
        onStep: ({ step }) => {
          const path = readPathFrom(step);
          if (path && !readPaths.includes(path)) readPaths.push(path);
        },
      });
      const result = await run.wait();

      if (result.status !== "finished") {
        throw new Error(`agent run ${result.status}: ${result.error?.message ?? "no detail"}`);
      }
      if (!result.result) throw new Error("agent run returned no text");

      log.info(`analyst opened ${readPaths.length} corpus pages`);
      return { text: result.result, readPaths };
    } finally {
      agent.close();
    }
  }

  /** No workspace: text in, JSON out, with the pre-loaded excerpts as its only evidence. */
  private async textOnlyRun(prompt: string): Promise<AnalystReply> {
    const run = await Agent.prompt(prompt, {
      apiKey: this.apiKey,
      model: { id: this.model },
      ...(this.runtime === "cloud"
        ? { cloud: { repos: [] } }
        : { tools: [], local: { cwd: process.cwd() } }),
    });

    if (run.status !== "finished") {
      throw new Error(`agent run ${run.status}: ${run.error?.message ?? "no detail"}`);
    }
    if (!run.result) throw new Error("agent run returned no text");
    return { text: run.result, readPaths: [] };
  }
}

/** Null when no API key is set, which is what puts the run on the fallback. */
export function createAnalystRunner(config: Config): AnalystRunner | null {
  if (!config.cursorApiKey) return null;
  return new CursorAnalyst(config.cursorModel, config.cursorApiKey, config.cursorRuntime);
}
