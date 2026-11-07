-- 036: What people send from the public Pylon pages, and the Pylon newsletter
-- list (routes/pylon.js; the rules are in utils/pylon.js).
--
-- This replaces the design in 008, 013 and 016, which never ran in
-- production: their tables had no row level security, and their API
-- (the old routes/pylon.js) never mounted. Nothing here depends on them.
--
-- pylon_requests: one row per form sent from a Pylon page.
--   team_package        pylon-team-packages.html: a coach books team coverage
--   player_package      pylon-player-packages.html: coverage of one athlete
--   transcript          pylon-athlete-subscribe.html: the season-long profile
--   recruiting          pylon-recruiting.html: the Recruiting Concierge
--   newsletter_premium  pylon-newsletter.html: the paid tier
--   ambassador          pylon-ambassadors.html: an application
--
-- What it holds, and what it never does:
--   * The contact: the adult we deal with. The head coach for a team, the
--     parent or legal guardian for an athlete, or the athlete when they're
--     18 or older. Shown to staff in the app, never on a public page. A plain
--     address only, so a staff Email button can't be made to copy anyone in.
--   * The athlete, by name, when the service is for one, with the answer to
--     the form's consent question and the exact words agreed to. Every
--     athlete on a request comes with that answer; a team request names no
--     athlete (each athlete's footage is cleared through their own parent or
--     guardian, at the event).
--   * The price from the server's own list (never the page's), the Stripe
--     checkout the page started, and the payment once Stripe confirms it.
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated.

create table if not exists public.pylon_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null
    check (kind in ('team_package', 'player_package', 'transcript', 'recruiting', 'newsletter_premium', 'ambassador')),
  package text not null check (package ~ '^[a-z0-9_]{1,40}$'),
  package_name text not null check (char_length(package_name) between 1 and 120),
  price_cents int check (price_cents is null or price_cents between 0 and 99999999),
  cadence text check (cadence is null or cadence in ('once', 'month', 'season')),
  referral_code text check (referral_code is null or referral_code ~ '^[A-Z0-9_-]{2,30}$'),
  contact_role text not null check (contact_role in ('coach', 'parent', 'guardian', 'athlete', 'subscriber')),
  contact_name text not null check (char_length(contact_name) between 1 and 80),
  contact_email text not null check (
    contact_email = lower(contact_email) and char_length(contact_email) between 3 and 200
    and contact_email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  contact_phone text check (contact_phone is null or char_length(contact_phone) between 7 and 30),
  athlete_name text check (athlete_name is null or char_length(athlete_name) between 1 and 80),
  consent text check (consent is null or consent in ('parent', 'guardian', 'adult')),
  consent_text text check (consent_text is null or char_length(consent_text) between 1 and 600),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  notes text check (notes is null or char_length(notes) <= 1000),
  status text not null default 'new' check (status in ('new', 'contacted', 'confirmed', 'done', 'closed')),
  status_by text check (status_by is null or char_length(status_by) <= 200),
  team_note text check (team_note is null or char_length(team_note) <= 2000),
  checkout_session_id text unique check (checkout_session_id is null or checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{8,200}$'),
  checkout_mode text check (checkout_mode is null or checkout_mode in ('test', 'live')),
  paid_at timestamptz,
  paid_cents int check (paid_cents is null or paid_cents between 0 and 99999999),
  paid_via text check (paid_via is null or paid_via in ('stripe', 'manual')),
  contact_emailed_at timestamptz,
  paid_emailed_at timestamptz,
  alerted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An athlete on a request comes with the consent answer, and the answer
  -- names who the contact is: the parent, the legal guardian, or the athlete
  -- themselves at 18 or older.
  constraint pylon_requests_athlete_consent check (
    (athlete_name is null and consent is null and consent_text is null)
    or (athlete_name is not null and consent is not null and consent_text is not null)),
  constraint pylon_requests_consent_contact check (
    consent is null
    or (consent = 'adult' and contact_role = 'athlete')
    or (consent = 'parent' and contact_role = 'parent')
    or (consent = 'guardian' and contact_role = 'guardian')),
  -- Each kind's shape: who the contact is, and whether there's an athlete.
  constraint pylon_requests_kind_shape check (
    (kind = 'team_package' and contact_role = 'coach' and athlete_name is null)
    or (kind = 'newsletter_premium' and contact_role = 'subscriber' and athlete_name is null)
    or (kind in ('player_package', 'transcript', 'recruiting', 'ambassador') and athlete_name is not null)),
  -- An application has no price and is never paid.
  constraint pylon_requests_ambassador_unpaid check (
    kind <> 'ambassador' or (price_cents is null and checkout_session_id is null and paid_at is null)),
  -- A payment is when, how much and how, together; one through Stripe is
  -- the checkout this request started.
  constraint pylon_requests_paid_whole check (
    (paid_at is null and paid_cents is null and paid_via is null)
    or (paid_at is not null and paid_cents is not null and paid_via is not null)),
  constraint pylon_requests_paid_stripe check (paid_via is distinct from 'stripe' or checkout_session_id is not null),
  constraint pylon_requests_checkout_mode check ((checkout_session_id is null) = (checkout_mode is null))
);

create index if not exists pylon_requests_status_idx on public.pylon_requests (status, created_at desc);

alter table public.pylon_requests enable row level security;

-- pylon_newsletter: The Off-Season Signal's free list. An address counts
-- once its owner confirms it from the email we send (double opt-in), so a
-- form can't sign someone else up. Only the confirmation link's hash is kept.
-- The unsubscribe link's token is kept as it is, because every issue has to
-- carry it; all it can do is take that one address off the list.
create table if not exists public.pylon_newsletter (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (
    email = lower(email) and char_length(email) between 3 and 200
    and email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'unsubscribed')),
  source text check (source is null or source ~ '^[a-z0-9_]{1,40}$'),
  confirm_token_hash text unique check (confirm_token_hash is null or confirm_token_hash ~ '^[0-9a-f]{64}$'),
  confirm_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribe_token text not null unique check (unsubscribe_token ~ '^[0-9a-f]{64}$'),
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pylon_newsletter_confirmed check (status <> 'confirmed' or (confirmed_at is not null and confirm_token_hash is null)),
  constraint pylon_newsletter_unsubscribed check (status <> 'unsubscribed' or (unsubscribed_at is not null and confirm_token_hash is null))
);

alter table public.pylon_newsletter enable row level security;

-- RLS with no policies already shuts the API roles out; take their table
-- rights away too, where those roles exist (a bare Postgres in tests has none).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.pylon_requests, public.pylon_newsletter from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.pylon_requests, public.pylon_newsletter from authenticated;
  end if;
end $$;
