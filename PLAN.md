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
how big it is, and the zero to three things Railway should do about it. Each
action opens a GitHub issue so the work lands on a desk.

Zero is a real answer. A competitor shipping something Railway already does
asks nothing of Railway, and the alert says so with a title naming which kind
of nothing it is, one sentence about this launch, and the docs pages under it.
The failure mode that matters is the other one: an issue telling Railway to
build something Railway already ships. One of those costs the credibility of
every alert after it, so an action that cannot be checked against Railway's own
docs is dropped rather than filed.

Success = the alerts are read and acted on, not muted.

## Inputs and outputs

**In**

- Render and Vercel blogs, Render's changelog, both official X accounts
  (Phase 1+), and a newsletter inbox (Phase 2)
- All of Railway's product docs on docs.railway.com, as the corpus every
  recommendation is checked against
- Railway's own changelog, as evidence that something shipped whether or not
  the docs mention it yet
- Railway's own compare and migrate pages, as the pages a recommendation may
  ask someone to edit
- Each competitor's own compare-to-Railway page, as context only

**Out**

- One Discord embed per new signal in one channel
- One GitHub issue per recommended action that survived the evidence gate
- Rows in Supabase so nothing is alerted twice, and a corpus that remembers
  what Railway documents and when it last changed

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

1. **Refresh the docs corpus.** Discover what Railway publishes from the union
   of the docs sitemap, `llms.txt`, the links held pages carry, and the product
   catalog. Read what is new or stale, hash each body, retire what has gone.
   Store competitor-mentioning paragraphs from the compare pages as `claims`.
2. **Write the workspace.** The corpus as markdown on disk, one file per page
   plus a table of contents, for the analyst to search.
3. **Collect** candidates from every configured source.
4. **Dedupe** against `items` on `(competitor, source, external_id)`. Only new
   rows continue.
5. **Fill in the body.** A blog diff yields a URL and whatever the listing
   said about it, so fetch the article for the text, and for the title and
   date on the indexes that name neither.
6. **Analyze** each new item: BM25 over the corpus pre-loads the ten best
   excerpts, then one Cursor run (`claude-opus-5`) with read-only search over
   the workspace and the whole table of contents. Parse into impact, one
   sentence, detail bullets, zero to three actions with their evidence,
   citations, open questions. Run the guards and the evidence gate (see Docs
   grounding).
7. **Illustrate and file.** Find the feature image, then open one GitHub issue
   per action that passed every check. Store both with the verdict so a retry
   re-links instead of re-filing.
8. **Post** one Discord embed per item, then stamp `analyses.posted_at`. An
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
   With no actions, one field carrying the verdict: **None – Railway already
   does this** or one of the other four kinds, the sentence under it, and a
   `See:` line linking the docs pages it rests on.
6. **Footer** – competitor · source · model.

Page citations, the copy a page edit proposes, and open questions live in the
issue, not the embed. A page edit's sentence names the page and one line under
it says the exact copy is in the issue, because a paragraph of finished prose
does not fit in a field shared with two other actions. Discord embed limits
(6000 chars total, 25 fields, 1024 per field value) are enforced before
posting.

## Docs grounding

Same concept as the PostHog bot. Every recommendation is a claim about what
Railway ships, so it is checked against Railway's product docs first.

**The corpus is the `pages` table.** Not a hand-listed set of pages: the whole
of what Railway publishes about the product, discovered from the union of the
docs sitemap, `llms.txt`, the docs links held pages carry, and the catalog
below, which pins the overview pages the bot routes to. Around 400 docs pages
in practice, plus the five marketing pages and Railway's own changelog.

No single input is trusted. A sitemap lags a launch, `llms.txt` is a subset
curated for somebody else's purpose, and a crawl only reaches what something
already linked. The sibling bot missed an Amplitude consent story because the
pages it could read were a six-URL allowlist and the privacy docs were not on
it; a union of sources is the fix, and the union is also what makes the
coverage gate below possible.

Freshness is a content hash, in two tiers. A re-download that hashes the same
leaves `changed_at` alone. A page an analyst read in the last three days is
re-read every three days, the rest every fortnight, and a URL the corpus has
never held is read the run it turns up. A URL no source has offered for two
runs in a row is retired, and so is one answering 404 or 410.

Each page carries what it is evidence of:

| Kind | What it proves |
| --- | --- |
| `docs` | What Railway ships today. The only evidence a gap claim may rest on |
| `marketing` | Copy written on some past date. Compare, migrate, and pricing pages. Never evidence about the product, and the only pages an action may ask anyone to edit |
| `changelog` | Shipped, may be undocumented. Railway ships ahead of its docs, so a changelog entry proves a capability exists and proves nothing about whether the docs mention it |

**Catalog.** `src/railway/products.ts` hand-lists canonical docs.railway.com
pages, one per product surface, with aliases for the names competitors use. It
no longer decides which pages exist. It does three things on top of the corpus:
names a surface in Railway's own casing, routes an action to the pages that
would contradict it, and boosts a surface's overview page in retrieval, because
"does Railway do this at all" is answered on an overview page and nowhere else.
Keyword lists stay short for the same reason: they route, so a long tail of
common words costs accuracy rather than buying reach. Surfaces:

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

A surface missing from the catalog is a recommendation nobody gave a nickname;
the corpus still holds the pages and the coverage gate still reads them. Every
page URL here is verified with a request before it is added.

**Fetch aid.** Each docs page is available as markdown by appending `.md`,
which is how the corpus is read: no nav, no cookie banner. `llms-full.txt` may
be used once to seed an empty corpus in a single request, and never again -
it is a vendor export, so it is as current as whenever they generated it.

**Retrieval.** BM25 over the stored titles and bodies, with each surface's
overview page boosted and no more than four hits from one docs section. The top
ten excerpts are pre-loaded into the prompt as a starting point. Lexical, not
embeddings, for two reasons: the vocabulary on both sides is the same industry
jargon, and a lexical hit is something a person can open, which is what lets
the coverage gate explain itself and a test reproduce it.

**One analyst run.** The corpus is written to disk as markdown with a table of
contents, and the analyst gets read-only tools over it: read, grep, glob, list.
The files it opens are recorded from its own tool calls. There is no second
model pass that reads the first reply and fixes it: a model shown its own
unsupported claim argues for it better rather than going to check. What
replaces that pass is this run having the corpus, and code checking every claim
against the same corpus afterwards.

**Guards**, run after the reply:

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

**The evidence gate**, which decides what becomes an issue:

- A product action names a `gap` in one line, cites an `evidence_url`, and
  quotes it. Missing any of the three drops the action.
- The cited page has to be in the corpus, and it has to be `docs`. Marketing
  copy is not evidence about the product, and a changelog entry is evidence the
  thing shipped, which is the opposite of a gap.
- The quote has to appear on the stored copy of that page, punctuation aside.
  The analyst read that exact text, so a paraphrase means it did not.
- **Coverage.** The corpus is searched again with the gap's own words. When it
  ranks a page above everything the analysis read, the action is dropped: a gap
  whose words lead straight to a page nobody opened is a gap about a page
  nobody opened. This is the check a hand-listed allowlist could never do.
- Pricing, plans, and packaging are not capability gaps. Billing mechanics can
  be; "their plan costs less" cannot.
- "Document this" is not an action type, and an action asking for docs to be
  written is dropped.
- A page edit has to name a page marketing owns, say what it should say
  instead, and quote copy that is still on the stored page. A page that no
  longer says the thing being corrected has already been fixed.
- A page edit also has to carry the copy itself, in `proposed_text`: the line
  as it should read on the page, written in that page's voice, ready to paste.
  An edit that arrives as "mention the new thing here" is dropped, and so is
  one whose copy is too short to be a line, reads as an instruction about the
  page rather than as the page, or leaves a placeholder for somebody to fill
  in. The analysis has just read the launch and the page; whoever opens the
  issue has read neither, so the writing belongs on this side of it.

A failed check is never rewritten into a weaker action. There is no way to
correct a claim whose basis we cannot find without inventing one, so the action
is dropped and what it said becomes an open question. Zero actions with a
verdict is a normal outcome, and no GitHub issue is opened for anything that
failed.

Every block carries a cause as well as a sentence, because "Railway already
ships this" and "nobody could check whether Railway ships this" are different
answers and only a token tells them apart in code. `covered_elsewhere` and
`wrong_page_ranked` are coverage, so they become **already_covered** naming the
pages the corpus ranked. `packaging` and `docs_only` become **not_a_gap**. Every
other cause becomes **unverified**, naming the check that failed. The mapping is
an exhaustive switch in
[`src/analysis/evidence.ts`](./src/analysis/evidence.ts), so a new cause does
not compile until it has a verdict.

Impact never moves for grounding. Impact is about what the competitor shipped.

## Data store

Supabase Postgres, a project of its own (not the PostHog bot's). Connection via
`DATABASE_URL`, and it has to be the **Session pooler** URI because the direct
host is IPv6-only and Actions runners have no IPv6 route.

Tables, in `migrations/001_init.sql`:

- `items` – one row per signal, unique on `(competitor, source, external_id)`
- `analyses` – verdict as `jsonb`, feature image, issue numbers, `posted_at`
- `pages` – the docs corpus, and which competitors each page mentions
- `claims` – competitor-mentioning paragraphs that can be cited

`migrations/003_docs_corpus.sql` gives `pages` the bookkeeping that makes it a
corpus rather than a cache: `kind`, `content_hash`, `changed_at`,
`discovered_from`, `missing_streak`, `last_used_at`, and `retired_at`.

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

**Actions**, zero to three per signal, most important first:

| Action | Means | Target |
| --- | --- | --- |
| `consider_enhancing` | Railway has this and the launch beats it. Names the Railway feature | Product |
| `consider_building` | Railway has nothing like it, shown in the docs | Product |
| `update_pages` | A Railway compare, migrate, pricing, or features page is now wrong, understated, or unanswered | Marketing |

No new action types, and no "document this": the docs are evidence, and asking
for them to be written is not work this bot files.

**Zero actions** is an answer, carried as a `no_action` verdict: a kind, one
sentence, and the corpus pages under it. The five kinds and where each is
written:

| Kind | Title | Written by |
| --- | --- | --- |
| `already_covered` | None – Railway already does this | The gate, off a coverage cause, or the analyst with docs pages it quoted |
| `not_a_gap` | None – not a product gap | The gate on a pricing or docs-only block, and the relevance guards |
| `unverified` | None – the gap could not be confirmed | Any other failed check, and a stored row that carries only a sentence |
| `dropped_on_review` | None – dropped on review | The review pass, in the reviewer's own words |
| `unanalyzed` | None – not analyzed this run | The heuristic, when `CURSOR_API_KEY` is unset |

`already_covered` is the only kind that has to carry pages. It is a claim about
what Railway ships, so it goes through the checks a gap claim does – in the
corpus, product documentation, quote on the stored copy – and a verdict left
with no evidence is downgraded to `unverified` naming the page that could not
be confirmed. Nothing is invented to fill the space.

The same sentence is written to `noActionReason` alongside the verdict, so a
row stored before the verdict had a shape still reads: it renders as
`unverified` with no pages, which is what it always was.

`update_pages` targets only Railway's own pages:
`platform/compare-to-render`, `platform/compare-to-vercel`,
`platform/migrate-from-render`, `platform/migrate-from-vercel`, and
`railway.com/pricing` or a features page when the launch is about them.

A page edit is finished copy, not a request for copy. The analyst reads the
target page in the workspace, quotes what it says today, and writes what it
should say instead: full sentences in that page's own voice, matching how it
argues (paragraph, table row, bullet), what it calls Railway and the
competitor, and how long its sentences run. A table row is replaced with a
table row. The bar is that a reader cannot tell which line on the page came
from the bot.

## GitHub issues

One issue per action that passed every check, in this repo, opened before the
embed so every action has a link. An alert with no surviving action opens
nothing. Title `Competitor: feature – Action`.

The body reads in the order a reader needs it. Metadata line and image, then
**what you need to know**, then the **recommended action**, then the teams it is
for. Somebody who reads that far and closes the tab has the whole point of the
issue. Everything that justifies the action comes after all three: the gap it
closes with the docs page it was read off and the line quoted from it, the whole
impact scale with this level checked, the detail bullets, the cited pages, open
questions, and sources. Product issues cite the docs that back the action and
end with the docs that would change if Railway ships it. Marketing issues carry
url + copy today + what the edit does + the copy to paste, in a code block,
labeled as a replacement for the quoted line or as an insert next to it.

Labels: `competitor-happenings`, `render|vercel`, `source:<label>`,
`impact:<level>`, `action:<action>`, `owner:product|marketing`, one to three
`team:<slug>` from the routing below, and one `review:<verdict>` from the pass
after it.

## Show the page edit as a picture

An `update_pages` issue carries the page, the line on it today, and the copy to
paste. What text cannot do is show the paragraph with that copy in it, so the
issue embeds a PNG of the paragraph twice, side by side, with removed words
struck through and new ones highlighted.

Drawn from the stored corpus copy of the page and never from the live page. The
Before panel is the text the analyst read and the evidence gate checked the quote
against, which is the copy somebody reviewed; the live page is neither, and
pointing a browser at railway.com every morning to edit its DOM buys nothing.

GitHub renders an image it can fetch, so the PNG is committed to
`artifacts/update-pages/` through the contents API before the issue is opened.
That is the only write this app makes to the repo, and it is why the two pipeline
workflows grant `contents: write`. The file name is a hash of the page and both
sides of the edit: a re-run reuses it, a rewrite gets a new one.

Page actions only. There is no before and after of a feature that does not exist,
so `consider_enhancing` and `consider_building` never get one.

Every step gives up quietly. No browser, no token, a dry run, a refused commit:
the issue is filed in text, saying the same thing in words. A dry run still draws
it to a temp directory and logs the path. `SKIP_PAGE_VISUALS=true` turns it off.
A revise redraws, because the copy is what a revise changes.

## Route it to a team, not to a department

`owner:product` names nobody. Railway publishes no team pages, but the about
page publishes every employee's title, and the titles are the org, so
[`src/railway/teams.ts`](./src/railway/teams.ts) holds the twelve teams those
titles add up to and the surfaces each one builds.

The analyst picks one to three, most involved first, from a list of names and
owned surfaces in its prompt. Its answer is checked, not trusted: a name that is
not on the about page is dropped rather than mapped to something near it, so
"Product", "Engineering", and "Inference Engineering" get nothing back. What
survives falls through to who owns the surface the action names, then to the team
vocabulary in the action's own words, then to Marketing for a page edit and
Product Engineering for anything else. The cap of three is real – a longer list
routes worse than a short one – and there is no team for the CEO or for Head of
Engineering, whose work the two engineering teams already cover.

Refreshing the list means reading the about page again. Nothing in it is derived
from the product catalog, so a team Railway grows into stays missing until
someone edits that file.

## Review every action once

The mistake worth the most to catch is an issue telling Railway to build
something Railway already ships. The evidence gate catches the ones whose
evidence is missing or fake. What it cannot catch is the claim whose evidence is
real and whose counter-evidence is on a page the analyst never opened, argued
well enough to read as true.

So once an action's issue is open, a **second model** reads the same corpus and
returns one verdict on that action:

| Verdict | Issue | Embed |
| --- | --- | --- |
| `agree` | Comment naming the pages it read, `review:agreed` | Unchanged |
| `revise` | Title, body, and labels rewritten, with a before/after comment, `review:revised` | Carries the corrected action |
| `drop` | Closed as not planned, `review:dropped`, with the verdict as a comment and as an `## Outcome` section above the body | The action is absent, and an alert that loses all of them shows **None – dropped on review** in the reviewer's own words, with the pages it read |

A `revise` is applied by the analyst's model in one text-only run: no corpus, no
tools, and only the pages the reviewer read in its prompt. What comes back is
bounded twice. `mergeRevision` refuses anything the reviewer did not ask for – a
type change that is not a swap between the two product actions, a surface name
the catalog does not know, an impact move nobody requested, copy for a page the
analysis never cited or that marketing does not write. Then `checkAction` runs
the whole chain again: docs reconciliation, page targets, topic guard, evidence
gate, sentence shaping. A rewrite that fails any of it is thrown away, the
original issue stands, and the label is `review:unconfirmed`. There is no third
pass.

For an `update_pages` action the rewrite **is** the copy for the page, so it is
held to the same `copyFault` check the analyst's `proposed_text` is: an
instruction, a fragment, or a placeholder is refused, and the original copy
stands.

The pass runs between the issues and the Discord post. The issue exists, so a
verdict has somewhere to write itself; the embed has not gone out, so a dropped
action is absent rather than corrected. It runs once per action: an edit never
calls the reviewer, every verdict stamps `review-pass:done`, the entry point
refuses an issue carrying it, the verdict is stored on the analysis row so a
retried post finds it, and `REVIEW_MAX_PER_RUN` (12) caps a run.

Models: `REVIEW_MODEL` (`claude-fable-5-1`) reviews, `UPDATER_MODEL`
(`CURSOR_MODEL`) rewrites, `SKIP_REVIEW` turns the pass off for a local run. A
model id the Cursor SDK turns down costs the run nothing: the action is filed as
written and labelled `review:skipped`.

## Phase 1 vs later

**Phase 1** – both blogs and Render's changelog, Opus analysis against the docs
corpus with read-only search over it, the evidence gate, the one-pass review of
every filed action, Discord embeds, one issue per surviving action, Supabase
dedupe, 7am PT cron, dry-run and
force-post workflows, `check-env`. X source ships in Phase 1 if
`X_BEARER_TOKEN` is available, otherwise it is skipped with a log line.

**Phase 2** – AgentMail inbox for newsletters (subscribe to Render and Vercel
product updates), richer image chain (screenshot renderer fallback).

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
