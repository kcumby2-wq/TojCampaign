-- 009_onboarding_intakes.sql
-- ---------------------------------------------------------------------------
-- Generalized onboarding intake pipeline for the whole TOJ / Subject ecosystem.
--
-- WHY A SEPARATE TABLE (not clients/foundation_scores):
--   foundation_scores + clients model BUSINESS OPERATORS (email = identity,
--   business_name, monthly_price). The people we onboard here are ATHLETES
--   (often minors), COACHES/TRAINERS, and BRANCH partners. Forcing minor-
--   athlete data into the business `clients` table would (a) muddy the model
--   and (b) put minor PII on a code path that auto-embeds to the agent RAG.
--   This table keeps those audiences separate and makes the child-safety
--   consent gate a first-class column, not an afterthought.
--
-- CHILD-SAFETY (load-bearing):
--   * A minor's row may be stored here (Supabase is the private store, outside
--     git) but is NEVER embedded to client_documents/client_embeddings — i.e.
--     never surfaced to agents/RAG — unless guardian consent is c3+ (named).
--     The application enforces this (routes/onboarding.js); `embedded` records
--     whether it happened. consent_status defaults to 'pending' for minors.
--   * No real minor data ever lands in git. This migration ships the SCHEMA
--     only; rows are created at runtime into the private Supabase project.
--
-- Apply AFTER 008. Idempotent (IF NOT EXISTS). Safe to re-run.
-- ---------------------------------------------------------------------------

create extension if not exists "pgcrypto";

create table if not exists public.onboarding_intakes (
  id                uuid primary key default gen_random_uuid(),

  -- who this is
  audience          text not null check (audience in
                      ('athlete','coach','branch','business','creator')),
  branch            text,        -- subject-medias | subject-report | subject-skillz
                                 -- | coached-by-hooks | flippa-highlights
                                 -- | optimum-grading | pylon | trail-of-joy
  subject_name      text,        -- display name of the person/entity onboarded
  is_minor          boolean not null default false,

  -- how to reach the responsible adult
  contact_email     text,        -- operator/coach OR guardian reachable email
  contact_phone     text,

  -- guardian + consent (child-safety gate)
  guardian_name     text,
  guardian_email    text,
  consent_level     text check (consent_level in ('c0','c1','c2','c3','c4')),
  consent_status    text not null default 'pending'
                      check (consent_status in
                      ('not_required','pending','granted','revoked')),

  -- the intake answers
  payload           jsonb not null default '{}'::jsonb,
  intake_version    text default 'v1',

  -- pipeline / CRM
  status            text not null default 'new'
                      check (status in
                      ('new','reviewing','contacted','onboarding','active','declined')),
  assigned_agent    text,        -- which agent role picked it up (agentic layer)

  -- RAG gate bookkeeping
  embedded          boolean not null default false,

  -- provenance
  source            text,
  ip                text,
  user_agent        text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists onboarding_intakes_audience_idx
  on public.onboarding_intakes (audience);
create index if not exists onboarding_intakes_branch_idx
  on public.onboarding_intakes (branch);
create index if not exists onboarding_intakes_status_idx
  on public.onboarding_intakes (status);
create index if not exists onboarding_intakes_consent_idx
  on public.onboarding_intakes (consent_status);
create index if not exists onboarding_intakes_created_idx
  on public.onboarding_intakes (created_at desc);

-- keep updated_at fresh
create or replace function public.touch_onboarding_intakes_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_onboarding_intakes_touch on public.onboarding_intakes;
create trigger trg_onboarding_intakes_touch
  before update on public.onboarding_intakes
  for each row execute function public.touch_onboarding_intakes_updated_at();

-- RLS: only the service role (the Express backend) reads/writes. No anon access.
-- The public intake POST goes through the backend using the service key; the
-- admin CRM reads through the backend behind session auth. There is no direct
-- browser → table path, so we lock the table to service-role only.
alter table public.onboarding_intakes enable row level security;

drop policy if exists onboarding_intakes_service_all on public.onboarding_intakes;
create policy onboarding_intakes_service_all
  on public.onboarding_intakes
  for all
  to service_role
  using (true)
  with check (true);
