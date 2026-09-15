import "dotenv/config";
import type { CompetitorId } from "./types.js";

export interface CompetitorConfig {
  id: CompetitorId;
  label: string;
  /**
   * RSS or Atom changelog feed. Absent for a competitor whose changelog is not
   * read, in which case the changelog source is skipped rather than reported
   * as broken.
   */
  changelogFeed?: string;
  /**
   * Sitemaps to diff for blog posts. Sitemap indexes are followed one level
   * deep, so pointing at an index is fine. Empty when the site publishes none,
   * in which case `blogIndexes` is the discovery path.
   */
  sitemaps: string[];
  /**
   * Blog index pages whose links are the listing. Render publishes no sitemap
   * at the root, so its index is the diff target: the URLs on it are compared
   * against what is already stored, and whatever is new is a new post.
   */
  blogIndexes: string[];
  /** Only URLs whose path starts with one of these become blog candidates. */
  blogPathPrefixes: string[];
  /** Official X handle, without the leading @. */
  xUsername: string;
  /** Lowercase strings that count as a mention of this competitor. */
  aliases: string[];
  /**
   * The competitor's own page about Railway. What they claim Railway cannot do
   * is one reason a Railway compare page needs an edit, so these go in front
   * of the model as context – never as evidence about Railway.
   */
  comparePages: string[];
}

export const COMPETITORS: Record<CompetitorId, CompetitorConfig> = {
  render: {
    id: "render",
    label: "Render",
    changelogFeed: "https://render.com/changelog/feed.xml",
    sitemaps: [],
    blogIndexes: ["https://render.com/blog"],
    blogPathPrefixes: ["/blog/"],
    xUsername: "render",
    aliases: ["render.com", "render"],
    comparePages: ["https://render.com/docs/migrate-from-railway"],
  },
  vercel: {
    id: "vercel",
    label: "Vercel",
    /*
     * No changelog: Vercel's changelog is not a source here. Its only feed
     * mixes changelog entries into the blog and cannot be read for one without
     * the other, so the blog index is the read. It describes each post it
     * lists, so a candidate off it carries the post's real title and date.
     */
    sitemaps: [],
    blogIndexes: ["https://vercel.com/blog"],
    blogPathPrefixes: ["/blog/"],
    xUsername: "vercel",
    aliases: ["vercel"],
    comparePages: ["https://vercel.com/compare/railway"],
  },
};

export const COMPETITOR_IDS = Object.keys(COMPETITORS) as CompetitorId[];

/** Issues are filed against this app's own repo, where the daily job already runs. */
export const DEFAULT_GITHUB_REPO = "itsmechase15/railway-competitor-happenings";

/**
 * Renderers that turn a page into an image, tried in order. Used when a
 * competitor's page offers no usable picture of its own, so the alert still
 * opens with a screenshot of the feature rather than nothing.
 *
 * Microlink leads because it is the one that honors a fragment, and it only
 * takes the hash through `{encodedUrl}`: an unencoded `#` never leaves the
 * client. thum.io has no daily quota, so it stays behind it.
 */
export const DEFAULT_SCREENSHOT_URL_TEMPLATES = [
  "https://api.microlink.io/?url={encodedUrl}&screenshot=true&meta=false&embed=screenshot.url",
  "https://image.thum.io/get/width/1200/crop/900/noanimate/{url}",
];

export interface Config {
  dryRun: boolean;
  databaseUrl: string | undefined;
  /** Bot token the embeds are posted with. */
  discordBotToken: string | undefined;
  /**
   * Channel the bot posts to. No default: a built-in id would be one server's
   * channel, and every other install would post at it by accident.
   */
  discordChannelId: string | undefined;
  /** Token used to open the issue each action links to. Set for free inside Actions. */
  githubToken: string | undefined;
  /** `owner/repo` the issues are filed against. */
  githubRepo: string;
  /**
   * URL templates whose `{url}` (or `{encodedUrl}`) is replaced with the page
   * to screenshot, tried in order until one serves an image.
   */
  screenshotUrlTemplates: string[];
  cursorApiKey: string | undefined;
  cursorModel: string;
  /** "local" runs the agent on this machine; "cloud" uses a no-repo cloud agent. */
  cursorRuntime: "local" | "cloud";
  xBearerToken: string | undefined;
  /** Items published before this many days ago are ignored. */
  lookbackDays: number;
  /** Hard cap on items analyzed and posted in one run, so a feed glitch cannot flood the channel. */
  maxItemsPerRun: number;
  /** Hard cap on new items accepted from a single competitor+source pair. */
  maxItemsPerSource: number;
  /** Cap on Railway pages fetched in one run. */
  railwayMaxPages: number;
  /** Re-fetch an indexed Railway page once it is this old. */
  railwayRefreshDays: number;
  /** Skip the Railway index refresh entirely (useful for fast local runs). */
  skipRailwayIndex: boolean;
  /**
   * Analyze a competitor+source pair's backlog on the very first run instead of
   * recording it silently. Dry runs only – it exists so you can preview a real
   * embed without a seeded database.
   */
  forceAnalyze: boolean;
  httpTimeoutMs: number;
  userAgent: string;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function str(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

/** A comma-separated variable, for the settings that accept more than one value. */
function list(name: string): string[] | undefined {
  const raw = str(name);
  if (raw === undefined) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

export function loadConfig(): Config {
  const runtime = (str("CURSOR_RUNTIME") ?? "local").toLowerCase();
  if (runtime !== "local" && runtime !== "cloud") {
    throw new Error(`CURSOR_RUNTIME must be "local" or "cloud", got "${runtime}"`);
  }

  const dryRun = bool("DRY_RUN", false);
  const forceAnalyze = bool("FORCE_ANALYZE", false);
  if (forceAnalyze && !dryRun) {
    throw new Error("FORCE_ANALYZE is only allowed with DRY_RUN=true – it bypasses seed protection");
  }

  return {
    dryRun,
    forceAnalyze,
    databaseUrl: str("DATABASE_URL"),
    discordBotToken: str("DISCORD_BOT_TOKEN"),
    discordChannelId: str("DISCORD_CHANNEL_ID"),
    githubToken: str("GITHUB_TOKEN") ?? str("GH_TOKEN"),
    githubRepo: str("GITHUB_REPOSITORY") ?? DEFAULT_GITHUB_REPO,
    screenshotUrlTemplates: list("SCREENSHOT_URL_TEMPLATE") ?? DEFAULT_SCREENSHOT_URL_TEMPLATES,
    cursorApiKey: str("CURSOR_API_KEY"),
    cursorModel: str("CURSOR_MODEL") ?? "claude-opus-5",
    cursorRuntime: runtime,
    xBearerToken: str("X_BEARER_TOKEN"),
    lookbackDays: int("LOOKBACK_DAYS", 7),
    maxItemsPerRun: int("MAX_ITEMS_PER_RUN", 12),
    maxItemsPerSource: int("MAX_ITEMS_PER_SOURCE", 8),
    railwayMaxPages: int("RAILWAY_MAX_PAGES", 40),
    railwayRefreshDays: int("RAILWAY_REFRESH_DAYS", 14),
    skipRailwayIndex: bool("SKIP_RAILWAY_INDEX", false),
    httpTimeoutMs: int("HTTP_TIMEOUT_MS", 20_000),
    userAgent:
      str("USER_AGENT") ??
      "railway-competitor-happenings/0.1 (+https://github.com/itsmechase15/railway-competitor-happenings)",
  };
}
