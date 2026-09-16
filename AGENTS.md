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
- **Zero actions is a normal answer**, rendered as **None** with a reason. Do
 not reintroduce a rule that an alert has to recommend something.
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
