import { describe, expect, it } from "vitest";
import type { DiscordMessage } from "../src/discord/embed.js";
import type { DiscordPoster } from "../src/discord/post.js";
import {
  buildQuietDayMessage,
  postQuietDay,
  QUIET_DAY_LEAD,
  quietDayMessage,
  quietDayText,
  scheduleDay,
  type QuietDayLog,
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

/** What the store keeps, in the one line of it this module uses. */
class DayLog implements QuietDayLog {
  readonly claimed = new Set<string>();

  async claimQuietDay(day: string): Promise<boolean> {
    if (this.claimed.has(day)) return false;
    this.claimed.add(day);
    return true;
  }
}

/** A database the run cannot write to – an unapplied migration, say. */
class BrokenDayLog implements QuietDayLog {
  async claimQuietDay(): Promise<boolean> {
    throw new Error('relation "quiet_days" does not exist');
  }
}

/** 07:00 in Los Angeles on a summer morning, and the hour after it. */
const FIRST_CRON = new Date("2026-09-24T14:00:00.000Z");
const SECOND_CRON = new Date("2026-09-24T15:00:00.000Z");

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
    expect(await postQuietDay(poster, quietRun(), new DayLog(), FIRST_CRON)).toBe(true);
    expect(poster.posted).toHaveLength(1);
    expect(poster.posted[0]?.content).toContain(QUIET_DAY_LEAD);
  });

  it("sends nothing when the run already posted alerts", async () => {
    const poster = new RecordingPoster();
    const run = quietRun({ alerts: 3, newItems: 3 });
    expect(await postQuietDay(poster, run, new DayLog(), FIRST_CRON)).toBe(false);
    expect(poster.posted).toEqual([]);
  });

  /** A refused post is logged and dropped: there is no launch here to lose. */
  it("reports that it did not post when Discord refuses the message", async () => {
    expect(await postQuietDay(new RefusingPoster(), quietRun(), new DayLog(), FIRST_CRON)).toBe(
      false,
    );
  });
});

/**
 * The line is the one thing posted with no item under it, so the dedupe the
 * alerts get from `items` has to come from somewhere else. It comes from the
 * day: the workflow is scheduled at 14:00 and 15:00 UTC because one of them is
 * 07:00 in Los Angeles depending on the season, and a morning told twice that
 * nothing shipped reads as a bot with a stutter.
 */
describe("one quiet-day line per morning", () => {
  it("says nothing on a second run of the same Los Angeles day", async () => {
    const poster = new RecordingPoster();
    const days = new DayLog();

    expect(await postQuietDay(poster, quietRun(), days, FIRST_CRON)).toBe(true);
    expect(await postQuietDay(poster, quietRun(), days, SECOND_CRON)).toBe(false);
    expect(poster.posted).toHaveLength(1);
  });

  /** Both winter cron entries land before noon UTC-8, on the same morning. */
  it("counts the winter pair as one morning too", async () => {
    const poster = new RecordingPoster();
    const days = new DayLog();

    await postQuietDay(poster, quietRun(), days, new Date("2026-12-09T14:00:00.000Z"));
    await postQuietDay(poster, quietRun(), days, new Date("2026-12-09T15:00:00.000Z"));
    expect(poster.posted).toHaveLength(1);
  });

  /**
   * An evening in Los Angeles is the next day in UTC, and a day counted in UTC
   * would hand a hand-started run that evening a second line for one morning.
   */
  it("counts the day from Los Angeles midnight, not UTC midnight", async () => {
    const poster = new RecordingPoster();
    const days = new DayLog();

    await postQuietDay(poster, quietRun(), days, FIRST_CRON);
    // 19:00 in Los Angeles on the same day, 02:00 UTC on the next.
    await postQuietDay(poster, quietRun(), days, new Date("2026-09-25T02:00:00.000Z"));
    expect(poster.posted).toHaveLength(1);
  });

  it("speaks again the next morning", async () => {
    const poster = new RecordingPoster();
    const days = new DayLog();

    await postQuietDay(poster, quietRun(), days, FIRST_CRON);
    await postQuietDay(poster, quietRun(), days, new Date("2026-09-25T14:00:00.000Z"));
    expect(poster.posted).toHaveLength(2);
  });

  it("takes the day only when it has a line to post", async () => {
    const days = new DayLog();
    await postQuietDay(new RecordingPoster(), quietRun({ alerts: 2 }), days, FIRST_CRON);
    expect(days.claimed.size).toBe(0);
  });

  /** A silent morning is the failure this message exists to prevent. */
  it("posts anyway when the day cannot be recorded", async () => {
    const poster = new RecordingPoster();
    expect(await postQuietDay(poster, quietRun(), new BrokenDayLog(), FIRST_CRON)).toBe(true);
    expect(poster.posted).toHaveLength(1);
  });

  it("names the day the way the table stores it", () => {
    expect(scheduleDay(FIRST_CRON)).toBe("2026-09-24");
    expect(scheduleDay(new Date("2026-09-25T02:00:00.000Z"))).toBe("2026-09-24");
    expect(scheduleDay(new Date("2026-01-01T00:30:00.000Z"))).toBe("2025-12-31");
  });
});
