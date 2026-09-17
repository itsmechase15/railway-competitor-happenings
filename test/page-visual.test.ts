import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  blobUrl,
  carriesCredential,
  createArtifactWriter,
  GitHubArtifactWriter,
  LocalArtifactWriter,
  type ArtifactWriter,
} from "../src/github/artifact.js";
import { buildIssueBody, buildIssueDrafts } from "../src/github/issue.js";
import { afterSpans, diffSummary, diffWords, words } from "../src/media/diff.js";
import type { CaptureResult } from "../src/media/live-page.js";
import {
  copyRuns,
  looseSpan,
  paragraphWith,
  planPageEdit,
  visualPaths,
  VISUAL_DIR,
  type PageVisual,
} from "../src/media/page-edit.js";
import {
  commitMessage,
  createPageVisualMaker,
  DisabledPageVisualMaker,
  plansFor,
  publishCapture,
} from "../src/media/visual.js";
import type { AnalyzedItem, RailwayRef, RecommendedAction } from "../src/types.js";
import { alert, analysis, corpusIndex, featureImage, storedItem } from "./helpers.js";

/** The paragraph the compare page has today, as the corpus stores it. */
const PAGE_TEXT = [
  "Railway and Render both run your containers, but they bill idle time differently.",
  "Railway stops an idle container and bills it by the minute while it is awake. Render keeps a web service running until you scale it down yourself.",
  "Both platforms give you a managed Postgres with daily backups.",
].join("\n\n");

const CLAIM = "Render keeps a web service running until you scale it down yourself.";

const PROPOSED =
  "Render now bills a web service per request once it goes idle, so a quiet service costs close to nothing between requests.";

const COMPARE_URL = "https://docs.railway.com/platform/compare-to-render";

/** The day a capture is stamped with, fixed so a test is not a clock. */
const TODAY = "2026-09-16";

const ref = (overrides: Partial<RailwayRef> = {}): RailwayRef => ({
  url: COMPARE_URL,
  claim: CLAIM,
  suggestedEdit: "Name the per-request billing Render now offers.",
  proposedText: PROPOSED,
  ...overrides,
});

const pageAction = (overrides: Partial<RecommendedAction> = {}): RecommendedAction => ({
  type: "update_pages",
  detail: "On the compare to render page, say Render now bills an idle service per request.",
  ...overrides,
});

const plan = (overrides: Partial<RailwayRef> = {}) => planPageEdit(ref(overrides), PAGE_TEXT, TODAY)!;

describe("the word diff a before/after is measured with", () => {
  it("splits text into words that join back into the original", () => {
    const text = "Railway stops an idle container.";
    expect(words(text).join("")).toBe(text);
  });

  it("marks only the words that changed, and keeps the rest as one run", () => {
    const spans = diffWords("Railway bills by the minute.", "Railway bills by the second.");
    expect(spans.map((span) => span.kind)).toEqual(["same", "removed", "added"]);
    expect(spans[0]?.text).toBe("Railway bills by the ");
  });

  it("ignores punctuation and casing when deciding a word survived", () => {
    const spans = diffWords("Railway bills by the minute", "railway bills, by the minute.");
    expect(spans.every((span) => span.kind === "same")).toBe(true);
    expect(diffSummary(spans)).toBe("no words changed, only punctuation or casing");
  });

  it("counts what changed in words, so the line reads as a size", () => {
    expect(diffSummary(diffWords("a b c", "a b c d e"))).toBe("2 words added");
    expect(diffSummary(diffWords("a b c d", "a b"))).toBe("2 words removed");
    expect(diffSummary(diffWords("a b c", "a x y"))).toBe("2 words added, 2 words removed");
    expect(diffSummary(diffWords("a b", "a b c"))).toBe("1 word added");
  });

  it("reads an empty side as the whole of the other one arriving or leaving", () => {
    expect(diffWords("", "new copy")).toEqual([{ kind: "added", text: "new copy" }]);
    expect(diffWords("old copy", "")).toEqual([{ kind: "removed", text: "old copy" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("gives up on word-level detail for a whole section swap, and says so in blocks", () => {
    const long = Array.from({ length: 700 }, (_, index) => `word${index}`).join(" ");
    const spans = diffWords(long, "something much shorter");
    expect(spans.map((span) => span.kind)).toEqual(["removed", "added"]);
  });
});

/**
 * The After shot paints the edit and nothing else, and what makes that hard is
 * that most replacements keep some of the line they replace. Marking the whole
 * of the proposed copy credited the bot with the page's own sentences, which is
 * what a reader glancing at a thumbnail reads off it.
 */
describe("which words of the copy are new to the page", () => {
  /** The shape a page edit usually has: the line today, kept, with a sentence added. */
  const ADDED = "Bandwidth is the exception, where a flat rate covers requests and transfer.";
  const GROWN = `${CLAIM} ${ADDED}`;

  const runs = (proposed: string, editKind: "replace" | "insert" = "replace") =>
    copyRuns(CLAIM, proposed, editKind)[0]!;

  const painted = (proposed: string, editKind: "replace" | "insert" = "replace") =>
    runs(proposed, editKind)
      .filter((run) => run.isNew)
      .map((run) => run.text);

  it("puts every word of the copy in a run, so the page gets the copy as written", () => {
    expect(runs(GROWN).map((run) => run.text).join("")).toBe(GROWN);
    expect(afterSpans(CLAIM, GROWN).map((span) => span.text).join("")).toBe(GROWN);
  });

  it("leaves the sentence the copy kept from the page unpainted", () => {
    expect(painted(GROWN)).toEqual([ADDED]);
    expect(runs(GROWN)[0]).toMatchObject({ isNew: false });
    expect(runs(GROWN)[0]?.text).toContain("keeps a web service running");
  });

  it("paints a replacement that keeps nothing of the old line, which is all of it", () => {
    const outright =
      "Idle containers now cost nothing between requests, and each invocation is metered on its own.";
    expect(painted(outright)).toEqual([outright]);
  });

  it("closes over a word or two the copy shares, and leaves the word it opens on plain", () => {
    // "a web service" and "it" are in both lines, and painting around each of
    // them would break one new sentence into three marks. The word the copy
    // opens on is where the page's prose runs into the edit, so it stays plain.
    const reworded = "Render bills a web service per request once it goes idle.";
    expect(painted(reworded)).toEqual(["bills a web service per request once it goes idle."]);
  });

  it("paints an insert in full, because an insert takes nothing off the page", () => {
    expect(painted(CLAIM, "insert")).toEqual([CLAIM]);
  });

  it("paints every paragraph after the first in full, because each is a new block", () => {
    const second = "Railway caches a response at the edge on every plan.";
    const [first, next] = copyRuns(CLAIM, `${GROWN}\n\n${CLAIM} ${second}`, "replace");
    expect(first?.filter((run) => run.isNew).map((run) => run.text)).toEqual([ADDED]);
    expect(next?.every((run) => run.isNew)).toBe(true);
  });

  it("keeps the space around a run outside the mark, so no highlight trails off a sentence", () => {
    for (const run of runs(GROWN).filter((entry) => entry.isNew)) {
      expect(run.text).toBe(run.text.trim());
    }
  });

  it("carries the runs on the plan, so the browser is told rather than asked to work it out", () => {
    expect(plan({ proposedText: GROWN }).copy).toEqual(copyRuns(CLAIM, GROWN, "replace"));
  });
});

describe("finding the line on the stored page", () => {
  it("finds a quote that differs from the page by punctuation or spacing", () => {
    const paragraph = "Railway  stops an idle container, and bills it by the minute.";
    expect(
      looseSpan(paragraph, "Railway stops an idle container and bills it by the minute"),
    ).not.toBeNull();
    expect(looseSpan(paragraph, "Railway runs it forever")).toBeNull();
  });

  it("takes the full stop that closes the quoted sentence with it", () => {
    const paragraph = "Railway bills by the minute. Render does not.";
    const span = looseSpan(paragraph, "Railway bills by the minute")!;
    expect(paragraph.slice(span[0], span[1])).toBe("Railway bills by the minute.");
  });

  it("picks the paragraph the line is on, not the whole page", () => {
    expect(paragraphWith(PAGE_TEXT, CLAIM)).toContain("Railway stops an idle container");
    expect(paragraphWith(PAGE_TEXT, CLAIM)).not.toContain("managed Postgres");
    expect(paragraphWith(PAGE_TEXT, "something no page says")).toBeNull();
  });
});

describe("planning one page edit", () => {
  it("carries the line to look for and the copy to stage in its place", () => {
    expect(plan().claim).toBe(CLAIM);
    expect(plan().proposedText).toBe(PROPOSED);
    expect(plan().editKind).toBe("replace");
  });

  it("measures the edit against the line it replaces", () => {
    expect(plan().summary).toMatch(/words added.*words removed/);
  });

  it("measures an insert as copy arriving, because an insert removes nothing", () => {
    expect(plan({ editKind: "insert" }).summary).not.toContain("removed");
  });

  it("plans nothing without finished copy, or without a line to look for", () => {
    expect(planPageEdit(ref({ proposedText: undefined }), PAGE_TEXT, TODAY)).toBeNull();
    expect(planPageEdit(ref({ proposedText: "   " }), PAGE_TEXT, TODAY)).toBeNull();
    expect(planPageEdit(ref({ claim: "" }), PAGE_TEXT, TODAY)).toBeNull();
  });

  it("records whether the stored page still has the line, so a live miss means something", () => {
    expect(plan().quotedOnStoredPage).toBe(true);
    expect(planPageEdit(ref(), undefined, TODAY)!.quotedOnStoredPage).toBe(false);
    expect(plan({ claim: "A line no stored page has on it." }).quotedOnStoredPage).toBe(false);
  });

  it("names the page, and says in each alt text which shot it is", () => {
    expect(plan().pageName).toBe("Compare to render");
    expect(plan().beforeAlt).toContain("as it reads today");
    expect(plan().afterAlt).toContain("with the proposed copy in it");
    expect(plan().afterAlt).toContain("highlighted in yellow");
    expect(plan().afterAlt).toContain(plan().summary);
  });
});

describe("where the pair is filed", () => {
  it("names two files for the page, under one folder", () => {
    const paths = visualPaths(ref(), TODAY);
    const stem = `${VISUAL_DIR}/platform-compare-to-render-[0-9a-f]{10}`;
    expect(paths.before).toMatch(new RegExp(`^${stem}-before\\.png$`));
    expect(paths.after).toMatch(new RegExp(`^${stem}-after\\.png$`));
  });

  it("lands on the same files when the same edit is photographed again that day", () => {
    expect(visualPaths(ref(), TODAY)).toEqual(visualPaths(ref(), TODAY));
  });

  it("photographs the page afresh on another day, rather than reusing yesterday's before", () => {
    expect(visualPaths(ref(), "2026-09-17").before).not.toBe(visualPaths(ref(), TODAY).before);
  });

  it("takes new files when the copy changes, so an open issue keeps its pictures", () => {
    expect(visualPaths(ref({ proposedText: "Different copy entirely, at length." }), TODAY)).not.toEqual(
      visualPaths(ref(), TODAY),
    );
  });
});

describe("which actions get a picture", () => {
  const index = () =>
    corpusIndex([
      { url: COMPARE_URL, title: "Compare to Render", text: PAGE_TEXT, kind: "marketing" },
    ]);

  const alertFor = (action: RecommendedAction, refs: RailwayRef[] = [ref()]): AnalyzedItem =>
    alert({ analysis: analysis({ actions: [action], railwayRefs: refs }) });

  it("photographs a page edit", () => {
    const plans = plansFor(alertFor(pageAction()), pageAction(), index());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.pageUrl).toBe(COMPARE_URL);
    expect(plans[0]?.quotedOnStoredPage).toBe(true);
  });

  it("never photographs a feature action, because there is no before of a feature", () => {
    for (const type of ["consider_enhancing", "consider_building"] as const) {
      const action: RecommendedAction = { type, feature: "CDN", detail: "Add it." };
      expect(plansFor(alertFor(action), action, index())).toEqual([]);
    }
  });

  it("skips a cited page that is not a page marketing writes", () => {
    const docsRef = ref({ url: "https://docs.railway.com/networking/cdn" });
    expect(plansFor(alertFor(pageAction(), [docsRef]), pageAction(), index())).toEqual([]);
  });

  it("skips a cited page with no copy proposed for it", () => {
    const bare = ref({ proposedText: undefined });
    expect(plansFor(alertFor(pageAction(), [bare]), pageAction(), index())).toEqual([]);
  });

  it("photographs at most two pages, so the copy is not under four screenshots", () => {
    const refs = [
      ref(),
      ref({ url: "https://docs.railway.com/platform/migrate-from-render" }),
      ref({ url: "https://docs.railway.com/platform/compare-to-vercel" }),
    ];
    expect(plansFor(alertFor(pageAction(), refs), pageAction(), index())).toHaveLength(2);
  });

  it("says which shot the commit is, what it is of, and keeps CI out of it", () => {
    const before = commitMessage(alertFor(pageAction()), plan(), "before");
    const after = commitMessage(alertFor(pageAction()), plan(), "after");
    expect(before).toContain("[skip ci]");
    expect(before).toContain(`as it read on ${TODAY}`);
    expect(after).toContain("published nowhere");
    expect(after).toContain(COMPARE_URL);
  });

  it("photographs nothing at all when the switch is off", async () => {
    const off = createPageVisualMaker({ skipPageVisuals: true } as Config, index());
    expect(off).toBeInstanceOf(DisabledPageVisualMaker);
    expect(off.description).toContain("SKIP_PAGE_VISUALS");
    expect(await off.make(alertFor(pageAction()), pageAction())).toEqual([]);
  });
});

describe("publishing what the capture came back with", () => {
  const captured: CaptureResult = {
    status: "captured",
    before: Buffer.from("before png"),
    after: Buffer.from("after png"),
  };

  const writer = (urls: Array<string | null>): ArtifactWriter => {
    const queue = [...urls];
    return {
      description: "a fake",
      write: vi.fn(async () => queue.shift() ?? null),
    };
  };

  const publish = (capture: CaptureResult, artifacts: ArtifactWriter, quoted = true) =>
    publishCapture(
      artifacts,
      alert(),
      { ...plan(), quotedOnStoredPage: quoted },
      capture,
    );

  it("hands back both urls once both pngs are committed", async () => {
    const visual = await publish(captured, writer(["https://github.com/o/r/blob/a/b-before.png?raw=true", "https://github.com/o/r/blob/a/b-after.png?raw=true"]));
    expect(visual?.shots?.beforeUrl).toContain("before");
    expect(visual?.shots?.afterUrl).toContain("after");
    expect(visual?.capturedOn).toBe(TODAY);
  });

  it("drops both when only one of them landed, rather than showing half a comparison", async () => {
    const visual = await publish(captured, writer(["https://github.com/o/r/blob/a/b-before.png?raw=true", null]));
    expect(visual).toBeNull();
  });

  it("drops both when a url would expire out from under the issue", async () => {
    const signed = "https://raw.githubusercontent.com/o/r/main/x.png?token=AJ7VCK";
    const visual = await publish(captured, writer(["https://github.com/o/r/blob/a/b-before.png?raw=true", signed]));
    expect(visual).toBeNull();
  });

  it("says nothing at all when the page could not be loaded", async () => {
    const skipped: CaptureResult = { status: "skipped", reason: "the page answered 503" };
    expect(await publish(skipped, writer([]))).toBeNull();
  });

  it("notes a line the stored page has and the live page does not", async () => {
    const visual = await publish({ status: "missing" }, writer([]));
    expect(visual?.shots).toBeNull();
    expect(visual?.copyMissingLive).toBe(true);
  });

  it("says nothing when the line is on neither, which is not news about the live page", async () => {
    expect(await publish({ status: "missing" }, writer([]), false)).toBeNull();
  });
});

const config = (overrides: Partial<Config>): Config =>
  ({
    dryRun: false,
    githubToken: undefined,
    githubRepo: "itsmechase15/railway-competitor-happenings",
    httpTimeoutMs: 5_000,
    ...overrides,
  }) as Config;

describe("committing the pictures so an issue can render them", () => {
  const png = Buffer.from("not really a png");
  const path = `${VISUAL_DIR}/platform-compare-to-render-abc1234567-before.png`;
  const sha = "9f4c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b";
  const blob = `https://github.com/o/r/blob/${sha}/${path}?raw=true`;

  /**
   * What the contents API actually hands back for a private repo: a raw URL
   * signed with a token that lasts minutes. Nothing may put this in an issue.
   */
  const signedRawUrl = `https://raw.githubusercontent.com/o/r/main/${path}?token=AJ7VCKEXPIRESSOON`;

  const writer = (): GitHubArtifactWriter => new GitHubArtifactWriter("o/r", "ghs-test", 5_000);

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("puts the file and hands back a url pinned to the commit it made", async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(json({ content: { download_url: signedRawUrl }, commit: { sha } }, 201));
    vi.stubGlobal("fetch", spy);

    expect(await writer().write(path, png, "Add the before")).toBe(blob);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/o/r/contents/${path}`);
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(init.body as string) as { content: string; message: string };
    expect(Buffer.from(sent.content, "base64").toString()).toBe("not really a png");
    expect(sent.message).toBe("Add the before");
  });

  it("never hands back the signed raw url, however the file got there", async () => {
    const created = vi
      .fn()
      .mockResolvedValue(json({ content: { download_url: signedRawUrl }, commit: { sha } }, 201));
    vi.stubGlobal("fetch", created);
    const fresh = await writer().write(path, png, "Add the before");

    const reused = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "sha wasn't supplied" }, 422))
      .mockResolvedValueOnce(json([{ sha }]));
    vi.stubGlobal("fetch", reused);
    const existing = await writer().write(path, png, "Add the before");

    for (const url of [fresh, existing]) {
      expect(url).not.toContain("raw.githubusercontent.com");
      expect(url).not.toContain("token=");
      expect(carriesCredential(url!)).toBe(false);
      expect(url).toMatch(/^https:\/\/github\.com\/o\/r\/blob\//);
    }
  });

  it("reuses the copy an earlier run already committed at that path", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "sha wasn't supplied" }, 422))
      .mockResolvedValueOnce(json([{ sha }]));
    vi.stubGlobal("fetch", spy);

    expect(await writer().write(path, png, "Add the before")).toBe(blob);
    expect(spy).toHaveBeenCalledTimes(2);

    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(url).toBe(
      `https://api.github.com/repos/o/r/commits?per_page=1&path=${encodeURIComponent(path)}`,
    );
  });

  it("falls back to the file's own page when the history cannot be read", async () => {
    const htmlUrl = `https://github.com/o/r/blob/main/${path}`;
    const spy = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "sha wasn't supplied" }, 422))
      .mockResolvedValueOnce(json({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(json({ html_url: htmlUrl, download_url: signedRawUrl }));
    vi.stubGlobal("fetch", spy);

    expect(await writer().write(path, png, "Add the before")).toBe(`${htmlUrl}?raw=true`);
  });

  it("gives back nothing, rather than throwing, when the commit is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: "Bad credentials" }, 401)));
    expect(await writer().write(path, png, "Add the before")).toBeNull();
  });

  it("knows which urls carry something that expires", () => {
    expect(carriesCredential(signedRawUrl)).toBe(true);
    expect(
      carriesCredential("https://private-user-images.githubusercontent.com/1/x.png?jwt=ey"),
    ).toBe(true);
    expect(carriesCredential(blob)).toBe(false);
    expect(carriesCredential(blobUrl("o/r", sha, path))).toBe(false);
    expect(carriesCredential("not a url at all")).toBe(false);
  });

  it("writes nowhere in a dry run, and nowhere without a token", () => {
    expect(createArtifactWriter(config({ dryRun: true, githubToken: "ghs-test" }))).toBeInstanceOf(
      LocalArtifactWriter,
    );
    expect(createArtifactWriter(config({}))).toBeInstanceOf(LocalArtifactWriter);
    expect(createArtifactWriter(config({ githubToken: "ghs-test" }))).toBeInstanceOf(
      GitHubArtifactWriter,
    );
  });

  it("still writes the picture in a dry run, to a temp file, and publishes nothing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await new LocalArtifactWriter("dry run").write(path, png)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the pictures on the issue", () => {
  const visual: PageVisual = {
    pageUrl: COMPARE_URL,
    shots: {
      beforeUrl: `https://github.com/o/r/blob/9f4c1b2d3e/${VISUAL_DIR}/x-before.png?raw=true`,
      afterUrl: `https://github.com/o/r/blob/9f4c1b2d3e/${VISUAL_DIR}/x-after.png?raw=true`,
      beforeAlt: "The compare to render page as it reads today, the quoted line in place",
      afterAlt:
        "The compare to render page with the proposed copy in it, highlighted in yellow: 16 words added",
    },
    summary: "16 words added, 13 words removed",
    capturedOn: TODAY,
    copyMissingLive: false,
  };

  const body = (visuals: PageVisual[]): string => {
    const action = pageAction();
    return buildIssueBody(
      alert({ item: storedItem(), analysis: analysis({ actions: [action], railwayRefs: [ref()] }) }),
      featureImage(),
      action,
      visuals,
    );
  };

  it("embeds both shots so GitHub renders them, rather than linking them", () => {
    const text = body([visual]);
    expect(text).toContain(`![${visual.shots!.beforeAlt}](${visual.shots!.beforeUrl})`);
    expect(text).toContain(`![${visual.shots!.afterAlt}](${visual.shots!.afterUrl})`);
    expect(text).toContain(visual.summary);
  });

  it("puts the before first, stacked above the after", () => {
    const text = body([visual]);
    expect(text.indexOf("**Before**")).toBeLessThan(text.indexOf("**After**"));
    expect(text.indexOf(visual.shots!.beforeUrl)).toBeLessThan(text.indexOf(visual.shots!.afterUrl));
  });

  it("says the after was staged in a browser and published nowhere", () => {
    expect(body([visual])).toContain("staged in a browser only. Nothing was published.");
    expect(body([visual])).toContain(`the live page on ${TODAY}`);
  });

  it("says the highlight on the after is what marks the recommended copy", () => {
    expect(body([visual])).toContain("highlighted in place");
  });

  it("puts them above the copy somebody came to paste", () => {
    const text = body([visual]);
    expect(text.indexOf(visual.shots!.afterUrl)).toBeLessThan(text.indexOf("```text"));
    expect(text.indexOf("### [")).toBeLessThan(text.indexOf(visual.shots!.beforeUrl));
  });

  it("heads the page with a link somebody can click, not a bare url", () => {
    const text = body([visual]);
    expect(text).toContain(`### [Compare to render](${COMPARE_URL})`);
    expect(text).not.toContain(`### ${COMPARE_URL}`);
    // The URL is still there to read and to copy, under the link.
    expect(text).toContain(`](${COMPARE_URL})\n${COMPARE_URL}`);
  });

  it("warns when the quoted line was not on the live page, and shows nothing", () => {
    const text = body([{ ...visual, shots: null, copyMissingLive: true }]);
    expect(text).not.toContain("![");
    expect(text).toContain(`was not found on the live page on ${TODAY}`);
    expect(text).toContain("```text");
  });

  it("reads exactly as it did before when there is no picture", () => {
    const text = body([]);
    expect(text).not.toContain("![");
    expect(text).toContain("- **Copy today:**");
    expect(text).toContain("```text");
  });

  it("leaves an unrelated page's edit without one", () => {
    const other = { ...visual, pageUrl: "https://docs.railway.com/platform/compare-to-vercel" };
    expect(body([other])).not.toContain(other.shots!.beforeUrl);
  });

  it("carries the pictures through to the draft, keyed to their own action", () => {
    const page = pageAction();
    const feature: RecommendedAction = {
      type: "consider_enhancing",
      feature: "CDN",
      detail: "Add stale-while-revalidate.",
    };
    const drafts = buildIssueDrafts(
      alert({ analysis: analysis({ actions: [page, feature], railwayRefs: [ref()] }) }),
      featureImage(),
      new Map([[page, [visual]]]),
    );

    expect(drafts[0]?.draft.body).toContain(visual.shots!.beforeUrl);
    expect(drafts[1]?.draft.body).not.toContain(visual.shots!.beforeUrl);
  });
});
