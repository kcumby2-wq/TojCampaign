-- 031: Team chat, more places to talk; and the tool shelf.
--
-- Builds on 026 (team chat), 030 (Subject Medias bookings) and the
-- operating system builds (os_builds). routes/chat.js and utils/chat.js have
-- the rules; routes/team-tools.js the tool shelf.
--
-- New rooms (no member rows: who can read one follows the team's roles and
-- tools on every request, like a stop's room):
--   team     everyone on the team
--   kit      one Studio kit, across its versions      everyone with Studio
--   booking  one Subject Medias booking                owners only
--   os       one operating system build                everyone with Operating Systems
-- Direct messages stay in the database's rules but are off in the app unless
-- the server has CHAT_DMS=on.
--
-- The tool shelf: links the owner adds to the app (a Claude page, a Milanote
-- board, a Google Sheet), each shown to the people it's meant for. https only.
--
-- Safe to run twice. Service role only, like 026.

-- ── Rooms on work ────────────────────────────────────────────────────────
alter table public.chat_rooms add column if not exists kit_slug text;
alter table public.chat_rooms add column if not exists booking_id uuid references public.sm_bookings(id) on delete cascade;
alter table public.chat_rooms add column if not exists os_build_id uuid references public.os_builds(id) on delete cascade;

alter table public.chat_rooms drop constraint if exists chat_rooms_kind_check;
alter table public.chat_rooms add constraint chat_rooms_kind_check
  check (kind in ('all', 'region', 'stop', 'topic', 'dm', 'team', 'kit', 'booking', 'os'));

-- Each new kind has one shape, like 026's.
alter table public.chat_rooms drop constraint if exists chat_rooms_team_chk;
alter table public.chat_rooms add constraint chat_rooms_team_chk
  check (kind <> 'team' or (slug = 'team' and region is null and event_id is null and title is null));
alter table public.chat_rooms drop constraint if exists chat_rooms_kit_chk;
alter table public.chat_rooms add constraint chat_rooms_kit_chk
  check (kind <> 'kit' or (kit_slug ~ '^[a-z0-9][a-z0-9-]{0,79}$' and slug = 'kit:' || kit_slug and region is null and event_id is null and title is null));
alter table public.chat_rooms drop constraint if exists chat_rooms_booking_chk;
alter table public.chat_rooms add constraint chat_rooms_booking_chk
  check (kind <> 'booking' or (booking_id is not null and slug = 'booking:' || booking_id::text and region is null and event_id is null and title is null));
alter table public.chat_rooms drop constraint if exists chat_rooms_os_chk;
alter table public.chat_rooms add constraint chat_rooms_os_chk
  check (kind <> 'os' or (os_build_id is not null and slug = 'os:' || os_build_id::text and region is null and event_id is null and title is null));
-- The work columns belong to their own kind only.
alter table public.chat_rooms drop constraint if exists chat_rooms_work_cols_chk;
alter table public.chat_rooms add constraint chat_rooms_work_cols_chk
  check ((kit_slug is null or kind = 'kit') and (booking_id is null or kind = 'booking') and (os_build_id is null or kind = 'os'));

-- ── The tool shelf ───────────────────────────────────────────────────────
create table if not exists public.team_tools (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  url text not null check (char_length(url) between 10 and 2000 and url ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$'),
  about text check (about is null or char_length(about) <= 140),
  audience text not null default 'team'
    check (audience in ('team', 'owners', 'studio', 'creators', 'os', 'gfs')),
  archived_at timestamptz,
  created_by text not null check (char_length(created_by) between 3 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

alter table public.team_tools enable row level security;
drop policy if exists team_tools_service_all on public.team_tools;
create policy team_tools_service_all on public.team_tools for all to service_role using (true) with check (true);
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.team_tools from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.team_tools from authenticated; end if;
end $$;
