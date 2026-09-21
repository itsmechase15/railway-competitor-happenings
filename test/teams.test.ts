import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt } from "../src/analysis/prompt.js";
import { buildIssueBody, buildIssueLabels } from "../src/github/issue.js";
import {
  findTeam,
  matchTeams,
  RAILWAY_ABOUT_URL,
  RAILWAY_TEAMS,
  teamLabel,
  teamsOwningFeature,
} from "../src/railway/teams.js";
import { MAX_TEAMS, relatedTeams, relatedTeamsLabel } from "../src/teams.js";
import { ACTIONS, type RecommendedAction } from "../src/types.js";
import { alert, analysis, featureImage, storedItem } from "./helpers.js";

const action = (overrides: Partial<RecommendedAction>): RecommendedAction => ({
  type: "consider_enhancing",
  detail: "A gap worth closing.",
  ...overrides,
});

const slugs = (value: RecommendedAction): string[] => relatedTeams(value).map((team) => team.slug);

describe("the Railway team catalog", () => {
  it("points every team at the about page, because Railway publishes no team pages", () => {
    for (const team of RAILWAY_TEAMS) {
      expect(team.url).toBe(RAILWAY_ABOUT_URL);
      expect(team.slug).toMatch(/^[a-z0-9-]+$/);
      expect(team.name.trim()).toBe(team.name);
    }
    expect(new Set(RAILWAY_TEAMS.map((team) => team.slug)).size).toBe(RAILWAY_TEAMS.length);
  });

  it("holds the twelve teams the titles on the about page add up to", () => {
    expect(RAILWAY_TEAMS.map((team) => team.slug)).toEqual([
      "infrastructure-engineering",
      "product-engineering",
      "support-engineering",
      "solutions-engineering",
      "customer-success",
      "marketing",
      "design",
      "developer-relations",
      "agentic-experience",
      "operations",
      "talent",
      "logistics",
    ]);
  });

  it("carries no emoji, because Railway publishes none to carry", () => {
    expect(teamLabel(findTeam("Marketing")!)).toBe("Marketing");
    expect(teamLabel(findTeam("Infrastructure Engineering")!)).toBe("Infrastructure Engineering");
    for (const team of RAILWAY_TEAMS) {
      expect(teamLabel(team)).toBe(team.name);
    }
  });

  it("finds a team however a model wrote its name", () => {
    for (const written of [
      "Product Engineering",
      "product engineering",
      "product-engineering",
      "the Product Engineering team",
    ]) {
      expect(findTeam(written)?.slug).toBe("product-engineering");
    }
    expect(findTeam("Customer Success")?.slug).toBe("customer-success");
  });

  it("refuses a department, and refuses the team nobody at Railway has a title for", () => {
    for (const invented of [
      "Product",
      "Engineering",
      "Platform",
      "Core Engineering",
      // The title does not appear on the about page, so neither does the team.
      "Inference Engineering",
      // On the page, and not a routing target: the work goes to the two
      // engineering teams that do it.
      "CEO",
      "Head of Engineering",
      "",
    ]) {
      expect(findTeam(invented)).toBeUndefined();
    }
  });

  it("knows which team builds a surface from the product catalog", () => {
    expect(teamsOwningFeature("CDN").map((team) => team.slug)).toContain(
      "infrastructure-engineering",
    );
    expect(teamsOwningFeature("Serverless").map((team) => team.slug)).toContain(
      "infrastructure-engineering",
    );
    expect(teamsOwningFeature("Pricing").map((team) => team.slug)).toContain("product-engineering");
    expect(teamsOwningFeature("Functions").map((team) => team.slug)).toContain(
      "product-engineering",
    );
    expect(teamsOwningFeature("MCP server").map((team) => team.slug)).toContain(
      "agentic-experience",
    );
  });

  it("names both owners of a surface two teams share", () => {
    expect(teamsOwningFeature("Templates").map((team) => team.slug)).toEqual(
      expect.arrayContaining(["product-engineering", "developer-relations"]),
    );
  });

  it("reads a team's vocabulary out of a sentence that names no surface", () => {
    expect(matchTeams("Lift and shift a proof of concept off their platform.", 1)[0]?.slug).toBe(
      "solutions-engineering",
    );
    expect(matchTeams("The support ticket volume is the tell here.", 1)[0]?.slug).toBe(
      "support-engineering",
    );
    expect(matchTeams("Rewrite the compare page positioning.", 1)[0]?.slug).toBe("marketing");
  });
});

describe("relatedTeams", () => {
  it("routes a networking or runtime action to Infrastructure Engineering", () => {
    expect(slugs(action({ feature: "CDN" }))).toContain("infrastructure-engineering");
    expect(slugs(action({ feature: "Serverless" }))).toContain("infrastructure-engineering");
    expect(slugs(action({ feature: "Databases" }))).toContain("infrastructure-engineering");
  });

  it("routes cost control to Product Engineering rather than to the network team", () => {
    const teams = slugs(
      action({
        feature: "Pricing",
        detail: "Add a hard usage limit so a project can stop spending at a number the owner sets.",
      }),
    );
    expect(teams).toContain("product-engineering");
    expect(teams[0]).toBe("product-engineering");
  });

  it("routes an agent launch to Agentic Experience", () => {
    expect(slugs(action({ feature: "MCP server" }))).toContain("agentic-experience");
    expect(
      slugs(action({ feature: "Cloud agents", detail: "Run a coding agent in a sandbox." })),
    ).toContain("agentic-experience");
  });

  it("routes page work to Marketing", () => {
    expect(
      slugs(action({ type: "update_pages", detail: "The compare page is stale on this." })),
    ).toContain("marketing");
  });

  it("takes the model's suggestion when it names a real team", () => {
    expect(
      slugs(
        action({
          teams: ["Solutions Engineering", "Marketing"],
          type: "update_pages",
          detail: "Answer their migration claim.",
        }),
      ),
    ).toEqual(["solutions-engineering", "marketing"]);
  });

  it("lets a suggestion stand alone, rather than padding it with keyword matches", () => {
    expect(
      slugs(
        action({
          teams: ["Infrastructure Engineering"],
          feature: "CDN",
          detail: "Add stale-while-revalidate to the CDN so a cached asset can serve while it refreshes.",
        }),
      ),
    ).toEqual(["infrastructure-engineering"]);
  });

  it("throws away a suggested team that is not on the about page", () => {
    const teams = slugs(
      action({ teams: ["Product", "Inference Engineering"], feature: "Serverless" }),
    );
    expect(teams).toContain("infrastructure-engineering");
    for (const invented of ["product", "inference-engineering"]) {
      expect(teams).not.toContain(invented);
    }
  });

  it("always names at least one team, and never more than three", () => {
    for (const type of ACTIONS) {
      const teams = relatedTeams(
        action({ type, detail: "A CDN change, a usage limit, and a compare page edit." }),
      );
      expect(teams.length).toBeGreaterThanOrEqual(1);
      expect(teams.length).toBeLessThanOrEqual(MAX_TEAMS);
      expect(new Set(teams).size).toBe(teams.length);
    }
  });

  it("falls back to a named team when the action's words match nothing", () => {
    expect(slugs(action({ detail: "Something nobody wrote down." }))).toEqual([
      "product-engineering",
    ]);
    expect(
      slugs(action({ type: "update_pages", detail: "Something nobody wrote down." })),
    ).toEqual(["marketing"]);
  });

  it("caps a model that suggests more teams than the issue can carry", () => {
    const teams = relatedTeams(
      action({
        teams: [
          "Infrastructure Engineering",
          "Product Engineering",
          "Marketing",
          "Design",
          "Talent",
        ],
      }),
    );
    expect(teams.map((team) => team.slug)).toEqual([
      "infrastructure-engineering",
      "product-engineering",
      "marketing",
    ]);
  });

  it("writes the teams the way an issue reads them", () => {
    expect(
      relatedTeamsLabel(action({ teams: ["Infrastructure Engineering", "Marketing"] })),
    ).toBe("Infrastructure Engineering, Marketing");
  });
});

/**
 * The model is the only reader with the whole signal in front of it, so it gets
 * the names and what each team owns, and its answer wins when the names are
 * real. A prompt that does not list them leaves every action to the fallback.
 */
describe("what the analyst is told about teams", () => {
  const prompt = buildAnalysisPrompt(storedItem());

  it("lists every team, with the surfaces it owns", () => {
    expect(prompt).toContain(`## Railway teams, from ${RAILWAY_ABOUT_URL}`);
    for (const team of RAILWAY_TEAMS) {
      expect(prompt).toContain(`- ${team.name}`);
    }
    expect(prompt).toContain("Infrastructure Engineering \u2013 owns Deployments");
  });

  it("asks for the teams field, and caps it", () => {
    expect(prompt).toContain(`"teams": ["string (1 to ${MAX_TEAMS} Railway team names`);
    expect(prompt).toContain(`"teams" is 1 to ${MAX_TEAMS} Railway teams`);
  });

  it("tells the model a department is not a team", () => {
    expect(prompt).toContain("Never invent a team, never write a department");
    expect(prompt).toContain('"Inference Engineering" are not Railway teams');
  });
});

describe("the team on an issue", () => {
  const alertFor = (recommended: RecommendedAction) =>
    alert({ analysis: analysis({ actions: [recommended] }) });

  it("labels the issue with every related team's slug", () => {
    const recommended = action({ teams: ["Infrastructure Engineering", "Marketing"] });
    const labels = buildIssueLabels(alertFor(recommended), recommended);
    expect(labels).toContain("team:infrastructure-engineering");
    expect(labels).toContain("team:marketing");
  });

  it("never labels an issue with more team slugs than the cap", () => {
    const recommended = action({
      teams: ["Infrastructure Engineering", "Product Engineering", "Marketing", "Design"],
    });
    const teamLabels = buildIssueLabels(alertFor(recommended), recommended).filter((label) =>
      label.startsWith("team:"),
    );
    expect(teamLabels).toHaveLength(MAX_TEAMS);
  });

  it("keeps the owner label as well, because a team is not a desk", () => {
    const recommended = action({ teams: ["Infrastructure Engineering"] });
    const labels = buildIssueLabels(alertFor(recommended), recommended);
    expect(labels).toContain("owner:product");
    expect(labels).toContain("team:infrastructure-engineering");
  });

  it("names the teams in the body, and says what they were read off", () => {
    const recommended = action({ feature: "CDN", teams: ["Infrastructure Engineering"] });
    const body = buildIssueBody(alertFor(recommended), featureImage(), recommended);
    expect(body).toContain("## Related team(s)\nInfrastructure Engineering");
    expect(body).toContain(`[railway.com/about](${RAILWAY_ABOUT_URL})`);
    // British en dash with a space either side, never an em dash.
    expect(body).not.toContain("\u2014");
  });
});
/**
 * Chase reads the issue top down and stops when he has the point: what
 * happened, then what to do about it. Everything that justifies the action
 * comes after both.
 */
describe("the order an issue reads in", () => {
  const cdnAction: RecommendedAction = {
    type: "consider_enhancing",
    feature: "CDN",
    detail: "Add stale-while-revalidate to the CDN.",
    gap: "no stale-while-revalidate on cached assets",
    evidenceUrl: "https://docs.railway.com/networking/cdn",
    evidenceQuote: "Railway caches static assets at the edge.",
  };

  const body = (): string =>
    buildIssueBody(
      alert({ item: storedItem(), analysis: analysis({ actions: [cdnAction] }) }),
      featureImage(),
      cdnAction,
    );

  const headingOrder = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3));

  it("leads with what you need to know, then the action, then the teams", () => {
    expect(headingOrder(body()).slice(0, 3)).toEqual([
      "What you need to know",
      "Recommended action",
      "Related team(s)",
    ]);
  });

  it("keeps the metadata line and the image above all of it", () => {
    const text = body();
    expect(text.indexOf("published 2026-08-26")).toBeLessThan(
      text.indexOf("## What you need to know"),
    );
    expect(text.indexOf("<img src=")).toBeLessThan(text.indexOf("## What you need to know"));
  });

  it("puts the evidence, the impact, and the detail after the action", () => {
    const headings = headingOrder(body());
    expect(headings).toEqual([
      "What you need to know",
      "Recommended action",
      "Related team(s)",
      "The gap this closes",
      "Impact",
      "More detail",
      "Railway docs this was checked against",
      "Open questions",
      "Sources",
    ]);
  });
});
