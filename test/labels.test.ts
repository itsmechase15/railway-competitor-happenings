import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL,
  ACTION_OWNER,
  actionLabel,
  actionOwner,
  actionTitleParts,
  IMPACT_COLOR,
  IMPACT_LABEL,
  IMPACT_MEANING,
  SOURCE_LABEL,
} from "../src/labels.js";
import { ACTIONS, IMPACTS, type SourceId } from "../src/types.js";

/**
 * The plan fixes four source labels and three actions. They are what the
 * embed, the footer, and every issue label are built from, so a rename here
 * silently changes what a reader sees and what a saved GitHub filter matches.
 */
describe("source labels", () => {
  it("uses the four labels the plan fixes", () => {
    expect(SOURCE_LABEL).toEqual({
      changelog: "changelog",
      blog: "article",
      x: "tweet",
      newsletter: "newsletter",
    });
  });

  it("names a blog post by what the reader lands on, not by where we found it", () => {
    const source: SourceId = "blog";
    expect(SOURCE_LABEL[source]).toBe("article");
  });
});

describe("impact labels", () => {
  it("labels every level, and only Minor, Notable, and Major", () => {
    expect(IMPACTS.map((impact) => IMPACT_LABEL[impact])).toEqual(["Minor", "Notable", "Major"]);
  });

  it("says what each level means, so an issue can show the whole scale", () => {
    expect(IMPACT_MEANING.minor).toMatch(/no new feature or enhancement/);
    expect(IMPACT_MEANING.notable).toMatch(/enhancement of a feature they already had/);
    expect(IMPACT_MEANING.major).toMatch(/brand-new feature/);
  });

  it("gives every level a distinct embed color", () => {
    const colors = IMPACTS.map((impact) => IMPACT_COLOR[impact]);
    expect(new Set(colors).size).toBe(IMPACTS.length);
  });
});

describe("action labels", () => {
  it("labels the three actions the plan allows", () => {
    expect(ACTION_LABEL).toEqual({
      consider_enhancing: "Consider enhancing",
      consider_building: "Consider building",
      update_pages: "Update pages",
    });
  });

  it("routes page work to marketing and product work to product", () => {
    expect(ACTIONS.map((action) => ACTION_OWNER[action])).toEqual([
      "product",
      "product",
      "marketing",
    ]);
    expect(actionOwner({ type: "update_pages", detail: "x" })).toBe("marketing");
  });

  it("puts the Railway surface in a consider_enhancing title, with its docs page", () => {
    const parts = actionTitleParts({
      type: "consider_enhancing",
      feature: "serverless",
      detail: "Add per-request billing.",
    });
    // The model's casing is replaced by the catalog's, so "serverless" reads
    // as the product it names.
    expect(parts).toEqual({
      label: "Consider enhancing",
      feature: { label: "Serverless", url: "https://docs.railway.com/deployments/serverless" },
    });
  });

  it("keeps an unrecognized feature as written, and unlinked", () => {
    const parts = actionTitleParts({
      type: "consider_enhancing",
      feature: "Quantum tunnels",
      detail: "Add quantum tunnels.",
    });
    expect(parts.feature).toEqual({ label: "Quantum tunnels", url: undefined });
  });

  it("leaves the other two actions without a feature in the title", () => {
    expect(actionLabel({ type: "consider_building", detail: "x", feature: "Scaling" })).toBe(
      "Consider building",
    );
    expect(actionLabel({ type: "update_pages", detail: "x" })).toBe("Update pages");
  });
});
