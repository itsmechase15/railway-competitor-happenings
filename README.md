# railway-competitor-happenings

A bot that tells Railway when Render or Vercel ships something, and what to do
about it.

Every morning at 7am PT it reads both competitors' changelogs and blogs (X too,
when a bearer token is set), drops anything already seen, and sends what is new
to Opus with Railway's own product docs in front of it. Each new launch becomes
one Discord embed: a feature image, one sentence on what changed with a source
link, an impact label (Minor / Notable / Major), a few detail bullets, and one
to three recommended actions. Each action opens its own GitHub issue in this
repo, and the embed links it.

Recommendations are checked against Railway's docs before they ship. An action
may only say Railway lacks something when a docs page shows the gap, and a page
edit may only target Railway's own compare, migrate, pricing, or features
pages. Docs are evidence, never edit targets.

## Status

Building. Phase 1 is implemented: collect, dedupe, analyze, file issues, post.
The daily run needs `DATABASE_URL` (a Supabase Session pooler URI for this
bot's own project) before it can remember what it has already posted;
`check-env` fails loud until it is set.

[PLAN.md](./PLAN.md) has the full operator plan: sources, daily loop, Discord
embed shape, docs grounding, data store, impact scale, actions, and phasing.

## How it runs

| Workflow | When | What it does |
| --- | --- | --- |
| `daily.yml` | 14:00 UTC (7am PT), or by hand | One full cycle: refresh the Railway index, collect, dedupe, analyze, open issues, post |
| `force-post.yml` | By hand, or a URL committed to `.github/force-post-url.txt` | Posts one named announcement, ignoring dedupe and the first-run seed guard |
| `check-secrets.yml` | By hand | Names every missing secret and asks Discord what the bot can see. Posts nothing |
| `ci.yml` | Push and pull request | Typecheck, tests, build |

The first run for each competitor and source records its backlog without
alerting, so turning on a new source never floods the channel. Caps are 8 new
items per source and 12 per run.

## Setup

1. Apply the schema to this bot's own Supabase project:

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
```

2. Add the secrets under **Settings → Secrets and variables → Actions**. Values
   never go in the repo.
3. Run **Actions → Check secrets** with strict on. It lists every variable,
   names what is missing, and says where each value comes from. Only the
   required four fail it: `X_BEARER_TOKEN` is optional and its absence just
   skips the X source.
4. Run **Actions → Daily competitor happenings** by hand once. The first run
   seeds the backlog quietly; the next morning's run is the first that posts.

## Secrets

| Secret | Phase | Needed for |
| --- | --- | --- |
| `DATABASE_URL` | 1 | Supabase Session pooler URI, for dedupe and state. This bot's own project |
| `DISCORD_BOT_TOKEN` | 1 | Posting embeds |
| `DISCORD_CHANNEL_ID` | 1 | The channel to post to. A variable is fine; the workflows read either |
| `CURSOR_API_KEY` | 1 | Opus analysis via the Cursor API |
| `X_BEARER_TOKEN` | 1+ (optional) | The X source. Unset skips it |
| `AGENTMAIL_API_KEY` + inbox id | 2 | The newsletter source |

`GITHUB_TOKEN` comes from Actions with `issues: write`.

The direct `db.<ref>.supabase.co` host is IPv6 only and GitHub's runners have
no IPv6 route, so `DATABASE_URL` has to be the Session pooler URI. `check-env`
warns when it is not.

## Local use

```bash
npm install
cp .env.example .env          # fill in what you have; git ignores .env
npm run check-env -- --strict # every variable, and whether it is set
npm run typecheck && npm test

# The whole pipeline against live feeds, printing payloads instead of posting
DRY_RUN=true FORCE_ANALYZE=true npm run run

# One named announcement, end to end. It has to still be in a live feed.
npm run run -- --url https://render.com/changelog/some-entry --out artifacts/embed.md

# Ask Discord whether the bot can see the channel
npm run run -- --check-discord
```

With no `CURSOR_API_KEY`, the run falls back to restating the source and every
alert says so in its footer. With `DRY_RUN=true` it needs no database.

## How it is put together

| Path | What lives there |
| --- | --- |
| `src/sources/` | Changelog feeds, blog sitemaps, the blog-index diff for a site with no sitemap, X, and article enrichment |
| `src/railway/` | The docs catalog (`products.ts`), what a page action may target (`pages.ts`), the per-signal docs context, and the index refresh |
| `src/analysis/` | The prompt, the reply schema, the docs-grounding guards, and the no-key fallback |
| `src/discord/` | The embed and the bot that posts it |
| `src/github/` | One issue per recommended action |
| `src/db/` | Postgres, the in-memory store for dry runs, and the dedupe contract |
| `src/pipeline.ts` | The daily cycle, and single-item mode |

## Not this

Not Slack. Not shared with
[posthog-competitor-happenings](https://github.com/itsmechase15/posthog-competitor-happenings):
same product pattern, separate code, database, secrets, and inbox.
