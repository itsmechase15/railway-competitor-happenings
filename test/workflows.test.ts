import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The workflows are the only place the app's environment is assembled, and a
 * variable the code now requires is worth nothing if the step that reads it
 * was never handed it. That gap is invisible in review and costs a whole
 * morning's alert, so it is asserted here instead.
 */

const WORKFLOW_DIR = ".github/workflows";

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(`${WORKFLOW_DIR}/${name}`, "utf8") }));

interface Step {
  run: string;
  /** Names the step can actually see: its own env plus the job's. */
  env: Set<string>;
}

/**
 * Enough of a reader for the shape these files are written in: a job `env:`
 * block at four spaces, steps at six, a step `env:` block at eight. A real
 * YAML parser would mean a dependency for one test.
 */
function readSteps(text: string): Step[] {
  const lines = text.split("\n");
  const jobEnv = new Set<string>();
  const steps: Step[] = [];

  let current: { run: string[]; env: Set<string> } | undefined;
  let envIndent: number | undefined;
  let inJobEnv = false;

  const flush = (): void => {
    if (current) steps.push({ run: current.run.join(" "), env: current.env });
    current = undefined;
  };

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (/^ {4}env:\s*$/.test(line)) {
      inJobEnv = true;
      envIndent = undefined;
      continue;
    }
    if (inJobEnv) {
      const match = /^ {6}([A-Z0-9_]+):/.exec(line);
      if (match?.[1]) {
        jobEnv.add(match[1]);
        continue;
      }
      inJobEnv = false;
    }

    if (/^ {6}- /.test(line)) {
      flush();
      current = { run: [], env: new Set() };
      envIndent = undefined;
    }

    if (!current) continue;

    if (/^ {8}env:\s*$/.test(line)) {
      envIndent = 10;
      continue;
    }
    if (envIndent !== undefined) {
      const match = /^ {10}([A-Z0-9_]+):/.exec(line);
      if (match?.[1]) {
        current.env.add(match[1]);
        continue;
      }
      if (indent <= 8) envIndent = undefined;
    }

    const run = /^\s+(?:- )?run: (.*)$/.exec(line);
    if (run?.[1]) current.run.push(run[1]);
    else if (current.run.length > 0 && indent >= 10) current.run.push(line.trim());
  }
  flush();

  return steps.map((step) => ({ run: step.run, env: new Set([...step.env, ...jobEnv]) }));
}

/** Steps that either judge the environment or run the pipeline against it. */
function configuredSteps(text: string): Step[] {
  return readSteps(text).filter(
    (step) => /check-env/.test(step.run) || /dist\/index\.js|npm run run/.test(step.run),
  );
}

describe("workflow environments", () => {
  it("ships the four workflows the plan asks for", () => {
    expect(workflows.map((workflow) => workflow.name).sort()).toEqual([
      "check-secrets.yml",
      "ci.yml",
      "daily.yml",
      "force-post.yml",
    ]);
  });

  it("finds the steps it means to check", () => {
    const counted = workflows.map(({ name, text }) => [name, configuredSteps(text).length]);
    expect(Object.fromEntries(counted)).toEqual({
      "check-secrets.yml": 2,
      "ci.yml": 0,
      "daily.yml": 2,
      "force-post.yml": 3,
    });
  });

  it.each(workflows)(
    "$name hands the channel id to every step it hands a bot token",
    ({ text }) => {
      for (const step of configuredSteps(text)) {
        if (!step.env.has("DISCORD_BOT_TOKEN")) continue;
        expect(step.env, step.run).toContain("DISCORD_CHANNEL_ID");
      }
    },
  );

  it.each(workflows)("$name hands a bot token to every step that posts", ({ text }) => {
    for (const step of configuredSteps(text)) {
      // check-env only reads whether the variables are set, and --check-discord
      // reads the token to ask Discord about itself. The steps that deliver are
      // the ones that must carry both.
      if (/check-env|--check-discord/.test(step.run)) continue;
      expect(step.env, step.run).toContain("DISCORD_BOT_TOKEN");
    }
  });

  /**
   * A channel id is not a credential, so it belongs in Variables – but it is
   * easy to reach for as a secret, and reading only `vars` leaves such a value
   * silently empty. Every reference takes both.
   */
  it.each(workflows)("$name reads the channel id from either home", ({ text }) => {
    const references = text.split("\n").filter((line) => /^\s+DISCORD_CHANNEL_ID:/.test(line));

    for (const line of references) {
      expect(line, line.trim()).toMatch(/vars\.DISCORD_CHANNEL_ID \|\| secrets\.DISCORD_CHANNEL_ID/);
    }
  });

  it.each(workflows)("$name never inlines a secret value", ({ text }) => {
    // Every credential comes out of `secrets.` or `vars.`; a literal token in
    // a workflow file is a leak that review misses.
    const assignments = text
      .split("\n")
      .filter((line) => /^\s+(DISCORD_BOT_TOKEN|CURSOR_API_KEY|DATABASE_URL|X_BEARER_TOKEN):/.test(line));

    for (const line of assignments) {
      expect(line, line.trim()).toMatch(/\$\{\{\s*(secrets|vars)\./);
    }
  });
});

describe("force-post", () => {
  const forcePost = workflows.find((workflow) => workflow.name === "force-post.yml")?.text ?? "";

  it("does nothing, rather than failing, when the file holds no URL", () => {
    // Between force posts the file is all comments, and every push that
    // touches it triggers this workflow. A red run for doing what was asked
    // teaches everyone to ignore the badge.
    expect(forcePost).toContain('echo "proceed=false" >> "$GITHUB_OUTPUT"');
    expect(forcePost).toContain("exit 0");
  });

  it("guards every step after the URL is picked", () => {
    const steps = forcePost.split("\n").filter((line) => /^ {6}- (name|uses|run):/.test(line));
    const guards = forcePost.match(/if: steps\.target\.outputs\.proceed == 'true'/g) ?? [];
    // Every step but the checkout and the URL pick itself.
    expect(guards).toHaveLength(steps.length - 2);
  });
});

describe("the daily schedule", () => {
  const daily = workflows.find((workflow) => workflow.name === "daily.yml")?.text ?? "";

  it("runs at 14:00 UTC, which is 7am PT", () => {
    expect(daily).toContain('- cron: "0 14 * * *"');
  });

  it("also schedules the winter offset, and skips whichever entry is too early", () => {
    expect(daily).toContain('- cron: "0 15 * * *"');
    expect(daily).toContain("TZ=America/Los_Angeles");
  });

  it("can open an issue per action", () => {
    expect(daily).toContain("issues: write");
  });

  it("cannot post over the force-post workflow", () => {
    const forcePost = workflows.find((workflow) => workflow.name === "force-post.yml")?.text ?? "";
    expect(daily).toContain("group: competitor-happenings");
    expect(forcePost).toContain("group: competitor-happenings");
  });
});
