-- Schema for railway-competitor-happenings.
--
-- Apply it once to this bot's own Supabase project (not any other bot's):
--   psql "$DATABASE_URL" -f migrations/001_init.sql
-- or paste it into the Supabase SQL editor.
--
-- DATABASE_URL has to be the Session pooler URI. The direct db.<ref>.supabase.co
-- host publishes only an AAAA record and GitHub Actions runners have no IPv6
-- route, so a direct URI works on a laptop and fails on every scheduled run.

-- One row per competitor signal. The unique key is what makes the daily run
-- idempotent: a changelog entry seen yesterday never becomes an alert again.
create table if not exists items (
  id            bigserial primary key,
  competitor    text        not null,
  source        text        not null,
  external_id   text        not null,
  title         text        not null,
  url           text        not null,
  published_at  timestamptz,
  raw           jsonb       not null default '{}'::jsonb,
  seen_at       timestamptz not null default now(),
  unique (competitor, source, external_id)
);

create index if not exists items_competitor_source_seen_idx
  on items (competitor, source, seen_at desc);

-- One row per verdict. `analysis` carries the whole alert: impact, summary,
-- key points, actions, citations, the feature image, and the issue opened for
-- each action, so a retry re-posts the same alert instead of opening a second
-- set of issues. `posted_at` is stamped only once Discord has accepted it.
create table if not exists analyses (
  id         bigserial primary key,
  item_id    bigint      not null references items (id) on delete cascade,
  impact     text        not null,
  analysis   jsonb       not null,
  model      text        not null,
  posted_at  timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists analyses_item_idx on analyses (item_id);
create index if not exists analyses_unposted_idx on analyses (created_at)
  where posted_at is null;

-- Railway pages the bot has read: the hand-listed product docs, which are the
-- evidence an action is checked against, plus the compare, migrate, and
-- pricing pages, which are the only pages an action may ask someone to edit.
create table if not exists pages (
  url        text primary key,
  title      text,
  text       text,
  mentions   text[]      not null default '{}',
  fetched_at timestamptz not null default now()
);

create index if not exists pages_mentions_idx on pages using gin (mentions);

-- Competitor-mentioning paragraphs lifted out of the compare and migrate
-- pages. These are what an update_pages action cites as the claim today.
create table if not exists claims (
  id         bigserial primary key,
  url        text not null references pages (url) on delete cascade,
  competitor text not null,
  paragraph  text not null,
  heading    text
);

create index if not exists claims_competitor_idx on claims (competitor);
create index if not exists claims_url_idx on claims (url);
