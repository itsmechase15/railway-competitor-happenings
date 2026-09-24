-- One quiet-day line per morning, however many times the job runs.
--
-- A morning with nothing in it gets one plain line in Discord, and that line
-- is the one thing the bot posts with no item behind it: the alerts are
-- deduped on `items`, and this has nothing to dedupe on but the day. So the
-- day is the row. The daily workflow is scheduled twice, at 14:00 and 15:00
-- UTC, because 07:00 in Los Angeles is one or the other depending on the
-- season, and a hand-started run is a third; whichever of them gets here
-- first writes the day and speaks, and the rest find it written and stay
-- quiet.
--
--   psql "$DATABASE_URL" -f migrations/004_quiet_days.sql
--
-- Safe to re-run. A day already in the table stays as it was.

-- The date in America/Los_Angeles, which is the zone the schedule is written
-- in: two runs at 14:00 and 15:00 UTC are one morning there. The primary key
-- is the whole mechanism – the insert is the claim, so there is no window
-- between reading that a day is free and taking it.
create table if not exists quiet_days (
  day date primary key,
  posted_at timestamptz not null default now()
);

-- The same treatment migration 002 gives the other tables, for the same
-- reason: Supabase serves everything in `public` over the Data API, and the
-- default privileges there hand `anon` and `authenticated` full write access.
-- A table nobody revokes is a table anyone can empty, and an emptied one here
-- means the channel hears the same morning twice.
alter table quiet_days enable row level security;
revoke all on table quiet_days from anon, authenticated;
