import { describe, expect, it } from "vitest";
import type { DocsWorkspace } from "../src/railway/workspace.js";
import { buildReviewPrompt, buildRewritePrompt } from "../src/review/prompt.js";
import { parseReview } from "../src/review/schema.js";
import type { AnalyzedItem, RecommendedAction } from "../src/types.js";
import { analysis, storedItem } from "./helpers.js";

const SERVERLESS = "https://docs.railway.com/deployments/serverless";
const COMPARE = "https://docs.railway.com/platform/compare-to-render";

const item = storedItem({
  title: "Per-request billing for idle web services",
  url: "https://render.com/changelog/per-request-billing",
});

const action: RecommendedAction = {
  type: "consider_enhancing",
  feature: "Serverless",
  detail: "Add per-request billing to Serverless so a sleeping service costs nothing.",
  gap: "No per-request billing for a sleeping service.",
  evidenceUrl: "https://docs.railway.com/volumes",
  evidenceQuote: "A volume attaches a persistent disk to exactly one service.",
};

const pageAction: RecommendedAction = {
  type: "update_pages",
  detail: "On the compare to render page, say Render now bills a web service per request.",
};

const alert: AnalyzedItem = {
  item,
  model: "claude-opus-5",
  analysis: analysis({
    impact: "notable",
    summary: "Render now bills an idle web service per request rather than per minute.",
    actions: [action],
    railwayRefs: [
      {
        url: COMPARE,
        claim: "Railway stops an idle container; Render keeps it running.",
        proposedText:
          "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.",
        suggestedEdit: "Say Render meters an idle web service per request.",
      },
    ],
  }),
};

const docs = [
  {
    url: SERVERLESS,
    title: "Serverless",
    excerpt: "Railway bills a container by the minute while it is awake.",
    kind: "docs" as const,
  },
];

const workspace = { dir: "/tmp/corpus" } as DocsWorkspace;

describe("buildReviewPrompt", () => {
  const prompt = buildReviewPrompt({ alert, action, workspace, docs });

  it("shows the reviewer the action exactly as it was filed", () => {
    expect(prompt).toContain("Action type: consider_enhancing");
    expect(prompt).toContain("Railway surface named: Serverless");
    expect(prompt).toContain("Gap claimed: No per-request billing for a sleeping service.");
    expect(prompt).toContain("Evidence page: https://docs.railway.com/volumes");
    expect(prompt).toContain(
      'Evidence quote: "A volume attaches a persistent disk to exactly one service."',
    );
  });

  it("shows the copy proposed for a page, which is what a page action is judged on", () => {
    expect(prompt).toContain(`- ${COMPARE}`);
    expect(prompt).toContain(
      'on the page today: "Railway stops an idle container; Render keeps it running."',
    );
    expect(prompt).toContain(
      'copy proposed for it: "Render bills a web service per request once it goes idle.',
    );
    expect(prompt).toContain('why: "Say Render meters an idle web service per request."');
  });

  it("says an update_pages action with no copy for the page is a revise on its own", () => {
    const noCopy = buildReviewPrompt({
      alert: {
        ...alert,
        analysis: {
          ...alert.analysis,
          railwayRefs: [
            { url: COMPARE, claim: "Railway stops an idle container; Render keeps it running." },
          ],
        },
      },
      action: pageAction,
      workspace,
      docs,
    });
    expect(noCopy).toContain("(none, which is a revise on its own for update_pages)");
    expect(prompt).toContain(
      "An update_pages action with no proposed copy at all is a revise, not a drop",
    );
  });

  it("names the three verdicts and the bar for each", () => {
    for (const fragment of [
      '"agree": it stands',
      '"revise": there is real work to file here',
      '"drop": there is nothing to file',
      "Do not revise for style",
      "Do not drop because you could not confirm the gap",
    ]) {
      expect(prompt).toContain(fragment);
    }
  });

  it("rules out the type change a review may not ask for", () => {
    expect(prompt).toContain("There is no path from a product action into update_pages");
  });

  it("calibrates on a real revise rather than describing one", () => {
    expect(prompt).toContain("## What a revise looks like");
    expect(prompt).toContain("Why that is a revise and not an agree or a drop");
    expect(prompt).toContain("Narrow the gap to what a product docs page supports");
    expect(prompt).toContain("What the same reply must not do");
  });

  it("tells it to search the corpus on disk, and what each page is evidence of", () => {
    expect(prompt).toContain("## The Railway docs, as files you can search");
    expect(prompt).toContain("kind: changelog");
    expect(prompt).toContain("Cite the `url` from a file's header, never the file path.");
  });

  it("holds back the verdicts that need the docs when there is no corpus on disk", () => {
    const textOnly = buildReviewPrompt({ alert, action, workspace: null, docs });
    expect(textOnly).toContain("You have no searchable copy of Railway's docs this run");
    expect(textOnly).toContain("you cannot drop the action");
    expect(textOnly).not.toContain("## The Railway docs, as files you can search");
  });

  it("carries the writing rules, because the reason is posted as a comment", () => {
    expect(prompt).toContain("Never use an em dash");
    expect(prompt).toContain("Write like an engineer explaining something to another engineer");
  });

  it("asks for the shape the parser reads", () => {
    // The parser is what actually enforces the contract, so the two have to agree.
    expect(prompt).toContain('"verdict": "agree" | "revise" | "drop"');
    expect(() =>
      parseReview(
        JSON.stringify({
          verdict: "revise",
          reason: "The quote does not carry the gap.",
          pages_checked: [SERVERLESS],
          changes: ["Narrow the gap."],
          impact: "notable",
          action_type: "consider_enhancing",
        }),
      ),
    ).not.toThrow();
  });
});

describe("buildRewritePrompt", () => {
  const review = parseReview(
    JSON.stringify({
      verdict: "revise",
      reason: "The gap claims more than the quoted page supports.",
      pages_checked: [SERVERLESS],
      changes: ["Narrow the gap to what the quote carries.", "Cite the serverless page."],
      impact: "major",
    }),
  );
  const prompt = buildRewritePrompt({ alert, action, review, docs });

  it("hands over the reviewer's reason, its changes, and the pages it read", () => {
    expect(prompt).toContain("Reason: The gap claims more than the quoted page supports.");
    expect(prompt).toContain("- Narrow the gap to what the quote carries.");
    expect(prompt).toContain("- Cite the serverless page.");
    expect(prompt).toContain(`Pages it read:\n- ${SERVERLESS}`);
    expect(prompt).toContain("The impact should be: major");
  });

  it("says the rewrite is checked afterwards, and what fails it", () => {
    expect(prompt).toContain("Code re-runs the whole evidence gate on your answer");
    expect(prompt).toContain(
      "a rewrite that fails it is thrown away with the original left standing",
    );
    expect(prompt).toContain("has to appear on that page exactly as it is written there");
  });

  it("bounds what it may quote to the pages already read", () => {
    expect(prompt).toContain("## The pages you may quote");
    expect(prompt).toContain(SERVERLESS);
    expect(prompt).toContain("A quote from anywhere else does not.");
  });

  it("asks for the sentence shape the embed renders", () => {
    expect(prompt).toContain("leads with the work to do, not with what Railway lacks");
    expect(prompt).toContain("under 220 characters");
  });

  /** A page rewrite is copy for a Railway page, so it gets the copy rules the analyst has. */
  it("holds a page rewrite to the same copy rules the analyst writes under", () => {
    const pagePrompt = buildRewritePrompt({ alert, action: pageAction, review, docs });
    expect(pagePrompt).toContain('"proposed_text" is the words that go on the page');
    expect(pagePrompt).toContain("What an update_pages action hands over");
    expect(pagePrompt).toContain('"edit_kind" is "replace"');
    expect(pagePrompt).toContain("read the excerpt and write in it");
    // A product rewrite is a claim about the product, so it gets the other set.
    expect(prompt).not.toContain('"proposed_text" is the words that go on the page');
  });

  it("says nothing about the type when the reviewer did not ask for one", () => {
    const asIs = buildRewritePrompt({
      alert,
      action,
      review: { ...review, actionType: undefined, impact: undefined },
      docs,
    });
    expect(asIs).not.toContain("The type should be:");
    expect(asIs).not.toContain("The impact should be:");
  });

  it("says so when the reviewer listed no specific change", () => {
    const bare = buildRewritePrompt({ alert, action, review: { ...review, changes: [] }, docs });
    expect(bare).toContain("Changes it asked for: none listed");
  });
});
