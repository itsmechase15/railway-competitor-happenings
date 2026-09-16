import { describe, expect, it } from "vitest";
import { mergeRevision, parseReview, parseRevision } from "../src/review/schema.js";
import type { RailwayRef, RecommendedAction } from "../src/types.js";

const SERVERLESS = "https://docs.railway.com/deployments/serverless";
const COMPARE = "https://docs.railway.com/platform/compare-to-render";

const productAction: RecommendedAction = {
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

const refs: RailwayRef[] = [
  {
    url: COMPARE,
    claim: "Railway stops an idle container; Render keeps it running.",
    suggestedEdit: "Say Render now bills a web service per request once it goes idle.",
  },
  {
    url: SERVERLESS,
    claim: "Railway bills a container by the minute while it is awake.",
  },
];

const review = parseReview(
  JSON.stringify({
    verdict: "revise",
    reason: "The gap claims more than the quoted page supports.",
    pages_checked: [SERVERLESS],
    changes: ["Narrow the gap to what the quote carries."],
  }),
);

describe("parseReview", () => {
  it("reads a verdict, its reason, and the pages behind it", () => {
    expect(review).toEqual({
      verdict: "revise",
      reason: "The gap claims more than the quoted page supports.",
      pagesChecked: [SERVERLESS],
      changes: ["Narrow the gap to what the quote carries."],
    });
  });

  it("reads a reply wrapped in prose and a code fence, which is how they arrive", () => {
    const parsed = parseReview(
      'Here is my review:\n```json\n{"verdict": "agree", "reason": "It stands."}\n```\nHope that helps.',
    );
    expect(parsed.verdict).toBe("agree");
    expect(parsed.pagesChecked).toEqual([]);
    expect(parsed.changes).toEqual([]);
  });

  it("punctuates the reason our way, because it is posted as a comment", () => {
    const parsed = parseReview(
      JSON.stringify({ verdict: "drop", reason: "Railway ships this\u2014see the docs." }),
    );
    expect(parsed.reason).toBe("Railway ships this \u2013 see the docs.");
  });

  it("takes an impact and a type correction only when the reviewer sends one", () => {
    const bare = parseReview(JSON.stringify({ verdict: "agree", reason: "Fine." }));
    expect(bare.impact).toBeUndefined();
    expect(bare.actionType).toBeUndefined();

    const corrected = parseReview(
      JSON.stringify({
        verdict: "revise",
        reason: "This is a new capability for them.",
        impact: "major",
        action_type: "consider_building",
      }),
    );
    expect(corrected.impact).toBe("major");
    expect(corrected.actionType).toBe("consider_building");
  });

  it("refuses a verdict that is not one of the three", () => {
    expect(() => parseReview(JSON.stringify({ verdict: "maybe", reason: "Unsure." }))).toThrow();
  });

  it("refuses a reply with no reason, because the comment has nothing to say", () => {
    expect(() => parseReview(JSON.stringify({ verdict: "drop" }))).toThrow();
  });

  it("drops blank lines out of the lists rather than failing the reply", () => {
    const parsed = parseReview(
      JSON.stringify({
        verdict: "revise",
        reason: "Narrow it.",
        changes: ["Narrow the gap.", "", "   "],
        pages_checked: [SERVERLESS, ""],
      }),
    );
    expect(parsed.changes).toEqual(["Narrow the gap."]);
    expect(parsed.pagesChecked).toEqual([SERVERLESS]);
  });
});

describe("parseRevision", () => {
  it("reads only the fields the writer changed", () => {
    const parsed = parseRevision(
      JSON.stringify({
        gap: "Railway meters compute by the minute while a service is awake.",
        evidence_url: SERVERLESS,
        evidence_quote: "Railway bills a container by the minute while it is awake.",
      }),
    );
    expect(parsed).toEqual({
      gap: "Railway meters compute by the minute while a service is awake.",
      evidenceUrl: SERVERLESS,
      evidenceQuote: "Railway bills a container by the minute while it is awake.",
      pageEdits: [],
    });
  });

  it("reads the copy for a page under whichever key the writer used", () => {
    const copy = "Render bills a web service per request once it goes idle.";
    for (const key of ["proposed_text", "proposedText", "replacement_text"]) {
      const parsed = parseRevision(JSON.stringify({ page_edits: [{ url: COMPARE, [key]: copy }] }));
      expect(parsed.pageEdits, key).toEqual([{ url: COMPARE, proposedText: copy }]);
    }
  });

  it("reads page edits sent under the older suggested_edits key", () => {
    const parsed = parseRevision(
      JSON.stringify({
        suggested_edits: [{ url: COMPARE, suggested_edit: "Name the per-request meter." }],
      }),
    );
    expect(parsed.pageEdits).toEqual([
      { url: COMPARE, suggestedEdit: "Name the per-request meter." },
    ]);
  });

  it("carries what the copy does to the line it quotes", () => {
    const parsed = parseRevision(
      JSON.stringify({
        page_edits: [
          { url: COMPARE, proposed_text: "Render bills per request.", edit_kind: "insert" },
        ],
      }),
    );
    expect(parsed.pageEdits[0]?.editKind).toBe("insert");
  });

  it("drops a page edit carrying neither the copy nor a reason", () => {
    expect(parseRevision(JSON.stringify({ page_edits: [{ url: COMPARE }] })).pageEdits).toEqual([]);
  });

  it("punctuates the page copy our way, because it is destined for a Railway page", () => {
    const parsed = parseRevision(
      JSON.stringify({
        page_edits: [
          { url: COMPARE, proposed_text: "Render bills per request\u2014Railway bills per minute." },
        ],
      }),
    );
    expect(parsed.pageEdits[0]?.proposedText).toBe(
      "Render bills per request \u2013 Railway bills per minute.",
    );
  });

  it("leaves a quote exactly as the page has it, dashes and all", () => {
    const quote = "Railway bills a container\u2014by the minute\u2014while it is awake.";
    const parsed = parseRevision(JSON.stringify({ evidence_quote: quote }));
    // Everything else is punctuated our way. A quote is checked character by
    // character against the stored page, so correcting it would fail.
    expect(parsed.evidenceQuote).toBe(quote);
    expect(parseRevision(JSON.stringify({ gap: quote })).gap).toContain(" \u2013 ");
  });

  it("reads a blank field as one the writer left alone", () => {
    const parsed = parseRevision(JSON.stringify({ detail: "", gap: "  ", feature: "Serverless" }));
    expect(parsed.detail).toBeUndefined();
    expect(parsed.gap).toBeUndefined();
    expect(parsed.feature).toBe("Serverless");
  });
});

describe("mergeRevision", () => {
  const merge = (raw: object, action = productAction, decision = review) =>
    mergeRevision(action, refs, parseRevision(JSON.stringify(raw)), decision, "notable");

  it("takes the detail, gap, evidence, and quote the writer sent", () => {
    const merged = merge({
      detail: "Meter a sleeping service by the request rather than the minute.",
      gap: "Railway meters compute by the minute while a service is awake.",
      evidence_url: SERVERLESS,
      evidence_quote: "Railway bills a container by the minute while it is awake.",
    });

    expect(merged.action).toMatchObject({
      type: "consider_enhancing",
      feature: "Serverless",
      detail: "Meter a sleeping service by the request rather than the minute.",
      gap: "Railway meters compute by the minute while a service is awake.",
      evidenceUrl: SERVERLESS,
      evidenceQuote: "Railway bills a container by the minute while it is awake.",
    });
    expect(merged.notes).toEqual([]);
  });

  it("swaps the two product actions for each other", () => {
    expect(merge({ type: "consider_building" }).action.type).toBe("consider_building");
    expect(
      merge({ type: "consider_enhancing" }, { ...productAction, type: "consider_building" }).action
        .type,
    ).toBe("consider_enhancing");
  });

  it("refuses to turn a product action into page work, which is a different recommendation", () => {
    const merged = merge({ type: "update_pages" });
    expect(merged.action.type).toBe("consider_enhancing");
    expect(merged.notes.join(" ")).toContain(
      "refused a type change from consider_enhancing to update_pages",
    );
  });

  it("refuses to turn page work into a product action, either", () => {
    const merged = merge({ type: "consider_building" }, pageAction);
    expect(merged.action.type).toBe("update_pages");
    expect(merged.notes.join(" ")).toContain(
      "only consider_building and consider_enhancing may swap",
    );
  });

  it("names the surface the way Railway does, whatever casing the writer used", () => {
    expect(merge({ feature: "storage buckets" }).action.feature).toBe("Storage buckets");
  });

  it("keeps the old surface when the catalog has never heard of the new one", () => {
    const merged = merge({ feature: "Time travel" });
    expect(merged.action.feature).toBe("Serverless");
    expect(merged.notes.join(" ")).toContain('the catalog has no product called "Time travel"');
  });

  it("moves impact only on the reviewer's word", () => {
    expect(merge({ impact: "major" }).impact).toBe("notable");
    expect(merge({ impact: "major" }).notes.join(" ")).toContain(
      "the reviewer did not say it was wrong",
    );

    const asked = { ...review, impact: "major" as const };
    expect(merge({}, productAction, asked).impact).toBe("major");
  });

  it("replaces a suggested edit on a page marketing writes", () => {
    const merged = merge({
      suggested_edits: [
        { url: COMPARE, suggested_edit: "Say Render meters an idle web service per request." },
      ],
    });

    expect(merged.refs[0]?.suggestedEdit).toBe(
      "Say Render meters an idle web service per request.",
    );
    // The other ref is untouched, and it never had an edit to begin with.
    expect(merged.refs[1]?.suggestedEdit).toBeUndefined();
    expect(merged.notes).toEqual([]);
  });

  it("replaces the copy for a page it may edit, which is what a page revise is", () => {
    const copy =
      "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.";
    const merged = merge({ page_edits: [{ url: COMPARE, proposed_text: copy }] });

    expect(merged.refs[0]?.proposedText).toBe(copy);
    // The one-line reason it was filed with survives a rewrite that only changed
    // the copy, so the issue still says why.
    expect(merged.refs[0]?.suggestedEdit).toBe(refs[0]?.suggestedEdit);
    expect(merged.notes).toEqual([]);
  });

  it("takes copy that reads as an instruction, and leaves the gate to refuse it", () => {
    // One judge of what counts as copy: `copyFault`, through the gate. This
    // merge only decides which page may be touched.
    const merged = merge({
      page_edits: [{ url: COMPARE, proposed_text: "Say Render now bills per request." }],
    });
    expect(merged.refs[0]?.proposedText).toBe("Say Render now bills per request.");
    expect(merged.notes).toEqual([]);
  });

  it("refuses an edit aimed at a docs page, which is evidence rather than a target", () => {
    const merged = merge({
      page_edits: [
        {
          url: SERVERLESS,
          proposed_text:
            "Railway bills a sleeping container nothing and meters it per request once it wakes.",
          suggested_edit: "Mention per-request billing.",
        },
      ],
    });
    const docs = merged.refs.find((ref) => ref.url === SERVERLESS);
    expect(docs?.proposedText).toBeUndefined();
    expect(docs?.suggestedEdit).toBeUndefined();
    expect(merged.notes.join(" ")).toContain("not a page marketing writes");
  });

  it("refuses an edit for a page this analysis never cited", () => {
    const merged = merge({
      page_edits: [{ url: "https://railway.com/pricing", suggested_edit: "Add a per-request row." }],
    });
    expect(merged.refs).toHaveLength(2);
    expect(merged.notes.join(" ")).toContain("which this analysis never cited");
  });

  it("leaves everything alone when the writer sent an empty object", () => {
    const merged = merge({});
    expect(merged.action).toEqual(productAction);
    expect(merged.refs).toEqual(refs);
    expect(merged.impact).toBe("notable");
    expect(merged.notes).toEqual([]);
  });
});
