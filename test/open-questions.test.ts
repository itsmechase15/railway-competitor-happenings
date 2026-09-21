import { describe, expect, it } from "vitest";
import { gateActions, type CoverageContext } from "../src/analysis/evidence.js";
import { heuristicAnalysis } from "../src/analysis/fallback.js";
import { asQuestion, isQuestion, toOpenQuestions } from "../src/analysis/questions.js";
import { parseAnalysis } from "../src/analysis/schema.js";
import { verifyAgainstDocs } from "../src/analysis/verify.js";
import { buildIssueBody } from "../src/github/issue.js";
import type { Analysis, RecommendedAction } from "../src/types.js";
import { alert, analysis, corpusIndex, featureImage, storedItem } from "./helpers.js";

/**
 * "Open questions" is a heading that promises questions. What used to land
 * under it was as often a note with the asking taken out of it – "Whether the
 * new tier is on every plan" – which reads as a fragment somebody meant to
 * finish. Code holds the shape and never the substance: it repairs the forms
 * that are a question with a word missing, and drops what it would have to
 * write.
 */
describe("what counts as a question", () => {
  it("takes a question that opens and ends like one", () => {
    expect(isQuestion("Is per-request billing on every Render plan?")).toBe(true);
    expect(asQuestion("Is per-request billing on every Render plan?")).toBe(
      "Is per-request billing on every Render plan?",
    );
  });

  it("takes a line that states a fact and then asks about it", () => {
    const line =
      "The post names no region: which regions get per-request billing first?";
    expect(isQuestion(line)).toBe(true);
    expect(asQuestion(line)).toBe(line);
  });

  it("refuses a statement, however much it sounds like an unknown", () => {
    expect(isQuestion("Whether the new tier is on every plan.")).toBe(false);
    expect(isQuestion("Railway may already meter requests somewhere.")).toBe(false);
  });

  it("refuses a question mark bolted onto a statement", () => {
    expect(isQuestion("Whether the new tier is on every plan?")).toBe(false);
  });
});

describe("repairing a question that lost its asking", () => {
  it("gives a whether clause the stem it is missing", () => {
    expect(asQuestion("Whether the new tier is on every Render plan.")).toBe(
      "Do we know whether the new tier is on every Render plan?",
    );
    expect(asQuestion("If Railway meters requests anywhere today")).toBe(
      "Do we know if Railway meters requests anywhere today?",
    );
  });

  it("drops the hedge a model puts in front of the clause", () => {
    expect(asQuestion("Unclear whether this is on the free plan.")).toBe(
      "Do we know whether this is on the free plan?",
    );
    expect(asQuestion("No word on whether Vercel charges for it.")).toBe(
      "Do we know whether Vercel charges for it?",
    );
  });

  it("adds the question mark to a line that was already asking", () => {
    expect(asQuestion("Does Railway bill a sleeping container by the minute")).toBe(
      "Does Railway bill a sleeping container by the minute?",
    );
  });

  /** The context a model went and found is the half of the line worth reading. */
  it("rewrites the asking end and leaves the context in front of it alone", () => {
    expect(
      asQuestion("The post names no plan: whether Enterprise is required for it."),
    ).toBe("The post names no plan: do we know whether Enterprise is required for it?");
    expect(
      asQuestion("Render published no pricing. Whether the meter is per request."),
    ).toBe("Render published no pricing. Do we know whether the meter is per request?");
  });

  /**
   * Turning "Railway may already meter requests" into a question means
   * deciding what is being asked, and the answer to that is not in the line.
   * A question this invented would be one nobody wrote.
   */
  it("drops a statement rather than inventing the question behind it", () => {
    expect(asQuestion("Railway may already meter requests somewhere.")).toBeNull();
    expect(asQuestion("")).toBeNull();
  });

  it("keeps the order and drops a repeat", () => {
    expect(
      toOpenQuestions([
        "Whether the new tier is on every plan.",
        "Railway may already do this.",
        "Do we know whether the new tier is on every plan?",
      ]),
    ).toEqual(["Do we know whether the new tier is on every plan?"]);
  });
});

describe("what a model writes under open_questions", () => {
  const parsed = (questions: string[]): Analysis =>
    parseAnalysis(
      JSON.stringify({
        impact: "notable",
        summary: "Render added per-request billing to web services.",
        actions: [],
        no_action: { kind: "not_a_gap", reason: "This is pricing, not a capability." },
        open_questions: questions,
      }),
    );

  it("is repaired on the way in, so nothing downstream has to", () => {
    expect(parsed(["Whether this is on every Render plan."]).openQuestions).toEqual([
      "Do we know whether this is on every Render plan?",
    ]);
  });

  it("loses the line that asks nothing", () => {
    expect(
      parsed([
        "Whether this is on every Render plan.",
        "Railway probably has something like this.",
      ]).openQuestions,
    ).toEqual(["Do we know whether this is on every Render plan?"]);
  });
});

/**
 * Every open question this bot writes itself is written as a question at the
 * source, rather than repaired after the fact: the gate, the docs check, and
 * the run with no model all file lines that a reader can answer.
 */
describe("the open questions the code writes", () => {
  const SERVERLESS = "https://docs.railway.com/deployments/serverless";
  const COMPARE = "https://docs.railway.com/platform/compare-to-render";

  function context(): CoverageContext {
    return {
      index: corpusIndex([
        {
          url: SERVERLESS,
          title: "Serverless",
          text: "Serverless stops a container when it has no inbound traffic.",
        },
        {
          url: COMPARE,
          title: "Compare to Render",
          kind: "marketing",
          text: "Railway and Render both deploy from a repository. Railway stops an idle container; Render keeps it running.",
        },
      ]),
      seenUrls: new Set([SERVERLESS]),
    };
  }

  const kept: RecommendedAction = {
    type: "update_pages",
    detail: "On the compare to render page, say Render now bills a web service per request.",
  };

  const dropped: RecommendedAction = {
    type: "consider_building",
    detail: "Build a request meter so an idle service costs nothing.",
    gap: "no per-request billing anywhere in Railway",
    evidenceUrl: "https://docs.railway.com/invented-page",
    evidenceQuote: "Railway bills a container by the minute while it is awake.",
  };

  it("asks whether a dropped action holds, rather than filing the reason as a note", () => {
    const { analysis: gated } = gateActions(
      analysis({
        actions: [kept, dropped],
        railwayRefs: [
          {
            url: COMPARE,
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
            proposedText:
              "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.",
          },
        ],
        openQuestions: [],
      }),
      context(),
    );

    const [question] = gated.openQuestions;
    expect(question).toContain("was dropped because");
    expect(question).toContain("not a page in Railway's docs corpus");
    expect(isQuestion(question ?? "")).toBe(true);
  });

  it("asks what the docs say when nothing confirmed a gap claim", () => {
    const { analysis: checked } = verifyAgainstDocs(
      analysis({
        actions: [
          {
            type: "consider_building",
            feature: "Serverless",
            detail: "Railway does not meter requests at all, so build a request meter.",
          },
        ],
        openQuestions: [],
      }),
      [],
    );

    expect(checked.openQuestions).toHaveLength(1);
    expect(isQuestion(checked.openQuestions[0] ?? "")).toBe(true);
  });

  it("asks rather than tells when no model analyzed the launch", () => {
    const verdict = heuristicAnalysis(storedItem(), [], [
      {
        url: "https://docs.railway.com/deployments/scaling",
        title: "Scaling",
        excerpt: "Railway scales services vertically and horizontally.",
      },
    ]);

    expect(verdict.openQuestions.length).toBeGreaterThan(0);
    for (const question of verdict.openQuestions) expect(isQuestion(question)).toBe(true);
    // Repairing them would be a no-op, which is the point: they are written
    // as questions rather than fixed into them.
    expect(toOpenQuestions(verdict.openQuestions)).toEqual(verdict.openQuestions);
  });
});

describe("the open questions on an issue", () => {
  function questions(openQuestions: string[]): string[] {
    const verdict = analysis({ openQuestions });
    const body = buildIssueBody(
      alert({ analysis: verdict }),
      featureImage(),
      verdict.actions[0]!,
    );
    const section = body.split("## Open questions\n")[1]?.split("\n\n")[0] ?? "";
    return section.split("\n").map((line) => line.replace(/^- /, ""));
  }

  it("renders every line as a question, whatever reached it", () => {
    for (const line of questions([
      "Whether Render meters requests on the free plan.",
      "Does this change what Railway charges for a sleeping service",
    ])) {
      expect(isQuestion(line)).toBe(true);
    }
  });

  it("says none were raised rather than leaving the heading bare", () => {
    expect(questions([])).toEqual(["_None raised._"]);
  });
});
