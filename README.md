# railway-competitor-happenings

A bot that tells Railway when Render or Vercel ships something, and what to do
about it.

Every morning at 7am PT it reads both competitors' blogs and Render's changelog
(X too, when a bearer token is set), drops anything already seen, and sends
what is new to Opus with Railway's own docs under it. Each new launch becomes
one Discord embed: a feature image, one sentence on what changed with a source
link, an impact label (Minor / Notable / Major), a few detail bullets, and
**zero to three** recommended actions. Each action opens its own GitHub issue
in this repo, and the embed links it.

Zero actions is a normal answer, not a failure. A competitor shipping something
Railway already does asks nothing of Railway, and the embed says so in words:
"None", with one sentence saying why. The mistake this bot is built to avoid is
the opposite one – a GitHub issue telling Railway to build something Railway
already ships – because that issue costs a reader's trust in every alert after
it.

So every recommendation carries evidence, and the evidence is checked rather
than trusted. A product action names the gap in one line, cites the docs page
it read the gap off, and quotes that page; the page has to be in the corpus,
the page has to be product documentation rather than marketing copy or a
changelog entry, and the quote has to be on the stored copy of it. Then the
corpus is searched again with the gap's own words, and an action is dropped
when the docs answer it on a page the analysis never opened. Anything that
fails becomes an open question instead of an issue.

## Sources

| Competitor | Read | Not read |
| --- | --- | --- |
| Render | Changelog feed at `https://render.com/changelog/feed.xml`, blog index at `https://render.com/blog`, `@render` | |
| Vercel | Blog index at `https://vercel.com/blog`, `@vercel` | Its changelog. The only feed Vercel publishes mixes changelog entries into the blog, so there is no reading one without the other |

A changelog entry is labelled `changelog`; a blog post is labelled `article`,
whether the site describes it on the listing or only links it.

## The docs corpus

The `pages` table is this bot's source of truth for what Railway documents.
Every run rebuilds it and then works from it.

- **Discovered** from the union of Railway's docs sitemap, `llms.txt`, the docs
  links the pages it already holds carry, and the product catalog, which pins
  the overview pages the bot routes to. No one input decides what the corpus
  contains: a sitemap lags a launch, and `llms.txt` is a subset somebody
  curated for another purpose. A short hand-listed allowlist of pages is what
  hid a whole privacy section from an analysis on the sibling bot.
- **Kept current** by content hash. A re-download that hashes the same leaves
  the page's change date alone, so "we looked" and "it moved" stay separate
  facts. Two tiers: a page an analyst read in the last three days is re-read
  every three days, the rest every fortnight, and a URL the corpus has never
  held is read the run it turns up.
- **Retired** when no source has offered the URL for two runs in a row, or when
  it answers 404 or 410. One sitemap that lags a deploy is a bad reason to
  forget a page.
- **Labelled** by what each page is evidence of. Railway's own changelog is in
  there as `shipped, may be undocumented`: it proves a capability exists and
  proves nothing about whether the docs mention it. Compare and migrate pages
  are `marketing copy`, which is never evidence about the product.

Every run writes the corpus to `.docs-workspace/` as markdown, one file per
page plus `TOC.md` listing all of them. The analyst runs one pass in that
directory with read-only tools – read, grep, glob, list – and the files it
opens are recorded from its own tool calls. That recording is what the coverage
gate rests on, so it is observed rather than self-reported.

A lexical BM25 search over the corpus pre-loads the ten best excerpts for each
launch as a starting point, capped at four per docs section. It is only a
starting point: a competitor's phrase for a feature ("scale to zero") rarely
matches Railway's words for the same thing ("stops an idle container"), which
is why the analyst also gets the whole table of contents and grep.

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

1. Apply the migrations to this bot's own Supabase project:

```bash
psql "$DATABASE_URL" -f migrations/001_init.sql
psql "$DATABASE_URL" -f migrations/002_close_data_api.sql
psql "$DATABASE_URL" -f migrations/003_docs_corpus.sql
```

   The first creates the four tables. The second takes them off Supabase's Data
   API, and it is not optional. See below for why. The third gives `pages` the
   bookkeeping that makes it a corpus: content hash, what each page is evidence
   of, when it last changed, and when something last reasoned against it.

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

## On Supabase, the tables are on the Data API until you close them

Supabase serves every table in `public` over PostgREST, and the default
privileges on that schema give `anon` and `authenticated` full insert, update,
and delete on anything created in it. Row-level security is off on a new table.
Nobody did anything wrong to get there, but a fresh project answers this from
the open internet:

```sh
curl "https://<ref>.supabase.co/rest/v1/items?select=*" -H "apikey: <publishable key>"
```

That is one read. The same key also takes `PATCH` and `DELETE`. Supabase flags
it as `rls_disabled_in_public`, at critical, and the flag is right even for a
bot that has no browser client anywhere near it.

Nothing here uses that path. The only way in is `DATABASE_URL`, over the
session pooler as `postgres`, which has BYPASSRLS. So
[`migrations/002_close_data_api.sql`](./migrations/002_close_data_api.sql)
enables row-level security with no policies, revokes the `anon` and
`authenticated` grants, and revokes the schema default privileges that would
hand the same thing to the next table someone adds. A run cannot tell the
difference.

Worth doing as well, in the dashboard: **Project Settings → Data API → off**.
The bot never calls PostgREST, and turning it off closes the surface rather
than emptying it, which is the one setting a later migration cannot undo by
accident.

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

With no `CURSOR_API_KEY`, the run falls back to restating the source. That
fallback recommends nothing at all – it knows no Railway product facts, so it
cannot name a gap or establish that a page is wrong – and every alert it
produces says so in its footer and in place of its actions.

A dry run builds the corpus for real, in memory when there is no database, so
the embeds it prints are the embeds a real run would post. `SKIP_RAILWAY_INDEX=true`
skips the corpus for a fast local run, at the cost of every gap claim being
dropped for want of anything to check it against.

## How it is put together

| Path | What lives there |
| --- | --- |
| `src/sources/` | Changelog feeds, the blog-index read (cards where the listing describes its posts, bare links where it does not), blog sitemaps, X, and article enrichment |
| `src/railway/corpus.ts` | The corpus refresh: what to read, what changed, what has gone |
| `src/railway/discover.ts` | What counts as a corpus page, and the union of sources that find them |
| `src/railway/retrieval.ts` | BM25 over the stored pages, with section diversity |
| `src/railway/workspace.ts` | The corpus as markdown on disk, plus the table of contents |
| `src/railway/products.ts` | The catalog: naming, routing, and boosting overview pages |
| `src/railway/pages.ts` | What a page action may target |
| `src/analysis/analyst.ts` | One analyst run, read-only, with the files it opened recorded |
| `src/analysis/evidence.ts` | The gate: citations, quotes, the coverage check, page edits |
| `src/analysis/` | The prompt, the reply schema, the docs-grounding guards, and the no-key fallback |
| `src/discord/` | The embed and the bot that posts it |
| `src/github/` | One issue per recommended action that passed every check |
| `src/db/` | Postgres, the in-memory store for dry runs, and the dedupe contract |
| `src/pipeline.ts` | The daily cycle, and single-item mode |
| `migrations/001_init.sql` | The four tables |
| `migrations/002_close_data_api.sql` | Takes those tables off Supabase's Data API |
| `migrations/003_docs_corpus.sql` | Makes `pages` a corpus: hashes, kinds, and freshness |

## Not this

Not Slack. Not shared with
[posthog-competitor-happenings](https://github.com/itsmechase15/posthog-competitor-happenings):
same product pattern, separate code, database, secrets, and inbox.
