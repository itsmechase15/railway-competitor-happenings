# railway-competitor-happenings – plan

Daily Discord alerts when Render or Vercel ships something, with what Railway
should do about it. Same product pattern as
[posthog-competitor-happenings](https://github.com/itsmechase15/posthog-competitor-happenings),
rebuilt for Railway: own code, own database, own secrets, Discord instead of
Slack.

Status: plan approved. Build starts once the Discord bot token, channel id, and
Cursor API key are in Actions secrets.

## Goal

Keep Railway current on Render and Vercel product moves without anyone reading
changelogs. One short alert per launch, every morning, that says what shipped,
how big it is, and the one to three things Railway should do about it. Each
action opens a GitHub issue so the work lands on a desk.

Success = the alerts are read and acted on, not muted.

## Inputs and outputs

**In**

- Render and Vercel blogs, Render's changelog, both official X accounts
  (Phase 1+), and a newsletter inbox (Phase 2)
- Railway's own product docs on docs.railway.com, as the evidence every
  recommendation is checked against
- Railway's own compare and migrate pages, as the pages a recommendation may
  ask someone to edit
- Each competitor's own compare-to-Railway page, as context only

**Out**

- One Discord embed per new signal in one channel
- One GitHub issue per recommended action, in this repo
- Rows in Supabase so nothing is alerted twice

## Competitors and sources

| Competitor | Changelog | Blog | X |
| --- | --- | --- | --- |
| Render | Atom feed at `https://render.com/changelog/feed.xml` | `https://render.com/blog`, diffed run over run (Render has no public sitemap at the root, so the blog index is the diff target). The index publishes bare links, so a new post reaches analysis with a URL and nothing else, and the article fetch fills in the title and the date | `@render` |
| Vercel | Not read. The only feed Vercel publishes, `https://vercel.com/atom`, mixes changelog entries into the blog and cannot be read for one without the other | `https://vercel.com/blog`, diffed run over run. The index describes each post it lists, so a candidate off it already carries the post's own title and its publish date | `@vercel` |

Every signal carries one of four source labels, used in the embed, the footer,
and the issue: `article` (anything published on the competitor's own site
that is not a changelog entry), `newsletter`, `tweet`, `changelog`. Only a
newsletter goes unlinked, because its URL is a thread in our own inbox.

Competitor compare pages read once per run as context, never as evidence
about Railway: `https://vercel.com/compare/railway` and
`https://render.com/docs/migrate-from-railway`.

A source that is unconfigured or throwing is logged and skipped. One broken
feed never takes down the run. A competitor with no changelog is skipped
silently rather than noted as a failure: Vercel not having one is the design,
not an outage.

## Daily loop

GitHub Actions cron at **14:00 UTC (7am PT)**. One run does:

1. **Refresh the Railway index.** Fetch the hand-listed product docs in
   `src/railway/products.ts` plus the compare and migrate pages. Store
   competitor-mentioning paragraphs from the compare pages as `claims`.
2. **Collect** candidates from every configured source.
3. **Dedupe** against `items` on `(competitor, source, external_id)`. Only new
   rows continue.
4. **Fill in the body.** A blog diff yields a URL and whatever the listing
   said about it, so fetch the article for the text, and for the title and
   date on the indexes that name neither.
5. **Analyze** each new item with the Cursor API (`claude-opus-5`) with the
   Railway docs for the products it touches in context. Parse into impact,
   one sentence, detail bullets, one to three actions, citations, open
   questions. Run the guards (see Docs grounding).
6. **Illustrate and file.** Find the feature image, then open one GitHub issue
   per action. Store both with the verdict so a retry re-links instead of
   re-filing.
7. **Post** one Discord embed per item, then stamp `analyses.posted_at`. An
   unstamped post is retried for up to three days.

Caps: `MAX_ITEMS_PER_SOURCE` (8) and `MAX_ITEMS_PER_RUN` (12). The first run
for each competitor + source records the backlog without alerting, so turning
on a new source never floods the channel.

## Discord delivery

A Discord bot (not a webhook) posts one embed per signal to `DISCORD_CHANNEL_ID`
using `DISCORD_BOT_TOKEN`. The bot needs `Send Messages` and `Embed Links` in
that channel. Bot token over webhook because the API returns real errors
(missing permission, wrong channel) and the channel can change without a new
secret.

Embed shape, in this order and nothing else:

1. **Feature image** – the changelog or blog image, a tweet image, or a
   screenshot of the feature page. Never posted without one.
2. **What you need to KNOW** – one sentence on what changed, source link on
   the end named by its label (`changelog`, `article`, `tweet`, `newsletter`).
3. **Impact** – Minor / Notable / Major.
4. **More detail** – two to four short bullets.
5. **Recommended action(s)** – each action as its own field: bold title, one
   sentence that leads with the work, link to that action's own GitHub issue.
6. **Footer** – competitor · source · model.

Page citations, suggested edits, and open questions live in the issue, not the
embed. Discord embed limits (6000 chars total, 25 fields, 1024 per field value)
are enforced before posting.

## Docs grounding

Same concept as the PostHog bot. Every recommendation is a claim about what
Railway ships, so it is checked against Railway's product docs first.

**Catalog.** `src/railway/products.ts` hand-lists canonical docs.railway.com
pages, one per product surface, with aliases for the names competitors use.
Seed list, sorted by what Render and Vercel ship against most:

- Deployments, GitHub autodeploys, healthchecks, monorepo, regions, scaling,
  serverless
- Builds, config as code, infrastructure as code
- Environments (PR environments), variables, cron jobs, functions
- Databases, volumes, backups, point-in-time recovery, storage buckets
- Public networking, private networking, domains, static outbound IPs, edge
  networking, CDN, WAF
- Observability (logs, metrics, alerts)
- Pricing, plans, cost control, committed spend
- Enterprise: compliance, audit logs, SAML SSO, access groups, environment
  RBAC, guardrails
- AI: Railway Agent, MCP server, cloud agents, agent integrations
- Templates, CLI, public API

A surface missing from the catalog is a recommendation with nothing to check
it against. Every page URL is verified with a request before it is added.

**Fetch aid.** Each docs page is available as markdown by appending `.md`.
`https://docs.railway.com/llms.txt` is an index of those pages and may be used
in Phase 2 to find a page the catalog does not list. It is not grounding: the
catalog is.

**Guards**, run after the model replies:

- `verifyAgainstDocs` – an action may only say Railway cannot do something
  when a docs excerpt in context shows the gap. A `consider_building` the docs
  contradict becomes `consider_enhancing` against the product that exists. A
  gap claim with no docs page behind it gets an open question, not a ship.
- `enforceUpdatePagesTopic` – a page edit has to be about the launch that
  found it. Off-topic page actions are dropped, even if that empties the alert.
- `isMarketingTarget` – `update_pages` only ever targets Railway's own compare
  and migrate pages, or pricing and features pages when the launch is about
  them. Never a product `/docs/` page other than those. Docs are evidence, not
  edit targets.
- `enforceActionLead` – each action opens with the work, not the gap.

Impact never moves for grounding. Impact is about what the competitor shipped.

## Data store

Supabase Postgres, a project of its own (not the PostHog bot's). Connection via
`DATABASE_URL`, and it has to be the **Session pooler** URI because the direct
host is IPv6-only and Actions runners have no IPv6 route.

Tables, in `migrations/001_init.sql`:

- `items` – one row per signal, unique on `(competitor, source, external_id)`
- `analyses` – verdict as `jsonb`, feature image, issue numbers, `posted_at`
- `pages` – Railway pages read, and which competitors they mention
- `claims` – competitor-mentioning paragraphs that can be cited

None of it is reachable over Supabase's Data API, by
`migrations/002_close_data_api.sql`: row-level security on with no policies, no
`anon` or `authenticated` grants, and no schema default privileges to hand the
same thing to the next table. `DATABASE_URL` is the only way in.

## Secrets

All in this repo's Actions secrets. Never in the repo, never in a chat.

| Secret | Phase | Needed for |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | 1 | Posting embeds |
| `DISCORD_CHANNEL_ID` | 1 | The channel to post to (stored as a variable is fine too) |
| `DATABASE_URL` | 1 | Dedupe and state. Supabase Session pooler URI |
| `CURSOR_API_KEY` | 1 | Opus analysis. Unset falls back to a labeled restatement |
| `X_BEARER_TOKEN` | 1+ (optional) | The X source. Unset skips it |
| `AGENTMAIL_API_KEY` + inbox id | 2 | The newsletter source. Own inbox for this bot |

`GITHUB_TOKEN` is provided by Actions with `issues: write`. No new secret.

## Impact and actions

**Impact** answers one question: what did the post ship?

| Impact | The post is about |
| --- | --- |
| Minor | A product post with no new feature and no enhancement: news, pricing copy, recaps |
| Notable | An enhancement of a feature they already had: new option, limit, region, platform |
| Major | A brand-new feature they did not have before |

Rated on the strongest thing in the post. A label, not a gate: every new
signal gets an embed.

**Actions**, one to three per signal, most important first:

| Action | Means | Target |
| --- | --- | --- |
| `consider_enhancing` | Railway has this and the launch beats it. Names the Railway feature | Product |
| `consider_building` | Railway has nothing like it, shown in the docs | Product |
| `update_pages` | A Railway compare, migrate, pricing, or features page is now wrong, understated, or unanswered | Marketing |

`update_pages` targets only Railway's own pages:
`platform/compare-to-render`, `platform/compare-to-vercel`,
`platform/migrate-from-render`, `platform/migrate-from-vercel`, and
`railway.com/pricing` or a features page when the launch is about them.

## GitHub issues

One issue per action, in this repo, opened before the embed so every action
has a link. Title `Competitor: feature – Action`. Body carries the action in
full, summary, detail, the whole impact scale with this level checked, open
questions, sources, and the image. Product issues cite the docs that back the
action and end with the docs that would change if Railway ships it. Marketing
issues carry url + claim today + suggested edit.

Labels: `competitor-happenings`, `render|vercel`, `source:<label>`,
`impact:<level>`, `action:<action>`, `owner:product|marketing`.

## Phase 1 vs later

**Phase 1** – both blogs and Render's changelog, Opus analysis against the docs
catalog, Discord embeds, one issue per action, Supabase dedupe, 7am PT cron,
dry-run and force-post workflows, `check-env`. X source ships in Phase 1 if
`X_BEARER_TOKEN` is available, otherwise it is skipped with a log line.

**Phase 2** – AgentMail inbox for newsletters (subscribe to Render and Vercel
product updates), llms.txt as a fetch aid for uncatalogued docs pages, richer
image chain (screenshot renderer fallback).

**Later** – PRs that draft the page edit, weekly digest, replying to an alert
to change its actions.

## Non-goals

- Slack. Discord only.
- Sharing anything with posthog-competitor-happenings: no shared code,
  database, secrets, or inbox.
- Editing Railway product docs. Docs are evidence only.
- Alerting on webinars, events, status pages, SDK releases, or LinkedIn.
- Auto-applying page edits.

## Open

- Which Discord server and channel. Resolved when Chase provides
  `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID`.
