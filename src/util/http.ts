import { createLogger } from "../log.js";

const log = createLogger("http");

export interface FetchTextOptions {
  timeoutMs: number;
  userAgent: string;
  headers?: Record<string, string>;
  /** Total attempts, including the first one. */
  attempts?: number;
  accept?: string;
  method?: "GET" | "HEAD";
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, options: FetchTextOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent,
        accept: options.accept ?? "*/*",
        ...options.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL as text, retrying transient failures with exponential backoff. */
export async function fetchText(url: string, options: FetchTextOptions): Promise<string> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(url, options);
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 500);
        const error = new HttpError(response.status, url, body);
        if (!retryable(response.status)) throw error;
        lastError = error;
      } else {
        return await response.text();
      }
    } catch (error) {
      if (error instanceof HttpError && !retryable(error.status)) throw error;
      lastError = error;
    }

    if (attempt < attempts) {
      const backoffMs = 500 * 2 ** (attempt - 1);
      log.debug(`retrying ${url} in ${backoffMs}ms (attempt ${attempt + 1}/${attempts})`);
      await sleep(backoffMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`failed to fetch ${url}`);
}

/**
 * What a URL claims to serve, without downloading it. Returns null when the
 * URL cannot be reached at all – callers treat that as "not usable" rather
 * than as an error worth failing a run over.
 */
export async function fetchContentType(
  url: string,
  options: FetchTextOptions,
): Promise<string | null> {
  try {
    const response = await request(url, { ...options, method: "HEAD", attempts: 1 });
    if (!response.ok) return null;
    return response.headers.get("content-type");
  } catch (error) {
    log.debug(`HEAD ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function fetchJson<T>(url: string, options: FetchTextOptions): Promise<T> {
  const text = await fetchText(url, { ...options, accept: options.accept ?? "application/json" });
  return JSON.parse(text) as T;
}
