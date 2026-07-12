-- 005: Move admin users from ephemeral db/users.json (JSON file on Render's
-- ephemeral disk — wiped on every redeploy) to Supabase Postgres so sessions
-- survive deploys.
--
-- Very small table: email (unique) + bcrypt hash + created_at + role.
-- The `role` column is a stub for future per-user permissions
-- (admin | client) — for now everyone who registers is admin.

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  hash text not null,
  role text not null default 'admin',
  created_at timestamptz not null default now()
);

create index if not exists users_email_idx on users(lower(email));

alter table users enable row level security;
-- No policies — the route uses the service role key and gates on session.
