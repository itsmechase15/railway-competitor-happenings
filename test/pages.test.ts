import { describe, expect, it } from "vitest";
import { enforcePageTargets } from "../src/analysis/relevance.js";
import {
  COMPARE_AND_MIGRATE_PATHS,
  isDocsUrl,
  isMarketingTarget,
  MARKETING_PAGE_URLS,
} from "../src/railway/pages.js";
import { CANONICAL_DOC_URLS } from "../src/railway/products.js";
import { analysis } from "./helpers.js";

/**
 * The one rule this bot must never break: Railway's product docs are the
 * evidence a recommendation is checked against, never a page it asks anyone to
 * edit. The awkward part is that Railway's compare and migrate pages live on
 * docs.railway.com too, so the rule is an explicit path allowlist rather than
 * "docs host bad, marketing host good".
 */
describe("what update_pages may target", () => {
  it("allows the four compare and migrate pages", () => {
    for (const path of COMPARE_AND_MIGRATE_PATHS) {
      expect(isMarketingTarget(`https://docs.railway.com${path}`), path).toBe(true);
    }
  });

  it("allows pricing and the features pages on railway.com", () => {
    expect(isMarketingTarget("https://railway.com/pricing")).toBe(true);
    expect(isMarketingTarget("https://railway.com/features/serverless")).toBe(true);
  });

  it("refuses every product docs page, including the ones an action cites", () => {
    for (const url of CANONICAL_DOC_URLS) {
      expect(isMarketingTarget(url), url).toBe(false);
      expect(isDocsUrl(url), url).toBe(true);
    }
  });

  it("refuses a docs page that merely looks like a compare page", () => {
    expect(isMarketingTarget("https://docs.railway.com/platform/compare-to-heroku")).toBe(false);
    expect(isMarketingTarget("https://docs.railway.com/deployments/compare-to-render")).toBe(false);
  });

  it("refuses a page on somebody else's site", () => {
    expect(isMarketingTarget("https://render.com/docs/migrate-from-railway")).toBe(false);
    expect(isMarketingTarget("https://vercel.com/compare/railway")).toBe(false);
  });

  it("refuses nonsense rather than throwing", () => {
    expect(isMarketingTarget("not a url")).toBe(false);
    expect(isDocsUrl("")).toBe(false);
  });

  it("treats a compare page as copy, not as evidence about the product", () => {
    expect(isDocsUrl("https://docs.railway.com/platform/compare-to-render")).toBe(false);
  });

  it("ignores a trailing slash, which is the same page", () => {
    expect(isMarketingTarget("https://docs.railway.com/platform/compare-to-vercel/")).toBe(true);
  });

  it("indexes every allowlisted page, so a page action always has a claim to cite", () => {
    for (const url of MARKETING_PAGE_URLS) {
      expect(isMarketingTarget(url), url).toBe(true);
    }
  });
});

describe("the guard that drops a page edit aimed at the docs", () => {
  it("drops an update_pages action whose only suggested edit is a docs page", () => {
    const { analysis: guarded, notes } = enforcePageTargets(
      analysis({
        actions: [{ type: "update_pages", detail: "Rewrite the serverless docs to mention this." }],
        railwayRefs: [
          {
            url: "https://docs.railway.com/deployments/serverless",
            claim: "Serverless sleeps idle containers.",
            suggestedEdit: "Say Render now bills per request.",
          },
        ],
      }),
    );

    expect(guarded.actions).toHaveLength(0);
    expect(notes[0]).toContain("product docs pages");
  });

  it("keeps it when at least one suggested edit is a page marketing owns", () => {
    const { analysis: guarded, notes } = enforcePageTargets(
      analysis({
        actions: [
          { type: "update_pages", detail: "On the compare to render page, answer their claim." },
        ],
        railwayRefs: [
          {
            url: "https://docs.railway.com/platform/compare-to-render",
            claim: "Railway and Render both scale vertically.",
            suggestedEdit: "Name the memory-optimized plans Render now sells.",
          },
        ],
      }),
    );

    expect(guarded.actions).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("leaves a product action alone: it was never pointed at a page", () => {
    const verdict = analysis();
    expect(enforcePageTargets(verdict).analysis.actions).toHaveLength(1);
  });
});
