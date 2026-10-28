-- 030: Subject Medias bookings. Every game, team or event someone books on
-- subjectmedias.com lands here, from the booking form or a paid package
-- (routes/sm-bookings.js; the rules are in utils/sm-bookings.js).
--
-- Each new booking alerts staff (a push to the TOJ app and an email) with the
-- creators in that region, so Kyron can staff it. Later the same rows route
-- jobs to creators directly.
--
-- What it holds, and what it never does:
--   * The booker's own contact (an adult: the form makes them confirm they're
--     18 or older, a parent or guardian when the athlete isn't). Needed to
--     call back; shown to staff in the app; never on a public page.
--   * The athlete as team and jersey number only. The form never asks for an
--     athlete's name. Notes are free text and stay in the app: never in a
--     push, and in an email only when the database couldn't take the booking
--     (then the email is the only copy).
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated.

create table if not exists public.sm_bookings (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'form' check (source in ('form', 'stripe')),
  kind text not null check (kind in ('athlete', 'team', 'event')),
  package text not null default 'unsure'
    check (package in ('unsure', 'photo', 'video', 'elite', 'transcript', 'team', 'event')),
  sport text check (sport is null or char_length(sport) between 1 and 40),
  event_name text check (event_name is null or char_length(event_name) between 1 and 120),
  event_date date,
  event_city text check (event_city is null or char_length(event_city) between 1 and 80),
  event_state text check (event_state is null or event_state ~ '^[A-Z]{2}$'),
  region text check (region is null or region in ('west', 'south_central', 'northeast', 'southeast', 'midwest')),
  athletes int check (athletes is null or athletes between 1 and 500),
  team_jersey text check (team_jersey is null or char_length(team_jersey) between 1 and 60),
  contact_name text not null check (char_length(contact_name) between 1 and 80),
  contact_email text not null check (contact_email = lower(contact_email) and char_length(contact_email) between 3 and 200),
  contact_phone text check (contact_phone is null or char_length(contact_phone) between 7 and 30),
  notes text check (notes is null or char_length(notes) <= 1000),
  adult_confirmed boolean not null default false,
  amount_cents int check (amount_cents is null or amount_cents >= 0),
  stripe_session_id text unique check (stripe_session_id is null or stripe_session_id ~ '^cs_[A-Za-z0-9_]{8,200}$'),
  status text not null default 'new'
    check (status in ('new', 'contacted', 'offered', 'staffed', 'delivered', 'cancelled')),
  -- A creator who staffed a booking keeps that history: pause them, don't delete them.
  staffed_creator_id uuid references public.gfs_creators(id) on delete restrict,
  matches jsonb not null default '[]'::jsonb,
  alerted_at timestamptz,
  status_by text check (status_by is null or char_length(status_by) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A form booking comes from someone who said they're an adult; a paid one
  -- carries its Stripe checkout.
  constraint sm_bookings_source_chk check (
    (source = 'form' and adult_confirmed and stripe_session_id is null)
    or (source = 'stripe' and stripe_session_id is not null)
  ),
  -- Staffed and delivered bookings name the creator.
  constraint sm_bookings_staffed_chk check (status not in ('staffed', 'delivered') or staffed_creator_id is not null)
);

create index if not exists sm_bookings_status_idx on public.sm_bookings (status, created_at desc);
create index if not exists sm_bookings_date_idx on public.sm_bookings (event_date);

alter table public.sm_bookings enable row level security;
-- RLS with no policies already shuts the API roles out; take their table
-- rights away too, where those roles exist (a bare Postgres in tests has none).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.sm_bookings from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.sm_bookings from authenticated; end if;
end $$;
