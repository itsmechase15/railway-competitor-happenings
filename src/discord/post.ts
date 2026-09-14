import { createLogger } from "../log.js";
import type { DiscordMessage } from "./embed.js";

const log = createLogger("discord");

export const DISCORD_API_BASE = "https://discord.com/api/v10";

export interface DiscordPoster {
  readonly description: string;
  post(message: DiscordMessage): Promise<void>;
}

interface DiscordErrorBody {
  message?: string;
  code?: number;
}

interface DiscordMessageResponse {
  id?: string;
  channel_id?: string;
}

interface DiscordUser {
  id?: string;
  username?: string;
}

interface DiscordChannel {
  id?: string;
  name?: string;
  guild_id?: string;
  type?: number;
}

export interface DiscordCredentialCheck {
  ok: boolean;
  /** One line, safe to log: identities and channel names, never the token. */
  detail: string;
}

function authHeaders(botToken: string): Record<string, string> {
  return {
    authorization: `Bot ${botToken}`,
    "content-type": "application/json",
  };
}

async function call<T>(
  url: string,
  botToken: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: T & DiscordErrorBody }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...authHeaders(botToken), ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & DiscordErrorBody;
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Discord what the token is and whether it can see the channel, before
 * anything with side effects runs. A bot that was never added to the server,
 * or a channel id from the wrong server, fails here rather than after an issue
 * has already been opened for a message that cannot be delivered.
 *
 * Whether the bot may *post* is not knowable without posting: Discord reports
 * `Send Messages` and `Embed Links` at the moment of the request. A readable
 * channel with no send permission still fails at delivery, and the run log
 * says which permission Discord refused.
 */
export async function checkBotToken(
  botToken: string,
  channelId: string | undefined,
  timeoutMs: number,
): Promise<DiscordCredentialCheck> {
  try {
    const me = await call<DiscordUser>(`${DISCORD_API_BASE}/users/@me`, botToken, timeoutMs);
    if (!me.ok) {
      return {
        ok: false,
        detail: `Discord refused the token: HTTP ${me.status} ${me.body.message ?? "no detail"}. Regenerate it at discord.com/developers → your app → Bot → Reset Token`,
      };
    }
    const identity = me.body.username ? `${me.body.username} (${me.body.id})` : "an unnamed bot";

    if (!channelId) {
      return {
        ok: false,
        detail: `${identity} has no channel to post to: DISCORD_CHANNEL_ID is not set`,
      };
    }

    const channel = await call<DiscordChannel>(
      `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}`,
      botToken,
      timeoutMs,
    );
    if (!channel.ok) {
      return {
        ok: false,
        detail: `${identity} cannot see channel ${channelId}: HTTP ${channel.status} ${channel.body.message ?? "no detail"}. Invite the bot to that server and give it View Channel, Send Messages, and Embed Links there`,
      };
    }

    const name = channel.body.name ? `#${channel.body.name}` : channelId;
    return { ok: true, detail: `${identity} can see ${name}` };
  } catch (error) {
    return {
      ok: false,
      detail: `Discord could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Posts one embed with a bot token. A bot rather than a webhook because the
 * API returns real errors – a missing permission, the wrong channel – and the
 * channel can change without a new secret.
 */
export class BotPoster implements DiscordPoster {
  readonly description: string;

  constructor(
    private readonly botToken: string,
    private readonly channelId: string,
    private readonly timeoutMs: number,
  ) {
    this.description = `Discord bot to channel ${channelId}`;
  }

  async post(message: DiscordMessage): Promise<void> {
    const { ok, status, body } = await call<DiscordMessageResponse>(
      `${DISCORD_API_BASE}/channels/${encodeURIComponent(this.channelId)}/messages`,
      this.botToken,
      this.timeoutMs,
      { method: "POST", body: JSON.stringify(message) },
    );

    if (!ok) {
      // Discord's own codes are what tell a missing permission apart from a
      // channel that does not exist, so both go in the message.
      throw new Error(
        `Discord refused the message: HTTP ${status}${body.code ? ` (code ${body.code})` : ""} ${
          body.message ?? "no detail"
        }`,
      );
    }

    // At info, not debug: a CI run's log is the only record that the alert was
    // delivered, and a run that posts nothing looks identical without it.
    const channel = body.channel_id ?? this.channelId;
    log.info(
      body.id ? `posted ${body.id} to ${channel}` : `posted to ${channel}`,
    );
  }
}

/** Prints what would have been posted. Used for dry runs and when Discord is unconfigured. */
export class ConsolePoster implements DiscordPoster {
  readonly description: string;

  constructor(private readonly reason: string) {
    this.description = `console (${reason})`;
  }

  async post(message: DiscordMessage): Promise<void> {
    log.info(`[${this.reason}] would post to Discord:`);
    console.log(JSON.stringify(message, null, 2));
  }
}
