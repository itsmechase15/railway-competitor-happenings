import { describe, expect, it } from "vitest";
import { enforceActionLead } from "../src/analysis/lead.js";
import { enforceUpdatePagesTopic } from "../src/analysis/relevance.js";
import { UNSTATED_NO_ACTION_REASON } from "../src/analysis/noAction.js";
import { buildAnalysisPrompt } from "../src/analysis/prompt.js";
import { MIN_ADDED_WORDS } from "../src/analysis/proportion.js";
import {
  extractJsonObject,
  parseAnalysis,
  parseStoredAlert,
  serializeAlertPayload,
} from "../src/analysis/schema.js";
import { claimsGap, verifyAgainstDocs } from "../src/analysis/verify.js";
import type { RailwayDoc, RecommendedAction } from "../src/types.js";
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
        open_questions: ["What does a bucket cost?"],
      }),
    );

    expect(snake.keyPoints).toEqual(["S3-compatible"]);
    expect(snake.actions[0]?.feature).toBe("Storage buckets");
    expect(snake.railwayRefs[0]?.url).toBe("https://docs.railway.com/storage-buckets");
    expect(snake.openQuestions).toEqual(["What does a bucket cost?"]);
  });

  it("keeps the teams a model named for an action, in its own words", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render shipped stale-while-revalidate.",
        actions: [
          {
            type: "consider_enhancing",
            feature: "CDN",
            detail: "Add stale-while-revalidate to the CDN.",
            // The catalog decides which of these is a real team, not the parser.
            railway_teams: ["Infrastructure Engineering", " Marketing ", "", "Inference Engineering"],
          },
        ],
      }),
    );
    expect(verdict.actions[0]?.teams).toEqual([
      "Infrastructure Engineering",
      "Marketing",
      "Inference Engineering",
    ]);
  });

  it("leaves teams off an action the model routed nowhere", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render raised a limit.",
        actions: [{ type: "update_pages", detail: "On the compare page, say so.", teams: [] }],
      }),
    );
    expect(verdict.actions[0]?.teams).toBeUndefined();
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
    // A bare sentence is a verdict nobody confirmed, whatever it asserts.
    expect(verdict.noAction?.kind).toBe("unverified");
  });

  it("reads a structured verdict as written, with the pages under it", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render raised the memory ceiling on its existing compute plans.",
        actions: [],
        no_action: {
          kind: "already_covered",
          reason: "Railway already offers memory-heavy plan shapes on every tier.",
          evidence: [
            {
              url: "https://docs.railway.com/deployments/scaling",
              quote: "Railway scales a service vertically and horizontally.",
            },
          ],
        },
      }),
    );

    expect(verdict.noAction).toEqual({
      kind: "already_covered",
      reason: "Railway already offers memory-heavy plan shapes on every tier.",
      evidence: [
        {
          url: "https://docs.railway.com/deployments/scaling",
          quote: "Railway scales a service vertically and horizontally.",
        },
      ],
    });
    expect(verdict.noActionReason).toBe(verdict.noAction?.reason);
  });

  /**
   * The verdict is stored on the analysis row, so a retry that replays it
   * renders the same title and the same pages rather than falling back to a
   * bare sentence.
   */
  it("reads a verdict back off a stored row unchanged", () => {
    const verdict = parseStoredAlert(
      serializeAlertPayload(
        {
          impact: "notable",
          summary: "Render raised the memory ceiling on its existing compute plans.",
          keyPoints: [],
          actions: [],
          noAction: {
            kind: "already_covered",
            reason: "Railway already offers memory-heavy plan shapes on every tier.",
            evidence: [{ url: "https://docs.railway.com/deployments/scaling", title: "Scaling" }],
          },
          noActionReason: "Railway already offers memory-heavy plan shapes on every tier.",
          railwayRefs: [],
          openQuestions: [],
        },
        null,
        [],
      ),
    );

    expect(verdict.analysis.noAction).toEqual({
      kind: "already_covered",
      reason: "Railway already offers memory-heavy plan shapes on every tier.",
      evidence: [{ url: "https://docs.railway.com/deployments/scaling", title: "Scaling" }],
    });
  });

  it("keeps the sentence but not the title when a model invents a kind", () => {
    const verdict = parseAnalysis(
      JSON.stringify({
        impact: "minor",
        summary: "Render wrote a post.",
        actions: [],
        no_action: { kind: "railway_is_fine", reason: "Railway ships this already." },
      }),
    );

    expect(verdict.noAction?.kind).toBe("unverified");
    expect(verdict.noAction?.reason).toBe("Railway ships this already.");
  });

  it("says which part is missing when a reply recommends nothing and offers no verdict", () => {
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
 * A page that could carry more about a competitor is not a page that should,
 * and the analyst is the only reader with the page and the launch both in
 * front of it. So the rule it writes under says the size the gate measures.
 */
describe("what the analyst is told about the size of a page edit", () => {
  const prompt = buildAnalysisPrompt(storedItem());

  it("asks for the shortest edit that makes the page correct, and says so as a judgment", () => {
    expect(prompt).toContain("A page that could carry more is not a page that should");
    expect(prompt).toContain("ask what the shortest edit is that makes the page correct");
    expect(prompt).toContain("either the shorter version or no page action is the right answer");
  });

  it("states the sizes the copy is measured against, which is what code enforces", () => {
    expect(prompt).toContain("How much the edit may add");
    expect(prompt).toContain(
      "The copy may add at most as many words as the passage it lands in already runs to, and never more than a fifth of the whole page",
    );
    expect(prompt).toContain(`${MIN_ADDED_WORDS} words of new copy always fit`);
    expect(prompt).toContain("drops the action when the copy is over");
  });

  it("says a long rewrite means writing a shorter one or nothing at all", () => {
    expect(prompt).toContain("A long rewrite is the signal to write a shorter one");
    expect(prompt).toContain("the honest answer is no update_pages action at all");
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

  it("says which kind of nothing it is when dropping it empties the alert", () => {
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
    expect(guarded.noAction?.kind).toBe("not_a_gap");
    expect(guarded.noAction?.reason).toContain("No Railway page in context is wrong");
    expect(guarded.noActionReason).toBe(guarded.noAction?.reason);
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

/**
 * The stored verdict is what stops a retry reviewing an action twice, so it has
 * to survive the round trip through the analysis row.
 */
describe("the review stored on an analysis row", () => {
  const payload = (issues: unknown) => ({
    impact: "notable",
    summary: "Render now bills an idle web service per request.",
    actions: [
      { type: "update_pages", detail: "On the compare to render page, name the new meter." },
    ],
    railway_refs: [],
    issues,
  });

  it("reads back the review each action got", () => {
    const stored = parseStoredAlert(
      payload([
        {
          type: "update_pages",
          issue: { url: "https://github.com/o/r/issues/3", number: 3 },
          review: {
            verdict: "revise",
            model: "claude-fable-5-1",
            at: "2026-09-02T09:00:00.000Z",
            reason: "The copy it proposes is a note about the page.",
            applied: false,
          },
        },
      ]),
    );

    expect(stored.issues[0]?.review).toEqual({
      verdict: "revise",
      model: "claude-fable-5-1",
      at: new Date("2026-09-02T09:00:00.000Z"),
      reason: "The copy it proposes is a note about the page.",
      applied: false,
    });
  });

  it("reads an action nobody reviewed as one a later run may review", () => {
    const stored = parseStoredAlert(payload([{ type: "update_pages", issue: null }]));
    // Absent, not null.
    expect(stored.issues[0]?.review).toBeUndefined();
  });

  it("reads a review the in-memory store never serialized to JSON", () => {
    const at = new Date("2026-09-02T09:00:00.000Z");
    const stored = parseStoredAlert(
      payload([
        { type: "update_pages", issue: null, review: { verdict: "agree", model: "m", at, reason: "r" } },
      ]),
    );
    expect(stored.issues[0]?.review?.at).toEqual(at);
  });

  it("refuses a stored verdict that is not one of the three", () => {
    expect(() =>
      parseStoredAlert(
        payload([
          {
            type: "update_pages",
            review: { verdict: "maybe", model: "m", at: "2026-09-02T09:00:00.000Z", reason: "r" },
          },
        ]),
      ),
    ).toThrow();
  });

  it("writes the verdict back out, so the next attempt to post finds it", () => {
    const verdict = {
      verdict: "agree" as const,
      model: "claude-fable-5-1",
      at: new Date("2026-09-02T09:00:00.000Z"),
      reason: "It stands.",
    };
    const verdicts = analysis();
    const [action] = verdicts.actions as [RecommendedAction];
    const written = serializeAlertPayload(verdicts, null, [
      { action, issue: null, review: verdict },
    ]);
    const round = parseStoredAlert(written);
    expect(round.issues[0]?.review).toEqual(verdict);
  });
});
