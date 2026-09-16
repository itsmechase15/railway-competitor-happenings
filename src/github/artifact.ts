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
 * An issue body can only show an image the reader's browser can fetch, so the
 * PNG has to be somewhere reachable before the issue that embeds it is opened.
 * This repo is that somewhere: the file is committed to
 * `artifacts/update-pages/` through the contents API. A link to a file someone
 * has to click is the thing this replaces – the point of the picture is that it
 * is already on the screen.
 *
 * **This repo is private, which decides the URL.** There is no address for a
 * file in it that an unauthenticated fetch can read, so the embed has to be one
 * the reader's own browser can authenticate. Two facts settle which:
 *
 * - GitHub does not send its own URLs through the camo image proxy, and camo
 *   fetches anonymously anyway – a proxied private URL could never resolve. A
 *   `github.com/...` image is fetched by the reader's browser, carrying the
 *   github.com session it already has.
 * - A commit SHA never moves, and neither does a blob at one.
 *
 * So the embed is `github.com/<repo>/blob/<commit sha>/<path>?raw=true`, and
 * `download_url` from the contents API is never it. That field is a
 * `raw.githubusercontent.com` URL with a signed `?token=` on the end: it renders
 * for the few minutes the signature lasts and 404s for everybody who opens the
 * issue after that, which is everybody. Baking one into an issue body is the bug
 * this file exists to not have, and {@link carriesCredential} is the guard.
 *
 * Two other ways in were looked at and are not available here. GitHub's own
 * paste flow, `github.com/user-attachments/assets/<uuid>`, is the nicest answer
 * and takes a personal access token – its upload endpoint answers 404 to the
 * Actions `GITHUB_TOKEN` at any permission level, so using it would mean a new
 * long-lived human credential in the secrets. A `data:` URI needs no credential
 * at all and GitHub's markdown sanitizer strips the `src` attribute off it.
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
   * throws, and never returns a URL that carries a credential.
   */
  write(path: string, png: Buffer, message: string): Promise<string | null>;
}

/** The web host, which is the one a reader looking at the issue is signed in to. */
const GITHUB_WEB_BASE = "https://github.com";

/**
 * The durable address of one file at one commit. `?raw=true` serves the bytes
 * rather than the blob page, which is what an `<img>` needs.
 */
export function blobUrl(repo: string, commitSha: string, path: string): string {
  return `${GITHUB_WEB_BASE}/${repo}/blob/${commitSha}/${encodeURI(path)}?raw=true`;
}

/**
 * Whether a URL carries a credential in its query, which is how a URL that
 * renders today 404s next week. `token` is what the contents API signs raw URLs
 * with and `jwt` is what GitHub's private attachment host uses; neither ever
 * belongs in an issue body.
 */
export function carriesCredential(url: string): boolean {
  try {
    const { searchParams } = new URL(url);
    return searchParams.has("token") || searchParams.has("jwt");
  } catch {
    return false;
  }
}

interface ContentsResponse {
  /** The commit the PUT made, which is what pins the URL. */
  commit?: { sha?: string };
  /** On a GET, the file's own page on the default branch. */
  html_url?: string;
  message?: string;
}

interface CommitSummary {
  sha?: string;
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
      const sha = created.commit?.sha;
      if (sha) return blobUrl(this.repo, sha, path);
      throw new Error("GitHub accepted the file but named no commit");
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
    return this.request<ContentsResponse>("PUT", `/contents/${encodeURI(path)}`, {
      message,
      content: png.toString("base64"),
    });
  }

  /**
   * The durable URL of a file an earlier run already committed here, or null
   * when it cannot be pinned down.
   *
   * The commit that last touched the path is the one holding the bytes, and its
   * SHA is what makes the URL outlive the branch. When the history cannot be
   * read, the file's own page on the default branch is the next best thing: it
   * is still a `github.com` address with no credential in it, and it renders for
   * as long as the file stays where it is.
   */
  private async existingUrl(path: string): Promise<string | null> {
    const sha = await this.lastCommitFor(path);
    if (sha) return blobUrl(this.repo, sha, path);

    try {
      const found = await this.request<ContentsResponse>("GET", `/contents/${encodeURI(path)}`);
      return found.html_url ? `${found.html_url}?raw=true` : null;
    } catch {
      return null;
    }
  }

  /** The newest commit touching one path, which is the one that wrote it. */
  private async lastCommitFor(path: string): Promise<string | null> {
    try {
      const commits = await this.request<CommitSummary[]>(
        "GET",
        `/commits?per_page=1&path=${encodeURIComponent(path)}`,
      );
      return commits[0]?.sha ?? null;
    } catch {
      return null;
    }
  }

  private async request<T>(
    method: "GET" | "PUT",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${GITHUB_API_BASE}/repos/${this.repo}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as T & { message?: string };
      if (!response.ok) {
        throw new Error(
          `${method} ${path} returned ${response.status}: ${body.message ?? "no detail"}`,
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
