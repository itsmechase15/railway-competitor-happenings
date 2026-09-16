import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  blobUrl,
  carriesCredential,
  createArtifactWriter,
  GitHubArtifactWriter,
  LocalArtifactWriter,
} from "../src/github/artifact.js";
import { buildIssueBody, buildIssueDrafts } from "../src/github/issue.js";
import { diffSummary, diffWords, panelSpans, words } from "../src/media/diff.js";
import {
  looseSpan,
  paragraphWith,
  planPageEdit,
  visualHtml,
  visualPath,
  VISUAL_DIR,
  type PageVisual,
} from "../src/media/page-edit.js";
import {
  commitMessage,
  createPageVisualMaker,
  DisabledPageVisualMaker,
  plansFor,
} from "../src/media/visual.js";
import type { AnalyzedItem, RailwayRef, RecommendedAction } from "../src/types.js";
import { alert, analysis, corpusIndex, featureImage, storedItem } from "./helpers.js";

/** The paragraph the compare page has today, as the corpus stores it. */
const PAGE_TEXT = [
  "Railway and Render both run your containers, but they bill idle time differently.",
  "Railway stops an idle container and bills it by the minute while it is awake. Render keeps a web service running until you scale it down yourself.",
  "Both platforms give you a managed Postgres with daily backups.",
].join("\n\n");

const CLAIM =
  "Render keeps a web service running until you scale it down yourself.";

const PROPOSED =
  "Render now bills a web service per request once it goes idle, so a quiet service costs close to nothing between requests.";

const COMPARE_URL = "https://docs.railway.com/platform/compare-to-render";

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

describe("the word diff a before/after is drawn from", () => {
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

  it("draws the page's own spelling of a word that only changed punctuation", () => {
    const spans = diffWords("bills by the minute", "bills by the minute.");
    expect(spans.map((span) => span.text).join("")).toBe("bills by the minute");
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

  it("gives each panel only the spans it can show", () => {
    const spans = diffWords("keeps it running", "bills it per request");
    expect(panelSpans(spans, "before").every((span) => span.kind !== "added")).toBe(true);
    expect(panelSpans(spans, "after").every((span) => span.kind !== "removed")).toBe(true);
  });
});

describe("finding the line on the page", () => {
  it("finds a quote that differs from the page by punctuation or spacing", () => {
    const paragraph = "Railway  stops an idle container, and bills it by the minute.";
    expect(looseSpan(paragraph, "Railway stops an idle container and bills it by the minute")).not.toBeNull();
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
  it("shows the paragraph around the edit, with the changed line marked", () => {
    const plan = planPageEdit(ref(), PAGE_TEXT)!;
    expect(plan.fromCorpus).toBe(true);
    expect(plan.before.lead).toContain("Railway stops an idle container");
    expect(plan.before.spans.some((span) => span.kind === "removed")).toBe(true);
    expect(plan.after.spans.some((span) => span.kind === "added")).toBe(true);
    // The paragraph before and after this one are not the edit's business.
    expect(plan.before.lead).not.toContain("managed Postgres");
  });

  it("keeps the line and adds the copy next to it for an insert", () => {
    const plan = planPageEdit(ref({ editKind: "insert" }), PAGE_TEXT)!;
    expect(plan.editKind).toBe("insert");
    expect(plan.before.spans.every((span) => span.kind === "same")).toBe(true);
    expect(plan.summary).not.toContain("removed");
  });

  it("falls back to the quoted line alone when the corpus has no copy of the page", () => {
    const plan = planPageEdit(ref(), undefined)!;
    expect(plan.fromCorpus).toBe(false);
    expect(plan.before.lead).toBe("");
    expect(visualHtml(plan)).toContain("The corpus held no copy of this page");
  });

  it("draws nothing without finished copy to draw an After from", () => {
    expect(planPageEdit(ref({ proposedText: undefined }), PAGE_TEXT)).toBeNull();
    expect(planPageEdit(ref({ proposedText: "   " }), PAGE_TEXT)).toBeNull();
    expect(planPageEdit(ref({ claim: "" }), PAGE_TEXT)).toBeNull();
  });

  it("names the page and says what the copy does to it", () => {
    expect(planPageEdit(ref(), PAGE_TEXT)!.pageName).toBe("Compare to render");
    expect(visualHtml(planPageEdit(ref(), PAGE_TEXT)!)).toContain(
      "the proposed copy replaces the highlighted line",
    );
    expect(visualHtml(planPageEdit(ref({ editKind: "insert" }), PAGE_TEXT)!)).toContain(
      "the proposed copy goes in next to the highlighted line",
    );
  });

  it("says in the alt text which page it is of and how much moved", () => {
    const plan = planPageEdit(ref(), PAGE_TEXT)!;
    expect(plan.altText).toBe(`Before and after of the compare to render page: ${plan.summary}`);
  });
});

describe("where a picture is filed", () => {
  it("names the file for the page, under one folder", () => {
    expect(visualPath(ref())).toMatch(
      new RegExp(`^${VISUAL_DIR}/platform-compare-to-render-[0-9a-f]{10}\\.png$`),
    );
  });

  it("lands on the same path when the same edit is drawn again", () => {
    expect(visualPath(ref())).toBe(visualPath(ref()));
  });

  it("takes a new path when the copy changes, so an open issue keeps its picture", () => {
    expect(visualPath(ref({ proposedText: "Different copy entirely, at length." }))).not.toBe(
      visualPath(ref()),
    );
  });
});

describe("the drawn page as HTML", () => {
  const html = (): string => visualHtml(planPageEdit(ref(), PAGE_TEXT)!);

  it("shows both panels, labelled", () => {
    expect(html()).toContain("the page today");
    expect(html()).toContain("with this edit");
  });

  it("says the picture came off the stored copy rather than the live page", () => {
    expect(html()).toContain("Rendered from the stored corpus copy of this page");
  });

  it("asks for nothing over the network, so a screenshot cannot wait on a font", () => {
    // No stylesheet, no webfont, no image. A shot that waits on a resource
    // renders in a fallback face some mornings and times out on others.
    expect(html()).not.toMatch(/(?:src|href)=/);
    expect(html()).not.toMatch(/@import|url\(/);
  });

  it("escapes copy that would otherwise be markup", () => {
    const nasty = planPageEdit(
      ref({
        claim: CLAIM,
        proposedText: 'Railway bills <script>alert("x")</script> by the minute, and it always has.',
      }),
      PAGE_TEXT,
    )!;
    expect(visualHtml(nasty)).toContain("&lt;script&gt;");
    expect(visualHtml(nasty)).not.toContain("<script>");
  });

  it("leaves whitespace outside a highlight, so no box hangs off the last word", () => {
    // A marked run ending in a space draws a coloured box past the word.
    expect(html()).not.toMatch(/<mark class="(added|removed)">\s/);
    expect(html()).not.toMatch(/\s<\/mark>/);
  });
});

describe("which actions get a picture", () => {
  const index = () => corpusIndex([{ url: COMPARE_URL, title: "Compare to Render", text: PAGE_TEXT, kind: "marketing" }]);

  const alertFor = (action: RecommendedAction, refs: RailwayRef[] = [ref()]): AnalyzedItem =>
    alert({ analysis: analysis({ actions: [action], railwayRefs: refs }) });

  it("draws one for a page edit", () => {
    const plans = plansFor(alertFor(pageAction()), pageAction(), index());
    expect(plans).toHaveLength(1);
    expect(plans[0]?.pageUrl).toBe(COMPARE_URL);
  });

  it("never draws one for a feature action, because there is no before of a feature", () => {
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

  it("draws at most two, so the copy is not under a screenful of images", () => {
    const refs = [
      ref(),
      ref({ url: "https://docs.railway.com/platform/migrate-from-render" }),
      ref({ url: "https://docs.railway.com/platform/compare-to-vercel" }),
    ];
    expect(plansFor(alertFor(pageAction(), refs), pageAction(), index())).toHaveLength(2);
  });

  it("says what the commit is for, and keeps CI out of it", () => {
    const plan = planPageEdit(ref(), PAGE_TEXT)!;
    const message = commitMessage(alertFor(pageAction()), plan);
    expect(message).toContain("[skip ci]");
    expect(message).toContain(COMPARE_URL);
    expect(message).toContain("render");
  });

  it("draws nothing at all when the switch is off", async () => {
    const off = createPageVisualMaker(
      { skipPageVisuals: true } as Config,
      index(),
    );
    expect(off).toBeInstanceOf(DisabledPageVisualMaker);
    expect(off.description).toContain("SKIP_PAGE_VISUALS");
    expect(await off.make(alertFor(pageAction()), pageAction())).toEqual([]);
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

describe("committing the picture so an issue can render it", () => {
  const png = Buffer.from("not really a png");
  const path = `${VISUAL_DIR}/platform-compare-to-render-abc1234567.png`;
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
      .mockResolvedValue(
        json({ content: { download_url: signedRawUrl }, commit: { sha } }, 201),
      );
    vi.stubGlobal("fetch", spy);

    expect(await writer().write(path, png, "Add a before/after")).toBe(blob);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/o/r/contents/${path}`);
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(init.body as string) as { content: string; message: string };
    expect(Buffer.from(sent.content, "base64").toString()).toBe("not really a png");
    expect(sent.message).toBe("Add a before/after");
  });

  it("never hands back the signed raw url, however the file got there", async () => {
    const created = vi
      .fn()
      .mockResolvedValue(json({ content: { download_url: signedRawUrl }, commit: { sha } }, 201));
    vi.stubGlobal("fetch", created);
    const fresh = await writer().write(path, png, "Add a before/after");

    const reused = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "sha wasn't supplied" }, 422))
      .mockResolvedValueOnce(json([{ sha }]));
    vi.stubGlobal("fetch", reused);
    const existing = await writer().write(path, png, "Add a before/after");

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

    expect(await writer().write(path, png, "Add a before/after")).toBe(blob);
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

    expect(await writer().write(path, png, "Add a before/after")).toBe(`${htmlUrl}?raw=true`);
  });

  it("gives back nothing, rather than throwing, when the commit is refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ message: "Bad credentials" }, 401)));
    expect(await writer().write(path, png, "Add a before/after")).toBeNull();
  });

  it("knows which urls carry something that expires", () => {
    expect(carriesCredential(signedRawUrl)).toBe(true);
    expect(carriesCredential("https://private-user-images.githubusercontent.com/1/x.png?jwt=ey")).toBe(
      true,
    );
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

  it("still draws the picture in a dry run, to a temp file, and publishes nothing", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await new LocalArtifactWriter("dry run").write(path, png)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the picture on the issue", () => {
  const visual: PageVisual = {
    pageUrl: COMPARE_URL,
    imageUrl: `https://github.com/o/r/blob/9f4c1b2d3e/${VISUAL_DIR}/x.png?raw=true`,
    altText: "Before and after of the compare to render page: 16 words added",
    summary: "16 words added, 13 words removed",
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

  it("embeds the image so GitHub renders it, rather than linking it", () => {
    const text = body([visual]);
    expect(text).toContain(`![${visual.altText}](${visual.imageUrl})`);
    expect(text).toContain(visual.summary);
  });

  it("puts it above the copy somebody came to paste", () => {
    const text = body([visual]);
    expect(text.indexOf(visual.imageUrl)).toBeLessThan(text.indexOf("```text"));
    expect(text.indexOf(`### ${COMPARE_URL}`)).toBeLessThan(text.indexOf(visual.imageUrl));
  });

  it("reads exactly as it did before when there is no picture", () => {
    const text = body([]);
    expect(text).not.toContain("![");
    expect(text).toContain("- **Copy today:**");
    expect(text).toContain("```text");
  });

  it("leaves an unrelated page's edit without one", () => {
    const other = { ...visual, pageUrl: "https://docs.railway.com/platform/compare-to-vercel" };
    expect(body([other])).not.toContain(other.imageUrl);
  });

  it("carries the picture through to the draft, keyed to its own action", () => {
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

    expect(drafts[0]?.draft.body).toContain(visual.imageUrl);
    expect(drafts[1]?.draft.body).not.toContain(visual.imageUrl);
  });
});
