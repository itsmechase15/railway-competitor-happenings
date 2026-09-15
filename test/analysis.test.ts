import { describe, expect, it } from "vitest";
import { enforceActionLead } from "../src/analysis/lead.js";
import { enforceUpdatePagesTopic } from "../src/analysis/relevance.js";
import {
  extractJsonObject,
  parseAnalysis,
  UNSTATED_NO_ACTION_REASON,
} from "../src/analysis/schema.js";
import { claimsGap, verifyAgainstDocs } from "../src/analysis/verify.js";
import type { RailwayDoc } from "../src/types.js";
import { analysis, storedItem } from "./helpers.js";

const serverlessDocs: RailwayDoc[] = [
  {
    url: "https://docs.railway.com/deployments/serverless",
    title: "Serverless",
    excerpt:
      "Serverless lets Railway stop a service's container when it has no inbound traffic. The container starts again on the next request.",
  },
];

describe("reading a model reply", () => {
  it("pulls the JSON out of a fenced block", () => {
    const raw = 'Here you go:\n```json\n{"impact":"minor","summary":"x"}\n```\nHope that helps.';
    expect(extractJsonObject(raw)).toBe('{"impact":"minor","summary":"x"}');
  });

  it("accepts snake_case and camelCase for the same fields", () => {
    const snake = parseAnalysis(
      JSON.stringify({
        impact: "major",
        summary: "Render shipped object storage.",
        key_points: ["S3-compatible"],
        actions: [{ type: "consider_enhancing", railway_feature: "Storage buckets", detail: "Add X." }],
        railway_refs: [{ url: "https://docs.railway.com/storage-buckets", claim: "Buckets exist." }],
        open_questions: ["Pricing?"],
      }),
    );

    expect(snake.keyPoints).toEqual(["S3-compatible"]);
    expect(snake.actions[0]?.feature).toBe("Storage buckets");
    expect(snake.railwayRefs[0]?.url).toBe("https://docs.railway.com/storage-buckets");
    expect(snake.openQuestions).toEqual(["Pricing?"]);
  });

  it("reads a field the model sent as an empty string as absent", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render raised a limit.",
        actions: [{ type: "update_pages", detail: "On the compare page, say so.", feature: "" }],
      }),
    );
    expect(verdict.actions[0]?.feature).toBeUndefined();
  });

  it("reads an empty actions list as an answer, and keeps the reason given for it", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "minor",
        summary: "Render wrote a post about their new office.",
        actions: [],
        no_action_reason: "This ships nothing, so there is nothing for Railway to answer.",
      }),
    );

    expect(verdict.actions).toEqual([]);
    expect(verdict.noActionReason).toBe(
      "This ships nothing, so there is nothing for Railway to answer.",
    );
  });

  it("says so when a reply recommends nothing and does not say why", () => {
    const verdict = parseAnalysis(
      JSON.stringify({ impact: "minor", summary: "Render wrote a post.", actions: [] }),
    );
    expect(verdict.noActionReason).toBe(UNSTATED_NO_ACTION_REASON);
  });

  it("refuses a reply that never answered the actions field at all", () => {
    expect(() =>
      parseAnalysis(JSON.stringify({ impact: "minor", summary: "Render wrote a post." })),
    ).toThrow(/missing its actions list/);
  });

  it("keeps a product action's gap, evidence page, and quote", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "major",
        summary: "Render shipped object storage.",
        actions: [
          {
            type: "consider_building",
            detail: "Add an S3-compatible bucket product.",
            gap: "no object storage product",
            evidence_url: "https://docs.railway.com/volumes",
            evidence_quote: "Volumes attach a persistent disk to one service.",
          },
        ],
      }),
    );

    const [action] = verdict.actions;
    expect(action?.gap).toBe("no object storage product");
    expect(action?.evidenceUrl).toBe("https://docs.railway.com/volumes");
    expect(action?.evidenceQuote).toBe("Volumes attach a persistent disk to one service.");
  });

  it("leaves a quote's own punctuation alone, because it is matched character for character", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render raised a limit.",
        actions: [
          {
            type: "consider_enhancing",
            feature: "Scaling",
            detail: "Raise the ceiling on vertical scaling.",
            gap: "no plan above 32 GB",
            evidence_url: "https://docs.railway.com/deployments/scaling",
            evidence_quote: "Services scale vertically—up to 32 GB of memory.",
          },
        ],
      }),
    );

    expect(verdict.actions[0]?.evidenceQuote).toContain("—");
  });

  it("caps a reply at three actions, which is what the embed can show", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "major",
        summary: "Render shipped four things at once.",
        actions: [
          { type: "update_pages", detail: "One." },
          { type: "update_pages", detail: "Two." },
          { type: "update_pages", detail: "Three." },
          { type: "update_pages", detail: "Four." },
        ],
      }),
    );
    expect(verdict.actions).toHaveLength(3);
  });

  it("rewrites an em dash a model slipped in", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "minor",
        summary: "Render shipped plans—lots of them.",
        actions: [{ type: "update_pages", detail: "On the compare page—say so." }],
      }),
    );
    expect(verdict.summary).not.toContain("—");
    expect(verdict.actions[0]?.detail).not.toContain("—");
  });
});

/**
 * "Railway can't do X" is the one claim a reader acts on without checking, and
 * the one a compare-page snippet cannot support. The prompt asks the model to
 * check the docs; this is what happens when it does not.
 */
describe("checking a verdict against the docs", () => {
  it("spots a gap claim however it is phrased", () => {
    expect(claimsGap("Railway has no scale-to-zero billing.")).toBe(true);
    expect(claimsGap("Railway cannot stop an idle service.")).toBe(true);
    expect(claimsGap("There is no Railway equivalent.")).toBe(true);
    expect(claimsGap("Add per-request billing to Serverless.")).toBe(false);
  });

  it("retypes consider_building to consider_enhancing when a docs page covers the area", () => {
    const { analysis: verified, notes } = verifyAgainstDocs(
      analysis({
        actions: [
          {
            type: "consider_building",
            detail: "Build scale-to-zero: Railway has nothing that stops an idle service.",
          },
        ],
        railwayRefs: [],
      }),
      serverlessDocs,
    );

    expect(verified.actions[0]?.type).toBe("consider_enhancing");
    expect(verified.actions[0]?.feature).toBe("Serverless");
    expect(verified.actions[0]?.detail).toContain("Railway already ships Serverless here");
    expect(verified.railwayRefs[0]?.url).toBe("https://docs.railway.com/deployments/serverless");
    expect(notes[0]).toContain("retyped consider_building");
  });

  it("cites the docs page a gap claim should have cited", () => {
    const { analysis: verified, notes } = verifyAgainstDocs(
      analysis({
        actions: [
          {
            type: "consider_enhancing",
            feature: "Serverless",
            detail: "Add per-request billing. Railway does not bill an idle service per request.",
          },
        ],
        railwayRefs: [],
      }),
      serverlessDocs,
    );

    expect(verified.railwayRefs.map((ref) => ref.url)).toEqual([
      "https://docs.railway.com/deployments/serverless",
    ]);
    expect(notes[0]).toContain("cited");
  });

  it("turns an unverifiable gap claim into an open question rather than a ship", () => {
    const { analysis: verified, notes } = verifyAgainstDocs(
      analysis({
        actions: [
          {
            type: "consider_enhancing",
            feature: "Serverless",
            detail: "Add per-request billing. Railway cannot bill per request.",
          },
        ],
        railwayRefs: [],
        openQuestions: [],
      }),
      [],
    );

    expect(verified.openQuestions[0]).toContain("no Railway docs page in context confirmed it");
    expect(notes[0]).toContain("unverified gap claim");
  });

  it("names the surface to enhance when the model left it out", () => {
    const { analysis: verified } = verifyAgainstDocs(
      analysis({
        actions: [{ type: "consider_enhancing", detail: "Stop billing an idle serverless container." }],
        railwayRefs: [],
      }),
      serverlessDocs,
    );
    expect(verified.actions[0]?.feature).toBe("Serverless");
  });

  it("leaves a verdict that got it right untouched", () => {
    const verdict = analysis();
    const { notes } = verifyAgainstDocs(verdict, []);
    expect(notes).toEqual([]);
  });
});

/**
 * A launch is not a licence to fix the rest of the page it touches. A page
 * edit about some other capability is work nobody asked for, arriving under an
 * alert about something else.
 */
describe("keeping a page edit on this launch's topic", () => {
  const item = storedItem({
    title: "New compute plans, and new IDs for existing plans",
  });

  it("drops a page edit about a different capability entirely", () => {
    const { analysis: guarded, notes } = enforceUpdatePagesTopic(
      analysis({
        summary: "Render added memory-optimized compute plans and a 12-CPU tier.",
        actions: [
          {
            type: "update_pages",
            detail:
              "On the compare to render page, answer their claim that Railway has no HIPAA compliance.",
          },
        ],
        railwayRefs: [],
      }),
      item,
    );

    expect(guarded.actions).toHaveLength(0);
    expect(notes[0]).toContain("dropped an update_pages action");
  });

  it("says so as an open question when dropping it empties the alert", () => {
    const { analysis: guarded } = enforceUpdatePagesTopic(
      analysis({
        summary: "Render added memory-optimized compute plans and a 12-CPU tier.",
        actions: [
          { type: "update_pages", detail: "On the compare page, answer their HIPAA claim." },
        ],
        railwayRefs: [],
        openQuestions: [],
      }),
      item,
    );
    expect(guarded.openQuestions[0]).toContain("asks for no page edit");
  });

  it("keeps a page edit that is about the thing that shipped", () => {
    const { analysis: guarded, notes } = enforceUpdatePagesTopic(
      analysis({
        summary: "Render added memory-optimized compute plans and a 12-CPU tier.",
        actions: [
          {
            type: "update_pages",
            detail:
              "On the compare to render page, name the memory-optimized compute plans Render now sells.",
          },
        ],
        railwayRefs: [],
      }),
      item,
    );

    expect(guarded.actions).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("never touches a product action", () => {
    const verdict = analysis();
    expect(enforceUpdatePagesTopic(verdict, item).analysis.actions).toHaveLength(1);
  });
});

/**
 * The embed shows one sentence per action and nothing else, so that sentence
 * has to say what is being asked for. This reorders what the model wrote; it
 * never deletes it.
 */
describe("making an action open with the work", () => {
  it("leaves a sentence that already leads with the change", () => {
    const { notes } = enforceActionLead(analysis());
    expect(notes).toEqual([]);
  });

  it("puts the change in front of a sentence that only states the gap", () => {
    const { analysis: led, notes } = enforceActionLead(
      analysis({
        actions: [
          {
            type: "consider_enhancing",
            feature: "Serverless",
            detail: "Railway sleeps idle containers but still bills them per minute when awake.",
          },
        ],
      }),
    );

    expect(led.actions[0]?.detail.startsWith("Close this gap in Serverless:")).toBe(true);
    // The model's own words survive: the issue still carries the evidence.
    expect(led.actions[0]?.detail).toContain("still bills them per minute");
    expect(notes[0]).toContain("rather than the gap");
  });

  it("names the page on a page action whose sentence left it out", () => {
    const { analysis: led, notes } = enforceActionLead(
      analysis({
        actions: [{ type: "update_pages", detail: "The page is out of date." }],
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Both scale vertically.",
            suggestedEdit: "Name the memory-optimized plans Render now sells.",
          },
        ],
      }),
    );

    expect(led.actions[0]?.detail).toContain("the compare to render page");
    expect(notes[0]).toContain("which its opening sentence left out");
  });

  it("leaves a page action that already names its page", () => {
    const { notes } = enforceActionLead(
      analysis({
        actions: [
          {
            type: "update_pages",
            detail: "Say on the compare to render page that Render now sells memory-optimized plans.",
          },
        ],
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Both scale vertically.",
          },
        ],
      }),
    );
    expect(notes).toEqual([]);
  });
});
