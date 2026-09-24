# Working on this repo

A bot that reads what Render and Vercel shipped and tells Railway what to do
about it, once a morning, in Discord. [README.md](./README.md) is the tour and
[PLAN.md](./PLAN.md) is the operator plan. This file is the part an agent needs
before it changes anything.

Never paste a secret into a file, a commit, or a chat. Naming the variable –
"set `CURSOR_API_KEY`" – is the whole job.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check-env -- --strict` | Name every variable and whether it is set |
| `DRY_RUN=true FORCE_ANALYZE=true npm run run` | Full pipeline, prints the payloads, posts nothing, writes nothing |
| `SKIP_REVIEW=true DRY_RUN=true … npm run run` | The same without the review pass, for when you only care about the analysis |
| `npm run run -- --url <url>` | Push one named announcement through the whole pipeline |
| `npm run run -- --check-discord` | Ask Discord what the bot token can see |
| `npm test` / `npm run typecheck` | What CI runs |

A dry run is the real thing minus delivery: it builds the corpus, runs the
analyst against it, and reviews what it files. The issue editor logs what it
would have written rather than writing it, so a dry run shows the whole outcome
and not the half of it that needs no credentials. `SKIP_RAILWAY_INDEX=true`
skips the corpus rebuild when you only care about the embed, at the cost of
every gap claim being dropped for want of anything to check it against.

A dry run still photographs the page for a page edit, writes both PNGs to a
temp directory, and logs the paths, because that is the part worth looking at
and it needs no credentials. It commits nothing, and it publishes nothing to
Railway: the proposed copy goes into the headless browser's own copy of the
document and dies with the tab. `SKIP_PAGE_VISUALS=true` skips the whole thing,
which is what you want on a box with no Chromium: run
`npx playwright install chromium` once if you would rather see it.

## House rules for changes

- **Evidence is checked, never trusted.** A product action names its gap, cites
  a corpus page, and quotes it, and every part of that is verified against the
  stored page by code in [`src/analysis/evidence.ts`](./src/analysis/evidence.ts).
  A check that cannot pass is a dropped action and an open question, never a
  correction: there is no way to rewrite a claim whose basis we cannot find
  without inventing one.
- **The docs are evidence, never a target.** `update_pages` may only name a
  compare, migrate, pricing, or features page. A `docs.railway.com` product page
  is what an action is judged against, so asking for one to be edited is turning
  the evidence into the job.
- **A page edit ships the copy.** `proposed_text` is the words for the page, not
 a note about them. `PAGE_REWRITE_RULES` in
 [`src/analysis/prompt.ts`](./src/analysis/prompt.ts) states it and `copyFault`
 enforces it, for the analyst and for the review's writer alike.
- **A page edit is the size of the thing it fixes.** A page could nearly always
 carry more about a competitor, and that is not a reason to put it there: the
 copy may add at most as many words as the passage it lands in already runs to,
 never more than a fifth of the page, and 45 words always fit.
 [`src/analysis/proportion.ts`](./src/analysis/proportion.ts) measures it
 against the stored page and the gate drops what is over, with the numbers in
 the open question. Nothing shortens the copy, because shortening copy is
 writing it: the analyst is told the rule and the review pass is given the
 measured sizes, so a shorter edit is one a model wrote rather than one this
 inferred. Do not raise the allowance to let a good paragraph through – the
 paragraph is the failure.
- **Do not add a guess-then-fix model pass.** A model shown its own unsupported
  claim argues for it better rather than going to check. One analyst run, with
  the corpus under it, then code.
- **The review pass is not that pass.** Once an action's issue is open, a
  different model reads the same corpus and says agree, revise, or drop, and a
  revise is rewritten once and re-gated by the same code. Five things make it a
  review rather than a model marking its own homework: it is a **different
  model** from the analyst, it is **shown the analyst's claim** rather than its
  own, it has the **corpus underneath it** rather than a memory of one, the
  rewrite is **re-checked by code** and not by another model, and it happens
  **once** – an unconfirmed rewrite is never applied. Take away any one of those
  and it becomes the forbidden pass. See [`src/review/`](./src/review/) and the
  [Review section of PLAN.md](./PLAN.md#review-every-action-once).
- **Zero actions is a normal answer**, and it is a verdict rather than a blank:
 a kind, one sentence about this launch, and the corpus pages under it. The
 five kinds are `already_covered`, `not_a_gap`, `unverified`,
 `dropped_on_review`, and `unanalyzed`, and
 [`src/analysis/noAction.ts`](./src/analysis/noAction.ts) is the only place that
 decides what they look like. Do not reintroduce a rule that an alert has to
 recommend something, and do not add a generic line for a writer that has
 nothing specific to say: `test/no-action.test.ts` greps `src/` for the
 platitudes this replaced and fails on a hit. Writing one means naming the
 capability and the page, or picking the kind that admits it does not know.
- **An open question is a question.** Every line under Open questions ends on
 one, because the heading promises one and "Whether the new tier is on every
 plan" is that thought with the asking taken out of it.
 [`src/analysis/questions.ts`](./src/analysis/questions.ts) holds the shape and
 never the substance: a `whether` clause gets the stem it is missing, a hedge in
 front of one is dropped, a line that already opens interrogatively gets its
 question mark, and anything else is dropped rather than rewritten, because
 deciding what a statement was asking is writing the question. The lines this
 bot writes itself – the gate's dropped action, an unconfirmed gap, a run with
 no model – are written as questions where they are written, not repaired after
 the fact.
- **An issue reads news, detail, ask, then everything that justifies the ask.**
 What you need to know, More detail, Recommended action, and only then the gap,
 the teams, the impact scale, the pages, the open questions, and the sources. A
 reader who has not understood the launch cannot judge the recommendation, which
 is why the bullets sit above it and why the Discord embed reads the same way.
- **An empty list of cited pages is an answer, not a failed lookup.** "Railway
 docs this was checked against" holds the pages the recommendation was read
 against, and on a `consider_building` action it is usually empty: Railway has
 not written about a capability Railway does not ship. The copy there says that,
 and it is a different section from "Docs that would change if this ships",
 which is the work the day Railway does ship it. Do not word either of them so
 it reads as a search that fell over.
- **A morning with nothing in it is posted, not skipped, and posted once.** A
 daily run that read the sources and found nothing new posts one plain line,
 because silence and a broken job read identically in a channel. It is held
 back by three things and only those three – an alert already went out,
 something new turned up and never became an alert, or not one source could be
 read – and each is a run that cannot honestly call the day quiet. It is not an
 embed, the line is not retried, and posting one URL by hand never triggers it.
 What *is* stored is the date: an alert is deduped on the item under it and this
 line has none, so the first run of a day in America/Los_Angeles takes that date
 in `quiet_days` and speaks, and any later run of the same day finds it taken.
 Count the day where the schedule is written and nowhere else – 14:00 and 15:00
 UTC are one morning there, and a day counted in UTC splits a hand-started
 evening run off into a second one. The workflow gate that runs only the cron
 entry which is 07:00 in Los Angeles today is the cheap half of this, and it is
 not a substitute: a rerun, a hand-started run, and a gate that cannot read the
 zone all reach the claim. See [`src/discord/quiet-day.ts`](./src/discord/quiet-day.ts),
 [`migrations/004_quiet_days.sql`](./migrations/004_quiet_days.sql), and
 `test/quiet-day.test.ts`.
- **"Railway already does this" is evidence, not a mood.** The comfortable
 answer is a claim about the product, so it is checked the way a gap claim is:
 the page has to be in the corpus, be product documentation, and contain the
 quote. A verdict whose evidence fails is downgraded to `unverified` naming the
 page, never kept with its pages quietly dropped.
- **The Before/After is two screenshots of the live page, and publishes
 nothing.** An `update_pages` issue embeds a PNG of the page as it reads today
 and a PNG of the same page with the proposed copy in it, taken by
 [`src/media/live-page.ts`](./src/media/live-page.ts): open the page in a
 headless browser, shoot it, put the copy into that tab's own DOM, shoot it
 again, throw the tab away. Nothing is submitted anywhere and the After's
 caption says so. What the edit **adds** is highlighted on the After and only
 there, so a reader spots it in a thumbnail; the Before is never marked, and
 nothing the page already said is either. That last part is `copyRuns` in
 [`src/media/page-edit.ts`](./src/media/page-edit.ts), which splits the copy
 against the line being replaced before the browser sees it, so a replacement
 that keeps a sentence of that line leaves it plain. Wrapping the whole of
 `proposed_text` in one mark is the bug that fixed, not a simplification worth
 going back to. This replaced a card drawn from
 the corpus text, which read as a text mock of a page rather than the page – do not bring it back, as a
 fallback or otherwise (Chase asked for the real UI, in so many words). The
 corpus is still what the claim is *checked* against, and a claim the live page
 no longer has is a dropped picture and a line in the issue saying the page has
 moved on, never a guess at where it went. Page actions only: there is no before
 and after of a feature that does not exist. Every step fails soft – no browser,
 a page that will not load, no token, a refused commit – because an issue
 without the pictures says the same thing in words.
- **A team is read off the about page, never invented.** Every entry in
 [`src/railway/teams.ts`](./src/railway/teams.ts) is the group of employee titles
 [railway.com/about](https://railway.com/about) lists, which is why there is no
 Inference Engineering, no CEO, and no emoji: Railway publishes none of the
 three. A model's suggested team is looked up there and dropped when it is not
 found, so adding a fallback that maps an invented name to the nearest real team
 undoes the whole check. Refreshing means re-reading the page.
- **Discord only.** No Slack, and nothing shared with
  [posthog-competitor-happenings](https://github.com/itsmechase15/posthog-competitor-happenings):
  same product pattern, separate code, database, and secrets.
- **New environment variable?** Add it to [`src/config.ts`](./src/config.ts),
  [`src/setup/requirements.ts`](./src/setup/requirements.ts), `.env.example`, and
  the workflow steps that run the pipeline. `test/requirements.test.ts` and
  `test/workflows.test.ts` fail until all four agree, because a variable the code
  reads and the workflow never passes is a setting nobody can change.
