-- 025: Pylon events · QR codes and the stop page (routes/gfs.js QR routes,
-- routes/gfs-page.js, utils/gfs-page.js, public/app/gfs.js #gfs-qr).
--
-- Each stop has a public page its QR codes open. It links to the stop's
-- footage on SportsClippers, to a creator's own SportsClippers page when the
-- code is theirs, and to GFS for help or a takedown. It never shows anything
-- about an athlete, and never shows a youth creator.
--
--   * gfs_events.sportsclippers_url    the stop's footage page on SportsClippers
--   * gfs_events.help_phone            an on-site number families can text (optional)
--   * gfs_events.qr_sources            the placements the stop has its own codes for
--   * gfs_creators.sportsclippers_url  the creator's own SportsClippers page (adults only)
--   * gfs_qr_hits                      scans and clicks per code per day: counts
--                                      only, nothing about the visitor
--
-- A link on the page must be on sportsclippers.com, so nobody can point a
-- Pylon page anywhere else.

-- ── The stop's links ─────────────────────────────────────────────────────
alter table public.gfs_events add column if not exists sportsclippers_url text;
alter table public.gfs_events add column if not exists help_phone text;
alter table public.gfs_events add column if not exists qr_sources text[] not null default '{}'::text[];
alter table public.gfs_events drop constraint if exists gfs_events_sportsclippers_url_chk;
alter table public.gfs_events add constraint gfs_events_sportsclippers_url_chk
  check (sportsclippers_url is null
         or (char_length(sportsclippers_url) <= 300 and sportsclippers_url ~ '^https://([a-z0-9-]+\.)*sportsclippers\.com(/[^\s"<>]*)?$'));
alter table public.gfs_events drop constraint if exists gfs_events_help_phone_chk;
alter table public.gfs_events add constraint gfs_events_help_phone_chk
  check (help_phone is null or help_phone ~ '^\+[1-9][0-9]{7,14}$');
-- Placement keys: lowercase letters, digits and hyphens, 2 to 24 characters
-- each, at most 20 of them. Checked one by one.
create or replace function public.gfs_qr_sources_ok(s text[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(s) <= 20
     and coalesce(bool_and(x is not null and x ~ '^[a-z0-9][a-z0-9-]{1,23}$'), true)
    from unnest(s) as u(x)
$$;
alter table public.gfs_events drop constraint if exists gfs_events_qr_sources_chk;
alter table public.gfs_events add constraint gfs_events_qr_sources_chk
  check (public.gfs_qr_sources_ok(qr_sources));

-- ── A creator's own SportsClippers page ──────────────────────────────────
alter table public.gfs_creators add column if not exists sportsclippers_url text;
alter table public.gfs_creators drop constraint if exists gfs_creators_sportsclippers_url_chk;
alter table public.gfs_creators add constraint gfs_creators_sportsclippers_url_chk
  check (sportsclippers_url is null
         or (char_length(sportsclippers_url) <= 300 and sportsclippers_url ~ '^https://([a-z0-9-]+\.)*sportsclippers\.com(/[^\s"<>]*)?$'));
-- A youth creator never appears on a public page, so has no public link.
alter table public.gfs_creators drop constraint if exists gfs_creators_youth_link_chk;
alter table public.gfs_creators add constraint gfs_creators_youth_link_chk
  check (tier = 'adult' or sportsclippers_url is null);

-- ── Scans and clicks ─────────────────────────────────────────────────────
-- source: 'stop' (the stop's main code), 's:<placement>', or 'c:<creator code>'.
-- kind: 'scan' (the page opened), 'footage' (to the stop's SportsClippers
-- page), 'creator' (to the creator's SportsClippers page).
create table if not exists public.gfs_qr_hits (
  event_id uuid not null references public.gfs_events(id) on delete cascade,
  day date not null,
  source text not null check (source ~ '^(stop|s:[a-z0-9][a-z0-9-]{1,23}|c:[A-Z0-9]{4,8})$'),
  kind text not null check (kind in ('scan', 'footage', 'creator')),
  hits int not null default 0 check (hits >= 0),
  primary key (event_id, day, source, kind)
);

create or replace function public.gfs_count_hit(p_event uuid, p_source text, p_kind text) returns void
language sql volatile set search_path = '' as $$
  insert into public.gfs_qr_hits as h (event_id, day, source, kind, hits)
  values (p_event, (now() at time zone 'utc')::date, p_source, p_kind, 1)
  on conflict (event_id, day, source, kind) do update set hits = h.hits + 1
$$;
-- Callable by the server only (Supabase grants new functions to its API roles).
revoke all on function public.gfs_count_hit(uuid, text, text) from public;
revoke all on function public.gfs_qr_sources_ok(text[]) from public;
do $$
declare
  f text;
begin
  foreach f in array array['public.gfs_count_hit(uuid, text, text)', 'public.gfs_qr_sources_ok(text[])'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

alter table public.gfs_qr_hits enable row level security;
drop policy if exists gfs_qr_hits_service_all on public.gfs_qr_hits;
create policy gfs_qr_hits_service_all on public.gfs_qr_hits for all to service_role using (true) with check (true);
