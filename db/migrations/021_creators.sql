-- 021: The Creator Club, phase 1 — creator profiles, their events and crew,
-- and orders from their landing pages (routes/creators.js, utils/creators.js).
--
-- Two lanes (Kyron, Oct 21, 2026):
--   creator lane  sales on the creator's own page and QR codes. The buyer pays
--                 the platform's Stripe; the creator's connected account (a
--                 parent's, for under-18) gets split_percent automatically.
--                 The creator owns this footage.
--   SM lane       events Subject Media assigns. Unchanged: SM collects and pays
--                 per the Videographer Services Agreement. Not stored here.
--
-- Stripe runs in test mode until counsel picks the company that holds it;
-- orders record which mode they were made in.
--
-- Orders hold buyer contact details (needed to deliver) and the athlete's team
-- and jersey as typed at checkout. Service-role only; never logged; never on a
-- public page. A minor's name never appears on a creator page.

create table if not exists public.creators (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  brand_name text not null,
  handle text,
  location text,
  tagline text,
  hero_lines text[] not null default array[]::text[],
  theme jsonb not null default '{}'::jsonb,
  packages jsonb not null default '[]'::jsonb,
  team_tier jsonb,
  footer_note text,
  creator_email text,
  under_18 boolean not null default false,
  guardian_email text,
  split_percent int not null default 80 check (split_percent between 50 and 95),
  rung int not null default 1 check (rung between 1 and 6),
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  club_status text not null default 'pending' check (club_status in ('pending', 'active', 'lapsed')),
  page_status text not null default 'none' check (page_status in ('none', 'requested', 'live', 'off')),
  page_requested_by text,
  page_requested_at timestamptz,
  page_approved_by text,
  page_approved_at timestamptz,
  camera text,
  camera_approved boolean not null default false,
  camera_approved_by text,
  stripe_account_id text,
  stripe_mode text check (stripe_mode in ('test', 'live')),
  stripe_ready boolean not null default false,
  checks jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not under_18 or guardian_email is not null)
);

create table if not exists public.creator_events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  name text not null,
  venue text,
  event_date date,
  sport text,
  status text not null default 'upcoming' check (status in ('upcoming', 'done', 'cancelled')),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists creator_events_creator_idx on public.creator_events (creator_id, event_date desc);

-- The creator's crew. A code per person credits their sales, like the
-- "which rep did you talk to" field on Subject Media's checkout.
create table if not exists public.creator_crew (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete cascade,
  name text not null,
  role text not null check (role in ('lead', 'support', 'photographer', 'coordinator', 'editor', 'designer')),
  code text not null check (code ~ '^[A-Z0-9]{4}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (creator_id, code)
);

create table if not exists public.creator_orders (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id) on delete restrict,
  event_id uuid references public.creator_events(id) on delete set null,
  crew_code text,
  package_id text not null,
  package_name text not null,
  amount_cents int not null check (amount_cents >= 0),
  creator_cents int not null check (creator_cents >= 0),
  platform_cents int not null check (platform_cents >= 0),
  buyer_name text,
  buyer_email text,
  buyer_phone text,
  team_jersey text,
  instagram text,
  consent_delivery boolean not null default false,
  consent_public boolean not null default false,
  status text not null default 'Paid' check (status in ('Paid', 'Shooting', 'Editing', 'Delivered', 'Refunded')),
  stripe_session_id text unique,
  mode text not null check (mode in ('test', 'live')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists creator_orders_creator_idx on public.creator_orders (creator_id, created_at desc);
create index if not exists creator_orders_event_idx on public.creator_orders (event_id);

create table if not exists public.creator_webhook_events (
  event_id text primary key,
  type text,
  processed_at timestamptz not null default now()
);

alter table public.creators enable row level security;
alter table public.creator_events enable row level security;
alter table public.creator_crew enable row level security;
alter table public.creator_orders enable row level security;
alter table public.creator_webhook_events enable row level security;

create policy creators_service_all on public.creators for all to service_role using (true) with check (true);
create policy creator_events_service_all on public.creator_events for all to service_role using (true) with check (true);
create policy creator_crew_service_all on public.creator_crew for all to service_role using (true) with check (true);
create policy creator_orders_service_all on public.creator_orders for all to service_role using (true) with check (true);
create policy creator_webhook_events_service_all on public.creator_webhook_events for all to service_role using (true) with check (true);
