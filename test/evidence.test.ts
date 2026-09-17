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
import { allowedWords, measureEdit, MIN_ADDED_WORDS } from "../src/analysis/proportion.js";
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
 * is dropped, and what stopped it becomes the verdict a reader sees – or an
 * open question, when other actions survived to carry the alert.
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
    // The verdict carries the reason, so it is not said twice.
    expect(gated.noAction?.reason).toContain("does not say what Railway cannot do");
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

/**
 * The mistake this stops is the one Railway issue #27 filed: a true, well
 * written paragraph about Vercel's new CDN pricing pasted into a paragraph of
 * the compare page that ran to two sentences. Every other check passed it,
 * because every other check asks whether the edit is right rather than whether
 * it is the size of the thing being fixed.
 */
describe("how much a page edit may add", () => {
  const COMPARE_URL = "https://docs.railway.com/platform/compare-to-vercel";

  /** A page with paragraphs the length a compare page actually writes them. */
  const PAGE_TEXT = [
    "Vercel and Railway both deploy from a repository, and they meter what runs very differently.",
    "This makes it possible for you to pay for what you use. However, since Vercel runs on AWS, the unit economics of the business need to be high to offset the cost of the underlying infrastructure. Those extra costs are then passed down to you as the user, so you end up paying extra for resources such as bandwidth, memory, CPU and storage.",
    "Railway follows a usage-based pricing model that depends on how long your service runs and the amount of resources it consumes.",
    "Both platforms give you a managed Postgres with daily backups, and both run a build on every push to the branch you deploy from.",
  ].join("\n\n");

  const CLAIM =
    "Those extra costs are then passed down to you as the user, so you end up paying extra for resources such as bandwidth, memory, CPU and storage.";

  /** One clause, which is what the launch actually makes the page wrong about. */
  const IN_PROPORTION = `${CLAIM.replace(" bandwidth,", "")} Bandwidth is the exception on Pro, where a flat rate now covers CDN requests and data transfer.`;

  /** The same correction with the competitor's launch post written out around it. */
  const A_DUMP = `${IN_PROPORTION} Vercel's Flat Rate CDN bundles CDN requests and data transfer into a fixed monthly fee, with the default tier included in the plan and higher tiers for more capacity, so a traffic spike does not turn into an overage. On Railway, egress is billed at $0.05/GB and CDN caching is available on all plans at no additional cost, so a cached response is served from the edge and incurs no egress at all.`;

  const pageIndex = (): CorpusIndex =>
    corpusIndex([
      { url: COMPARE_URL, title: "Compare to Vercel", kind: "marketing", text: PAGE_TEXT },
      { url: "https://docs.railway.com/networking/cdn", title: "CDN", text: "Railway caches a response at the edge on every plan." },
    ]);

  const pageEdit = (proposedText: string): Analysis =>
    withAction(
      {
        type: "update_pages",
        detail:
          "On the compare to vercel page, say Vercel's flat rate CDN now covers requests and transfer, and that Railway caches at the edge on every plan.",
      },
      {
        summary: "Vercel put CDN requests and data transfer on a flat monthly rate.",
        railwayRefs: [
          {
            url: COMPARE_URL,
            claim: CLAIM,
            suggestedEdit: "Answer the flat rate CDN on the bandwidth line.",
            proposedText,
            editKind: "replace",
          },
        ],
      },
    );

  const gate = (proposedText: string) =>
    gateActions(pageEdit(proposedText), { index: pageIndex(), seenUrls: new Set([COMPARE_URL]) });

  it("files a correction the size of the passage it lands in", () => {
    const { analysis: gated, blocked } = gate(IN_PROPORTION);
    expect(blocked).toEqual([]);
    expect(gated.actions).toHaveLength(1);
  });

  it("drops an edit that puts a write-up of the launch on the page", () => {
    const { analysis: gated, blocked } = gate(A_DUMP);

    expect(gated.actions).toEqual([]);
    expect(blocked[0]?.cause).toBe("page_edit_out_of_proportion");
    expect(blocked[0]?.reason).toContain("out of proportion to the page it goes on");
    // The numbers are the whole argument, so the reader is given them.
    expect(blocked[0]?.reason).toMatch(/puts \d+ words onto a \d+-word passage/);
    expect(blocked[0]?.urls).toEqual([COMPARE_URL]);
  });

  it("says a page that needs no write-up is not a gap, and points at the page", () => {
    const { analysis: gated } = gate(A_DUMP);

    expect(gated.noAction?.kind).toBe("not_a_gap");
    expect(gated.noAction?.reason).toContain("No page edit is filed here");
    expect(gated.noAction?.reason).toMatch(/\d+-word passage/);
  });

  it("lets a sentence or two onto a page too short to have room for anything", () => {
    const short = corpusIndex([
      {
        url: COMPARE_URL,
        title: "Compare to Vercel",
        kind: "marketing",
        text: "Vercel meters functions. Railway meters a container by the minute.",
      },
    ]);
    const copy =
      "Railway meters a container by the minute, and a flat rate now covers Vercel's CDN requests and data transfer.";

    const { blocked } = gateActions(
      withAction(
        {
          type: "update_pages",
          detail:
            "On the compare to vercel page, say a flat rate now covers Vercel's CDN requests and data transfer.",
        },
        {
          summary: "Vercel put CDN requests and data transfer on a flat monthly rate.",
          railwayRefs: [
            {
              url: COMPARE_URL,
              claim: "Railway meters a container by the minute.",
              suggestedEdit: "Answer the flat rate CDN.",
              proposedText: copy,
              editKind: "replace",
            },
          ],
        },
      ),
      { index: short, seenUrls: new Set([COMPARE_URL]) },
    );

    expect(blocked).toEqual([]);
  });
});

describe("measuring one page edit against its page", () => {
  const PAGE_TEXT = [
    "Railway and Render both run your containers.",
    "Railway stops an idle container and bills it by the minute while it is awake. Render keeps a web service running until you scale it down yourself.",
    "Both platforms give you a managed Postgres with daily backups.",
  ].join("\n\n");

  const CLAIM = "Render keeps a web service running until you scale it down yourself.";

  it("counts what the edit adds, the passage it lands in, and the whole page", () => {
    const measured = measureEdit(
      {
        url: "https://docs.railway.com/platform/compare-to-render",
        claim: CLAIM,
        proposedText: `${CLAIM} It bills that service per request once it goes idle.`,
      },
      PAGE_TEXT,
    )!;

    // The kept sentence is the page's, so only the new one counts as added.
    expect(measured.added).toBe(10);
    expect(measured.passage).toBe(27);
    expect(measured.page).toBe(44);
  });

  it("measures an insert as all of it arriving, because an insert removes nothing", () => {
    const inserted = measureEdit(
      {
        url: "https://docs.railway.com/platform/compare-to-render",
        claim: CLAIM,
        proposedText: CLAIM,
        editKind: "insert",
      },
      PAGE_TEXT,
    )!;
    expect(inserted.added).toBe(12);
  });

  it("allows the passage's own length, a fifth of the page, and never less than a sentence or two", () => {
    // A long page is bounded by the passage the edit lands in.
    expect(allowedWords(60, 2_000)).toBe(60);
    // A long passage on a short page is bounded by the page.
    expect(allowedWords(400, 600)).toBe(120);
    // Both bounds are below the floor, which is what a short page gets.
    expect(allowedWords(20, 120)).toBe(MIN_ADDED_WORDS);
  });

  it("measures nothing without copy, and nothing without a stored page to measure against", () => {
    const ref = {
      url: "https://docs.railway.com/platform/compare-to-render",
      claim: CLAIM,
      proposedText: "Copy long enough to be a line somebody would paste on the page.",
    };
    expect(measureEdit({ ...ref, proposedText: undefined }, PAGE_TEXT)).toBeNull();
    expect(measureEdit(ref, undefined)).toBeNull();
    expect(measureEdit(ref, "   ")).toBeNull();
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
  /**
   * The verdict names the gap that was claimed and the check it failed, which
   * is the difference between "Railway ships this" and "nobody could tell".
   */
  it("says the gap could not be confirmed, and which check said so", () => {
    const { analysis: gated } = gateActions(
      withAction(enhancing({ evidenceUrl: "https://docs.railway.com/invented-page" })),
      context(),
    );

    expect(gated.actions).toEqual([]);
    expect(gated.noAction?.kind).toBe("unverified");
    expect(gated.noAction?.reason).toContain("as a gap, but it cites");
    expect(gated.noAction?.reason).toContain("not a page in Railway's docs corpus");
    expect(gated.noActionReason).toBe(gated.noAction?.reason);
  });

  /**
   * "Railway already does this" is the answer a reader is after, so a gap the
   * corpus answers on a page nobody opened says exactly that, with the page.
   */
  it("says Railway already does this when the docs answer the gap elsewhere", () => {
    const { analysis: gated } = gateActions(
      withAction(
        enhancing({
          feature: "Enterprise and compliance",
          detail: "Add a consent decision per workspace so analytics can be turned off.",
          gap: "Railway records no analytics consent decision and honors no do-not-track header",
          evidenceUrl: "https://docs.railway.com/volumes",
          evidenceQuote: "A volume attaches a persistent disk to exactly one service.",
        }),
      ),
      context(),
    );

    expect(gated.actions).toEqual([]);
    expect(gated.noAction?.kind).toBe("already_covered");
    expect(gated.noAction?.reason).toContain("Railway documents this already");
    // Titled off the corpus row, so the link reads as the page rather than a URL.
    expect(gated.noAction?.evidence).toEqual([
      { url: "https://docs.railway.com/enterprise/privacy", title: "Privacy and consent" },
    ]);
  });

  /**
   * A gap about money is not a gap at all, and saying "could not be confirmed"
   * about one would invite somebody to go and confirm it.
   */
  it("says not a product gap when the only thing recommended was about price", () => {
    const { analysis: gated } = gateActions(
      withAction(enhancing({ gap: "Render's free tier is cheaper than Railway's" })),
      context(),
    );

    expect(gated.actions).toEqual([]);
    expect(gated.noAction?.kind).toBe("not_a_gap");
    expect(gated.noAction?.reason).toContain("what a competitor charges");
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
