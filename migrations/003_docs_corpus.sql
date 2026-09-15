-- Make `pages` the source of truth for what Railway documents.
--
-- Until now `pages` held whatever the hand-listed catalog pointed at, and
-- freshness was one timestamp: a page was re-read when it got old, and there
-- was no way to tell a page that had changed from one that had merely been
-- looked at again. A recommendation is only as good as the corpus behind it,
-- so the corpus now carries its own bookkeeping.
--
--   psql "$DATABASE_URL" -f migrations/003_docs_corpus.sql
--
-- Safe to re-run. Existing rows are backfilled as `docs` pages whose content
-- hash is unknown, which makes the next run re-read them once and record what
-- they actually say.

-- What the page is for. Docs are evidence about the product, marketing pages
-- are the only pages an action may ask anyone to edit, and a changelog entry
-- is evidence that something shipped and none that it is documented.
alter table pages add column if not exists kind text not null default 'docs';

-- Freshness is decided on the body, not the clock: a re-download whose hash
-- matches leaves `changed_at` alone, so "we looked" and "it moved" stay
-- separate facts and a stable page stops costing anything to keep.
alter table pages add column if not exists content_hash text not null default '';
alter table pages add column if not exists changed_at timestamptz not null default now();

-- Which discovery sources offered this URL on the last run: the vendor
-- sitemap, llms.txt, a docs link on a page we already had, or the catalog,
-- which pins the overview pages the bot routes to.
alter table pages add column if not exists discovered_from text[] not null default '{}';

-- Consecutive runs no source offered this URL. Two in a row retires it, so a
-- sitemap that drops a page for one run does not lose us the page.
alter table pages add column if not exists missing_streak integer not null default 0;

-- The last time this page reached an analyst, which is what puts it in the
-- every-few-days refresh tier instead of the every-fortnight one. The pages
-- being reasoned against are the ones worth keeping current.
alter table pages add column if not exists last_used_at timestamptz;

-- Set when the page is gone: missing from every source twice over, or
-- answering 404 or 410. The row stays for the history and leaves the corpus.
alter table pages add column if not exists retired_at timestamptz;

-- The corpus read is "every live page", and the refresh read is "every live
-- page of this kind, oldest first".
create index if not exists pages_live_idx on pages (kind, fetched_at) where retired_at is null;
