import { describe, expect, it } from "vitest";
import { heuristicAnalysis, heuristicImpact } from "../src/analysis/fallback.js";
import { analysisSchema, normalizeAnalysis } from "../src/analysis/schema.js";
import { buildIssueBody } from "../src/github/issue.js";
import { IMPACTS } from "../src/types.js";
import { alert, analysis, featureImage, storedItem } from "./helpers.js";

/**
 * Impact answers exactly one question: what did the post ship? A brand-new
 * feature is major, an enhancement of an existing one is notable, and a post
 * with neither is minor. Nothing else moves it – not how strategic the launch
 * feels, and not whether Railway has a gap.
 */
describe("the impact scale", () => {
  it("has three levels, weakest first", () => {
    expect(IMPACTS).toEqual(["minor", "notable", "major"]);
  });

  it("refuses a level outside the scale", () => {
    expect(() => normalizeAnalysis(analysisSchema.parse({ impact: "critical", summary: "x" }))).toThrow();
  });

  it("refuses a verdict with no impact at all", () => {
    expect(() =>
      normalizeAnalysis(
        analysisSchema.parse({
          summary: "Render shipped something.",
          actions: [{ type: "update_pages", detail: "Say so on the compare page." }],
        }),
      ),
    ).toThrow(/missing impact/);
  });
});

describe("the heuristic that runs without a model", () => {
  it("rates a brand-new feature major", () => {
    expect(heuristicImpact("Introducing Render Workflows, a new way to run durable tasks")).toBe(
      "major",
    );
    expect(heuristicImpact("Announcing the Render MCP server")).toBe("major");
  });

  it("rates an enhancement of something they already had notable", () => {
    expect(heuristicImpact("You can now pick a memory-optimized compute plan")).toBe("notable");
    expect(heuristicImpact("Reduced median service build time by 40%")).toBe("notable");
  });

  it("rates a post that ships nothing minor", () => {
    expect(heuristicImpact("A hidden DNS dependency in Kubernetes")).toBe("minor");
    expect(heuristicImpact("Built on Render winners: MIT Weblab")).toBe("minor");
  });

  it("lets a new-feature word beat an enhancement word in the same post", () => {
    // A launch wrapped in recap copy is still a launch.
    expect(heuristicImpact("Introducing storage buckets, and faster builds while we are here")).toBe(
      "major",
    );
  });

  it("never invents a Railway product fact: its only action is a page check", () => {
    const verdict = heuristicAnalysis(storedItem(), [], []);
    expect(verdict.actions).toHaveLength(1);
    expect(verdict.actions[0]?.type).toBe("update_pages");
    expect(verdict.actions[0]?.detail).toContain("No model analysis ran");
  });

  it("sends the reader to this competitor's own compare page, not the other one", () => {
    const vercel = heuristicAnalysis(storedItem({ competitor: "vercel" }), [], []);
    expect(vercel.actions[0]?.detail).toContain(
      "https://docs.railway.com/platform/compare-to-vercel",
    );
    expect(vercel.actions[0]?.detail).not.toContain("compare-to-render");
  });

  it("prefers a page we have actually indexed a claim from", () => {
    const verdict = heuristicAnalysis(storedItem(), [
      {
        url: "https://docs.railway.com/platform/migrate-from-render",
        competitor: "render",
        paragraph: "Moving a Render service to Railway takes a Dockerfile and a volume.",
        heading: "Services",
      },
    ]);
    expect(verdict.actions[0]?.detail).toContain(
      "https://docs.railway.com/platform/migrate-from-render",
    );
  });
});

describe("the whole scale on an issue", () => {
  it("checks the level this alert is, and only that one", () => {
    const body = buildIssueBody(
      alert({ analysis: analysis({ impact: "notable" }) }),
      featureImage(),
      analysis().actions[0]!,
    );
    expect(body).toContain("- [ ] Minor");
    expect(body).toContain("- [x] Notable");
    expect(body).toContain("- [ ] Major");
  });

  it("says what each level means next to it", () => {
    const body = buildIssueBody(alert(), featureImage(), analysis().actions[0]!);
    expect(body).toContain("brand-new feature that did not exist before");
  });
});
