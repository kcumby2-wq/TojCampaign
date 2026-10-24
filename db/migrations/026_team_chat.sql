-- 026: Team chat · rooms and direct messages in the TOJ app (utils/chat.js,
-- routes/chat.js, public/app/chat.js #chat).
--
-- Who's in it: the team only, meaning owners on ADMIN_EMAILS and active
-- team_members. Each person joins once: they confirm they're 18 or older and
-- pick the name people see (chat_people). Athletes, families and creators
-- aren't in it.
--
-- Rooms:
--   all     everyone with Pylon events                  (derived)
--   region  everyone with Pylon events in that region    (derived)
--   stop    everyone who can see that Pylon event        (derived)
--   topic   the people listed; owners and approvers make them
--   dm      two people
-- Derived rooms have no member rows. Who can read one follows the team's roles
-- and regions on every request, so changing someone's regions changes their
-- rooms.
--
-- Text only: photos and video don't go in chat. A message, a name or a room
-- title can't carry an email address or a phone number (checked here and in
-- the app), and the app asks people to talk about athletes by team and jersey
-- number only.
--
-- Needs migration 024 first (a stop's room points at its gfs_events row).
--
-- Everything here is service-role only (RLS on, one service_role policy each).

-- ── People ───────────────────────────────────────────────────────────────
-- No email address or phone number in a name, a title or a message. The
-- check runs on a normalized copy: compatibility forms folded (full-width
-- digits and @, non-breaking and other Unicode spaces), invisible characters
-- dropped, every kind of dash made a hyphen. Digits in tel:, sms: and wa.me
-- links count; a long number elsewhere in a link doesn't (a URL's ID isn't a
-- phone number). Mirrors hasContact() in utils/chat.js.
create or replace function public.chat_text_ok(s text) returns boolean
language sql immutable set search_path = '' as $$
  select s is null or not (
    t ~* '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}'
    or t ~* '(^|[^a-z])(tel|sms|callto|facetime):[[:space:]]*\+?[0-9]'
    or t ~* 'wa\.me/[[:space:]]*\+?[0-9]'
    or regexp_replace(t, 'https?://[^ \t\n\r\f\v<>"'']+', ' ', 'gi') ~ '(?<![0-9])(\+?1[ .-]?)?\(?[2-9][0-9]{2}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}(?![0-9])'
    or regexp_replace(t, 'https?://[^ \t\n\r\f\v<>"'']+', ' ', 'gi') ~ '(?<![0-9])\+[1-9]([ .-]?[0-9]){7,14}(?![0-9])'
  )
  from (select regexp_replace(regexp_replace(normalize(coalesce(s, ''), NFKC),
                 '[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]', '', 'g'),
                 '[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]', '-', 'g') as t) n
$$;

create table if not exists public.chat_people (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  display_name text not null check (char_length(display_name) between 1 and 40 and public.chat_text_ok(display_name)),
  -- They confirmed they're 18 or older when they joined. Nobody joins without it.
  adult_confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One person per name, whatever the case: nobody can post as someone else.
create unique index if not exists chat_people_name_key on public.chat_people (lower(display_name));

-- ── Rooms ────────────────────────────────────────────────────────────────
-- slug names a room once: 'all', 'region:<region>', 'stop:<event id>',
-- 'topic:<uuid>', 'dm:<person id>:<person id>' (the two ids sorted).
create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  kind text not null check (kind in ('all', 'region', 'stop', 'topic', 'dm')),
  region text check (region is null or region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  event_id uuid references public.gfs_events(id) on delete cascade,
  title text check (title is null or (char_length(title) between 1 and 60 and public.chat_text_ok(title))),
  created_by uuid references public.chat_people(id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  check (kind <> 'all' or (slug = 'all' and region is null and event_id is null and title is null)),
  check (kind <> 'region' or (region is not null and slug = 'region:' || region and event_id is null and title is null)),
  check (kind <> 'stop' or (event_id is not null and slug = 'stop:' || event_id::text and region is null and title is null)),
  check (kind <> 'topic' or (title is not null and slug ~ '^topic:[0-9a-f-]{36}$' and region is null and event_id is null)),
  check (kind <> 'dm' or (slug ~ '^dm:[0-9a-f-]{36}:[0-9a-f-]{36}$' and region is null and event_id is null and title is null))
);
create index if not exists chat_rooms_kind_idx on public.chat_rooms (kind, last_message_at desc);

-- Members, for topic rooms and DMs only.
create table if not exists public.chat_room_members (
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  person_id uuid not null references public.chat_people(id) on delete cascade,
  added_by uuid references public.chat_people(id) on delete set null,
  added_at timestamptz not null default now(),
  primary key (room_id, person_id)
);
create index if not exists chat_room_members_person_idx on public.chat_room_members (person_id);

create or replace function public.chat_members_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  k text;
begin
  select kind into k from public.chat_rooms where id = new.room_id;
  if k is null or k not in ('topic', 'dm') then
    raise exception 'chat_room_has_no_members';
  end if;
  if k = 'dm' and (select count(*) from public.chat_room_members where room_id = new.room_id and person_id <> new.person_id) >= 2 then
    raise exception 'chat_dm_two_people';
  end if;
  return new;
end $$;
drop trigger if exists chat_members_gate on public.chat_room_members;
create trigger chat_members_gate before insert or update on public.chat_room_members
  for each row execute function public.chat_members_gate();

-- ── Messages ─────────────────────────────────────────────────────────────
-- A removed message keeps its place and loses its text. A person who deletes
-- their account loses the text of everything they wrote (routes/team.js).
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  author_id uuid references public.chat_people(id) on delete set null,
  body text check (body is null or char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  removed_at timestamptz,
  removed_by uuid references public.chat_people(id) on delete set null,
  check ((removed_at is null) = (body is not null))
);
create index if not exists chat_messages_room_idx on public.chat_messages (room_id, id);
create index if not exists chat_messages_author_idx on public.chat_messages (author_id);

create or replace function public.chat_messages_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.body is not null and not public.chat_text_ok(new.body) then
    raise exception 'chat_contact_details';
  end if;
  if tg_op = 'UPDATE' then
    if new.room_id <> old.room_id or (new.author_id is not null and new.author_id is distinct from old.author_id) then
      raise exception 'chat_message_moved';
    end if;
    if old.removed_at is not null and new.body is not null then
      raise exception 'chat_message_removed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists chat_messages_gate on public.chat_messages;
create trigger chat_messages_gate before insert or update on public.chat_messages
  for each row execute function public.chat_messages_gate();

-- The room list sorts by the latest message; it's set in the same statement.
create or replace function public.chat_messages_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  update public.chat_rooms set last_message_at = new.created_at where id = new.room_id;
  return null;
end $$;
drop trigger if exists chat_messages_touch on public.chat_messages;
create trigger chat_messages_touch after insert on public.chat_messages
  for each row execute function public.chat_messages_touch();

-- ── Reading ──────────────────────────────────────────────────────────────
-- How far each person has read in each room, whether they muted it, and when
-- they last had it open (no notification while they're looking at it).
create table if not exists public.chat_reads (
  person_id uuid not null references public.chat_people(id) on delete cascade,
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  last_read_id bigint not null default 0,
  muted boolean not null default false,
  seen_at timestamptz,
  primary key (person_id, room_id)
);
create index if not exists chat_reads_room_idx on public.chat_reads (room_id);

-- For the room list: unread count and the latest message, per room.
create or replace function public.chat_room_stats(p_person uuid, p_rooms uuid[])
returns table (room_id uuid, unread int, last_id bigint, last_at timestamptz, last_author uuid, last_body text, last_removed boolean)
language sql stable set search_path = '' as $$
  select r.id,
         (select count(*)::int from public.chat_messages m
           where m.room_id = r.id
             and m.removed_at is null
             and m.author_id is distinct from p_person
             and m.id > coalesce((select cr.last_read_id from public.chat_reads cr
                                   where cr.person_id = p_person and cr.room_id = r.id), 0)),
         l.id, l.created_at, l.author_id, left(l.body, 140), l.removed_at is not null
    from public.chat_rooms r
    left join lateral (select m.id, m.created_at, m.author_id, m.body, m.removed_at
                         from public.chat_messages m
                        where m.room_id = r.id
                        order by m.id desc
                        limit 1) l on true
   where r.id = any(p_rooms)
$$;

-- Callable by the server only (Supabase grants new functions to its API roles).
revoke all on function public.chat_room_stats(uuid, uuid[]) from public;
revoke all on function public.chat_text_ok(text) from public;
do $$
declare
  f text;
begin
  foreach f in array array['public.chat_room_stats(uuid, uuid[])', 'public.chat_text_ok(text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

alter table public.chat_people enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.chat_room_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reads enable row level security;

drop policy if exists chat_people_service_all on public.chat_people;
create policy chat_people_service_all on public.chat_people for all to service_role using (true) with check (true);
drop policy if exists chat_rooms_service_all on public.chat_rooms;
create policy chat_rooms_service_all on public.chat_rooms for all to service_role using (true) with check (true);
drop policy if exists chat_room_members_service_all on public.chat_room_members;
create policy chat_room_members_service_all on public.chat_room_members for all to service_role using (true) with check (true);
drop policy if exists chat_messages_service_all on public.chat_messages;
create policy chat_messages_service_all on public.chat_messages for all to service_role using (true) with check (true);
drop policy if exists chat_reads_service_all on public.chat_reads;
create policy chat_reads_service_all on public.chat_reads for all to service_role using (true) with check (true);
