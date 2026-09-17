import { describe, expect, it } from "vitest";
import type { DiscordMessage } from "../src/discord/embed.js";
import type { DiscordPoster } from "../src/discord/post.js";
import {
  buildQuietDayMessage,
  postQuietDay,
  QUIET_DAY_LEAD,
  quietDayMessage,
  quietDayText,
  type QuietDayRun,
} from "../src/discord/quiet-day.js";

class RecordingPoster implements DiscordPoster {
  readonly description = "recording";
  readonly posted: DiscordMessage[] = [];

  async post(message: DiscordMessage): Promise<void> {
    this.posted.push(message);
  }
}

class RefusingPoster implements DiscordPoster {
  readonly description = "refusing";

  async post(): Promise<void> {
    throw new Error("Discord refused the message: HTTP 403 Missing Permissions");
  }
}

/** A morning where both competitors were read and neither shipped anything. */
function quietRun(overrides: Partial<QuietDayRun> = {}): QuietDayRun {
  return { alerts: 0, newItems: 0, sourcesRead: 3, unread: [], ...overrides };
}

/**
 * A channel that goes silent says two things at once: nothing shipped, and the
 * job is broken. Only one of them is ever true, so a run that read the feeds
 * and found nothing says so in one line.
 */
describe("the quiet-day line", () => {
  it("posts one short message when a run read the sources and found nothing", () => {
    const message = quietDayMessage(quietRun());
    expect(message?.content).toBe(
      "No new competitor products or features today. Nothing new from Render or Vercel.",
    );
  });

  it("says nothing when the run already posted an alert", () => {
    expect(quietDayMessage(quietRun({ alerts: 1, newItems: 1 }))).toBeNull();
  });

  it("says nothing when a retried analysis was the only thing posted", () => {
    expect(quietDayMessage(quietRun({ alerts: 2 }))).toBeNull();
  });

  /**
   * A new item that never became an alert is a seeded backlog or an analysis
   * that gave up. Both are the opposite of a quiet day, and the run log is
   * where they belong.
   */
  it("says nothing when items turned up but never reached Discord", () => {
    expect(quietDayMessage(quietRun({ newItems: 4 }))).toBeNull();
  });

  /** Every feed failing is a blind run, not a quiet one. */
  it("says nothing when no source could be read at all", () => {
    expect(
      quietDayMessage(quietRun({ sourcesRead: 0, unread: ["Render's blog", "Vercel's blog"] })),
    ).toBeNull();
  });

  it("names the source that failed rather than counting it as quiet", () => {
    const message = quietDayMessage(quietRun({ sourcesRead: 2, unread: ["Render's changelog"] }));
    expect(message?.content).toBe(
      `${QUIET_DAY_LEAD} Nothing new from Render or Vercel, except Render's changelog, which could not be read this run.`,
    );
  });

  it("lists more than one unread source in one sentence", () => {
    expect(quietDayText(["Render's changelog", "Vercel's blog"])).toContain(
      "except Render's changelog and Vercel's blog, which could not be read this run",
    );
  });

  it("is plain text with no embed, because a quiet day is not a launch", () => {
    const message = buildQuietDayMessage();
    expect(message.embeds).toEqual([]);
    expect(message.content).toBe(quietDayText());
  });

  it("pings nobody, like everything else this bot posts", () => {
    expect(buildQuietDayMessage().allowed_mentions).toEqual({ parse: [] });
  });

  it("writes the punctuation this bot writes", () => {
    expect(quietDayText()).not.toContain("—");
  });
});

/** What the end of a run actually does with it. */
describe("posting the quiet-day line", () => {
  it("sends exactly one message when a run posted no alerts", async () => {
    const poster = new RecordingPoster();
    expect(await postQuietDay(poster, quietRun())).toBe(true);
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]?.content).toContain(QUIET_DAY_LEAD);
  });

  it("sends nothing when the run already posted alerts", async () => {
    const poster = new RecordingPoster();
    expect(await postQuietDay(poster, quietRun({ alerts: 3, newItems: 3 }))).toBe(false);
    expect(poster.posted).toEqual([]);
  });

  /** A refused post is logged and dropped: there is no launch here to lose. */
  it("reports that it did not post when Discord refuses the message", async () => {
    expect(await postQuietDay(new RefusingPoster(), quietRun())).toBe(false);
  });
});
