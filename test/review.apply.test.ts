import { describe, expect, it } from "vitest";
import type { IssueEditor, IssuePatch } from "../src/github/issue.js";
import { REVIEW_LABEL, REVIEW_PASS_DONE } from "../src/labels.js";
import {
  createReviewBudget,
  reviewActions,
  type ReviewPassResult,
  type ReviewTarget,
} from "../src/review/apply.js";
import type { Reviewer, ReviewOutcome } from "../src/review/reviewer.js";
import type { Revision } from "../src/review/schema.js";
import type { ActionWriter } from "../src/review/writer.js";
import type {
  AnalyzedItem,
  IssueRef,
  RecommendedAction,
  ReviewVerdict,
} from "../src/types.js";
import { analysis, corpusIndex, featureImage, storedItem } from "./helpers.js";

/**
 * The review pass end to end, with fake models and a recording editor.
 *
 * What each case is really asking is whether a wrong verdict can reach an issue.
 * A rewrite that cannot be checked must not, a dropped action must leave the
 * Discord embed, and no action may be reviewed twice however many times the run
 * comes back to it.
 */

const SERVERLESS = "https://docs.railway.com/deployments/serverless";
const VOLUMES = "https://docs.railway.com/volumes";
const COMPARE = "https://docs.railway.com/platform/compare-to-render";

const COMPARE_CLAIM = "Railway stops an idle container; Render keeps it running.";

const index = corpusIndex([
  {
    url: SERVERLESS,
    title: "Serverless",
    text: "Serverless stops a service's container when it has no inbound traffic. The container starts again on the next request. Railway bills a container by the minute while it is awake.",
  },
  {
    url: VOLUMES,
    title: "Volumes",
    text: "A volume attaches a persistent disk to exactly one service. A volume cannot be mounted into two services at once.",
  },
  {
    url: COMPARE,
    title: "Compare to Render",
    kind: "marketing",
    text: `Railway and Render both deploy from a repository. ${COMPARE_CLAIM}`,
  },
]);

const item = storedItem({
  title: "Per-request billing for idle web services",
  url: "https://render.com/changelog/per-request-billing",
});

const image = featureImage();

/** As filed: the right recommendation, resting on a page about something else. */
const filed: RecommendedAction = {
  type: "consider_enhancing",
  feature: "Serverless",
  detail: "Add per-request billing to Serverless so a sleeping service costs nothing.",
  gap: "no per-request billing for a sleeping service",
  evidenceUrl: VOLUMES,
  evidenceQuote: "A volume attaches a persistent disk to exactly one service.",
};

const pageAction: RecommendedAction = {
  type: "update_pages",
  detail: "On the compare to render page, say Render now bills an idle web service per request.",
};

const alert: AnalyzedItem = {
  item,
  model: "claude-opus-5",
  docs: [],
  analysis: analysis({
    impact: "notable",
    summary: "Render now bills an idle web service per request rather than per minute.",
    keyPoints: ["Per-request billing on the plans they already sell"],
    actions: [filed],
    railwayRefs: [
      {
        url: COMPARE,
        claim: COMPARE_CLAIM,
        suggestedEdit: "Say Render meters an idle web service per request.",
        // An update_pages action carries the copy for the page, not a note about
        // it, so the fixture carries one the gate accepts.
        proposedText:
          "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.",
      },
    ],
    openQuestions: [],
  }),
};

interface Edit {
  kind: "update" | "comment" | "close";
  issue: IssueRef | null;
  patch?: IssuePatch;
  body?: string;
  reason?: string;
  labels?: string[];
}

class RecordingEditor implements IssueEditor {
  readonly description = "recording";
  readonly edits: Edit[] = [];

  async update(issue: IssueRef | null, patch: IssuePatch): Promise<boolean> {
    this.edits.push({ kind: "update", issue, patch });
    return issue !== null;
  }

  async comment(issue: IssueRef | null, body: string): Promise<boolean> {
    this.edits.push({ kind: "comment", issue, body });
    return issue !== null;
  }

  async close(
    issue: IssueRef | null,
    reason: "completed" | "not_planned",
    labels?: string[],
  ): Promise<boolean> {
    this.edits.push({ kind: "close", issue, reason, ...(labels ? { labels } : {}) });
    return issue !== null;
  }

  labelsOf(kind: Edit["kind"] = "update"): string[] {
    const edit = this.edits.find((entry) => entry.kind === kind);
    return edit?.patch?.labels ?? edit?.labels ?? [];
  }

  get comments(): string[] {
    return this.edits.filter((edit) => edit.kind === "comment").map((edit) => edit.body ?? "");
  }
}

let reviewerCalls = 0;

function fakeReviewer(verdict: ReviewVerdict, overrides: Partial<ReviewOutcome> = {}): Reviewer {
  return {
    model: "claude-fable-5-1",
    description: "fake reviewer",
    async review() {
      reviewerCalls += 1;
      return {
        verdict,
        reason: "The page it cites is about volumes, not about how a service sleeps.",
        pagesChecked: [],
        changes: ["Cite the serverless page and quote it."],
        readUrls: [SERVERLESS],
        model: "claude-fable-5-1",
        ...overrides,
      };
    },
  };
}

function throwingReviewer(message: string): Reviewer {
  return {
    model: "claude-fable-5-1",
    description: "fake reviewer",
    async review() {
      reviewerCalls += 1;
      throw new Error(message);
    },
  };
}

function fakeWriter(revision: Revision): ActionWriter {
  return {
    model: "claude-opus-5",
    description: "fake writer",
    async rewrite() {
      return revision;
    },
  };
}

/** The rewrite that lands on the page the corpus ranks for the gap. */
const goodRewrite: Revision = {
  gap: "Railway bills a container by the minute while it is awake, with no per-request option",
  evidenceUrl: SERVERLESS,
  evidenceQuote: "Railway bills a container by the minute while it is awake.",
  pageEdits: [],
};

const issue: IssueRef = { number: 7, url: "https://github.com/o/r/issues/7" };
const openedLabels = ["competitor-happenings", "render", "impact:notable", "owner:product"];

interface RunOptions {
  targets?: ReviewTarget[];
  reviewer?: Reviewer | null;
  writer?: ActionWriter | null;
  budget?: number;
  editor?: RecordingEditor;
  alert?: AnalyzedItem;
}

async function run(
  options: RunOptions = {},
): Promise<{ result: ReviewPassResult; editor: RecordingEditor }> {
  reviewerCalls = 0;
  const editor = options.editor ?? new RecordingEditor();
  const result = await reviewActions({
    alert: options.alert ?? alert,
    image,
    targets: options.targets ?? [{ action: filed, issue, labels: openedLabels }],
    editor,
    reviewer: options.reviewer === undefined ? fakeReviewer("agree") : options.reviewer,
    writer: options.writer === undefined ? fakeWriter(goodRewrite) : options.writer,
    index,
    workspace: null,
    budget: createReviewBudget({ reviewMaxPerRun: options.budget ?? 12 } as never),
  });
  return { result, editor };
}

describe("agree", () => {
  it("comments, labels, and leaves the issue body alone", async () => {
    const { result, editor } = await run({
      reviewer: fakeReviewer("agree", {
        reason: "The gap is real and the quote is on the page.",
        pagesChecked: [SERVERLESS],
      }),
    });

    expect(result.analysis.actions).toEqual([filed]);
    expect(editor.comments[0]).toContain(
      "Reviewed by `claude-fable-5-1`: agreed \u2013 The gap is real and the quote is on the page.",
    );
    expect(editor.comments[0]).toContain(`Pages checked:\n- ${SERVERLESS}`);

    const patches = editor.edits.filter((edit) => edit.kind === "update");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch).toEqual({
      labels: [...openedLabels, REVIEW_LABEL.agreed, REVIEW_PASS_DONE],
    });
    // Agreeing changes nothing about what the issue says.
    expect(patches[0]?.patch?.body).toBeUndefined();
    expect(patches[0]?.patch?.title).toBeUndefined();
  });

  it("records the verdict on the action, so a retry never reviews it again", async () => {
    const { result } = await run();
    expect(result.issues[0]?.review).toMatchObject({
      verdict: "agree",
      model: "claude-fable-5-1",
    });
    expect(result.issues[0]?.review?.at).toBeInstanceOf(Date);
  });
});

describe("revise", () => {
  it("rewrites the action, patches title, body, and labels, and says what changed", async () => {
    const { result, editor } = await run({ reviewer: fakeReviewer("revise") });

    const revised = result.analysis.actions[0];
    expect(revised?.gap).toBe(
      "Railway bills a container by the minute while it is awake, with no per-request option",
    );
    expect(revised?.evidenceUrl).toBe(SERVERLESS);
    expect(result.issues[0]?.review).toMatchObject({ verdict: "revise", applied: true });

    const patch = editor.edits.find((edit) => edit.kind === "update")?.patch;
    expect(patch?.title).toContain("Consider enhancing Serverless");
    expect(patch?.body).toContain(SERVERLESS);
    expect(patch?.body).not.toContain(VOLUMES);
    expect(patch?.labels).toContain(REVIEW_LABEL.revised);
    expect(patch?.labels).toContain(REVIEW_PASS_DONE);

    const comment = editor.comments[0] ?? "";
    expect(comment).toContain("Reviewed by `claude-fable-5-1`: revised");
    expect(comment).toContain("Cite the serverless page and quote it.");
    expect(comment).toContain("**Before**");
    expect(comment).toContain(`- Evidence: ${VOLUMES}`);
    expect(comment).toContain("**After**");
    expect(comment).toContain(`- Evidence: ${SERVERLESS}`);
    expect(comment).toContain("Rewritten with `claude-opus-5`");
  });

  it("keeps the original when the rewrite cannot survive the evidence checks", async () => {
    const { result, editor } = await run({
      reviewer: fakeReviewer("revise"),
      // Real page, real quote, and about how a service sleeps rather than about
      // volumes: exactly the mistake the gate exists to catch, by a new route.
      writer: fakeWriter({
        feature: "Volumes",
        gap: "no way to attach a persistent disk to more than one service",
        evidenceUrl: SERVERLESS,
        evidenceQuote: "Railway bills a container by the minute while it is awake.",
        pageEdits: [],
      }),
    });

    expect(result.analysis.actions).toEqual([filed]);
    expect(result.issues[0]?.review).toMatchObject({ verdict: "revise", applied: false });

    const patches = editor.edits.filter((edit) => edit.kind === "update");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch?.body).toBeUndefined();
    expect(patches[0]?.patch?.labels).toContain(REVIEW_LABEL.unconfirmed);
    expect(patches[0]?.patch?.labels).toContain(REVIEW_PASS_DONE);
    expect(editor.comments[0]).toContain("The rewrite was not applied");
    expect(editor.comments[0]).toContain("inventing one");
    // Named by the check that caught it, so a reader knows what to settle.
    expect(editor.comments[0]).toContain(VOLUMES);
  });

  it("leaves it unconfirmed when the writer fails rather than filing something unchecked", async () => {
    const { result, editor } = await run({
      reviewer: fakeReviewer("revise"),
      writer: {
        model: "claude-opus-5",
        description: "fake writer",
        async rewrite() {
          throw new Error("no JSON object found in model output");
        },
      },
    });

    expect(result.analysis.actions).toEqual([filed]);
    expect(editor.labelsOf()).toContain(REVIEW_LABEL.unconfirmed);
    expect(editor.comments[0]).toContain("no JSON object found in model output");
  });

  it("never calls the reviewer a second time about its own rewrite", async () => {
    await run({ reviewer: fakeReviewer("revise") });
    expect(reviewerCalls).toBe(1);
  });

  it("moves the impact only when the reviewer said the label is wrong", async () => {
    const { result } = await run({ reviewer: fakeReviewer("revise", { impact: "major" }) });
    expect(result.analysis.impact).toBe("major");

    const unasked = await run({ reviewer: fakeReviewer("revise") });
    expect(unasked.result.analysis.impact).toBe("notable");
  });

  /** An update_pages action's substance is the copy for the page, so that is what a revise rewrites. */
  const pageRun = (revision: Revision, changes = ["Name where the meter applies, in its voice."]) =>
    run({
      targets: [{ action: pageAction, issue, labels: openedLabels }],
      alert: { ...alert, analysis: { ...alert.analysis, actions: [pageAction] } },
      reviewer: fakeReviewer("revise", { changes }),
      writer: fakeWriter(revision),
    });

  const rewritten =
    "Render bills a web service per request once it goes idle, so a quiet service costs nothing between requests. Railway stops an idle container and bills it by the minute while it is awake.";

  it("replaces the copy proposed for a compare page and keeps the page action", async () => {
    const { result, editor } = await pageRun({
      pageEdits: [
        {
          url: COMPARE,
          proposedText: rewritten,
          suggestedEdit: "Name what the per-request meter costs between requests.",
        },
      ],
    });

    expect(result.analysis.actions.map((action) => action.type)).toEqual(["update_pages"]);
    expect(result.analysis.railwayRefs[0]?.proposedText).toBe(rewritten);
    expect(result.analysis.railwayRefs[0]?.suggestedEdit).toBe(
      "Name what the per-request meter costs between requests.",
    );

    const patch = editor.edits.find((edit) => edit.kind === "update")?.patch;
    expect(patch?.body).toContain("Replace the copy above with this, word for word:");
    expect(patch?.body).toContain(rewritten);
    // The before/after shows the copy, because on a page action it is the change.
    expect(editor.comments[0]).toContain(`- Copy for it: "${rewritten}"`);
  });

  it("refuses a rewrite that writes about the edit instead of writing it", async () => {
    const { result, editor } = await pageRun({
      pageEdits: [
        {
          url: COMPARE,
          proposedText: "Say that Render now meters an idle web service per request.",
        },
      ],
    });

    // The original copy stands: an instruction is not a page edit, and the same
    // check that says so for the analyst says so for the rewrite.
    expect(result.analysis.railwayRefs[0]?.proposedText).toBe(
      alert.analysis.railwayRefs[0]?.proposedText,
    );
    expect(editor.labelsOf()).toContain(REVIEW_LABEL.unconfirmed);
    expect(editor.comments[0]).toContain("an instruction rather than copy");
  });

  it("refuses copy that leaves a blank for somebody else to fill in", async () => {
    const { result, editor } = await pageRun({
      pageEdits: [
        {
          url: COMPARE,
          proposedText:
            "Render bills a web service per request once it goes idle, at [their per-request rate], while Railway bills by the minute.",
        },
      ],
    });

    expect(result.analysis.railwayRefs[0]?.proposedText).toBe(
      alert.analysis.railwayRefs[0]?.proposedText,
    );
    expect(editor.labelsOf()).toContain(REVIEW_LABEL.unconfirmed);
    expect(editor.comments[0]).toContain("placeholder");
  });

  it("refuses copy for a docs page, which is evidence rather than a target", async () => {
    const cited = {
      url: SERVERLESS,
      claim: "Railway bills a container by the minute while it is awake.",
    };
    const { result } = await run({
      targets: [{ action: pageAction, issue, labels: openedLabels }],
      alert: {
        ...alert,
        analysis: {
          ...alert.analysis,
          actions: [pageAction],
          // Cited as evidence, which is what a docs page is for. Being cited is
          // not permission to edit it.
          railwayRefs: [...alert.analysis.railwayRefs, cited],
        },
      },
      reviewer: fakeReviewer("revise"),
      writer: fakeWriter({ pageEdits: [{ url: SERVERLESS, proposedText: rewritten }] }),
    });

    expect(result.notes.join(" ")).toContain("not a page marketing writes");
    expect(result.analysis.railwayRefs.find((ref) => ref.url === SERVERLESS)).toEqual(cited);
  });
});

describe("drop", () => {
  it("closes the issue as not planned and leaves the action out of the alert", async () => {
    const { result, editor } = await run({
      reviewer: fakeReviewer("drop", {
        reason: "Railway already stops an idle container and charges nothing for it.",
        pagesChecked: [SERVERLESS],
      }),
    });

    expect(result.analysis.actions).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.analysis.noActionReason).toContain(
      "Railway already stops an idle container and charges nothing for it.",
    );

    const closed = editor.edits.find((edit) => edit.kind === "close");
    expect(closed?.reason).toBe("not_planned");
    expect(closed?.labels).toContain(REVIEW_LABEL.dropped);
    expect(closed?.labels).toContain(REVIEW_PASS_DONE);
    expect(editor.comments[0]).toContain("Pages that show Railway already covers this:");
    expect(editor.comments[0]).toContain(SERVERLESS);
  });

  it("keeps the actions it agreed with when it drops one of several", async () => {
    let call = 0;
    const reviewer: Reviewer = {
      model: "claude-fable-5-1",
      description: "fake reviewer",
      async review() {
        call += 1;
        return {
          verdict: call === 1 ? "drop" : "agree",
          reason: call === 1 ? "Railway already does this." : "It stands.",
          pagesChecked: [],
          changes: [],
          readUrls: [],
          model: "claude-fable-5-1",
        };
      },
    };

    const { result } = await run({
      reviewer,
      targets: [
        { action: filed, issue, labels: openedLabels },
        { action: pageAction, issue: { number: 8, url: "u8" }, labels: openedLabels },
      ],
      alert: { ...alert, analysis: { ...alert.analysis, actions: [filed, pageAction] } },
    });

    expect(result.analysis.actions).toEqual([pageAction]);
    expect(result.analysis.noActionReason).toBeUndefined();
    expect(result.issues.map((entry) => entry.issue?.number)).toEqual([8]);
  });
});

describe("the loop runs once", () => {
  it("refuses an issue that already carries the one-pass label", async () => {
    const { result, editor } = await run({
      targets: [{ action: filed, issue, labels: [...openedLabels, REVIEW_PASS_DONE] }],
    });

    expect(reviewerCalls).toBe(0);
    expect(editor.edits).toEqual([]);
    expect(result.analysis.actions).toEqual([filed]);
    expect(result.notes.join(" ")).toContain("already been past a reviewer");
  });

  it("refuses an action whose review is already on the analysis row", async () => {
    const stored = {
      verdict: "agree" as const,
      model: "claude-fable-5-1",
      at: new Date("2026-09-02T00:00:00Z"),
      reason: "It stands.",
    };
    const { result } = await run({
      targets: [{ action: filed, issue, labels: openedLabels, review: stored }],
    });

    expect(reviewerCalls).toBe(0);
    // Carried forward, so a third attempt to post finds it too.
    expect(result.issues[0]?.review).toEqual(stored);
  });
});

describe("when there is no review to be had", () => {
  it("files every action as written when the reviewer is off", async () => {
    const { result, editor } = await run({ reviewer: null, writer: null });
    expect(result.analysis.actions).toEqual([filed]);
    expect(result.issues[0]?.review).toBeUndefined();
    expect(editor.edits).toEqual([]);
  });

  it("labels an action past the run's budget rather than reviewing it", async () => {
    const { result, editor } = await run({
      budget: 1,
      targets: [
        { action: filed, issue, labels: openedLabels },
        { action: pageAction, issue: { number: 8, url: "u8" }, labels: openedLabels },
      ],
      alert: { ...alert, analysis: { ...alert.analysis, actions: [filed, pageAction] } },
    });

    expect(reviewerCalls).toBe(1);
    expect(result.analysis.actions).toEqual([filed, pageAction]);
    const skipped = editor.edits.filter((edit) =>
      edit.patch?.labels?.includes(REVIEW_LABEL.skipped),
    );
    expect(skipped).toHaveLength(1);
    // Skipped is not a verdict, so it does not stamp the issue as reviewed.
    expect(skipped[0]?.patch?.labels).not.toContain(REVIEW_PASS_DONE);
    expect(result.notes.join(" ")).toContain("over the budget for this run");
  });

  it("skips the action, and keeps the run, when the reviewer model is refused", async () => {
    const { result, editor } = await run({
      reviewer: throwingReviewer("agent run error: unknown model claude-fable-5-1"),
    });

    expect(result.analysis.actions).toEqual([filed]);
    expect(result.issues[0]?.review).toBeUndefined();
    expect(editor.labelsOf()).toContain(REVIEW_LABEL.skipped);
    expect(result.notes.join(" ")).toContain("unknown model");
  });
});

describe("a dry run", () => {
  it("reviews, rewrites, and shows the result without writing anything", async () => {
    const editor = new RecordingEditor();
    const { result } = await run({
      editor,
      // No token and no issue: the review still happens, and the alert carries it.
      targets: [{ action: filed, issue: null, labels: openedLabels }],
      reviewer: fakeReviewer("revise"),
    });

    expect(result.analysis.actions[0]?.evidenceUrl).toBe(SERVERLESS);
    expect(result.issues[0]?.issue).toBeNull();
    expect(result.issues[0]?.review).toMatchObject({ verdict: "revise", applied: true });
    // The editor was still asked, so a disabled one logs the whole verdict.
    expect(editor.edits.map((edit) => edit.kind)).toEqual(["update", "comment"]);
    expect(editor.edits.every((edit) => edit.issue === null)).toBe(true);
  });
});
