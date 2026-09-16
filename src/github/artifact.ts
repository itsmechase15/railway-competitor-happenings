import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createLogger } from "../log.js";
import { GITHUB_API_BASE } from "./issue.js";

const log = createLogger("artifact");

/**
 * Where a Before/After picture is put so a GitHub issue can render it inline.
 *
 * An issue body can only show an image it can fetch, so the PNG has to live
 * somewhere public before the issue that embeds it is opened. This repo is that
 * somewhere: the file is committed to `artifacts/update-pages/` through the
 * contents API, and the raw URL GitHub hands back goes straight into the issue
 * body as an image. A link to a file someone has to click is the thing this
 * replaces – the point of the picture is that it is already on the screen.
 *
 * Committing on the daily job's behalf is why `daily.yml` grants
 * `contents: write`. Nothing else in the app writes to the repo.
 *
 * Every path here is soft. A refused commit costs the picture and nothing else:
 * the issue is opened in text, saying the same thing in words.
 */
export interface ArtifactWriter {
  readonly description: string;
  /**
   * The URL an issue can embed, or null when nothing was published. Never
   * throws.
   */
  write(path: string, png: Buffer, message: string): Promise<string | null>;
}

interface ContentsResponse {
  content?: { download_url?: string | null; sha?: string };
  message?: string;
}

export class GitHubArtifactWriter implements ArtifactWriter {
  readonly description: string;

  constructor(
    private readonly repo: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {
    this.description = `commits to ${repo}`;
  }

  async write(path: string, png: Buffer, message: string): Promise<string | null> {
    try {
      const created = await this.put(path, png, message);
      const url = created.content?.download_url;
      if (url) return url;
      throw new Error("GitHub accepted the file but returned no download url");
    } catch (error) {
      // A path that already holds a file is a 422, and it means an earlier run
      // drew the same edit: the name is a hash of the page and the copy. That is
      // a hit, not a failure, so the existing file is what the issue points at.
      if (error instanceof Error && /\b(409|422)\b/.test(error.message)) {
        const existing = await this.existingUrl(path);
        if (existing) {
          log.info(`reusing the copy already committed at ${path}`);
          return existing;
        }
      }
      log.warn(
        `could not commit ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async put(path: string, png: Buffer, message: string): Promise<ContentsResponse> {
    return this.request("PUT", path, {
      message,
      content: png.toString("base64"),
    });
  }

  /** The raw URL of a file already at this path, or null when there is not one. */
  private async existingUrl(path: string): Promise<string | null> {
    try {
      const found = await this.request("GET", path);
      // A GET on a file returns the file's own fields at the top level rather
      // than under `content`, so read it as either shape.
      const body = found as ContentsResponse & { download_url?: string | null };
      return body.download_url ?? body.content?.download_url ?? null;
    } catch {
      return null;
    }
  }

  private async request(
    method: "GET" | "PUT",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<ContentsResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${this.repo}/contents/${encodeURI(path)}`,
        {
          method,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
          },
          ...(payload ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        },
      );

      const body = (await response.json().catch(() => ({}))) as ContentsResponse;
      if (!response.ok) {
        throw new Error(
          `${method} contents/${path} returned ${response.status}: ${body.message ?? "no detail"}`,
        );
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Used for a dry run and for a run with no token.
 *
 * It still writes the PNG, to a temp directory, and logs where. A dry run that
 * skipped drawing would show half the outcome: the picture is the part worth
 * looking at before this goes near the repo, and looking at it costs no
 * credentials. What it does not do is commit, so nothing lands in the repo and
 * the issue body is the text-only one.
 */
export class LocalArtifactWriter implements ArtifactWriter {
  readonly description: string;

  constructor(readonly reason: string) {
    this.description = `writes to a temp directory (${reason})`;
  }

  async write(path: string, png: Buffer): Promise<string | null> {
    try {
      const directory = await mkdtemp(join(tmpdir(), "update-pages-"));
      const file = join(directory, path.split("/").pop() ?? "before-after.png");
      await writeFile(file, png);
      log.info(`[${this.reason}] would commit ${path} ${"\u2013"} wrote it to ${file} instead`);
    } catch (error) {
      log.warn(
        `[${this.reason}] could not write ${path} locally: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

export function createArtifactWriter(config: Config): ArtifactWriter {
  if (config.dryRun) return new LocalArtifactWriter("dry run");
  if (!config.githubToken) return new LocalArtifactWriter("GITHUB_TOKEN is not set");
  return new GitHubArtifactWriter(config.githubRepo, config.githubToken, config.httpTimeoutMs);
}
