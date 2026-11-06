-- 033: The Subject Medias marketplace, for the events Subject Medias runs
-- itself (not Pylon). Subject Medias and its crews sell; families, teams and
-- event hosts buy (routes/sm-market.js for staff, routes/sm-market-public.js
-- for families; the rules are in utils/sm-market.js).
--
-- Footage lives in Supabase Storage, bucket sm-market (private): originals
-- and watermarked previews. The app only ever hands out short-lived signed
-- links.
--
-- What it holds, and what it never does:
--   * Athletes are a team and a jersey number at one event. Never a name,
--     birth date, school or contact.
--   * Consent per athlete, from a parent or guardian: family only, OK to sell,
--     OK to show publicly, or keep out. It comes from the QR at the event and
--     counts once confirmed from the guardian's email (keep out counts at
--     once), or a staff member records it. The most careful answer among the
--     guardians wins, and staff keep-out beats everything. Nothing of an
--     athlete is shown or sold without a confirmed consent. An athlete 12 or
--     younger is family only: never sold to other families, never public.
--     The guardian also gives an age band (12 or younger, 13 to 15, 16 or
--     17, 18 or older), so rules that turn on 16 or 18 can be applied. A
--     guardian's new answer that loosens what counts waits, as pending_*,
--     until it's confirmed; what tightens counts at once.
--   * The event's clips page needs its access code (view_key), handed out
--     at check-in, never on the public consent poster.
--   * A clip goes on sale only once an approver checks that everyone who
--     stands out in it is tagged, and never with a kept-out athlete in it.
--   * Tags: the AI suggests jersey numbers; only a person confirms them, and
--     only confirmed tags decide whose a clip is.
--   * Orders: the buyer's email, what they bought, the Stripe checkout. The
--     order link carries a token; the database keeps only its hash, as it does
--     for the consent and family links.
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated.

create table if not exists public.sm_market_events (
  id uuid primary key default gen_random_uuid(),
  -- In links and on the QR: subjectmedias.com/m/<code>. No 0/O or 1/I.
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  name text not null check (char_length(name) between 1 and 120),
  sport text check (sport is null or char_length(sport) between 1 and 40),
  starts_on date not null,
  ends_on date not null,
  venue text check (venue is null or char_length(venue) between 1 and 120),
  city text check (city is null or char_length(city) between 1 and 80),
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  status text not null default 'draft' check (status in ('draft', 'live', 'closed')),
  clip_cents int not null default 1200 check (clip_cents between 100 and 100000),
  photo_cents int not null default 800 check (photo_cents between 100 and 100000),
  -- The clips page's access code: subjectmedias.com/m/<code>?k=<view_key>,
  -- on the clips QR and the check-in handout. One code shared by the event's
  -- families (not a person's link), kept as is so staff can show it again,
  -- and changed if it leaks.
  view_key text not null check (view_key ~ '^[A-HJ-NP-Z2-9]{8}$'),
  created_by text not null check (char_length(created_by) between 3 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sm_market_events_days_chk check (ends_on >= starts_on and ends_on <= starts_on + 14)
);

create table if not exists public.sm_market_teams (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sm_market_events(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (id, event_id)
);
create unique index if not exists sm_market_teams_name_idx on public.sm_market_teams (event_id, lower(name));

create table if not exists public.sm_market_athletes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  team_id uuid not null,
  jersey text not null check (jersey ~ '^[0-9]{1,3}$'),
  -- Staff keep-out: a takedown, or a family who asked in person. Beats every consent.
  keep_out boolean not null default false,
  keep_out_at timestamptz,
  keep_out_by text check (keep_out_by is null or char_length(keep_out_by) <= 254),
  created_at timestamptz not null default now(),
  unique (team_id, jersey),
  unique (id, event_id),
  -- The team is at the same event.
  foreign key (team_id, event_id) references public.sm_market_teams(id, event_id) on delete cascade,
  constraint sm_market_athletes_keep_out_chk check (not keep_out or keep_out_at is not null)
);
create index if not exists sm_market_athletes_event_idx on public.sm_market_athletes (event_id);

create table if not exists public.sm_market_consents (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.sm_market_athletes(id) on delete cascade,
  email text not null check (
    email = lower(email) and char_length(email) between 3 and 200
    and email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  level text not null check (level in ('out', 'family', 'sell', 'public')),
  under_13 boolean not null,
  -- The age band given: 12 or younger, 13 to 15, 16 or 17, 18 or older.
  -- under_13 is the first of them.
  age_band text not null check (age_band in ('u13', '13_15', '16_17', '18_plus')),
  source text not null default 'qr' check (source in ('qr', 'staff')),
  -- The emailed confirmation link's hash, until it's used.
  confirm_hash text check (confirm_hash is null or confirm_hash ~ '^[0-9a-f]{64}$'),
  -- A change that loosens the answer above, waiting for that link. Until
  -- it's confirmed, level, under_13 and age_band are what count.
  pending_level text check (pending_level is null or pending_level in ('family', 'sell', 'public')),
  pending_under_13 boolean,
  pending_age_band text check (pending_age_band is null or pending_age_band in ('u13', '13_15', '16_17', '18_plus')),
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  -- The family link's hash, set once confirmed.
  family_hash text unique check (family_hash is null or family_hash ~ '^[0-9a-f]{64}$'),
  recorded_by text check (recorded_by is null or char_length(recorded_by) <= 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_id, email),
  -- 12 or younger: family only or kept out. Never sold to other families,
  -- never public.
  constraint sm_market_consents_u13_chk check (not under_13 or level in ('out', 'family')),
  constraint sm_market_consents_age_chk check (under_13 = (age_band = 'u13')),
  -- A staff member who records a consent confirms it.
  constraint sm_market_consents_staff_chk check (source = 'qr' or (confirmed_at is not null and recorded_by is not null)),
  constraint sm_market_consents_family_chk check (family_hash is null or confirmed_at is not null),
  -- A pending change is whole, has its link, and keeps the 12-or-younger rule.
  constraint sm_market_consents_pending_chk check (
    (pending_level is null) = (pending_under_13 is null)
    and (pending_level is null) = (pending_age_band is null)
    and (pending_level is null or confirm_hash is not null)
    and (pending_age_band is null or pending_under_13 = (pending_age_band = 'u13'))
    and not (pending_under_13 and pending_level in ('sell', 'public')))
);
create index if not exists sm_market_consents_athlete_idx on public.sm_market_consents (athlete_id);
create unique index if not exists sm_market_consents_confirm_idx on public.sm_market_consents (confirm_hash) where confirm_hash is not null;

create table if not exists public.sm_market_media (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sm_market_events(id) on delete restrict,
  kind text not null check (kind in ('clip', 'photo')),
  object_key text not null unique
    check (object_key ~ '^events/[0-9a-f-]{36}/originals/[0-9a-f-]{36}\.(mp4|mov|m4v|jpg|jpeg|png)$'),
  preview_key text check (preview_key is null or preview_key ~ '^events/[0-9a-f-]{36}/previews/[0-9a-f-]{36}\.(mp4|jpg)$'),
  poster_key text check (poster_key is null or poster_key ~ '^events/[0-9a-f-]{36}/previews/[0-9a-f-]{36}-poster\.jpg$'),
  filename text check (filename is null or char_length(filename) between 1 and 200),
  bytes bigint check (bytes is null or bytes between 1 and 10737418240),
  duration_ms int check (duration_ms is null or duration_ms between 0 and 3600000),
  width int check (width is null or width between 1 and 20000),
  height int check (height is null or height between 1 and 20000),
  -- uploaded → processing → review → approved (or hidden). failed after 3 tries.
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'review', 'approved', 'hidden', 'failed')),
  error text check (error is null or char_length(error) <= 300),
  attempts int not null default 0 check (attempts between 0 and 10),
  uploaded_by text not null check (char_length(uploaded_by) between 3 and 254),
  processing_at timestamptz,
  processed_at timestamptz,
  approved_at timestamptz,
  approved_by text check (approved_by is null or char_length(approved_by) <= 254),
  -- An approver's check that everyone who stands out in it is tagged, so no
  -- untagged child is sold by accident.
  everyone_tagged_at timestamptz,
  everyone_tagged_by text check (everyone_tagged_by is null or char_length(everyone_tagged_by) <= 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, event_id),
  constraint sm_market_media_ready_chk check (status not in ('review', 'approved') or (preview_key is not null and poster_key is not null)),
  constraint sm_market_media_approved_chk check (
    status <> 'approved' or (approved_at is not null and approved_by is not null and everyone_tagged_at is not null and everyone_tagged_by is not null))
);
create index if not exists sm_market_media_event_idx on public.sm_market_media (event_id, status);

create table if not exists public.sm_market_tags (
  media_id uuid not null,
  athlete_id uuid not null,
  event_id uuid not null,
  source text not null check (source in ('ai', 'staff')),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  confirmed boolean not null default false,
  confirmed_by text check (confirmed_by is null or char_length(confirmed_by) <= 254),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (media_id, athlete_id),
  -- The clip and the athlete are at the same event.
  foreign key (media_id, event_id) references public.sm_market_media(id, event_id) on delete cascade,
  foreign key (athlete_id, event_id) references public.sm_market_athletes(id, event_id) on delete cascade,
  constraint sm_market_tags_confirmed_chk check (not confirmed or (confirmed_by is not null and confirmed_at is not null))
);
create index if not exists sm_market_tags_athlete_idx on public.sm_market_tags (athlete_id) where confirmed;

create table if not exists public.sm_market_orders (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sm_market_events(id) on delete restrict,
  email text check (email is null or (
    email = lower(email) and char_length(email) between 3 and 200
    and email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded', 'expired')),
  amount_cents int not null check (amount_cents between 50 and 10000000),
  stripe_session_id text unique check (stripe_session_id is null or stripe_session_id ~ '^cs_[A-Za-z0-9_]{8,200}$'),
  -- The payment, so a refund in Stripe finds its order.
  stripe_payment_intent text check (stripe_payment_intent is null or stripe_payment_intent ~ '^pi_[A-Za-z0-9_]{8,200}$'),
  -- The order link's hash. The link itself is only ever in the buyer's hands.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  mode text check (mode is null or mode in ('test', 'live')),
  paid_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sm_market_orders_paid_chk check (status not in ('paid', 'refunded') or (paid_at is not null and stripe_session_id is not null))
);
create index if not exists sm_market_orders_event_idx on public.sm_market_orders (event_id, created_at desc);
create index if not exists sm_market_orders_payment_idx on public.sm_market_orders (stripe_payment_intent) where stripe_payment_intent is not null;

create table if not exists public.sm_market_order_items (
  order_id uuid not null references public.sm_market_orders(id) on delete cascade,
  -- A sold item can't be deleted out from under the buyer.
  media_id uuid not null references public.sm_market_media(id) on delete restrict,
  price_cents int not null check (price_cents between 0 and 100000),
  primary key (order_id, media_id)
);

alter table public.sm_market_events enable row level security;
alter table public.sm_market_teams enable row level security;
alter table public.sm_market_athletes enable row level security;
alter table public.sm_market_consents enable row level security;
alter table public.sm_market_media enable row level security;
alter table public.sm_market_tags enable row level security;
alter table public.sm_market_orders enable row level security;
alter table public.sm_market_order_items enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sm_market_events', 'sm_market_teams', 'sm_market_athletes', 'sm_market_consents',
                           'sm_market_media', 'sm_market_tags', 'sm_market_orders', 'sm_market_order_items'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on public.%I from authenticated', t); end if;
  end loop;
end $$;

-- The private bucket for originals and previews (Supabase only; a bare
-- Postgres in tests has no storage schema). Files up to 2 GB, video and
-- photos only. On Supabase's free plan the project's own 50 MB limit wins.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('sm-market', 'sm-market', false, 2147483648,
            array['video/mp4', 'video/quicktime', 'video/x-m4v', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;
