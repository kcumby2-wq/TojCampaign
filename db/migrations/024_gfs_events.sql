-- 024: Ground Floor Sports · Pylon events — the event-media system in the TOJ
-- app (routes/gfs.js, utils/gfs.js, public/app/gfs.js).
--
-- 7–10 people run Pylon events across the country: Regional Directors plan
-- their region's events, set creator crews, load the roster and consent flags,
-- log footage, tag clips by jersey number, deliver what Schedule C of the
-- Pylon agreement owes, and send clips to SportsClippers. Kyron and Pylon's
-- approvers see every region and clear what goes public.
--
-- What lives here, and what doesn't:
--   * The roster keeps a Sports Thread roster ID, team, division, jersey,
--     position and the permission flags. Never a name, birth date, contact,
--     school or hometown: the importer drops those columns before storing.
--   * Clips are the upload log (file names, angles, jersey tags), not video.
--     Footage stays in GFS storage; SportsClippers hosts what gets listed.
--   * Creators are the adults (and youth creators, through a parent) GFS books.
--
-- Rules the database enforces, so no route bug can break them:
--   * A creator is crewed only with a signed contract, a background check and
--     minor-safety training inside the year before the event ends (Scout
--     Agreement v1.6 §6). A youth creator never leads or edits, and never
--     works without a confirmed, screened adult on site (Creator Playbook
--     v1.5). Crew changes lock the event row, so two at once can't race past
--     that, and deleting a crew row is held to the same rule. A creator's
--     tier can't change while they're on an upcoming crew.
--   * A clip's hold comes from the athlete's record: a takedown, a
--     do-not-publish flag, or no capture consent; or, for a clip that was out
--     when the roster changed its athlete's number or team, "roster_changed".
--     A held clip can't be approved, sent to a family or listed.
--   * A roster correction (a new jersey or team) sends that athlete's clips
--     back to tag review, unless they're already out.
--   * Clips move shot → tagged → edited → approved, one step at a time.
--   * A clip is marked sent or listed only after it went out in the family
--     file or the SportsClippers file, and only as public if it was exported
--     as public. A new tag, or a trip back to the start, clears the export:
--     a file made under one athlete is never marked sent under another.
--   * SportsClippers Schedule A: listing needs sale-of-media consent; public
--     only when the guardian chose public display and the athlete is not
--     under 13 (no verified age, or a division numbered 12 or under, counts as
--     under 13). A listing the roster stops allowing gets a pull reason.
--   * A deliverable that posts on Pylon's channels is approved only with the
--     approver recorded and their attestation that no athlete on the event's
--     keep-out list appears, and only when every athlete it names has capture
--     and marketing consent and no hold (Schedule C-1 "Consent"), checked
--     again whenever the names on a cleared piece change.
--   * A takedown sets its own clock (safety request: 2h Pylon channels, 24h
--     elsewhere; withdrawn consent: 24h and 72h; a removal request to
--     accounts Pylon doesn't run within 24h) and sets the athlete to
--     do-not-publish at every event the same moment, including events whose
--     roster loads later. That flag can't be cleared while the takedown
--     stands, and "off every other surface" can't be marked done while any of
--     the athlete's clips are still out.
--
-- Everything is service-role only (RLS on, one service_role policy each).
-- Functions run with an empty search_path and name every table in full.

-- ── Regions on the team ──────────────────────────────────────────────────
alter table public.team_members add column if not exists regions text[] not null default '{}'::text[];
alter table public.team_invites add column if not exists regions text[] not null default '{}'::text[];
alter table public.team_members drop constraint if exists team_members_regions_chk;
alter table public.team_members add constraint team_members_regions_chk
  check (regions <@ array['west', 'south_central', 'northeast', 'southeast', 'midwest']::text[]);
alter table public.team_invites drop constraint if exists team_invites_regions_chk;
alter table public.team_invites add constraint team_invites_regions_chk
  check (regions <@ array['west', 'south_central', 'northeast', 'southeast', 'midwest']::text[]);

-- ── Events ───────────────────────────────────────────────────────────────
create table if not exists public.gfs_events (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9]{2,24}$'),
  name text not null check (char_length(name) between 2 and 120),
  series text check (series is null or char_length(series) <= 60),
  size text not null check (size in ('premier', 'one_day', 'clinic')),
  region text not null check (region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  city text not null check (char_length(city) between 1 and 80),
  state text not null check (state ~ '^[A-Z]{2}$'),
  venue text check (venue is null or char_length(venue) <= 120),
  tz text not null default 'America/Chicago',
  starts_on date not null,
  ends_on date not null,
  wraps_at time not null default '18:00',
  ends_at timestamptz not null,
  director_email text check (director_email is null or director_email = lower(director_email)),
  status text not null default 'planning' check (status in ('planning', 'live', 'wrapped', 'closed', 'cancelled')),
  crew_target int not null default 2 check (crew_target between 0 and 30),
  clip_price_cents int not null default 1999 check (clip_price_cents between 0 and 100000),
  storefront_url text check (storefront_url is null or storefront_url ~ '^https://[^\s]{4,300}$'),
  storefront_ready_at timestamptz,
  roster_in_at timestamptz,
  brief_sent_at timestamptz,
  tags_approved_at timestamptz,
  tags_approved_by text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on and ends_on - starts_on <= 6)
);
create index if not exists gfs_events_region_idx on public.gfs_events (region, starts_on);
create index if not exists gfs_events_starts_idx on public.gfs_events (starts_on);

-- Deadlines run from the end of the event (Schedule C): the last day at the
-- wrap time, in the event's own time zone. An unknown zone raises here.
create or replace function public.gfs_events_times() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.ends_at := (new.ends_on + new.wraps_at) at time zone new.tz;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists gfs_events_times on public.gfs_events;
create trigger gfs_events_times before insert or update on public.gfs_events
  for each row execute function public.gfs_events_times();

-- ── Creators ─────────────────────────────────────────────────────────────
create table if not exists public.gfs_creators (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{4,8}$'),
  name text not null check (char_length(name) between 1 and 80),
  email text check (email is null or (email = lower(email) and char_length(email) <= 200)),
  region text not null check (region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  home_city text check (home_city is null or char_length(home_city) <= 80),
  tier text not null default 'adult' check (tier in ('adult', 'youth')),
  lead_scout boolean not null default false,
  contract_signed_on date,
  background_check_on date,
  safety_training_on date,
  shadow_events int not null default 0 check (shadow_events between 0 and 50),
  status text not null default 'active' check (status in ('active', 'paused', 'inactive')),
  notes text check (notes is null or char_length(notes) <= 500),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tier = 'adult' or not lead_scout)
);
create index if not exists gfs_creators_region_idx on public.gfs_creators (region, status);

-- Screened for an event that ends on on_date: active, contract signed, and a
-- background check and minor-safety training inside the year before.
create or replace function public.gfs_creator_ok(c public.gfs_creators, on_date date) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(c.status = 'active' and c.contract_signed_on is not null
                  and c.background_check_on >= (on_date - interval '1 year')::date
                  and c.safety_training_on >= (on_date - interval '1 year')::date, false)
$$;

-- A youth creator's roles are limited and an adult's role can anchor a youth
-- creator, so the tier doesn't change while they're on an upcoming crew.
create or replace function public.gfs_creators_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.tier is distinct from old.tier
     and exists (select 1 from public.gfs_crew x join public.gfs_events e on e.id = x.event_id
                 where x.creator_id = new.id and x.status in ('invited', 'confirmed') and e.ends_on >= current_date) then
    raise exception 'gfs_creator_on_crew';
  end if;
  return new;
end $$;
drop trigger if exists gfs_creators_check on public.gfs_creators;
create trigger gfs_creators_check before update on public.gfs_creators
  for each row execute function public.gfs_creators_check();

-- ── Crew ─────────────────────────────────────────────────────────────────
create table if not exists public.gfs_crew (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  creator_id uuid not null references public.gfs_creators(id) on delete restrict,
  role text not null check (role in ('lead', 'shooter', 'photographer', 'story', 'editor', 'shadow')),
  status text not null default 'invited' check (status in ('invited', 'confirmed', 'declined', 'removed')),
  note text check (note is null or char_length(note) <= 120),
  family_rating numeric(2, 1) check (family_rating is null or family_rating between 1 and 5),
  rating_count int check (rating_count is null or rating_count between 0 and 100000),
  assigned_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists gfs_crew_active_idx on public.gfs_crew (event_id, creator_id)
  where status in ('invited', 'confirmed');
create index if not exists gfs_crew_creator_idx on public.gfs_crew (creator_id);

-- An "anchor" is a confirmed adult on site (lead, shooter, photographer or
-- story camera) who is screened for the event. A confirmed youth creator
-- needs one; the last one can't step away (decline, removal, un-confirming,
-- or a move to an off-site role) while a youth creator is confirmed.
create or replace function public.gfs_crew_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  c public.gfs_creators%rowtype;
  e public.gfs_events%rowtype;
  floor_date date;
  was_anchor boolean := false;
  is_anchor boolean;
  others_anchor boolean;
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.event_id := old.event_id;
    new.creator_id := old.creator_id;
    -- A note or a family rating after the event changes nothing to check.
    if new.role = old.role and new.status = old.status then return new; end if;
  end if;
  -- One crew change per event at a time: without this, confirming a youth
  -- creator and removing the last adult at the same moment would both pass.
  select * into e from public.gfs_events where id = new.event_id for update;
  select * into c from public.gfs_creators where id = new.creator_id;

  if new.status in ('invited', 'confirmed') then
    floor_date := (e.ends_on - interval '1 year')::date;
    if c.status is distinct from 'active' then raise exception 'crew_creator_not_active'; end if;
    if c.contract_signed_on is null then raise exception 'crew_no_contract'; end if;
    if c.background_check_on is null or c.background_check_on < floor_date then raise exception 'crew_background_check'; end if;
    if c.safety_training_on is null or c.safety_training_on < floor_date then raise exception 'crew_safety_training'; end if;
    if c.tier = 'youth' and new.role not in ('shooter', 'photographer', 'shadow') then raise exception 'crew_youth_role'; end if;
  end if;

  is_anchor := new.status = 'confirmed' and new.role in ('lead', 'shooter', 'photographer', 'story')
               and c.tier = 'adult' and public.gfs_creator_ok(c, e.ends_on);
  if tg_op = 'UPDATE' then
    was_anchor := old.status = 'confirmed' and old.role in ('lead', 'shooter', 'photographer', 'story')
                  and c.tier = 'adult' and public.gfs_creator_ok(c, e.ends_on);
  end if;
  others_anchor := exists (
    select 1 from public.gfs_crew x join public.gfs_creators y on y.id = x.creator_id
     where x.event_id = new.event_id and x.id <> new.id and x.status = 'confirmed'
       and x.role in ('lead', 'shooter', 'photographer', 'story') and y.tier = 'adult'
       and public.gfs_creator_ok(y, e.ends_on));

  if c.tier = 'youth' and new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') and not others_anchor then
    raise exception 'crew_youth_needs_adult';
  end if;
  if was_anchor and not is_anchor and not others_anchor
     and exists (select 1 from public.gfs_crew x join public.gfs_creators y on y.id = x.creator_id
                 where x.event_id = new.event_id and x.id <> new.id and x.status = 'confirmed' and y.tier = 'youth') then
    raise exception 'crew_youth_left_alone';
  end if;
  return new;
end $$;
drop trigger if exists gfs_crew_check on public.gfs_crew;
create trigger gfs_crew_check before insert or update on public.gfs_crew
  for each row execute function public.gfs_crew_check();

-- Deleting a crew row is held to the same rule as removing it (an event
-- deleted as a whole takes its crew with it).
create or replace function public.gfs_crew_guard_delete() returns trigger
language plpgsql set search_path = '' as $$
declare
  c public.gfs_creators%rowtype;
  e public.gfs_events%rowtype;
begin
  select * into e from public.gfs_events where id = old.event_id for update;
  if not found then return old; end if;
  select * into c from public.gfs_creators where id = old.creator_id;
  if old.status = 'confirmed' and old.role in ('lead', 'shooter', 'photographer', 'story')
     and c.tier = 'adult' and public.gfs_creator_ok(c, e.ends_on)
     and not exists (select 1 from public.gfs_crew x join public.gfs_creators y on y.id = x.creator_id
                      where x.event_id = old.event_id and x.id <> old.id and x.status = 'confirmed'
                        and x.role in ('lead', 'shooter', 'photographer', 'story') and y.tier = 'adult'
                        and public.gfs_creator_ok(y, e.ends_on))
     and exists (select 1 from public.gfs_crew x join public.gfs_creators y on y.id = x.creator_id
                  where x.event_id = old.event_id and x.id <> old.id and x.status = 'confirmed' and y.tier = 'youth') then
    raise exception 'crew_youth_left_alone';
  end if;
  return old;
end $$;
drop trigger if exists gfs_crew_guard_delete on public.gfs_crew;
create trigger gfs_crew_guard_delete before delete on public.gfs_crew
  for each row execute function public.gfs_crew_guard_delete();

-- ── The roster: IDs, jerseys and permissions only ────────────────────────
create table if not exists public.gfs_roster (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  roster_id text not null check (roster_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  team text not null check (char_length(team) between 1 and 80),
  division text check (division is null or char_length(division) <= 24),
  jersey text check (jersey is null or jersey ~ '^[0-9]{1,2}$'),
  position text check (position is null or position ~ '^[A-Z0-9]{1,6}$'),
  -- Schedule F (Guardian Consent): every permission false unless granted.
  consent_capture boolean not null default false,
  consent_recruiting boolean not null default false,
  consent_marketing boolean not null default false,
  consent_sale boolean not null default false,
  consent_training boolean not null default false,
  consent_3d boolean not null default false,
  consent_nft boolean not null default false,
  consent_feature boolean not null default false,
  -- SportsClippers: commercial license tiers (§6) and public display (Schedule A).
  consent_commercial boolean not null default false,
  public_display boolean not null default false,
  -- From Sports Thread; null = no verified age, treated as under 13 (L-5).
  under_13 boolean,
  do_not_publish boolean not null default false,
  low_profile boolean not null default false,
  priority boolean not null default false,
  takedown_at timestamptz,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, roster_id)
);
create index if not exists gfs_roster_jersey_idx on public.gfs_roster (event_id, team, jersey);
create index if not exists gfs_roster_rid_idx on public.gfs_roster (roster_id);

create or replace function public.gfs_hold_reason(r public.gfs_roster) returns text
language sql immutable set search_path = '' as $$
  select case
    when r.id is null then null
    when r.takedown_at is not null then 'takedown'
    when r.do_not_publish then 'do_not_publish'
    when not r.consent_capture then 'no_capture_consent'
    else null end
$$;

-- L-5: no verified age counts as under 13, and so does a division with any
-- standalone number of 12 or less (12U, U12, U-12, "Under 12", "12 & Under",
-- "Girls U-10"). Mirrors utils/gfs.js under13.
create or replace function public.gfs_under_13(r public.gfs_roster) returns boolean
language sql immutable set search_path = '' as $$
  select r.under_13 is distinct from false
      or exists (select 1 from regexp_matches(coalesce(r.division, ''), '(?:^|\D)(\d{1,2})(?!\d)', 'g') m
                  where m[1]::int <= 12)
$$;

-- A takedown is permanent: its time never clears, and while it stands the
-- athlete stays do-not-publish whatever a later roster file says. A roster
-- that loads after the takedown (the same Sports Thread ID at a later stop)
-- picks it up as the row goes in.
create or replace function public.gfs_roster_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.event_id := old.event_id;
    new.roster_id := old.roster_id;
    if old.takedown_at is not null then new.takedown_at := old.takedown_at; end if;
  end if;
  if new.takedown_at is null then
    new.takedown_at := (select min(t.received_at) from public.gfs_takedowns t where t.roster_id = new.roster_id);
  end if;
  if new.takedown_at is not null then
    new.do_not_publish := true;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists gfs_roster_guard on public.gfs_roster;
create trigger gfs_roster_guard before insert or update on public.gfs_roster
  for each row execute function public.gfs_roster_guard();

-- When an athlete's record changes, their clips follow:
--   * a new jersey or team means the clips may show someone else: the ones
--     that aren't out go back to tag review, and the ones that are out are
--     held ("roster_changed") until someone takes them down and tags them
--     again;
--   * a change to a hold or a SportsClippers permission re-checks each clip's
--     hold and pull reason (the clips gate recomputes both).
create or replace function public.gfs_roster_refresh() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.jersey is distinct from old.jersey or new.team is distinct from old.team then
    update public.gfs_clips
       set match = 'unmatched', why = 'roster_changed', roster_row = null, label = null, stage = 'shot', team = nullif(team_given, '?')
     where roster_row = new.id
       and not ((delivered_at is not null or listed_at is not null) and removed_at is null);
    update public.gfs_clips set retag = true
     where roster_row = new.id
       and (delivered_at is not null or listed_at is not null) and removed_at is null;
  elsif new.takedown_at is distinct from old.takedown_at
     or new.do_not_publish is distinct from old.do_not_publish
     or new.consent_capture is distinct from old.consent_capture
     or new.consent_sale is distinct from old.consent_sale
     or new.public_display is distinct from old.public_display
     or new.under_13 is distinct from old.under_13
     or new.division is distinct from old.division then
    update public.gfs_clips set updated_at = now() where roster_row = new.id;
  end if;
  return null;
end $$;
drop trigger if exists gfs_roster_refresh on public.gfs_roster;
create trigger gfs_roster_refresh after update on public.gfs_roster
  for each row execute function public.gfs_roster_refresh();

-- ── Clips: the upload log, tagged by jersey number ───────────────────────
create table if not exists public.gfs_clips (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  log_key text not null unique,
  game text check (game is null or char_length(game) <= 160),
  -- The matched athlete's team; for an unmatched clip, the team the upload
  -- log named (team_given).
  team text check (team is null or char_length(team) <= 80),
  -- The upload log's team column, kept only when it names one of the game's
  -- teams or a roster team; '?' when it named some other team (the text isn't
  -- kept). Matching treats it as certain, and '?' never matches.
  team_given text check (team_given is null or char_length(team_given) <= 80),
  -- The team folder above the jersey folder, kept only when it names one of
  -- the game's teams or a roster team (B-5's jersey folders alone can't tell
  -- two teams' #7 apart).
  team_hint text check (team_hint is null or char_length(team_hint) <= 80),
  -- Only a jersey folder or 00-unassigned is kept; any other folder name
  -- could be a person's.
  folder text check (folder is null or folder ~ '^([0-9]{1,2}|00-?[Uu][Nn][Aa][Ss][Ss][Ii][Gg][Nn][Ee][Dd])$'),
  file text not null check (file ~ '^[A-Za-z0-9._-]{1,120}$'),
  angle text check (angle is null or angle in ('Sideline', 'EndZone', 'EagleEye', 'Story')),
  clip_no int check (clip_no is null or clip_no between 0 and 99999),
  -- The number the file was filed under; a director's tag doesn't change it.
  jersey text check (jersey is null or jersey ~ '^[0-9]{1,2}$'),
  creator_id uuid references public.gfs_creators(id) on delete set null,
  -- No delete action: a roster row with clips logged against it stays (an
  -- event deleted as a whole takes both with it).
  roster_row uuid references public.gfs_roster(id),
  match text not null default 'unmatched' check (match in ('matched', 'unmatched', 'not_a_player')),
  -- 'jersey': matched (or not) by the file's number; 'manual': a director
  -- decided, and re-matching leaves it alone.
  tag_source text not null default 'jersey' check (tag_source in ('jersey', 'manual')),
  why text check (why is null or why in ('no_number', 'not_on_roster', 'team_not_on_roster', 'two_teams', 'duplicate_number', 'no_roster',
                                         'no_team', 'team_conflict', 'roster_changed', 'untagged', 'number_conflict')),
  label text check (label is null or label ~ '^[A-Za-z0-9-]{3,120}$'),
  held boolean not null default false,
  hold_reason text check (hold_reason is null or hold_reason in ('takedown', 'do_not_publish', 'no_capture_consent', 'roster_changed')),
  -- Out when the roster changed its athlete's number or team: held until it's
  -- taken down and tagged again.
  retag boolean not null default false,
  stage text not null default 'shot' check (stage in ('shot', 'tagged', 'edited', 'approved')),
  approved_by text,
  approved_at timestamptz,
  -- In a family-links file, then marked sent.
  family_export_at timestamptz,
  delivered_at timestamptz,
  -- In a SportsClippers file (and how it was listed there), then marked listed.
  exported_at timestamptz,
  export_visibility text check (export_visibility is null or export_visibility in ('family', 'public')),
  listed_at timestamptz,
  visibility text check (visibility is null or visibility in ('family', 'public')),
  -- A live listing the roster no longer allows (computed by the gate).
  pull_reason text check (pull_reason is null or pull_reason in ('no_sale_consent', 'not_public')),
  removed_at timestamptz,
  uploaded_at timestamptz,
  logged_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (match <> 'matched' or roster_row is not null),
  check (stage = 'shot' or match = 'matched'),
  check (stage <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (listed_at is null or visibility is not null),
  check (exported_at is null or export_visibility is not null)
);
create index if not exists gfs_clips_event_idx on public.gfs_clips (event_id, match, stage);
create index if not exists gfs_clips_roster_idx on public.gfs_clips (roster_row);

create or replace function public.gfs_clips_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  r public.gfs_roster%rowtype;
  reason text;
  was_out boolean;
  going_listed boolean;
  going_delivered boolean;
begin
  new.updated_at := now();
  if new.roster_row is not null then
    select * into r from public.gfs_roster where id = new.roster_row;
  end if;

  -- Once a clip has reached a family or SportsClippers (and hasn't been taken
  -- down), its athlete and its approval are fixed; a wrong tag out there is a
  -- takedown, not an edit.
  was_out := tg_op = 'UPDATE' and (old.delivered_at is not null or old.listed_at is not null) and old.removed_at is null;
  if was_out and (new.roster_row is distinct from old.roster_row or new.stage <> 'approved') then
    raise exception 'gfs_clip_already_out';
  end if;

  -- An export belongs to the clip as it was tagged and approved. A new tag,
  -- or a trip back to the start, means it goes out in a new file: otherwise
  -- a file made under one athlete could be marked sent under another.
  if tg_op = 'UPDATE' and (new.roster_row is distinct from old.roster_row or new.match is distinct from old.match
                           or (new.stage = 'shot' and old.stage is distinct from 'shot')) then
    new.family_export_at := null;
    new.exported_at := null;
    new.export_visibility := null;
  end if;

  -- "Roster changed" sticks until the clip is tagged again.
  if tg_op = 'INSERT' then
    new.retag := false;
  elsif new.roster_row is distinct from old.roster_row or new.match is distinct from old.match then
    new.retag := false;
  elsif old.retag then
    new.retag := true;
  end if;

  -- The hold always comes from the athlete's record (and a stuck re-tag).
  reason := case when new.roster_row is null then null
                 else coalesce(public.gfs_hold_reason(r), case when new.retag then 'roster_changed' end) end;
  new.held := reason is not null;
  new.hold_reason := reason;

  -- One step at a time, or back to the start for a re-tag.
  if tg_op = 'INSERT' and new.stage <> 'shot' then
    raise exception 'gfs_clip_stage';
  end if;
  if tg_op = 'UPDATE' and new.stage is distinct from old.stage and new.stage <> 'shot'
     and not ((old.stage = 'shot' and new.stage = 'tagged')
           or (old.stage = 'tagged' and new.stage = 'edited')
           or (old.stage = 'edited' and new.stage = 'approved')) then
    raise exception 'gfs_clip_stage';
  end if;
  if new.stage <> 'approved' then
    new.approved_by := null;
    new.approved_at := null;
  end if;

  going_listed := new.listed_at is not null and new.removed_at is null
    and (tg_op = 'INSERT' or old.listed_at is null or old.removed_at is not null or new.visibility is distinct from old.visibility);
  going_delivered := new.delivered_at is not null and new.removed_at is null
    and (tg_op = 'INSERT' or old.delivered_at is null or old.removed_at is not null);

  if new.held and (going_listed or going_delivered
                   or (new.stage = 'approved' and (tg_op = 'INSERT' or old.stage is distinct from 'approved'))) then
    raise exception 'gfs_clip_held';
  end if;
  if (going_listed or going_delivered) and new.stage <> 'approved' then
    raise exception 'gfs_clip_not_approved';
  end if;
  -- Marked sent or listed only once it went out in that file, and listed as
  -- public only if the file said public.
  if going_delivered and new.family_export_at is null then
    raise exception 'gfs_clip_not_exported';
  end if;
  if going_listed and (new.exported_at is null or (new.visibility = 'public' and new.export_visibility is distinct from 'public')) then
    raise exception 'gfs_clip_not_exported';
  end if;

  -- SportsClippers Schedule A, whenever a listing starts or changes.
  if going_listed then
    if not coalesce(r.consent_sale, false) then raise exception 'gfs_clip_no_sale_consent'; end if;
    if new.visibility = 'public' and (not r.public_display or public.gfs_under_13(r)) then raise exception 'gfs_clip_not_public'; end if;
  end if;

  -- A live listing the roster no longer allows: no sale consent means it
  -- comes down; lost public display (or under 13) means family-only.
  new.pull_reason := case
    when new.listed_at is null or new.removed_at is not null then null
    when not coalesce(r.consent_sale, false) then 'no_sale_consent'
    when new.visibility = 'public' and (not coalesce(r.public_display, false) or public.gfs_under_13(r)) then 'not_public'
    else null end;
  return new;
end $$;
drop trigger if exists gfs_clips_gate on public.gfs_clips;
create trigger gfs_clips_gate before insert or update on public.gfs_clips
  for each row execute function public.gfs_clips_gate();

-- ── Game uploads (the creator measures) ──────────────────────────────────
create table if not exists public.gfs_uploads (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  log_key text not null unique,
  game text not null check (char_length(game) between 1 and 160),
  angle text not null check (angle in ('Sideline', 'EndZone', 'EagleEye', 'Story')),
  file text not null check (file ~ '^[A-Za-z0-9._-]{1,160}$'),
  creator_id uuid references public.gfs_creators(id) on delete set null,
  final_whistle_at timestamptz,
  uploaded_at timestamptz,
  usable boolean,
  logged_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists gfs_uploads_creator_idx on public.gfs_uploads (creator_id, created_at);
create index if not exists gfs_uploads_event_idx on public.gfs_uploads (event_id);

-- ── Deliverables (Pylon agreement v11, Schedule C-1 and C-2) ─────────────
create table if not exists public.gfs_deliverables (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  kind text not null check (kind in ('top_performers', 'who_is', 'interviews', 'winner_montage', 'championship_photos', 'recap', 'recap_ad',
                                     'cutdowns', 'stills', 'championship_games', 'tagging', 'sponsor_proof', 'event_report')),
  day int not null default 0 check (day between 0 and 7),
  required int not null default 1 check (required between 0 and 1000),
  delivered int not null default 0 check (delivered between 0 and 10000),
  approved_count int not null default 0 check (approved_count between 0 and 10000),
  due_at timestamptz not null,
  delivered_at timestamptz,
  late_cause text check (late_cause is null or char_length(late_cause) <= 200),
  publishes boolean not null default false,
  featured uuid[] not null default '{}'::uuid[],
  status text not null default 'open' check (status in ('open', 'submitted', 'approved', 'changes', 'done')),
  submitted_by text,
  submitted_at timestamptz,
  decided_by text,
  decided_at timestamptz,
  -- The approver's word that no athlete on the event's keep-out list (on
  -- hold, or without marketing consent) appears in what they cleared.
  attested_by text,
  attested_at timestamptz,
  note text check (note is null or char_length(note) <= 300),
  updated_at timestamptz not null default now(),
  unique (event_id, kind, day),
  check (cardinality(featured) <= 200),
  check (approved_count <= delivered),
  check (status not in ('submitted', 'approved', 'changes') or publishes),
  check (status <> 'done' or not publishes),
  check (status <> 'approved' or (decided_by is not null and decided_at is not null and attested_by is not null and attested_at is not null))
);
create index if not exists gfs_deliverables_event_idx on public.gfs_deliverables (event_id);
create index if not exists gfs_deliverables_status_idx on public.gfs_deliverables (status) where status = 'submitted';

create or replace function public.gfs_deliverables_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.approved_count <> 0 then raise exception 'gfs_deliverable_starts_open'; end if;
    return new;
  end if;
  new.publishes := old.publishes;
  new.kind := old.kind;
  new.event_id := old.event_id;

  if new.status is distinct from old.status
     and not ((old.status in ('open', 'changes', 'approved') and new.status = 'submitted')
           or (old.status = 'submitted' and new.status in ('approved', 'changes'))
           or (old.status = 'open' and new.status = 'done')
           or (old.status = 'done' and new.status = 'open')) then
    raise exception 'gfs_deliverable_status';
  end if;

  if new.status = 'submitted' and old.status is distinct from 'submitted' and new.delivered <= old.approved_count then
    raise exception 'gfs_deliverable_nothing_new';
  end if;
  if new.status = 'done' and old.status is distinct from 'done' and new.delivered < new.required then
    raise exception 'gfs_deliverable_short';
  end if;

  -- Naming an athlete (posted, or an interview or tracked Top Performer)
  -- needs capture and marketing consent and no hold: checked as a piece
  -- clears, and again whenever the names on a cleared piece change.
  if (new.status = 'approved' and old.status = 'submitted')
     or (new.status = 'done' and old.status is distinct from 'done')
     or (new.status in ('approved', 'done') and new.featured is distinct from old.featured) then
    if new.kind in ('top_performers', 'who_is', 'interviews') and cardinality(new.featured) = 0 then
      raise exception 'gfs_featured_required';
    end if;
    if exists (
      select 1 from unnest(new.featured) f(rid)
      left join public.gfs_roster r on r.id = f.rid
      where r.id is null or r.event_id <> new.event_id or not r.consent_capture or not r.consent_marketing
         or r.do_not_publish or r.takedown_at is not null) then
      raise exception 'gfs_featured_consent';
    end if;
  end if;

  -- An attestation belongs to one approval: it's given as the piece clears,
  -- by the approver who clears it, and a new submission starts without one.
  if new.status = 'submitted' and old.status is distinct from 'submitted' then
    new.attested_by := null;
    new.attested_at := null;
  elsif not (new.status = 'approved' and old.status = 'submitted') then
    new.attested_by := old.attested_by;
    new.attested_at := old.attested_at;
  end if;

  if new.status = 'approved' and old.status = 'submitted' then
    if new.decided_by is null or new.decided_at is null then raise exception 'gfs_deliverable_approver'; end if;
    if new.attested_at is null or new.attested_by is distinct from new.decided_by then raise exception 'gfs_deliverable_attest'; end if;
    new.approved_count := new.delivered;
  elsif new.approved_count is distinct from old.approved_count then
    new.approved_count := old.approved_count;
  end if;

  if new.delivered < new.approved_count then raise exception 'gfs_deliverable_below_approved'; end if;
  -- Delivered means the count is met; the time it was first met is what the
  -- monthly report checks against the deadline.
  if new.delivered < new.required then
    new.delivered_at := null;
  elsif new.required > 0 and new.delivered_at is null then
    new.delivered_at := now();
  end if;
  return new;
end $$;
drop trigger if exists gfs_deliverables_gate on public.gfs_deliverables;
create trigger gfs_deliverables_gate before insert or update on public.gfs_deliverables
  for each row execute function public.gfs_deliverables_gate();

-- ── Takedowns ────────────────────────────────────────────────────────────
create table if not exists public.gfs_takedowns (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity unique,
  event_id uuid references public.gfs_events(id) on delete set null,
  region text not null check (region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  roster_id text not null check (roster_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  team text check (team is null or char_length(team) <= 80),
  reason text not null check (reason in ('consent_withdrawn', 'safety_request')),
  received_at timestamptz not null default now(),
  pylon_due_at timestamptz not null,
  other_due_at timestamptz not null,
  offsite_due_at timestamptz not null,
  pylon_done_at timestamptz,
  pylon_done_by text,
  other_done_at timestamptz,
  other_done_by text,
  offsite_requested_at timestamptz,
  offsite_requested_by text,
  status text not null default 'open' check (status in ('open', 'done')),
  logged_by text not null,
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  check (status = 'open' or (pylon_done_at is not null and other_done_at is not null and offsite_requested_at is not null))
);
create index if not exists gfs_takedowns_open_idx on public.gfs_takedowns (status, region);
create index if not exists gfs_takedowns_rid_idx on public.gfs_takedowns (roster_id);

create or replace function public.gfs_takedowns_clock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.received_at := coalesce(new.received_at, now());
    if new.received_at > now() + interval '5 minutes' then raise exception 'gfs_takedown_future'; end if;
    if new.reason = 'safety_request' then
      new.pylon_due_at := new.received_at + interval '2 hours';
      new.other_due_at := new.received_at + interval '24 hours';
    else
      new.pylon_due_at := new.received_at + interval '24 hours';
      new.other_due_at := new.received_at + interval '72 hours';
    end if;
    new.offsite_due_at := new.received_at + interval '24 hours';
  else
    -- The athlete, the reason and the clock never change after logging, and
    -- a step marked done stays done.
    new.roster_id := old.roster_id;
    new.reason := old.reason;
    new.received_at := old.received_at;
    new.pylon_due_at := old.pylon_due_at;
    new.other_due_at := old.other_due_at;
    new.offsite_due_at := old.offsite_due_at;
    new.logged_by := old.logged_by;
    if old.pylon_done_at is not null then new.pylon_done_at := old.pylon_done_at; new.pylon_done_by := old.pylon_done_by; end if;
    if old.other_done_at is not null then new.other_done_at := old.other_done_at; new.other_done_by := old.other_done_by; end if;
    if old.offsite_requested_at is not null then new.offsite_requested_at := old.offsite_requested_at; new.offsite_requested_by := old.offsite_requested_by; end if;
  end if;
  -- "Off every other surface" isn't done while a family link or a
  -- SportsClippers listing of the athlete, at any event, is still out.
  if new.other_done_at is not null and (tg_op = 'INSERT' or old.other_done_at is null)
     and exists (select 1 from public.gfs_clips c join public.gfs_roster r on r.id = c.roster_row
                  where r.roster_id = new.roster_id
                    and (c.delivered_at is not null or c.listed_at is not null) and c.removed_at is null) then
    raise exception 'gfs_takedown_clips_out';
  end if;
  new.status := case when new.pylon_done_at is not null and new.other_done_at is not null and new.offsite_requested_at is not null then 'done' else 'open' end;
  return new;
end $$;
drop trigger if exists gfs_takedowns_clock on public.gfs_takedowns;
create trigger gfs_takedowns_clock before insert or update on public.gfs_takedowns
  for each row execute function public.gfs_takedowns_clock();

-- The athlete goes do-not-publish at every event, the same moment.
create or replace function public.gfs_takedowns_flag() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.gfs_roster
     set takedown_at = coalesce(takedown_at, new.received_at), do_not_publish = true
   where roster_id = new.roster_id;
  return null;
end $$;
drop trigger if exists gfs_takedowns_flag on public.gfs_takedowns;
create trigger gfs_takedowns_flag after insert on public.gfs_takedowns
  for each row execute function public.gfs_takedowns_flag();

-- ── Pipeline counts for the Distribution desk ────────────────────────────
--   needs_removal   out (family link or listing) and held, or listed without
--                   sale consent: it has to come down
--   to_family_only  a public listing that lost public display (not held)
--   to_send         in a family-links file, not marked sent yet
--   to_list         in a SportsClippers file, not marked listed yet
drop function if exists public.gfs_event_counts(uuid[]);
create function public.gfs_event_counts(p_events uuid[])
returns table (
  event_id uuid, shot int, matched int, unmatched int, not_a_player int, tagged int, edited int,
  approved int, delivered int, listed int, held int, needs_removal int, to_family_only int, to_send int, to_list int
)
language sql stable set search_path = '' as $$
  select c.event_id,
         count(*)::int,
         count(*) filter (where c.match = 'matched')::int,
         count(*) filter (where c.match = 'unmatched')::int,
         count(*) filter (where c.match = 'not_a_player')::int,
         count(*) filter (where c.stage in ('tagged', 'edited', 'approved'))::int,
         count(*) filter (where c.stage in ('edited', 'approved'))::int,
         count(*) filter (where c.stage = 'approved')::int,
         count(*) filter (where c.delivered_at is not null)::int,
         count(*) filter (where c.listed_at is not null and c.removed_at is null)::int,
         count(*) filter (where c.held)::int,
         count(*) filter (where (c.held or c.pull_reason = 'no_sale_consent')
                            and (c.listed_at is not null or c.delivered_at is not null) and c.removed_at is null)::int,
         count(*) filter (where c.pull_reason = 'not_public' and not c.held)::int,
         count(*) filter (where c.family_export_at is not null and c.delivered_at is null and c.removed_at is null
                            and c.stage = 'approved' and not c.held)::int,
         count(*) filter (where c.exported_at is not null and c.listed_at is null and c.removed_at is null
                            and c.stage = 'approved' and not c.held)::int
    from public.gfs_clips c
   where c.event_id = any (p_events)
   group by c.event_id
$$;
-- Callable by the server only (Supabase grants new functions to its API roles).
revoke all on function public.gfs_event_counts(uuid[]) from public;
revoke all on function public.gfs_hold_reason(public.gfs_roster) from public;
revoke all on function public.gfs_under_13(public.gfs_roster) from public;
revoke all on function public.gfs_creator_ok(public.gfs_creators, date) from public;
do $$
declare
  f text;
begin
  foreach f in array array['public.gfs_event_counts(uuid[])', 'public.gfs_hold_reason(public.gfs_roster)', 'public.gfs_under_13(public.gfs_roster)',
                           'public.gfs_creator_ok(public.gfs_creators, date)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

-- ── Service role only ────────────────────────────────────────────────────
alter table public.gfs_events enable row level security;
alter table public.gfs_creators enable row level security;
alter table public.gfs_crew enable row level security;
alter table public.gfs_roster enable row level security;
alter table public.gfs_clips enable row level security;
alter table public.gfs_uploads enable row level security;
alter table public.gfs_deliverables enable row level security;
alter table public.gfs_takedowns enable row level security;

drop policy if exists gfs_events_service_all on public.gfs_events;
create policy gfs_events_service_all on public.gfs_events for all to service_role using (true) with check (true);
drop policy if exists gfs_creators_service_all on public.gfs_creators;
create policy gfs_creators_service_all on public.gfs_creators for all to service_role using (true) with check (true);
drop policy if exists gfs_crew_service_all on public.gfs_crew;
create policy gfs_crew_service_all on public.gfs_crew for all to service_role using (true) with check (true);
drop policy if exists gfs_roster_service_all on public.gfs_roster;
create policy gfs_roster_service_all on public.gfs_roster for all to service_role using (true) with check (true);
drop policy if exists gfs_clips_service_all on public.gfs_clips;
create policy gfs_clips_service_all on public.gfs_clips for all to service_role using (true) with check (true);
drop policy if exists gfs_uploads_service_all on public.gfs_uploads;
create policy gfs_uploads_service_all on public.gfs_uploads for all to service_role using (true) with check (true);
drop policy if exists gfs_deliverables_service_all on public.gfs_deliverables;
create policy gfs_deliverables_service_all on public.gfs_deliverables for all to service_role using (true) with check (true);
drop policy if exists gfs_takedowns_service_all on public.gfs_takedowns;
create policy gfs_takedowns_service_all on public.gfs_takedowns for all to service_role using (true) with check (true);
