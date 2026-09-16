/**
 * Everything this app reads out of the environment, in one list, so a fresh
 * clone can be told exactly what is missing instead of failing halfway through
 * a run with a vendor error nobody can place.
 *
 * The list is the source of truth for three things that would otherwise drift
 * apart: `.env.example`, the secrets table in the README, and the preflight
 * the workflows run before the pipeline. Add a variable to `src/config.ts` and
 * it belongs here too.
 */

/** How much a run loses when the variable is not set. */
export type Need =
  /** The daily run cannot do its job without it. */
  | "required"
  /**
   * One source goes dark. The run still posts everything else, so this never
   * fails a check – not under `--strict` either.
   */
  | "source"
  /** Tuning, or a default that is already right. */
  | "optional";

/** Where the value lives once this is running for real, on GitHub Actions. */
export type Home =
  | "actions-secret"
  | "actions-variable"
  /** Actions hands it to the job. Never set by hand there. */
  | "actions-builtin"
  /** Only ever set on a laptop, for a local run. */
  | "local";

export interface Requirement {
  name: string;
  need: Need;
  home: Home;
  /** What the app does with it. */
  purpose: string;
  /** Where a person gets the value, in one line. */
  howToGet: string;
  /** What happens on a run without it. Only for the ones a run survives. */
  without?: string;
  /** Other names the same value may arrive under. */
  alsoAccepts?: string[];
}

export const REQUIREMENTS: Requirement[] = [
  {
    name: "DATABASE_URL",
    need: "required",
    home: "actions-secret",
    purpose: "Postgres that remembers what has already been posted",
    howToGet:
      "Supabase → this bot's own project → Project Settings → Database → Connection string → Session pooler. It has to be the pooler URI, not the direct host, and not another bot's project",
  },
  {
    name: "DISCORD_BOT_TOKEN",
    need: "required",
    home: "actions-secret",
    purpose: "Posts the embed to the channel",
    howToGet:
      "discord.com/developers/applications → your app → Bot → Reset Token, then invite the bot to the server with Send Messages and Embed Links in the channel",
    without: "nothing is delivered: the run analyzes, files issues, and prints the payload",
  },
  {
    name: "DISCORD_CHANNEL_ID",
    need: "required",
    home: "actions-variable",
    purpose: "Channel the bot posts to. Yours, and there is no default",
    howToGet:
      "In Discord, turn on Settings → Advanced → Developer Mode, right-click the channel, Copy Channel ID. The workflows read it from Variables, then from a secret of the same name",
    without: "the bot token has nowhere to post, so the run stops before delivery",
  },
  {
    name: "CURSOR_API_KEY",
    need: "required",
    home: "actions-secret",
    purpose: "Runs the Opus analysis that turns a launch into recommended actions",
    howToGet: "cursor.com/dashboard → Integrations → API Keys → Create key",
    without: "the run falls back to restating the source, labeled 'not model-analyzed'",
  },
  // The plan has X optional from phase 1 on: the run ships the blogs and the
  // changelog with or without a bearer token. A repo that never gets one is a
  // working repo, so an unset token is reported and never fails a check.
  {
    name: "X_BEARER_TOKEN",
    need: "source",
    home: "actions-secret",
    purpose: "Reads the last few posts from @render and @vercel",
    howToGet: "developer.x.com → Projects & Apps → your app → Keys and tokens → Bearer Token",
    without: "the X source is skipped, with a log line saying so",
  },
  {
    name: "GITHUB_TOKEN",
    need: "optional",
    home: "actions-builtin",
    purpose: "Opens the issue each recommended action links to",
    howToGet:
      "Actions provides it; the workflows grant it issues: write. Locally, a PAT with repo scope, as GITHUB_TOKEN or GH_TOKEN",
    without: "issue creation is skipped and the alert posts without issue links",
    alsoAccepts: ["GH_TOKEN"],
  },
  {
    name: "SCREENSHOT_URL_TEMPLATE",
    need: "optional",
    home: "actions-variable",
    purpose: "Renderers that screenshot a feature page when it offers no image of its own",
    howToGet: "Only set this to move off the microlink → thum.io default",
  },
  {
    name: "CURSOR_MODEL",
    need: "optional",
    home: "actions-variable",
    purpose: "Model id passed to the Cursor SDK",
    howToGet: "Defaults to claude-opus-5",
  },
  {
    name: "REVIEW_MODEL",
    need: "optional",
    home: "actions-variable",
    purpose:
      "Model that reviews every filed action against the docs corpus and returns agree, revise, or drop",
    howToGet: "Defaults to claude-fable-5-1. It has to be a model your CURSOR_API_KEY can run",
    without:
      "a model id the Cursor SDK turns down skips the review, labels the issue review:skipped, and files the action as the analyst wrote it",
  },
  {
    name: "UPDATER_MODEL",
    need: "optional",
    home: "actions-variable",
    purpose: "Model that rewrites an action the reviewer asked to revise",
    howToGet: "Defaults to CURSOR_MODEL, which is the analyst's model",
  },
  {
    name: "SKIP_REVIEW",
    need: "optional",
    home: "local",
    purpose: "Turn the review pass off, for a fast local run",
    howToGet: "Set it to true on a laptop. The daily job leaves it unset",
    without: "nothing – unset is the daily job's behaviour, which is to review",
  },
  {
    name: "SKIP_PAGE_VISUALS",
    need: "optional",
    home: "local",
    purpose:
      "Stop drawing the before/after image on an update_pages issue, which is the one thing here that runs a browser and commits to the repo",
    howToGet: "Set it to true where there is no Chromium, or to keep the repo clean of artifacts",
    without: "nothing – unset is the daily job's behaviour, which is to draw them",
  },
  {
    name: "REVIEW_MAX_PER_RUN",
    need: "optional",
    home: "actions-variable",
    purpose: "Reviews allowed in one run, which is what caps the review's cost",
    howToGet: "Defaults to 12, the same cap as MAX_ITEMS_PER_RUN",
    without: "actions past the cap are filed as written and labelled review:skipped",
  },
  {
    name: "DOCS_LLMS_FULL_TXT",
    need: "optional",
    home: "actions-variable",
    purpose: "One-off seed for an empty docs corpus, read once and then ignored",
    howToGet:
      "Only set this to fill a fresh corpus in one request instead of over several runs, e.g. https://docs.railway.com/llms-full.txt",
    without: "the corpus fills a page at a time, a few runs before it is complete",
  },
];

export interface EnvReport {
  /** Set, and safe to run with. */
  present: string[];
  /** Not set, and the daily run cannot work without them. */
  missingRequired: Requirement[];
  /** Not set, so that source is dark. Everything else still runs. */
  missingSources: Requirement[];
  /** Things that are set but look wrong, or worth saying out loud. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function has(env: Env, name: string): boolean {
  const value = env[name];
  return value !== undefined && value.trim() !== "";
}

function isSet(env: Env, requirement: Requirement): boolean {
  return [requirement.name, ...(requirement.alsoAccepts ?? [])].some((name) => has(env, name));
}

/**
 * Supabase's direct host resolves to IPv6 only and GitHub's runners have no
 * IPv6 route, so a direct URI works on a laptop and fails on every scheduled
 * run with `connect ENETUNREACH`. Catching it here costs one string compare;
 * catching it in production costs a silent morning.
 */
export function isDirectSupabaseHost(databaseUrl: string): boolean {
  return /@db\.[a-z0-9]+\.supabase\.co[:/]/i.test(databaseUrl);
}

/**
 * Read the environment against the list above. Pure, so the workflows, the
 * CLI, and the tests all judge a missing secret the same way.
 */
export function checkEnv(env: Env): EnvReport {
  const dryRun = ["1", "true", "yes", "on"].includes((env.DRY_RUN ?? "").trim().toLowerCase());

  const present: string[] = [];
  const missingRequired: Requirement[] = [];
  const missingSources: Requirement[] = [];
  const warnings: string[] = [];

  for (const requirement of REQUIREMENTS) {
    if (isSet(env, requirement)) {
      present.push(requirement.name);
      continue;
    }

    // A dry run prints the payloads and writes nothing, so it needs no
    // database. Every other run does: without one the same launches would be
    // alerted again tomorrow.
    if (requirement.name === "DATABASE_URL" && dryRun) {
      warnings.push("DRY_RUN=true, so the run uses the in-memory store and records nothing");
      continue;
    }

    // Only the bot token reads the channel id, and a dry run prints the
    // payload instead of delivering it.
    if (
      requirement.name === "DISCORD_CHANNEL_ID" &&
      (!has(env, "DISCORD_BOT_TOKEN") || dryRun)
    ) {
      continue;
    }

    if (requirement.need === "required") missingRequired.push(requirement);
    else if (requirement.need === "source") missingSources.push(requirement);
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl && isDirectSupabaseHost(databaseUrl)) {
    warnings.push(
      "DATABASE_URL points at Supabase's direct host, which is IPv6 only. GitHub Actions has no IPv6 route, so use the Session pooler URI instead",
    );
  }

  if (!has(env, "GITHUB_TOKEN") && !has(env, "GH_TOKEN")) {
    warnings.push(
      "No GITHUB_TOKEN: issue creation is skipped, so the alerts post without issue links. Actions sets this for free",
    );
  }

  return { present, missingRequired, missingSources, warnings };
}

const HOME_LABEL: Record<Home, string> = {
  "actions-secret": "Settings → Secrets and variables → Actions → Secrets",
  "actions-variable": "Settings → Secrets and variables → Actions → Variables",
  "actions-builtin": "provided by Actions",
  local: ".env only",
};

function describe(requirement: Requirement): string {
  const lines = [
    `  ${requirement.name} – ${requirement.purpose}`,
    `      get it:  ${requirement.howToGet}`,
    `      put it:  ${HOME_LABEL[requirement.home]}`,
  ];
  if (requirement.without) lines.push(`      without: ${requirement.without}`);
  return lines.join("\n");
}

const NEED_WIDTH = Math.max(...REQUIREMENTS.map((requirement) => requirement.need.length));
const NAME_WIDTH = Math.max(...REQUIREMENTS.map((requirement) => requirement.name.length));

/**
 * Every variable and whether it is set, which is what `--strict` is for. The
 * terse `Set:` line answers "can this run"; a fresh clone is asking the wider
 * question of what is still on the table, and an optional variable nobody has
 * heard of is one nobody sets.
 */
function inventory(report: EnvReport): string {
  const present = new Set(report.present);

  const lines = REQUIREMENTS.map((requirement) => {
    const set = present.has(requirement.name);
    const columns = [
      set ? "set  " : "unset",
      requirement.name.padEnd(NAME_WIDTH),
      requirement.need.padEnd(NEED_WIDTH),
      set ? requirement.purpose : (requirement.without ?? requirement.purpose),
    ];
    return `  ${columns.join("  ")}`;
  });

  return `Every variable this app reads:\n${lines.join("\n")}`;
}

/**
 * The report as a person reads it. Names every missing variable and where the
 * value comes from, because "DATABASE_URL is not set" without the next two
 * lines is the same dead end as the vendor error it replaced.
 */
export function formatReport(report: EnvReport, strict: boolean): string {
  const sections: string[] = [];

  if (report.missingRequired.length > 0) {
    sections.push(
      `Missing ${report.missingRequired.length} required secret(s) – the daily run cannot work:\n${report.missingRequired
        .map(describe)
        .join("\n")}`,
    );
  }

  if (report.missingSources.length > 0) {
    sections.push(
      `Missing ${report.missingSources.length} source secret(s) – optional, so these sources are skipped and the rest of the run is unaffected:\n${report.missingSources
        .map(describe)
        .join("\n")}`,
    );
  }

  if (report.warnings.length > 0) {
    sections.push(`Worth knowing:\n${report.warnings.map((line) => `  - ${line}`).join("\n")}`);
  }

  sections.push(
    strict
      ? inventory(report)
      : `Set: ${report.present.length > 0 ? report.present.join(", ") : "nothing"}`,
  );

  if (report.missingRequired.length === 0 && report.missingSources.length === 0) {
    sections.push("Everything this app reads is configured.");
  } else {
    sections.push(
      "Never paste a secret into a file, a commit, or a chat with an agent. Add it in the repo's Actions secrets, or in a local .env that git already ignores.",
    );
  }

  return sections.join("\n\n");
}

/**
 * Whether the report should stop a run. Only the required variables do. A
 * missing source costs that one source and nothing else, so `--strict` reports
 * it and moves on: a repo with no X token is a repo that posts blogs and a
 * changelog every morning, and failing its preflight would be a lie.
 */
export function isFailing(report: EnvReport): boolean {
  return report.missingRequired.length > 0;
}
