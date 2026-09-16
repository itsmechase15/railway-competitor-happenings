import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  createIssueCreator,
  createIssueEditor,
  DisabledIssueCreator,
  DisabledIssueEditor,
  GitHubIssueCreator,
  GitHubIssueEditor,
} from "../src/github/issue.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = (overrides: Partial<Config>): Config =>
  ({
    dryRun: false,
    githubToken: undefined,
    githubRepo: "itsmechase15/railway-competitor-happenings",
    httpTimeoutMs: 5_000,
    ...overrides,
  }) as Config;

describe("who may write to GitHub", () => {
  it("opens and edits issues through the same token", () => {
    expect(createIssueCreator(config({ githubToken: "ghs-test" }))).toBeInstanceOf(
      GitHubIssueCreator,
    );
    expect(createIssueEditor(config({ githubToken: "ghs-test" }))).toBeInstanceOf(GitHubIssueEditor);
  });

  it("writes nothing during a dry run, even with a token", () => {
    const dry = config({ dryRun: true, githubToken: "ghs-test" });
    expect(createIssueCreator(dry)).toBeInstanceOf(DisabledIssueCreator);
    expect(createIssueEditor(dry)).toBeInstanceOf(DisabledIssueEditor);
  });

  it("says which secret is missing when there is no token", () => {
    expect(createIssueCreator(config({})).description).toContain("GITHUB_TOKEN");
    expect(createIssueEditor(config({})).description).toContain("GITHUB_TOKEN");
  });
});

/** Every review verdict reaches its issue through one of these three calls. */
describe("GitHubIssueEditor", () => {
  const issue = { number: 12, url: "https://github.com/o/r/issues/12" };
  const editor = (): GitHubIssueEditor => new GitHubIssueEditor("o/r", "ghs-test", 5_000);

  const ok = (): Response =>
    new Response(JSON.stringify({ number: 12 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const refused = (status: number, message: string): Response =>
    new Response(JSON.stringify({ message }), {
      status,
      headers: { "content-type": "application/json" },
    });

  const sent = (spy: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
    JSON.parse((spy.mock.calls[call]?.[1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;

  it("patches the issue and names the state reason GitHub understands", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    expect(
      await editor().update(issue, {
        title: "Render: per-request billing \u2013 Consider enhancing Serverless",
        body: "the revised body",
        labels: ["impact:notable", "review:revised"],
        state: "closed",
        stateReason: "not_planned",
      }),
    ).toBe(true);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/issues/12");
    expect(init.method).toBe("PATCH");
    expect(sent(spy)).toEqual({
      title: "Render: per-request billing \u2013 Consider enhancing Serverless",
      body: "the revised body",
      labels: ["impact:notable", "review:revised"],
      state: "closed",
      state_reason: "not_planned",
    });
  });

  it("closes as not planned and lands the labels in the same request", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    await editor().close(issue, "not_planned", ["review:dropped", "review-pass:done"]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent(spy)).toEqual({
      labels: ["review:dropped", "review-pass:done"],
      state: "closed",
      state_reason: "not_planned",
    });
  });

  it("posts a comment to the comments endpoint", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    await editor().comment(issue, "Reviewed by `claude-fable-5-1`: agreed \u2013 it stands.");

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r/issues/12/comments");
    expect(init.method).toBe("POST");
    expect(sent(spy).body).toContain("agreed");
  });

  it("keeps a rewritten body when the repo rejects one of its labels", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(refused(422, "Validation Failed"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", spy);

    expect(await editor().update(issue, { body: "revised", labels: ["review:revised"] })).toBe(true);
    expect(sent(spy, 1)).toEqual({ body: "revised" });
  });

  it("gives up on a labels-only patch it cannot send, rather than patching nothing", async () => {
    const spy = vi.fn().mockResolvedValue(refused(422, "Validation Failed"));
    vi.stubGlobal("fetch", spy);

    // Nothing but labels was asked for, so there is no smaller request to make.
    expect(await editor().update(issue, { labels: ["review:agreed"] })).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal instead of failing the run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refused(401, "Bad credentials")));
    expect(await editor().comment(issue, "anything")).toBe(false);
  });

  it("has nothing to edit when no issue was opened", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    expect(await editor().update(null, { labels: ["review:agreed"] })).toBe(false);
    expect(await editor().comment(null, "anything")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("DisabledIssueEditor", () => {
  it("says what it would have done, including for an issue that was never opened", async () => {
    const spy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const editor = new DisabledIssueEditor("dry run");

    expect(await editor.update(null, { body: "revised", labels: ["review:revised"] })).toBe(false);
    expect(await editor.comment({ number: 3, url: "u" }, "Reviewed by x")).toBe(false);
    expect(await editor.close(null, "not_planned", ["review:dropped"])).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
