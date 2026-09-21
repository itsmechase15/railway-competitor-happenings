import { describe, expect, it } from "vitest";
import { buildIssueBody } from "../src/github/issue.js";
import type { RailwayDoc, RecommendedAction } from "../src/types.js";
import { alert, analysis, featureImage } from "./helpers.js";

/**
 * Two sections on an issue name Railway pages and they mean opposite things:
 * the pages the recommendation was read against, and the pages somebody
 * rewrites the day Railway ships it. The first one is empty on most
 * consider_building actions, because a capability Railway does not ship is a
 * capability Railway has not written about – and the line that said so used to
 * read as a lookup that fell over.
 */
describe("the pages an issue cites", () => {
  const building: RecommendedAction = {
    type: "consider_building",
    detail: "Build a request meter so an idle service costs nothing.",
    gap: "no per-request billing anywhere in Railway",
    evidenceUrl: "https://docs.railway.com/deployments/serverless",
    evidenceQuote: "Railway bills a container by the minute while it is awake.",
  };

  const body = (action: RecommendedAction, docs?: RailwayDoc[]): string =>
    buildIssueBody(
      alert({
        analysis: analysis({ actions: [action], railwayRefs: [] }),
        ...(docs ? { docs } : {}),
      }),
      featureImage(),
      action,
    );

  it("says the docs are quiet because Railway does not ship this, not because nothing loaded", () => {
    const text = body(building);
    expect(text).toContain("## Railway docs this was checked against");
    expect(text).toContain("Railway's docs have no page on this capability");
    expect(text).toContain("rather than a search that came back empty");
    // The evidence is not repeated here; it is quoted under the gap.
    expect(text).toContain('quoted under "The gap this closes" above');
  });

  it("names the section for what the pages are, not for the mood they set", () => {
    const text = body({
      ...building,
      type: "consider_enhancing",
      feature: "Serverless",
    });
    expect(text).not.toContain("Railway docs for context");
  });

  it("keeps the pages read apart from the pages that would change", () => {
    const text = body(building, [
      {
        url: "https://docs.railway.com/deployments/serverless",
        title: "Serverless",
        excerpt: "Railway bills a container by the minute while it is awake.",
      },
    ]);

    const checked = text.indexOf("## Railway docs this was checked against");
    const changed = text.indexOf("## Docs that would change if this ships");
    expect(checked).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(checked);
    expect(text).toContain("- https://docs.railway.com/deployments/serverless");
  });

  it("tells a page action there is no page to paste onto, and that this is the finding", () => {
    const text = body({
      type: "update_pages",
      detail: "On the compare to render page, answer their per-request billing.",
    });
    expect(text).toContain("## Railway pages to update");
    expect(text).toContain("there is no page here to paste copy onto");
    expect(text).toContain("is itself worth a look");
  });
});
