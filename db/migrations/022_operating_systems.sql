-- 022: The Operating System builder (TOJ app → Tools → Operating Systems;
-- routes/os.js, utils/os.js).
--
-- One row per client operating system. It walks the trail in the same order
-- as the site and its launch video:
--
--   raw         Raw operation      the door is picked (Personal Brand,
--                                  Non-profit or Authority)
--   intake      Foundation Score   the intake is in (imported from the site's
--                                  Foundation Score form, or entered in the app)
--   standard    The Standard       the five pillars are scored and approved
--   transcript  Transcript         the Operational Transcript is approved and,
--                                  with a client email, in the client portal
--   systemized  Systemized         Intake, Delivery and Follow-up are being
--                                  installed; the operating brain is generated
--   running     Trail of Joy       every system is live; handed off
--
-- Agents only draft (score_draft, transcript_draft). An approver or the owner
-- copies a draft into pillars / transcript. Authority builds can hold minors'
-- data, so the API keeps them owner-only. Logs carry ids, never names or
-- contact details. Service-role only.

create table if not exists public.os_builds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vertical text not null check (vertical in ('personal-brand', 'nonprofit', 'authority')),
  stage text not null default 'raw' check (stage in ('raw', 'intake', 'standard', 'transcript', 'systemized', 'running')),
  contact_email text,
  client_id uuid references public.clients(id) on delete set null,
  foundation_score_id uuid references public.foundation_scores(id) on delete set null,

  intake jsonb not null default '{}'::jsonb,
  intake_source text not null default 'app' check (intake_source in ('app', 'foundation_score')),
  intake_at timestamptz,

  score_draft jsonb,
  score_status text not null default 'none' check (score_status in ('none', 'running', 'ready', 'failed')),
  score_error text,
  score_started_at timestamptz,
  pillars jsonb,
  pillars_approved_by text,
  pillars_approved_at timestamptz,

  transcript_draft jsonb,
  transcript_status text not null default 'none' check (transcript_status in ('none', 'running', 'ready', 'failed')),
  transcript_error text,
  transcript_started_at timestamptz,
  transcript jsonb,
  transcript_approved_by text,
  transcript_approved_at timestamptz,
  published_at timestamptz,

  systems jsonb not null default '[]'::jsonb,
  brain jsonb,
  brain_generated_at timestamptz,
  running_at timestamptz,

  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists os_builds_stage_idx on public.os_builds (stage);
create index if not exists os_builds_updated_idx on public.os_builds (updated_at desc);
create index if not exists os_builds_fs_idx on public.os_builds (foundation_score_id);

alter table public.os_builds enable row level security;
drop policy if exists os_builds_service_all on public.os_builds;
create policy os_builds_service_all on public.os_builds
  for all to service_role using (true) with check (true);
