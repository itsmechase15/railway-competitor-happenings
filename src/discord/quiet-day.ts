import { COMPETITOR_IDS, COMPETITORS } from "../config.js";
import { createLogger } from "../log.js";
import { sanitizeCopy } from "../util/text.js";
import type { DiscordMessage } from "./embed.js";
import type { DiscordPoster } from "./post.js";

const log = createLogger("quiet-day");

/**
 * A quiet day is a result, and a channel that says nothing on one is
 * indistinguishable from a bot that fell over in the night. So a run that read
 * both competitors and found nothing new posts one line saying exactly that.
 *
 * It is a line of text rather than an embed on purpose: an embed is the shape
 * a launch arrives in, and a day with no launch should not look like one on a
 * phone screen.
 */
export const QUIET_DAY_LEAD = "No new competitor products or features today.";

/**
 * The zone the schedule is written in, and so the one a morning is counted in.
 * The workflow fires at 14:00 or 15:00 UTC depending on the season; both are
 * the same morning here, and a day counted in UTC would call them two.
 */
const SCHEDULE_ZONE = "America/Los_Angeles";

/** Today where the schedule lives, as `2026-09-24`. */
export function scheduleDay(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The record of which mornings have already been called quiet. One question,
 * asked of whatever is keeping state, so this module needs nothing else out of
 * persistence and a test can answer it with a set.
 */
export interface QuietDayLog {
  /** Take the day for this run, or false because an earlier run has it. */
  claimQuietDay(day: string): Promise<boolean>;
}

/** What one run knows about itself by the time delivery is over. */
export interface QuietDayRun {
  /** Alerts this run had to deliver: fresh analyses plus retried ones. */
  alerts: number;
  /** Items stored this run, whether they were analyzed, seeded, or given up on. */
  newItems: number;
  /** Sources that answered. Zero means the run read nothing and so knows nothing. */
  sourcesRead: number;
  /** Sources that did not answer, named the way a sentence says them. */
  unread: string[];
}

function joinNames(names: readonly string[], conjunction: string): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;
}

/** Everything the run watches, named as the message names it: "Render or Vercel". */
function competitorNames(): string {
  return joinNames(
    COMPETITOR_IDS.map((id) => COMPETITORS[id].label),
    "or",
  );
}

/**
 * The line itself. The second sentence says what was read, because "nothing
 * new" is only worth anything next to where it was looked for, and a source
 * that failed this run is named rather than counted as quiet.
 */
export function quietDayText(unread: readonly string[] = []): string {
  const looked = `Nothing new from ${competitorNames()}`;
  const sentence =
    unread.length === 0
      ? `${looked}.`
      : `${looked}, except ${joinNames(unread, "and")}, which could not be read this run.`;
  return sanitizeCopy(`${QUIET_DAY_LEAD} ${sentence}`);
}

export function buildQuietDayMessage(unread: readonly string[] = []): DiscordMessage {
  return { content: quietDayText(unread), embeds: [], allowed_mentions: { parse: [] } };
}

/**
 * The message a run posts when it has nothing else to say, or null when it
 * should stay quiet after all.
 *
 * Three things keep the line honest, and each of them is a day this bot used
 * to say nothing at all:
 *
 * - **It already spoke.** One alert is enough to make the day a busy one, so a
 *   run that posted anything – a fresh analysis or one retried from an earlier
 *   run – never adds "nothing today" underneath it.
 * - **Something turned up.** A new item that never became an alert is a
 *   seeded backlog or an analysis that gave up, and both of those are the
 *   opposite of nothing new. The run log says which; the channel is not told
 *   the day was quiet when it was not.
 * - **Nothing was read.** Every feed failing is not a quiet day, it is a blind
 *   one, and "no new products or features" is a claim about the competitors
 *   that a run which read none of them cannot make.
 */
export function quietDayMessage(run: QuietDayRun): DiscordMessage | null {
  if (run.alerts > 0) return null;
  if (run.newItems > 0) return null;
  if (run.sourcesRead === 0) return null;
  return buildQuietDayMessage(run.unread);
}

/**
 * Whether this run is the one that speaks for the morning.
 *
 * A log that cannot answer is read as an unclaimed day. The failure it covers
 * is a database this run could not write to, and between a morning said twice
 * and a morning said not at all, the second is the one this message exists to
 * prevent.
 */
async function claimDay(days: QuietDayLog, day: string): Promise<boolean> {
  try {
    return await days.claimQuietDay(day);
  } catch (error) {
    log.warn(
      `could not record that ${day} was called quiet, so posting the line and risking a repeat`,
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}

/**
 * Post it, at most once a day, at the end of a run. Called after delivery
 * rather than instead of it, so the count it reads is what actually went out.
 *
 * Once a day and not once a run, because the workflow is scheduled twice for
 * one morning and a hand-started run is a third. The alerts are deduped on the
 * items behind them and this line has no item, so the day it belongs to is
 * what it is deduped on: the first run of a Los Angeles day takes the day, and
 * a later one finds it taken and says nothing.
 *
 * A refused post is logged and dropped rather than stored for a retry: the
 * retry queue exists so an alert about a launch is not lost, and this is not
 * about a launch. It keeps the day it took, because a channel that refused one
 * message refuses the next one for the same reason, and a job that answers a
 * missing permission by trying again every hour is a worse read than a quiet
 * morning. Tomorrow's run answers for tomorrow.
 */
export async function postQuietDay(
  poster: DiscordPoster,
  run: QuietDayRun,
  days: QuietDayLog,
  now: Date = new Date(),
): Promise<boolean> {
  const message = quietDayMessage(run);
  if (!message) {
    if (run.alerts === 0) {
      log.info(
        `nothing to post, and no quiet-day line either: ${run.newItems} new items this run, ${run.sourcesRead} sources read`,
      );
    }
    return false;
  }

  const day = scheduleDay(now);
  if (!(await claimDay(days, day))) {
    log.info(`the channel was already told ${day} was quiet – not saying it twice`);
    return false;
  }

  try {
    await poster.post(message);
    return true;
  } catch (error) {
    log.error(
      "failed to post the quiet-day line to Discord",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
