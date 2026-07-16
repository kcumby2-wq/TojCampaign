-- 008: Hooks weekly-stats + canonical athlete roster + offer events.
--
-- The Hooks operator (Margin Hooks / Sky's The Limit WR) currently types raw
-- stat lines into a Notes app and screenshots them for Twitter. This gives him
-- a canonical roster table so name/school variants stop drifting ("Braylun" vs
-- "Braylon", "Mans. Lakeridge" vs "M.Lakeridge") and a structured weekly_stats
-- table so Sunday-night branded-card generation becomes deterministic.
--
-- Namespace: all Hooks tables are prefixed `hooks_` to keep the operator's
-- data physically separate from TOJ's own agent tables while sharing the same
-- Postgres instance.

create table if not exists hooks_athletes (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,               -- 'Kaydon Finley'
  name_variants text[] default '{}',          -- ['Kaydon Finley','K. Finley']
  school text,                                -- 'Aledo HS'
  school_short text,                          -- 'Aledo'
  position text,                              -- 'WR'
  class_year int,                             -- 2027
  headshot_url text,
  prospect_edge_url text,                     -- link to Subject Report profile
  twitter text,
  hometown text,
  offer_count int default 0,
  top_apy int,                                -- highest APY offer in dollars
  status text default 'active',               -- active | committed | signed | inactive
  committed_to text,                          -- 'Wisconsin' when committed
  client_id uuid references clients(id) on delete set null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hooks_athletes_name_school_idx
  on hooks_athletes(lower(canonical_name), lower(coalesce(school, '')));
create index if not exists hooks_athletes_status_idx on hooks_athletes(status);
create index if not exists hooks_athletes_client_idx on hooks_athletes(client_id);

-- One row per athlete per game-week. Unique on (athlete, season, week) so
-- re-ingest of the same week updates rather than duplicates.
create table if not exists hooks_weekly_stats (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references hooks_athletes(id) on delete cascade,
  season int not null,                        -- 2025
  week int not null,                          -- 8
  position text,                              -- position at time of stat
  receptions int,
  rec_yards int,
  rec_tds int,
  rush_att int,
  rush_yards int,
  rush_tds int,
  apy int,                                    -- if this row is an APY marker
  notes text,                                 -- e.g. '110 APY' or 'GW TD'
  raw_input text,                             -- 'Kaydon Finley Aledo HS 5-157-2'
  parsed_by text default 'haiku',             -- 'haiku' | 'manual'
  source text default 'paste',                -- 'paste' | 'sms' | 'optimum' | 'manual'
  ingested_by text,                           -- user email
  posted_at timestamptz,                      -- when the marketing card went out
  created_at timestamptz not null default now()
);

create unique index if not exists hooks_weekly_stats_athlete_week_idx
  on hooks_weekly_stats(athlete_id, season, week);
create index if not exists hooks_weekly_stats_week_idx
  on hooks_weekly_stats(season, week);
create index if not exists hooks_weekly_stats_unposted_idx
  on hooks_weekly_stats(posted_at nulls first, created_at desc);

-- Offer / commitment events. Every offer add is a potential "OFFER ADDED"
-- branded post; every commitment/sign is a bigger one. posted_at nulls first
-- lets the publisher find unposted events efficiently.
create table if not exists hooks_offer_events (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references hooks_athletes(id) on delete cascade,
  school text not null,
  event_type text not null default 'offer',   -- offer | commitment | signed
  apy int,
  event_date date not null default current_date,
  source text,
  posted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists hooks_offer_events_athlete_idx
  on hooks_offer_events(athlete_id, event_date desc);
create index if not exists hooks_offer_events_unposted_idx
  on hooks_offer_events(posted_at nulls first, created_at desc);

-- Log of every branded card pack we generate. Lets us re-download a prior
-- Sunday's pack without regenerating, and lets Roster Pulse cite what already
-- shipped so it doesn't recommend duplicate content.
create table if not exists hooks_card_pack_runs (
  id uuid primary key default gen_random_uuid(),
  season int not null,
  week int not null,
  card_type text not null,                    -- 'weekly_leader' | 'leaderboard' | 'offer_add'
  athlete_count int,
  filenames text[],
  generated_by text,
  created_at timestamptz not null default now()
);

create index if not exists hooks_card_pack_runs_week_idx
  on hooks_card_pack_runs(season, week, created_at desc);
