import { describe, expect, it } from "vitest";
import {
  copyFault,
  coverageMisses,
  gateActions,
  isDocumentationOnlyAction,
  isPackagingGap,
  quoteAppearsOn,
  type CoverageContext,
} from "../src/analysis/evidence.js";
import type { CorpusIndex } from "../src/railway/retrieval.js";
import type { Analysis, RecommendedAction } from "../src/types.js";
import { analysis, corpusIndex } from "./helpers.js";

const SERVERLESS_TEXT =
  "Serverless stops a service's container when it has no inbound traffic. The container starts again on the next request. Railway bills a container by the minute while it is awake.";

const PRIVACY_TEXT =
  "Railway records a consent decision for every workspace and honors a do-not-track header. Turn analytics consent off in the workspace privacy settings.";

/** A corpus with the two pages the tests below argue about, plus some noise. */
function index(): CorpusIndex {
  return corpusIndex([
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
      url: "https://docs.railway.com/platform/compare-to-render",
      title: "Compare to Render",
      kind: "marketing",
      text: "Railway and Render both deploy from a repository. Railway stops an idle container; Render keeps it running.",
    },
    {
      url: "https://railway.com/changelog/2026-09-01-consent",
      title: "Consent controls",
      kind: "changelog",
      text: "Workspaces can now record an analytics consent decision per user.",
    },
    {
      url: "https://docs.railway.com/volumes",
      title: "Volumes",
      text: "A volume attaches a persistent disk to exactly one service.",
    },
  ]);
}

function context(seen: string[] = []): CoverageContext {
  return { index: index(), seenUrls: new Set(seen) };
}

function enhancing(overrides: Partial<RecommendedAction> = {}): RecommendedAction {
  return {
    type: "consider_enhancing",
    feature: "Serverless",
    detail: "Add per-request billing to Serverless so a sleeping service costs nothing.",
    gap: "Railway bills a sleeping container by the minute rather than per request",
    evidenceUrl: "https://docs.railway.com/deployments/serverless",
    evidenceQuote: "Railway bills a container by the minute while it is awake.",
    ...overrides,
  };
}

function withAction(action: RecommendedAction, overrides: Partial<Analysis> = {}): Analysis {
  return analysis({ actions: [action], railwayRefs: [], ...overrides });
}

/**
 * Every check here exists to stop one issue being opened: "Railway should
 * build X", filed against a Railway that already ships X. That issue costs a
 * reader's trust in every alert after it, so an action that cannot be checked
 * is dropped and what it claimed becomes an open question instead.
 */
describe("checking the evidence a product action rests on", () => {
  it("files an action whose page, quote, and gap all hold up", () => {
    const { analysis: gated, blocked } = gateActions(
      withAction(enhancing()),
      context(["https://docs.railway.com/deployments/serverless"]),
    );

    expect(blocked).toEqual([]);
    expect(gated.actions).toHaveLength(1);
  });

  it("drops an action that never says what Railway cannot do", () => {
    const { analysis: gated, blocked } = gateActions(
      withAction(enhancing({ gap: undefined })),
      context(),
    );

    expect(gated.actions).toEqual([]);
    expect(blocked[0]?.reason).toContain("does not say what Railway cannot do");
    expect(gated.openQuestions.join(" ")).toContain("does not say what Railway cannot do");
  });

  it("drops an action that cites no docs page for its gap", () => {
    const { blocked } = gateActions(
      withAction(enhancing({ evidenceUrl: undefined })),
      context(),
    );
    expect(blocked[0]?.reason).toContain("cites no Railway docs page");
  });

  it("drops an action citing a page the corpus does not hold", () => {
    const { blocked } = gateActions(
      withAction(enhancing({ evidenceUrl: "https://docs.railway.com/invented-page" })),
      context(),
    );
    expect(blocked[0]?.reason).toContain("not a page in Railway's docs corpus");
  });

  /**
   * A compare page is copy somebody wrote on some past date. Reading a gap off
   * it is reading last year's marketing as this morning's product.
   */
  it("refuses marketing copy as evidence about the product", () => {
    const { blocked } = gateActions(
      withAction(
        enhancing({
          evidenceUrl: "https://docs.railway.com/platform/compare-to-render",
          evidenceQuote: "Railway stops an idle container; Render keeps it running.",
        }),
      ),
      context(),
    );
    expect(blocked[0]?.reason).toContain("marketing copy");
  });

  /**
   * The changelog is in the corpus so an analyst can see what shipped ahead of
   * the docs. Citing it for a gap is citing proof of the opposite.
   */
  it("refuses a changelog entry as evidence of a gap, because it says the thing shipped", () => {
    const { blocked } = gateActions(
      withAction(
        enhancing({
          feature: "Serverless",
          evidenceUrl: "https://railway.com/changelog/2026-09-01-consent",
          evidenceQuote: "Workspaces can now record an analytics consent decision per user.",
        }),
      ),
      context(),
    );
    expect(blocked[0]?.reason).toContain("the opposite of evidence for a gap");
  });

  it("drops an action that cites a page without quoting it", () => {
    const { blocked } = gateActions(
      withAction(enhancing({ evidenceQuote: undefined })),
      context(),
    );
    expect(blocked[0]?.reason).toContain("without quoting");
  });

  it("drops an action whose quote is not on the page it cites", () => {
    const { blocked } = gateActions(
      withAction(
        enhancing({
          evidenceQuote: "Railway has no way to bill a request.",
        }),
      ),
      context(),
    );
    expect(blocked[0]?.reason).toContain("its quote is not on");
  });
});

/**
 * The failure this whole design was built for.
 *
 * A gap claim can be well argued, cite a real page, and quote it correctly,
 * and still be wrong, because the page that answers it was one nobody opened.
 * Searching the corpus a second time with the gap's own words is what catches
 * that – and it is what a short hand-listed allowlist of pages could never do.
 */
describe("the coverage gate", () => {
  const consent = enhancing({
    feature: "Enterprise and compliance",
    detail: "Add a consent decision per workspace so analytics can be turned off.",
    gap: "Railway records no analytics consent decision and honors no do-not-track header",
    evidenceUrl: "https://docs.railway.com/volumes",
    evidenceQuote: "A volume attaches a persistent disk to exactly one service.",
  });

  it("blocks a gap whose own words lead to a page the analysis never opened", () => {
    const { analysis: gated, blocked } = gateActions(withAction(consent), context());

    expect(gated.actions).toEqual([]);
    expect(blocked[0]?.reason).toContain("https://docs.railway.com/enterprise/privacy");
  });

  it("lets the same claim through once that page has been read and cited", () => {
    const read = enhancing({
      feature: "Enterprise and compliance",
      detail: "Add a per-user consent decision to the workspace privacy settings.",
      gap: "Railway records a consent decision per workspace, not per user",
      evidenceUrl: "https://docs.railway.com/enterprise/privacy",
      evidenceQuote: "Railway records a consent decision for every workspace",
    });

    const { analysis: gated, blocked } = gateActions(
      withAction(read),
      context(["https://docs.railway.com/enterprise/privacy"]),
    );

    expect(blocked).toEqual([]);
    expect(gated.actions).toHaveLength(1);
  });

  it("names the pages the corpus ranks for a gap, read or not", () => {
    const { misses, strong } = coverageMisses(consent, context(), new Set());

    expect(strong.map((hit) => hit.url)).toContain("https://docs.railway.com/enterprise/privacy");
    expect(misses.map((miss) => miss.url)).toContain(
      "https://docs.railway.com/enterprise/privacy",
    );
  });

  it("has nothing to say about a gap the corpus holds no words for", () => {
    const { misses } = coverageMisses(
      enhancing({ gap: "no office in Lisbon", feature: undefined }),
      context(),
      new Set(),
    );
    expect(misses).toEqual([]);
  });
});

describe("what is not a capability gap", () => {
  it("drops a gap about what a competitor charges", () => {
    const { blocked } = gateActions(
      withAction(
        enhancing({
          gap: "Render's plan is cheaper than Railway's for the same workload",
          detail: "Match Render on price.",
        }),
      ),
      context(),
    );
    expect(blocked[0]?.reason).toContain("what a competitor charges");
  });

  it("keeps a gap about billing mechanics, which is about what the product does", () => {
    expect(isPackagingGap(enhancing())).toBe(false);
  });

  it("drops an action that asks for the docs to be written", () => {
    const { blocked } = gateActions(
      withAction(
        enhancing({
          detail: "Document that Railway stops an idle container, because nobody can find it.",
        }),
      ),
      context(),
    );
    expect(blocked[0]?.reason).toContain("asks for the docs to be written");
  });

  it("does not read a real change that also mentions docs as a docs request", () => {
    expect(
      isDocumentationOnlyAction(
        enhancing({
          detail: "Add per-request billing to Serverless, and document it on the pricing page.",
        }),
      ),
    ).toBe(false);
  });
});

describe("checking a page edit", () => {
  const pageAction: RecommendedAction = {
    type: "update_pages",
    detail:
      "On the compare to render page, say Railway stops an idle container while Render keeps it running.",
  };

  /** The copy a page edit is expected to carry: the finished line, not a note. */
  const EXACT_COPY =
    "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.";

  it("files a page edit that names a page, the copy today, and the copy to paste", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
            proposedText: EXACT_COPY,
            editKind: "replace",
          },
        ],
      }),
      context(),
    );
    expect(blocked).toEqual([]);
  });

  it("drops a page edit that names no page anyone owns", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/deployments/serverless",
            claim: "Serverless stops a service's container",
            suggestedEdit: "Mention Render here.",
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("names no Railway compare, migrate, pricing, or features");
  });

  it("drops a page edit that says which page but not what it should say", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("not what the page should say instead");
  });

  /** A page that no longer says the thing being corrected has already been fixed. */
  it("drops a page edit whose quoted copy is not on the page any more", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway has no way to stop an idle container.",
            suggestedEdit: "Say Railway stops idle containers.",
            proposedText: EXACT_COPY,
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("is not on");
  });

  it("drops a page edit that never writes the copy it wants pasted", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("never writes the copy");
  });

  it("drops a page edit whose copy is another instruction in disguise", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
            proposedText: "Mention that Render now bills a web service per request when idle.",
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("instruction rather than copy");
  });

  it("drops a page edit whose copy leaves a blank for somebody to fill in", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
            proposedText:
              "Render bills a web service per request once it goes idle. Railway [describe Railway's billing here].",
          },
        ],
      }),
      context(),
    );
    expect(blocked[0]?.reason).toContain("placeholder");
  });

  it("takes the copy from whichever cited page carries it", () => {
    const { blocked } = gateActions(
      withAction(pageAction, {
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-vercel",
            claim: "Railway and Vercel both deploy from a repository.",
            suggestedEdit: "Leave this page alone for now.",
          },
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway stops an idle container; Render keeps it running.",
            suggestedEdit: "Name the per-request billing Render now offers.",
            proposedText: EXACT_COPY,
          },
        ],
      }),
      context(),
    );
    expect(blocked).toEqual([]);
  });
});

describe("telling copy from a note about copy", () => {
  it("accepts a finished line", () => {
    expect(
      copyFault(
        "Render bills a web service per request once it goes idle. Railway stops an idle container and bills it by the minute while it is awake.",
      ),
    ).toBeNull();
  });

  it("accepts a table row, which is what a comparison table needs back", () => {
    expect(
      copyFault("| Per-request billing | Yes, on idle web services | No, Railway bills by the minute |"),
    ).toBeNull();
    // Three short cells are a finished row, so the length floor does not apply.
    expect(copyFault("| Per-request billing | Yes | No |")).toBeNull();
  });

  /** A migrate page is a how-to, and its own copy is written in imperatives. */
  it("accepts an instruction to the reader, which is what a migrate page says", () => {
    expect(
      copyFault("Add your environment variables to the Railway service before the first deploy."),
    ).toBeNull();
  });

  it("accepts copy that names a variable, which is not a blank", () => {
    expect(
      copyFault("Railway sets ${PORT} on every service, and your app binds to it on start."),
    ).toBeNull();
  });

  it("accepts copy that links out, which is copy and not a placeholder", () => {
    expect(
      copyFault(
        "Railway stops an idle container. See [Serverless](https://docs.railway.com/deployments/serverless) for how it wakes.",
      ),
    ).toBeNull();
  });

  it("refuses a fragment too short to be the line anybody pastes", () => {
    expect(copyFault("Per-request billing.")).toBe("too_short");
  });

  it("refuses an instruction, however detailed", () => {
    expect(copyFault("Update this row to say Render now bills per request on idle services.")).toBe(
      "instruction",
    );
  });

  it("refuses copy with a gap left in it", () => {
    expect(copyFault("Render bills per request on idle web services, and Railway {fills this in}.")).toBe(
      "placeholder",
    );
  });

  it("reads nothing at all as nothing written", () => {
    expect(copyFault(undefined)).toBe("missing");
    expect(copyFault("   ")).toBe("missing");
  });
});

describe("what a reader gets when everything is dropped", () => {
  it("says there is nothing to do, and why, rather than going out blank", () => {
    const { analysis: gated } = gateActions(
      withAction(enhancing({ evidenceUrl: "https://docs.railway.com/invented-page" })),
      context(),
    );

    expect(gated.actions).toEqual([]);
    expect(gated.noActionReason).toContain("survived the evidence checks");
    expect(gated.openQuestions.length).toBeGreaterThan(0);
  });
});

describe("matching a quote to the page it came off", () => {
  it("accepts a quote whose punctuation drifted", () => {
    expect(quoteAppearsOn("Railway bills a container by the minute", SERVERLESS_TEXT)).toBe(true);
    expect(quoteAppearsOn("Railway bills a container, by the minute!", SERVERLESS_TEXT)).toBe(
      true,
    );
  });

  it("accepts a quote joined by an ellipsis, with both halves on the page", () => {
    expect(
      quoteAppearsOn("Serverless stops a service's container ... starts again on the next request", SERVERLESS_TEXT),
    ).toBe(true);
  });

  it("refuses a paraphrase", () => {
    expect(quoteAppearsOn("Railway charges per minute for sleeping services", SERVERLESS_TEXT)).toBe(
      false,
    );
  });

  it("refuses a fragment too short to prove anything", () => {
    expect(quoteAppearsOn("the", SERVERLESS_TEXT)).toBe(false);
  });
});
