import { describe, expect, it } from "vitest";
import { readPathFrom, READ_ONLY_TOOLS } from "../src/analysis/analyst.js";
import { checkAnalysis, type RunContext } from "../src/analysis/analyze.js";
import type { AnalyzerOutput } from "../src/analysis/analyzer.js";
import { parseAnalysis } from "../src/analysis/schema.js";
import { buildIssueDrafts } from "../src/github/issue.js";
import type { RailwayDoc } from "../src/types.js";
import { corpusIndex, storedItem } from "./helpers.js";

/**
 * What the analyst may do, and what we know about what it did.
 *
 * The coverage gate is only as honest as this: it blocks a claim whose pages
 * were never read, so "read" has to mean a file that was opened, recorded from
 * the run's own tool calls rather than from the reply's account of itself.
 */
describe("watching what the analyst reads", () => {
  it("gives it search and nothing that could change the evidence", () => {
    expect([...READ_ONLY_TOOLS]).toEqual(["read", "grep", "glob", "ls"]);
    expect(READ_ONLY_TOOLS).not.toContain("edit");
    expect(READ_ONLY_TOOLS).not.toContain("shell");
  });

  it("records the file a read opened", () => {
    expect(
      readPathFrom({
        type: "toolCall",
        message: { type: "read", args: { path: "pages/deployments/serverless.md" } },
      }),
    ).toBe("pages/deployments/serverless.md");
  });

  /** Knowing a page exists is not knowing what it says. */
  it("does not count a grep or a directory listing as having read a page", () => {
    expect(
      readPathFrom({ type: "toolCall", message: { type: "grep", args: { pattern: "consent" } } }),
    ).toBeNull();
    expect(
      readPathFrom({ type: "toolCall", message: { type: "ls", args: { path: "pages" } } }),
    ).toBeNull();
  });

  it("shrugs off a step shape it does not recognize", () => {
    expect(readPathFrom({ type: "assistantMessage", message: { text: "hello" } })).toBeNull();
    expect(readPathFrom(null)).toBeNull();
    expect(readPathFrom({ type: "toolCall", message: { type: "read", args: {} } })).toBeNull();
  });
});

const SERVERLESS_TEXT =
  "Serverless stops a service's container when it has no inbound traffic. The container starts again on the next request. Railway bills a container by the minute while it is awake.";

const PRIVACY_TEXT =
  "Railway records a consent decision for every workspace and honors a do-not-track header. Turn analytics consent off in the workspace privacy settings.";

function context(): RunContext {
  return {
    index: corpusIndex([
      {
        url: "https://docs.railway.com/deployments/serverless",
        title: "Serverless",
        text: SERVERLESS_TEXT,
      },
      {
        url: "https://docs.railway.com/enterprise/privacy",
        title: "Privacy and consent",
        text: PRIVACY_TEXT,
      },
      {
        url: "https://docs.railway.com/volumes",
        title: "Volumes",
        text: "A volume attaches a persistent disk to exactly one service.",
      },
      {
        url: "https://docs.railway.com/platform/compare-to-render",
        title: "Compare to Render",
        kind: "marketing",
        text: "Railway and Render both deploy from a repository. Railway stops an idle container; Render keeps it running.",
      },
    ]),
    workspace: null,
  };
}

const serverlessDoc: RailwayDoc = {
  url: "https://docs.railway.com/deployments/serverless",
  title: "Serverless",
  excerpt: SERVERLESS_TEXT,
  kind: "docs",
};

function reply(json: unknown, readUrls: string[] = []): AnalyzerOutput {
  return { analysis: parseAnalysis(JSON.stringify(json)), readUrls };
}

function run(output: AnalyzerOutput, docs: RailwayDoc[] = [serverlessDoc]) {
  const notes: string[] = [];
  const analysis = checkAnalysis(
    output,
    docs,
    storedItem({
      title: "Per-request billing for idle services",
      raw: { body: "Render now bills an idle service per request instead of per minute." },
    }),
    context(),
    (note) => notes.push(note),
  );
  return { analysis, notes };
}

/**
 * The whole chain on a hand-written reply: the docs pass, the page guards, the
 * evidence gate, and the sentence shaping. These are the cases the design was
 * argued over, so they are the ones pinned here – an issue is only ever opened
 * for an action that came out the far end.
 */
describe("one reply, end to end", () => {
  it("files an action that names its gap, cites a docs page, and quotes it", () => {
    const { analysis } = run(
      reply(
        {
          impact: "notable",
          summary: "Render now bills an idle service per request rather than per minute.",
          key_points: ["Per-request billing on existing plans"],
          actions: [
            {
              type: "consider_enhancing",
              feature: "Serverless",
              detail:
                "Add per-request billing to Serverless so a sleeping service costs nothing while it is asleep.",
              gap: "Railway bills a container by the minute while it is awake, with no per-request option",
              evidence_url: "https://docs.railway.com/deployments/serverless",
              evidence_quote: "Railway bills a container by the minute while it is awake.",
            },
          ],
          railway_refs: [],
        },
        ["https://docs.railway.com/deployments/serverless"],
      ),
    );

    expect(analysis.actions).toHaveLength(1);
    expect(analysis.actions[0]?.type).toBe("consider_enhancing");
    expect(buildIssueDrafts({ item: storedItem(), analysis, model: "test" }, null)).toHaveLength(1);
  });

  /**
   * A page edit ends as copy somebody pastes. The reply writes the line, the
   * gate keeps it because it is a line rather than a note about one, and the
   * issue carries it in a block nobody has to retype.
   */
  it("carries a page edit's exact copy through to the issue", () => {
    const proposed =
      "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.";
    const { analysis } = run(
      reply({
        impact: "notable",
        summary: "Render now bills an idle service per request rather than per minute.",
        actions: [
          {
            type: "update_pages",
            detail:
              "On the compare to render page, replace the idle-container line with what Render now charges for an idle service.",
          },
        ],
        railway_refs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggested_edit: "Name the per-request billing Render now offers.",
            proposed_text: proposed,
            edit_kind: "replace",
          },
        ],
      }),
    );

    expect(analysis.actions).toHaveLength(1);
    const [draft] = buildIssueDrafts({ item: storedItem(), analysis, model: "test" }, null);
    expect(draft?.draft.body).toContain("Replace the copy above with this, word for word:");
    expect(draft?.draft.body).toContain(proposed);
  });

  it("opens no issue for a page edit that only says what to write", () => {
    const { analysis, notes } = run(
      reply({
        impact: "notable",
        summary: "Render now bills an idle service per request rather than per minute.",
        actions: [
          {
            type: "update_pages",
            detail:
              "On the compare to render page, mention that Render now bills an idle service per request rather than per minute.",
          },
        ],
        railway_refs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggested_edit: "Name the per-request billing Render now offers.",
          },
        ],
      }),
    );

    expect(analysis.actions).toEqual([]);
    expect(notes.some((note) => note.includes("never writes the copy"))).toBe(true);
    expect(buildIssueDrafts({ item: storedItem(), analysis, model: "test" }, null)).toHaveLength(0);
  });

  /**
   * The regression this design exists for. The claim is well argued, the page
   * it cites is real, and the quote is on it – and the docs answer the gap on
   * a page the analysis never opened. No issue is filed for it.
   */
  it("opens no issue for a gap the docs answer on a page nobody read", () => {
    const { analysis, notes } = run(
      reply({
        impact: "major",
        summary: "Render shipped per-user analytics consent controls.",
        actions: [
          {
            type: "consider_building",
            detail: "Build a consent decision per user so analytics can be turned off.",
            gap: "Railway records no analytics consent decision and honors no do-not-track header",
            evidence_url: "https://docs.railway.com/volumes",
            evidence_quote: "A volume attaches a persistent disk to exactly one service.",
          },
        ],
        railway_refs: [],
      }),
    );

    expect(analysis.actions).toEqual([]);
    expect(analysis.noActionReason).toBeDefined();
    expect(analysis.openQuestions.join(" ")).toContain(
      "https://docs.railway.com/enterprise/privacy",
    );
    expect(notes.some((note) => note.includes("blocked a consider_building"))).toBe(true);
    expect(buildIssueDrafts({ item: storedItem(), analysis, model: "test" }, null)).toHaveLength(0);
  });

  it("keeps a zero-action answer, and the reason given for it", () => {
    const { analysis } = run(
      reply({
        impact: "notable",
        summary: "Render raised the memory ceiling on its existing compute plans.",
        key_points: ["Same plans, more memory"],
        actions: [],
        no_action_reason: "Railway already scales memory on every plan, so there is nothing to do.",
      }),
    );

    expect(analysis.actions).toEqual([]);
    expect(analysis.noActionReason).toContain("Railway already scales memory");
  });

  it("records the pages the analyst read on the analysis itself", () => {
    const { analysis } = run(
      reply(
        {
          impact: "minor",
          summary: "Render published a recap.",
          actions: [],
          no_action_reason: "A recap of things already shipped asks nothing of Railway.",
        },
        ["https://docs.railway.com/deployments/serverless"],
      ),
    );

    expect(analysis.pagesRead).toEqual(["https://docs.railway.com/deployments/serverless"]);
  });

  it("drops a page edit aimed at the product docs before anything else looks at it", () => {
    const { analysis, notes } = run(
      reply({
        impact: "notable",
        summary: "Render now bills an idle service per request.",
        actions: [
          { type: "update_pages", detail: "Rewrite the serverless docs to mention per-request billing." },
        ],
        railway_refs: [
          {
            url: "https://docs.railway.com/deployments/serverless",
            claim: "Railway bills a container by the minute while it is awake.",
            suggested_edit: "Say Render bills per request.",
          },
        ],
      }),
    );

    expect(analysis.actions).toEqual([]);
    expect(notes.some((note) => note.includes("product docs pages"))).toBe(true);
  });
});
