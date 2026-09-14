# railway-competitor-happenings

A bot that tells Railway when Render or Vercel ships something, and what to do
about it.

Every morning at 7am PT it reads both competitors' changelogs and blogs (X and
newsletters later), drops anything already seen, and sends what is new to Opus
with Railway's own product docs in front of it. Each new launch becomes one
Discord embed: a feature image, one sentence on what changed with a source
link, an impact label (Minor / Notable / Major), a few detail bullets, and one
to three recommended actions. Each action opens its own GitHub issue in this
repo, and the embed links it.

Recommendations are checked against Railway's docs before they ship. An action
may only say Railway lacks something when a docs page shows the gap, and a
page edit may only target Railway's own compare, migrate, pricing, or features
pages. Docs are evidence, never edit targets.

## Status

Plan approved. Build pending the Discord bot token, channel id, and Cursor API
key.

[PLAN.md](./PLAN.md) has the full operator plan: sources, daily loop, Discord
embed shape, docs grounding, data store, impact scale, actions, and phasing.

## Secrets

Set under **Settings → Secrets and variables → Actions** in this repo. Values
never go in the repo.

| Secret | Phase | Needed for |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 1 | Posting embeds |
| `DISCORD_CHANNEL_ID` | 1 | The channel to post to |
| `DATABASE_URL` | 1 | Supabase Session pooler URI, for dedupe and state |
| `CURSOR_API_KEY` | 1 | Opus analysis via the Cursor API |
| `X_BEARER_TOKEN` | 1+ (optional) | The X source. Unset skips it |
| `AGENTMAIL_API_KEY` + inbox id | 2 | The newsletter source |

`GITHUB_TOKEN` comes from Actions with `issues: write`.

## Not this

Not Slack. Not shared with
[posthog-competitor-happenings](https://github.com/itsmechase15/posthog-competitor-happenings):
same pattern, separate code, database, secrets, and inbox.
