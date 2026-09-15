import { describe, expect, it } from "vitest";
import {
  checkEnv,
  formatReport,
  isDirectSupabaseHost,
  isFailing,
  REQUIREMENTS,
} from "../src/setup/requirements.js";

const ready = {
  DATABASE_URL: "postgresql://user:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  DISCORD_BOT_TOKEN: "token",
  DISCORD_CHANNEL_ID: "123456789012345678",
  CURSOR_API_KEY: "key",
  X_BEARER_TOKEN: "bearer",
  GITHUB_TOKEN: "gh",
};

/**
 * The preflight exists so a missing secret fails in the first ten seconds,
 * naming the variable and where its value comes from, instead of surfacing
 * twenty minutes later as a Postgres timeout or a silent channel.
 */
describe("the environment preflight", () => {
  it("passes when everything is set", () => {
    const report = checkEnv(ready);
    expect(report.missingRequired).toEqual([]);
    expect(report.missingSources).toEqual([]);
    expect(isFailing(report)).toBe(false);
  });

  it("fails loud when DATABASE_URL is unset, which is where this repo is today", () => {
    const report = checkEnv({ ...ready, DATABASE_URL: undefined });
    expect(report.missingRequired.map((requirement) => requirement.name)).toEqual(["DATABASE_URL"]);
    expect(isFailing(report)).toBe(true);
    // And it says where the value comes from, not just that it is missing.
    expect(formatReport(report, false)).toContain("Session pooler");
  });

  it("fails when the Discord bot token or channel id is missing", () => {
    expect(
      checkEnv({ ...ready, DISCORD_BOT_TOKEN: undefined }).missingRequired.map((r) => r.name),
    ).toEqual(["DISCORD_BOT_TOKEN"]);
    expect(
      checkEnv({ ...ready, DISCORD_CHANNEL_ID: undefined }).missingRequired.map((r) => r.name),
    ).toEqual(["DISCORD_CHANNEL_ID"]);
  });

  it("fails when the Cursor key is missing, but says the run would still post", () => {
    const report = checkEnv({ ...ready, CURSOR_API_KEY: undefined });
    expect(report.missingRequired.map((requirement) => requirement.name)).toEqual([
      "CURSOR_API_KEY",
    ]);
    expect(formatReport(report, false)).toContain("restating the source");
  });

  /**
   * The plan has X optional from phase 1 on. A repo that never gets a bearer
   * token still posts both blogs and Render's changelog every morning, so a red
   * preflight over it would be telling an operator to fix a working repo.
   */
  it("never fails over a missing X token, --strict included", () => {
    const report = checkEnv({ ...ready, X_BEARER_TOKEN: undefined });
    expect(report.missingRequired).toEqual([]);
    expect(report.missingSources.map((requirement) => requirement.name)).toEqual([
      "X_BEARER_TOKEN",
    ]);
    expect(isFailing(report)).toBe(false);
    // And it still says what that costs, in both modes.
    expect(formatReport(report, false)).toContain("the X source is skipped");
    expect(formatReport(report, true)).toContain("the X source is skipped");
  });

  it("requires exactly the four the plan calls phase 1", () => {
    const required = REQUIREMENTS.filter((requirement) => requirement.need === "required").map(
      (requirement) => requirement.name,
    );
    expect(required.sort()).toEqual([
      "CURSOR_API_KEY",
      "DATABASE_URL",
      "DISCORD_BOT_TOKEN",
      "DISCORD_CHANNEL_ID",
    ]);
    expect(required).not.toContain("X_BEARER_TOKEN");
  });

  it("lists every variable under --strict, so an unset optional is visible", () => {
    const text = formatReport(checkEnv({ DATABASE_URL: ready.DATABASE_URL }), true);
    for (const requirement of REQUIREMENTS) expect(text).toContain(requirement.name);
    expect(text).toContain("Every variable this app reads");
  });

  it("takes GH_TOKEN for GITHUB_TOKEN, which is what a laptop has", () => {
    const report = checkEnv({ ...ready, GITHUB_TOKEN: undefined, GH_TOKEN: "gh" });
    expect(report.present).toContain("GITHUB_TOKEN");
    expect(report.warnings.join(" ")).not.toContain("issue creation is skipped");
  });

  it("excuses the database and the channel id on a dry run, which posts nothing", () => {
    const report = checkEnv({
      ...ready,
      DATABASE_URL: undefined,
      DISCORD_CHANNEL_ID: undefined,
      DRY_RUN: "true",
    });
    expect(report.missingRequired).toEqual([]);
    expect(report.warnings.join(" ")).toContain("in-memory store");
  });

  it("does not ask for a channel id when there is no bot token to use it", () => {
    const report = checkEnv({
      ...ready,
      DISCORD_BOT_TOKEN: undefined,
      DISCORD_CHANNEL_ID: undefined,
    });
    expect(report.missingRequired.map((requirement) => requirement.name)).toEqual([
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("reads whitespace as unset, because a blank Actions secret is not a value", () => {
    expect(checkEnv({ ...ready, CURSOR_API_KEY: "   " }).missingRequired).toHaveLength(1);
  });

  it("warns about a Supabase direct host, which has no IPv4 route from Actions", () => {
    expect(isDirectSupabaseHost("postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres")).toBe(
      true,
    );
    expect(
      isDirectSupabaseHost("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres"),
    ).toBe(false);

    const report = checkEnv({
      ...ready,
      DATABASE_URL: "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres",
    });
    expect(report.warnings.join(" ")).toContain("Session pooler");
  });

  it("warns when nothing can open an issue", () => {
    const report = checkEnv({ ...ready, GITHUB_TOKEN: undefined });
    expect(report.warnings.join(" ")).toContain("issue creation is skipped");
  });

  it("names Discord, never Slack: this bot has one delivery path", () => {
    const names = REQUIREMENTS.map((requirement) => requirement.name);
    expect(names).toContain("DISCORD_BOT_TOKEN");
    expect(names).toContain("DISCORD_CHANNEL_ID");
    expect(names.filter((name) => name.includes("SLACK"))).toEqual([]);
  });

  it("tells every variable where its value comes from and where it goes", () => {
    for (const requirement of REQUIREMENTS) {
      expect(requirement.purpose, requirement.name).not.toBe("");
      expect(requirement.howToGet, requirement.name).not.toBe("");
    }
  });
});
