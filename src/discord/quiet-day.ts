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
 * Post it, at most once, at the end of a run. Called after delivery rather
 * than instead of it, so the count it reads is what actually went out.
 *
 * A refused post is logged and dropped rather than stored for a retry: the
 * retry queue exists so an alert about a launch is not lost, and this is not
 * about a launch. Tomorrow's run answers for tomorrow.
 */
export async function postQuietDay(poster: DiscordPoster, run: QuietDayRun): Promise<boolean> {
  const message = quietDayMessage(run);
  if (!message) {
    if (run.alerts === 0) {
      log.info(
        `nothing to post, and no quiet-day line either: ${run.newItems} new items this run, ${run.sourcesRead} sources read`,
      );
    }
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
