-- 011_eval_runs_rls.sql
-- Close the Supabase advisory: public.eval_runs had RLS disabled, so anyone with
-- the anon key + project URL could read/write it. The app only ever touches it
-- via the service role (which bypasses RLS), so enabling RLS with a service-role
-- policy locks out anon/authenticated without changing app behavior.
alter table public.eval_runs enable row level security;
drop policy if exists eval_runs_service_all on public.eval_runs;
create policy eval_runs_service_all on public.eval_runs
  for all to service_role using (true) with check (true);
