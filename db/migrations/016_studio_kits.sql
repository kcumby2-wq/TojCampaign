-- 016: Studio kits — versioned Milanote kits made by the studio agents
-- (agents/studio, routes/studio-agents.js).
--
-- Every agent run saves a NEW row as a draft. Nothing an agent does edits an
-- existing row. A person (staff session, not an API key) approves a draft;
-- approving retires the slug's previous approved version to 'superseded' in
-- the same transaction, so a slug has at most one approved version.
--
-- The first approved Same Work kit (Oct 19, 2026) ships in the repo as
-- agents/studio/kits/same-work.v1.json and is not stored here. A slug with no
-- approved row here falls back to its built-in version.
--
-- Access is server-side only (service role), like eval_runs (migration 011).

create table if not exists public.studio_kits (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  version int not null check (version >= 1),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'superseded', 'discarded')),
  title text not null,
  kit jsonb not null,
  base_kit_id text,                 -- the approved kit a refresh started from (uuid or builtin:<slug>:v<n>)
  base_version int,
  source_run_id uuid references public.agent_runs(id) on delete set null,
  role text,                        -- kit-builder | kit-refresher
  eval_status text,                 -- passed | passed_after_retry | failed_after_retries | not_run
  check_blockers int not null default 0,
  summary text,                     -- the agent's closing summary
  changes jsonb,                    -- the run's change log (op, column, title, reason)
  created_by text,
  approved_by text,
  approved_at timestamptz,
  discarded_by text,
  discarded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (slug, version)
);

create unique index if not exists studio_kits_one_approved
  on public.studio_kits (slug) where status = 'approved';
create index if not exists studio_kits_slug_idx
  on public.studio_kits (slug, version desc);

alter table public.studio_kits enable row level security;
drop policy if exists studio_kits_service_all on public.studio_kits;
create policy studio_kits_service_all on public.studio_kits
  for all to service_role using (true) with check (true);

-- Approve one draft: retire the slug's approved version, promote this one.
-- Returns the approved row's id, or raises if the row isn't a draft.
create or replace function public.studio_kit_approve(p_id uuid, p_by text)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_slug text;
  v_status text;
begin
  select slug, status into v_slug, v_status
    from public.studio_kits where id = p_id for update;
  if v_slug is null then
    raise exception 'studio_kit_not_found';
  end if;
  if v_status <> 'draft' then
    raise exception 'studio_kit_not_draft';
  end if;
  perform 1 from public.studio_kits where slug = v_slug for update;
  update public.studio_kits set status = 'superseded'
   where slug = v_slug and status = 'approved';
  update public.studio_kits
     set status = 'approved', approved_by = p_by, approved_at = now()
   where id = p_id;
  return p_id;
end;
$$;

revoke all on function public.studio_kit_approve(uuid, text) from public, anon, authenticated;
grant execute on function public.studio_kit_approve(uuid, text) to service_role;
