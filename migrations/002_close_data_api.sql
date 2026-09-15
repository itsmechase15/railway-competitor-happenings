-- Take the four tables off the Data API.
--
-- Supabase serves every table in `public` over PostgREST, and the default
-- privileges on that schema hand `anon` and `authenticated` full insert,
-- update, and delete on anything created in it. With row-level security off,
-- that pair means the project URL and the publishable key are enough to read,
-- edit, and delete every row. That is the `rls_disabled_in_public` advisor.
--
-- Nothing here uses that path. The bot connects over the session pooler as
-- `postgres`, which has BYPASSRLS, so none of this changes what a run can do.
-- Safe to re-run, and safe to run before or after the app has written rows.
--
--   psql "$DATABASE_URL" -f migrations/002_close_data_api.sql

alter table items enable row level security;
alter table analyses enable row level security;
alter table pages enable row level security;
alter table claims enable row level security;

-- No policies follow, on purpose. Row-level security with no policy denies
-- every row to every role that does not bypass it, and the two roles PostgREST
-- authenticates as, `anon` and `authenticated`, are exactly those. This is also
-- the half the advisor reads: it checks the flag, not the grants.

-- The grants themselves, so a mistakenly added policy cannot re-open the door.
revoke all on table items, analyses, pages, claims from anon, authenticated;

-- Revoking on four tables leaves the fifth table to repeat the finding, because
-- the grants came from default privileges rather than from anything this repo
-- wrote. These are the defaults `postgres` applies to what `postgres` creates,
-- which is every object here.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
