-- 038: Pin the search path of the functions Supabase's security advisor
-- flags (function_search_path_mutable): the campaign deal graph's (015) and
-- the two updated_at triggers (001, 009).
--
-- With a search path that comes from whoever calls them, a function's
-- unqualified names could be made to resolve somewhere else. Each of these
-- already names its tables with their schema (deal.*) or touches only NEW
-- and now(), so an empty search path changes nothing they do; built-ins
-- (now, coalesce, current_setting) still come from pg_catalog, which is
-- always searched. Only the functions that exist are changed, so this runs
-- on any database, and again without complaint.

do $$
declare
  f text;
begin
  foreach f in array array[
    'deal.actor()',
    'deal.actor_role(uuid)',
    'deal.approval_gate()',
    'deal.approve_graph_version(uuid)',
    'deal.discard_graph_version(uuid)',
    'deal.fact_gate()',
    'deal.finding_gate()',
    'deal.graph_at(uuid, integer)',
    'deal.graph_diff(uuid, integer, integer)',
    'deal.graph_version_gate()',
    'deal.member_gate()',
    'deal.outbound_gate()',
    'public.touch_onboarding_intakes_updated_at()',
    'public.touch_updated_at()'
  ] loop
    if to_regprocedure(f) is not null then
      execute format('alter function %s set search_path = %L', f, '');
    end if;
  end loop;
end $$;
