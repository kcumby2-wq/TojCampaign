-- =============================================================
-- TOJ SaaS · Initial schema · 2026-07-08
-- Owned by Trail of Joy Management Group, LLC.
--
-- Run this once against the Supabase project. It creates the tables
-- Phase 1 (concierge MVP) uses and the tables Phase 2 (semi-auto SaaS)
-- will use — with Row-Level Security enabled from day one so client
-- data is scoped by user_id / client_id automatically.
--
-- To run: paste into Supabase → SQL Editor → New Query → Run.
-- Idempotent: safe to re-run (CREATE ... IF NOT EXISTS everywhere).
-- =============================================================

-- ---------- 1. Waitlist (public marketing site captures) ----------
create table if not exists public.waitlist (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  vertical     text not null check (vertical in ('personal-brand', 'nonprofit', 'authority', 'unknown')),
  source       text,
  meta         jsonb default '{}'::jsonb,
  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  invited_at   timestamptz,
  converted_at timestamptz,
  unique (email, vertical)
);
create index if not exists waitlist_vertical_idx  on public.waitlist (vertical);
create index if not exists waitlist_created_at_idx on public.waitlist (created_at desc);

-- Waitlist gets written by anon (public site) and read by admins only.
alter table public.waitlist enable row level security;
drop policy if exists waitlist_anon_insert on public.waitlist;
create policy waitlist_anon_insert on public.waitlist
  for insert to anon with check (true);
drop policy if exists waitlist_service_all on public.waitlist;
create policy waitlist_service_all on public.waitlist
  for all to service_role using (true) with check (true);

-- ---------- 2. Clients (concierge pilots + future SaaS users) ----------
create table if not exists public.clients (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid unique references auth.users(id) on delete set null,
  business_name     text,
  operator_name     text,
  email             text not null,
  vertical          text not null check (vertical in ('personal-brand', 'nonprofit', 'authority')),
  tier              text not null default 'founding' check (tier in ('founding', 'core', 'premium', 'sunset')),
  monthly_price_usd integer not null default 99,
  status            text not null default 'pilot' check (status in ('pilot', 'active', 'paused', 'churned')),
  onboarded_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (email)
);
create index if not exists clients_vertical_idx on public.clients (vertical);
create index if not exists clients_status_idx   on public.clients (status);

alter table public.clients enable row level security;
drop policy if exists clients_self_read on public.clients;
create policy clients_self_read on public.clients
  for select to authenticated using (auth_user_id = auth.uid());
drop policy if exists clients_service_all on public.clients;
create policy clients_service_all on public.clients
  for all to service_role using (true) with check (true);

-- ---------- 3. Foundation Score submissions ----------
create table if not exists public.foundation_scores (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references public.clients(id) on delete cascade,
  vertical        text not null check (vertical in ('personal-brand', 'nonprofit', 'authority')),
  intake_payload  jsonb not null,                      -- full intake response, versioned
  intake_version  text not null default 'v1',
  submitted_at    timestamptz not null default now(),
  -- Scoring output (populated after Kyron + CPO deliver the Transcript)
  pillar_scores   jsonb,                               -- {brand_identity: 82, operational_health: 68, ...}
  transcript_url  text,                                -- link to the finalized Operational Transcript PDF/page
  transcript_delivered_at timestamptz,
  proposal_tier   text check (proposal_tier in ('founding', 'core', 'premium')),
  proposal_url    text
);
create index if not exists fs_client_id_idx    on public.foundation_scores (client_id);
create index if not exists fs_submitted_at_idx on public.foundation_scores (submitted_at desc);

alter table public.foundation_scores enable row level security;
drop policy if exists fs_client_read on public.foundation_scores;
create policy fs_client_read on public.foundation_scores
  for select to authenticated
  using (client_id in (select id from public.clients where auth_user_id = auth.uid()));
drop policy if exists fs_service_all on public.foundation_scores;
create policy fs_service_all on public.foundation_scores
  for all to service_role using (true) with check (true);

-- ---------- 4. Weekly deliverables (concierge output log) ----------
create table if not exists public.deliverables (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  kind            text not null check (kind in ('csv', 'campaign', 'sop', 'transcript', 'call-notes', 'module', 'other')),
  title           text not null,
  description     text,
  file_url        text,
  delivered_at    timestamptz not null default now(),
  delivered_by    text                          -- who on the TOJ team
);
create index if not exists deliverables_client_id_idx on public.deliverables (client_id);
create index if not exists deliverables_kind_idx      on public.deliverables (kind);

alter table public.deliverables enable row level security;
drop policy if exists deliverables_client_read on public.deliverables;
create policy deliverables_client_read on public.deliverables
  for select to authenticated
  using (client_id in (select id from public.clients where auth_user_id = auth.uid()));
drop policy if exists deliverables_service_all on public.deliverables;
create policy deliverables_service_all on public.deliverables
  for all to service_role using (true) with check (true);

-- ---------- 5. Pilots pipeline (internal tracker) ----------
create table if not exists public.pilots (
  id             uuid primary key default gen_random_uuid(),
  operator_name  text,
  business_name  text,
  contact_email  text,
  vertical       text check (vertical in ('personal-brand', 'nonprofit', 'authority')),
  intended_tier  text check (intended_tier in ('founding', 'core', 'premium')),
  status         text not null default 'prospect'
                 check (status in ('prospect', 'committed', 'signed', 'onboarded', 'declined', 'sunset')),
  commit_signed_at timestamptz,
  onboarded_at   timestamptz,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pilots_status_idx   on public.pilots (status);
create index if not exists pilots_vertical_idx on public.pilots (vertical);

alter table public.pilots enable row level security;
-- Pilots table is internal only. No anon or authenticated access. Service role only.
drop policy if exists pilots_service_all on public.pilots;
create policy pilots_service_all on public.pilots
  for all to service_role using (true) with check (true);

-- ---------- 6. updated_at triggers ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clients_touch_updated_at on public.clients;
create trigger clients_touch_updated_at
  before update on public.clients
  for each row execute function public.touch_updated_at();

drop trigger if exists pilots_touch_updated_at on public.pilots;
create trigger pilots_touch_updated_at
  before update on public.pilots
  for each row execute function public.touch_updated_at();

-- =============================================================
-- End of migration 001. Kyron: after running, paste
-- SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY into Render env vars
-- and SUPABASE_URL + SUPABASE_ANON_KEY into Vercel env vars.
-- =============================================================
