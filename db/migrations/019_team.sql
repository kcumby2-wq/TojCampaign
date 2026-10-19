-- 019: The team — members, invites, an activity log, and push subscriptions
-- for the TOJ app (utils/team.js, routes/team.js, routes/push.js).
--
-- Owners are not stored here: an owner is a staff account whose email is on
-- the ADMIN_EMAILS server setting (utils/staff.js), exactly as before. This
-- table adds the people Kyron invites, each with one role:
--   approver — approves kit drafts, and everything a member can do
--   member   — writes briefs, starts runs, reviews drafts; can't approve
--   viewer   — opens approved kits and copies cards
-- and the tools they may open (today only 'studio' is wired).
--
-- Invites store only a SHA-256 of the one-time token; the link itself is
-- shown to Kyron once. Everything here is service-role only (RLS on, one
-- service_role policy each), like eval_runs (migration 011).

create table if not exists public.team_members (
  email text primary key check (email = lower(email)),
  name text,
  role text not null check (role in ('approver', 'member', 'viewer')),
  tools text[] not null default array['studio']::text[],
  status text not null default 'active' check (status in ('active', 'removed')),
  invited_by text,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  email text not null check (email = lower(email)),
  name text,
  role text not null check (role in ('approver', 'member', 'viewer')),
  tools text[] not null default array['studio']::text[],
  invited_by text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists team_invites_email_idx on public.team_invites (email, created_at desc);

-- Who did what. Subjects are kit slugs, run ids and team emails; never an
-- athlete's name or contact.
create table if not exists public.team_activity (
  id bigserial primary key,
  actor text not null,
  action text not null,
  subject text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists team_activity_created_idx on public.team_activity (created_at desc);

-- Who started each agent run (studio runs set it; older packs leave it null).
alter table public.agent_runs add column if not exists created_by text;

-- Web push: one row per device that turned notifications on.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  fail_count int not null default 0
);
create index if not exists push_subscriptions_email_idx on public.push_subscriptions (email);

-- Small server settings the app makes for itself (the web-push key pair when
-- no VAPID_* env vars are set).
create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.team_activity enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.app_config enable row level security;

create policy team_members_service_all on public.team_members for all to service_role using (true) with check (true);
create policy team_invites_service_all on public.team_invites for all to service_role using (true) with check (true);
create policy team_activity_service_all on public.team_activity for all to service_role using (true) with check (true);
create policy push_subscriptions_service_all on public.push_subscriptions for all to service_role using (true) with check (true);
create policy app_config_service_all on public.app_config for all to service_role using (true) with check (true);
