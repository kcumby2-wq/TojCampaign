-- 027: Pylon events · the asset library (routes/gfs-assets.js,
-- utils/gfs-assets.js, public/app/gfs-assets.js #gfs-assets).
--
-- One record for each digital asset GFS makes from a Pylon stop, beyond the
-- single clips the clips table already tracks:
--   edit           a recap, montage, feature, reel or photo set
--   venue_world    a 3D World of the venue, with no people in it
--   moment         a Family 3D or 4D Moment of one athlete (or an AI replay)
--   world_pass     a numbered collectible edition of a venue World
--   narrative_nft  the record of one verified clip or photo of one athlete
--   brand          a graphic, template, LUT, overlay or sponsor asset
--
-- The files stay where they are (GFS storage, World Labs, the family's
-- library, the GFS store, the ledger). A record keeps where, under an ID or
-- label, never a path with a folder name in it, and never a link to footage.
-- Athletes are roster rows, shown by team and jersey number.
--
-- An asset moves draft → review → approved → live → retired. Going to
-- approved or live checks everything here (gfs_asset_blocks): the athletes'
-- permissions from the Sports Thread roster, the kind's own rules from the
-- GFS agreements, and the checks a person records. A live asset whose
-- athlete loses a permission or gets a takedown has to be retired, and a
-- takedown can't be marked off every surface while one is still live.
--
-- Where each rule comes from (October 2026 drafts):
--   GFS World Pipeline Developer Spec v1.2   rules 1-9, §2.3-2.6, §4.3, §9, §9A
--   GFS Narrative NFT Terms v1.0             §3, §4, §6 and the Consent to Mint
--   GFS Digital Collectibles Terms v1.1      §1, §2, §7
--   GFS Digital Scout Agreement v1.5         §8, Schedule B-2
--   Pylon × GFS Partnership Agreement        Schedule I-2, I-3
--
-- Everything here is service-role only (RLS on, one service_role policy each).

-- No email address or phone number in a title or a note. Mirrors
-- public.chat_text_ok (026) and utils/chat.js hasContact.
create or replace function public.gfs_asset_text_ok(s text) returns boolean
language sql immutable set search_path = '' as $$
  select s is null or not (
    s ~* '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
    or regexp_replace(s, 'https?://[^[:space:]]+', ' ', 'gi') ~ '(?<![0-9])(\+?1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])'
    or regexp_replace(s, 'https?://[^[:space:]]+', ' ', 'gi') ~ '(?<![0-9])\+[1-9]([ .-]?[0-9]){7,14}(?![0-9])'
  )
$$;

create table if not exists public.gfs_assets (
  id uuid primary key default gen_random_uuid(),
  -- Every kind belongs to a stop except brand assets, which may be national
  -- (no event, no region) or a region's.
  event_id uuid references public.gfs_events(id) on delete restrict,
  region text check (region is null or region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  kind text not null check (kind in ('edit', 'venue_world', 'moment', 'world_pass', 'narrative_nft', 'brand')),
  format text check (format is null or format in (
    'recap', 'montage', 'feature', 'reel', 'photos', 'interview',   -- edit
    '3d', '4d',                                                       -- moment
    'graphic', 'template', 'lut', 'overlay', 'logo', 'sponsor'        -- brand
  )),
  title text not null check (char_length(title) between 1 and 80 and public.gfs_asset_text_ok(title)),
  stage text not null default 'draft' check (stage in ('draft', 'review', 'approved', 'live', 'retired')),
  -- Where the file is, and its ID or label there.
  location text check (location is null or location in ('gfs_storage', 'world_labs', 'family_library', 'gfs_store', 'sportsclippers', 'pylon_channels', 'ledger', 'link')),
  ref text check (ref is null or char_length(ref) <= 300),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- A World Pass is an edition of a venue World.
  source_asset_id uuid references public.gfs_assets(id) on delete restrict,
  price_cents int check (price_cents is null or price_cents between 100 and 100000),
  -- Scout Agreement B-2: school stadiums are never sold.
  school_venue boolean not null default false,
  sponsor_marks boolean not null default false,
  -- Checks a person records (who and when):
  --   venue_permission  the venue's signed permission (Pylon I-2), for a venue World
  --   deidentified      every other player blurred or masked, human-checked (Spec §7, §9)
  --   tier4             the family's Tier 4 consent on the CFR record (Spec rule 2, §9)
  --   mint_consent      the signed Consent to Mint (NFT Terms Schedule A); Kyron records it
  --   marks_licensed    the sponsor's licence for its marks (Spec §4.3)
  venue_permission_at timestamptz, venue_permission_by text,
  deidentified_at timestamptz, deidentified_by text,
  tier4_at timestamptz, tier4_by text,
  mint_consent_at timestamptz, mint_consent_by text,
  marks_licensed_at timestamptz, marks_licensed_by text,
  note text check (note is null or (char_length(note) <= 300 and public.gfs_asset_text_ok(note))),
  approved_at timestamptz, approved_by text,
  live_at timestamptz,
  retired_at timestamptz, retired_by text,
  retire_reason text check (retire_reason is null or retire_reason in ('withdrawn', 'takedown', 'replaced', 'expired', 'mistake')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'brand' or event_id is not null),
  check (stage not in ('approved', 'live') or (approved_at is not null and approved_by is not null)),
  check (stage <> 'live' or live_at is not null),
  check (stage <> 'retired' or (retired_at is not null and retire_reason is not null)),
  -- A link only for a brand asset, and only https.
  check (location is distinct from 'link' or (kind = 'brand' and ref ~ '^https://[^\s"<>]+$')),
  -- Everywhere else, an ID or a label in the B-5 / J-9 form: letters, digits
  -- and a few separators, no spaces and no slashes (so no folder names).
  check (location is null or location = 'link' or ref is null or ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  check (kind = 'world_pass' or (source_asset_id is null and price_cents is null)),
  check (kind = 'venue_world' or not school_venue),
  check (format is null or (kind = 'edit' and format in ('recap', 'montage', 'feature', 'reel', 'photos', 'interview'))
                        or (kind = 'moment' and format in ('3d', '4d'))
                        or (kind = 'brand' and format in ('graphic', 'template', 'lut', 'overlay', 'logo', 'sponsor')))
);
create index if not exists gfs_assets_event_idx on public.gfs_assets (event_id, kind, stage);
create index if not exists gfs_assets_region_idx on public.gfs_assets (region, stage);
create index if not exists gfs_assets_source_idx on public.gfs_assets (source_asset_id);

-- The athletes an asset shows, as roster rows of its stop. Team and jersey
-- are copied when the athlete is added, so a roster change shows.
create table if not exists public.gfs_asset_athletes (
  asset_id uuid not null references public.gfs_assets(id) on delete cascade,
  roster_row uuid not null references public.gfs_roster(id),
  team text,
  jersey text,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (asset_id, roster_row)
);
create index if not exists gfs_asset_athletes_row_idx on public.gfs_asset_athletes (roster_row);

-- ── Why an asset can't be approved or go live ────────────────────────────
-- Asset-level reasons, and per-athlete reasons as 'reason:<roster row id>'.
-- Mirrors assetBlocks() in utils/gfs-assets.js.
create or replace function public.gfs_asset_blocks(a public.gfs_assets) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  ev public.gfs_events%rowtype;
  src public.gfs_assets%rowtype;
  ro public.gfs_roster%rowtype;
  out text[] := '{}';
  n int := 0;
  hold text;
  aa record;
begin
  if a.event_id is not null then
    select * into ev from public.gfs_events where id = a.event_id;
  end if;
  for aa in select x.roster_row, x.team, x.jersey from public.gfs_asset_athletes x where x.asset_id = a.id loop
    n := n + 1;
    select * into ro from public.gfs_roster where id = aa.roster_row;
    -- The holds every clip has (024): a takedown, do-not-publish, no capture consent.
    hold := public.gfs_hold_reason(ro);
    if hold is not null then out := out || (hold || ':' || ro.id); end if;
    if ro.team is distinct from aa.team or ro.jersey is distinct from aa.jersey then out := out || ('roster_changed:' || ro.id); end if;
    if a.kind = 'moment' then
      if not ro.consent_3d then out := out || ('no_3d_consent:' || ro.id); end if;
      -- COPPA: verifiable parental consent for a child under 13 isn't
      -- tracked yet, so no Moment of a child who may be under 13.
      if public.gfs_under_13(ro) then out := out || ('under_13:' || ro.id); end if;
    elsif a.kind = 'narrative_nft' then
      if not ro.consent_nft then out := out || ('no_nft_consent:' || ro.id); end if;
    elsif a.kind = 'edit' then
      if not ro.consent_marketing then out := out || ('no_marketing_consent:' || ro.id); end if;
    end if;
  end loop;
  if a.kind in ('moment', 'narrative_nft') and n <> 1 then out := out || 'one_athlete'::text; end if;
  if a.kind = 'venue_world' and a.venue_permission_at is null then out := out || 'venue_permission'::text; end if;
  if a.kind = 'moment' then
    if a.deidentified_at is null then out := out || 'deidentified'::text; end if;
    if a.tier4_at is null then out := out || 'tier4'::text; end if;
    -- No AI reconstruction of people at Illinois stops until counsel clears BIPA.
    if ev.state = 'IL' then out := out || 'illinois_hold'::text; end if;
  end if;
  if a.kind = 'narrative_nft' and a.mint_consent_at is null then out := out || 'mint_consent'::text; end if;
  if a.sponsor_marks and a.marks_licensed_at is null then out := out || 'marks_licensed'::text; end if;
  if a.kind = 'world_pass' then
    if a.price_cents is null then out := out || 'price'::text; end if;
    if a.source_asset_id is null then
      out := out || 'source_world'::text;
    else
      select * into src from public.gfs_assets where id = a.source_asset_id;
      if src.id is null or src.kind <> 'venue_world' or src.stage <> 'live' then out := out || 'source_world'::text;
      elsif src.school_venue then out := out || 'school_venue'::text;
      end if;
    end if;
  end if;
  return out;
end $$;

-- Where a live asset has to be.
create or replace function public.gfs_asset_live_location(kind text) returns text[]
language sql immutable set search_path = '' as $$
  select case kind
    when 'moment' then array['family_library']
    when 'narrative_nft' then array['ledger']
    when 'world_pass' then array['gfs_store']
    when 'venue_world' then array['gfs_storage']
    when 'edit' then array['gfs_storage', 'pylon_channels', 'sportsclippers']
    else array['gfs_storage', 'link'] end
$$;

create or replace function public.gfs_assets_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  ev_region text;
  blocks text[];
begin
  new.updated_at := now();
  if new.event_id is not null then
    select region into ev_region from public.gfs_events where id = new.event_id;
    new.region := ev_region;
  end if;
  if tg_op = 'INSERT' then
    if new.stage <> 'draft' then raise exception 'gfs_asset_starts_as_draft'; end if;
    return new;
  end if;

  -- What it is and where it's from never change.
  if new.kind <> old.kind or new.event_id is distinct from old.event_id or new.created_by <> old.created_by then
    raise exception 'gfs_asset_fixed';
  end if;
  if old.stage = 'retired' then
    -- Retired is final. Retiring may clear where the file was (an NFT keeps
    -- no content), nothing else changes.
    if new.stage <> 'retired' or new.title <> old.title or new.retired_at is distinct from old.retired_at
       or new.retire_reason is distinct from old.retire_reason or new.location is distinct from old.location
       or (new.ref is not null and new.ref is distinct from old.ref) or (new.sha256 is not null and new.sha256 is distinct from old.sha256) then
      raise exception 'gfs_asset_retired';
    end if;
    return new;
  end if;
  -- Only a draft's own details change. Where it lives can still be filled in
  -- until it goes live.
  if old.stage <> 'draft' and (new.title <> old.title or new.format is distinct from old.format or new.source_asset_id is distinct from old.source_asset_id
       or new.price_cents is distinct from old.price_cents or new.school_venue <> old.school_venue or new.sponsor_marks <> old.sponsor_marks) then
    raise exception 'gfs_asset_locked';
  end if;
  if old.stage = 'live' and new.stage = 'live' and (new.location is distinct from old.location or new.ref is distinct from old.ref or new.sha256 is distinct from old.sha256) then
    raise exception 'gfs_asset_locked';
  end if;

  if new.stage is distinct from old.stage then
    if not ((old.stage = 'draft' and new.stage in ('review', 'retired'))
         or (old.stage = 'review' and new.stage in ('draft', 'approved', 'retired'))
         or (old.stage = 'approved' and new.stage in ('draft', 'live', 'retired'))
         or (old.stage = 'live' and new.stage = 'retired')) then
      raise exception 'gfs_asset_stage';
    end if;
    if new.stage = 'draft' then
      new.approved_at := null;
      new.approved_by := null;
    end if;
    if new.stage in ('approved', 'live') then
      blocks := public.gfs_asset_blocks(new);
      if cardinality(blocks) > 0 then raise exception 'gfs_asset_blocked'; end if;
    end if;
    if new.stage = 'live' then
      if new.location is null or not (new.location = any(public.gfs_asset_live_location(new.kind))) or new.ref is null then
        raise exception 'gfs_asset_live_location';
      end if;
      new.live_at := coalesce(new.live_at, now());
    end if;
    if new.stage = 'retired' then
      new.retired_at := coalesce(new.retired_at, now());
    end if;
  end if;
  return new;
end $$;
drop trigger if exists gfs_assets_gate on public.gfs_assets;
create trigger gfs_assets_gate before insert or update on public.gfs_assets
  for each row execute function public.gfs_assets_gate();

-- Only a draft can be deleted; anything that was reviewed stays on record.
create or replace function public.gfs_assets_keep() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.stage <> 'draft' then raise exception 'gfs_asset_keep'; end if;
  if exists (select 1 from public.gfs_assets x where x.source_asset_id = old.id) then raise exception 'gfs_asset_in_use'; end if;
  return old;
end $$;
drop trigger if exists gfs_assets_keep on public.gfs_assets;
create trigger gfs_assets_keep before delete on public.gfs_assets
  for each row execute function public.gfs_assets_keep();

-- Athletes: only on a draft, only from the stop's own roster, none in a venue
-- World, a World Pass or a brand asset, and one in a Moment or an NFT. A
-- retired Moment or NFT drops its athlete (the app does it on retiring).
create or replace function public.gfs_asset_athletes_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  a public.gfs_assets%rowtype;
  ro public.gfs_roster%rowtype;
begin
  if tg_op = 'DELETE' then
    select * into a from public.gfs_assets where id = old.asset_id;
    if a.id is not null and a.stage not in ('draft', 'retired') then raise exception 'gfs_asset_locked'; end if;
    return old;
  end if;
  select * into a from public.gfs_assets where id = new.asset_id;
  if a.stage <> 'draft' then raise exception 'gfs_asset_locked'; end if;
  if a.kind in ('venue_world', 'world_pass', 'brand') then raise exception 'gfs_asset_no_athletes'; end if;
  select * into ro from public.gfs_roster where id = new.roster_row;
  if ro.id is null or ro.event_id is distinct from a.event_id then raise exception 'gfs_asset_not_on_roster'; end if;
  if a.kind in ('moment', 'narrative_nft')
     and exists (select 1 from public.gfs_asset_athletes x where x.asset_id = new.asset_id and x.roster_row <> new.roster_row) then
    raise exception 'gfs_asset_one_athlete';
  end if;
  if tg_op = 'INSERT' then
    new.team := ro.team;
    new.jersey := ro.jersey;
  else
    new.team := old.team;
    new.jersey := old.jersey;
  end if;
  return new;
end $$;
drop trigger if exists gfs_asset_athletes_gate on public.gfs_asset_athletes;
create trigger gfs_asset_athletes_gate before insert or update or delete on public.gfs_asset_athletes
  for each row execute function public.gfs_asset_athletes_gate();

-- ── Takedowns: off every surface means the asset library too ─────────────
-- The same rules as 024, plus: "off every other surface" isn't done while a
-- live asset shows the athlete, at any event.
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
  -- Nor while a live asset shows them.
  if new.other_done_at is not null and (tg_op = 'INSERT' or old.other_done_at is null)
     and exists (select 1 from public.gfs_asset_athletes aa
                   join public.gfs_roster r on r.id = aa.roster_row
                   join public.gfs_assets a on a.id = aa.asset_id
                  where r.roster_id = new.roster_id and a.stage = 'live') then
    raise exception 'gfs_takedown_assets_out';
  end if;
  new.status := case when new.pylon_done_at is not null and new.other_done_at is not null and new.offsite_requested_at is not null then 'done' else 'open' end;
  return new;
end $$;

-- Callable by the server only (Supabase grants new functions to its API roles).
revoke all on function public.gfs_asset_text_ok(text) from public;
revoke all on function public.gfs_asset_blocks(public.gfs_assets) from public;
revoke all on function public.gfs_asset_live_location(text) from public;
do $$
declare
  f text;
begin
  foreach f in array array['public.gfs_asset_text_ok(text)', 'public.gfs_asset_blocks(public.gfs_assets)', 'public.gfs_asset_live_location(text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

alter table public.gfs_assets enable row level security;
alter table public.gfs_asset_athletes enable row level security;
drop policy if exists gfs_assets_service_all on public.gfs_assets;
create policy gfs_assets_service_all on public.gfs_assets for all to service_role using (true) with check (true);
drop policy if exists gfs_asset_athletes_service_all on public.gfs_asset_athletes;
create policy gfs_asset_athletes_service_all on public.gfs_asset_athletes for all to service_role using (true) with check (true);
