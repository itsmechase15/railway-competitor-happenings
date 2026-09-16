import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evidenceFor,
  MAX_NO_ACTION_LINKS,
  noActionOf,
  noActionTitle,
  renderNoAction,
  UNSTATED_NO_ACTION_REASON,
  withNoAction,
} from "../src/analysis/noAction.js";
import { NO_ACTION_KINDS, type Analysis, type NoAction } from "../src/types.js";
import { analysis as fixture, corpusIndex } from "./helpers.js";

const SERVERLESS = "https://docs.railway.com/deployments/serverless";
const SCALING = "https://docs.railway.com/deployments/scaling";

const covered: NoAction = {
  kind: "already_covered",
  reason:
    "Render's per-request billing for idle services matches what Railway Serverless already does: a container stops when it has no inbound traffic and starts again on the next request.",
  evidence: [
    { url: SERVERLESS, title: "Serverless" },
    { url: SCALING, title: "Scaling" },
  ],
};

const empty: Analysis = fixture({ actions: [], railwayRefs: [], openQuestions: [] });

describe("noActionTitle", () => {
  it("names which kind of nothing this is, for every kind", () => {
    for (const kind of NO_ACTION_KINDS) {
      const title = noActionTitle(kind);
      expect(title.startsWith("None")).toBe(true);
      expect(title).not.toBe("None");
    }
  });

  it("writes the dash this bot writes, with a space either side", () => {
    expect(noActionTitle("already_covered")).toBe("None – Railway already does this");
    expect(noActionTitle("already_covered")).not.toContain("—");
  });
});

describe("renderNoAction", () => {
  it("leads with the title, then the sentence, then the pages", () => {
    expect(renderNoAction(covered)).toBe(
      [
        "**None – Railway already does this**",
        covered.reason,
        `See: [Serverless](${SERVERLESS}), [Scaling](${SCALING})`,
      ].join("\n"),
    );
  });

  it("escapes what the surface asks it to escape, and never a URL", () => {
    const rendered = renderNoAction(
      { kind: "not_a_gap", reason: "Pricing *news* and nothing else.", evidence: [] },
      { escape: (text) => text.replace(/([*_`~|\\])/g, "\\$1") },
    );
    expect(rendered).toContain("Pricing \\*news\\* and nothing else.");
  });

  it("leaves a link's URL alone when the surface escapes everything else", () => {
    const rendered = renderNoAction(covered, {
      escape: (text) => text.replace(/([*_`~|\\])/g, "\\$1"),
    });
    expect(rendered).toContain(`(${SERVERLESS})`);
  });

  it("falls back to the page's path when the corpus held no title", () => {
    const rendered = renderNoAction({
      kind: "already_covered",
      reason: "Railway sleeps an idle container already.",
      evidence: [{ url: SERVERLESS }],
    });
    expect(rendered).toContain(`[the serverless page](${SERVERLESS})`);
  });

  it("caps the pages, so the block stays an alert rather than a reading list", () => {
    const many: NoAction = {
      kind: "already_covered",
      reason: "Railway ships all of this.",
      evidence: [1, 2, 3, 4, 5].map((index) => ({
        url: `https://docs.railway.com/page-${index}`,
        title: `Page ${index}`,
      })),
    };
    expect(renderNoAction(many).match(/docs\.railway\.com/g)).toHaveLength(MAX_NO_ACTION_LINKS);
  });

  it("leaves the See line off a verdict with no pages under it", () => {
    const rendered = renderNoAction({
      kind: "not_a_gap",
      reason: "This post is about a new office.",
      evidence: [],
    });
    expect(rendered).not.toContain("See:");
  });

  it("drops an evidence entry that is not a link anybody can open", () => {
    const rendered = renderNoAction({
      kind: "already_covered",
      reason: "Railway ships this.",
      evidence: [{ url: "deployments/serverless", title: "Serverless" }],
    });
    expect(rendered).not.toContain("See:");
  });

  it("cuts a reason long enough to break an embed field", () => {
    const rendered = renderNoAction(
      { kind: "unverified", reason: "word ".repeat(400), evidence: [] },
      { maxChars: 600 },
    );
    expect(rendered.length).toBeLessThan(700);
  });

  it("names the product the caller asked it to name", () => {
    expect(renderNoAction(covered, { product: "Railway" })).toContain("Railway already does this");
  });
});

describe("noActionOf", () => {
  it("reads the verdict when the analysis carries one", () => {
    expect(noActionOf(withNoAction(empty, covered)).kind).toBe("already_covered");
  });

  /**
   * Fail-soft on a row written before the verdict had a shape: the sentence is
   * all it has, so it renders as the unconfirmed verdict it always was rather
   * than claiming pages nobody stored.
   */
  it("reads a row stored as one sentence as a verdict nobody confirmed", () => {
    const stored = { ...empty, noActionReason: "Railway already sleeps idle containers." };
    expect(noActionOf(stored)).toEqual({
      kind: "unverified",
      reason: "Railway already sleeps idle containers.",
      evidence: [],
    });
  });

  it("says which part is missing when there is no verdict at all", () => {
    expect(noActionOf(empty).reason).toBe(UNSTATED_NO_ACTION_REASON);
  });
});

describe("withNoAction", () => {
  it("writes the sentence next to the structure, so the two cannot disagree", () => {
    const written = withNoAction(empty, covered);
    expect(written.noAction).toEqual(covered);
    expect(written.noActionReason).toBe(covered.reason);
  });
});

describe("evidenceFor", () => {
  it("labels a page with the title the corpus holds for it", () => {
    const index = corpusIndex([{ url: SERVERLESS, title: "Serverless" }]);
    expect(evidenceFor(index, SERVERLESS)).toEqual({ url: SERVERLESS, title: "Serverless" });
  });

  it("names a page the corpus does not hold without inventing a title for it", () => {
    const index = corpusIndex([{ url: SCALING }]);
    expect(evidenceFor(index, SERVERLESS)).toEqual({ url: SERVERLESS });
  });
});

/**
 * The platitudes this feature exists to delete, checked by grep.
 *
 * Each of these was true, said nothing, and read like a bug: a reader who saw
 * one could not tell whether Railway ships the thing, whether the launch was
 * irrelevant, or whether the run had fallen over. A verdict has a kind, a
 * sentence about this launch, and the pages it rests on, so there is nothing
 * left for a generic line to do.
 */
describe("no generic no-action copy survives in src/", () => {
  const BANNED = ["survived the evidence checks", "no reason was recorded", "did not say why"];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith(".ts") ? [path] : [];
    });
  }

  for (const phrase of BANNED) {
    it(`says nothing anywhere that reads "${phrase}"`, () => {
      const offenders = sourceFiles("src").filter((path) =>
        readFileSync(path, "utf8").includes(phrase),
      );
      expect(offenders).toEqual([]);
    });
  }
});
