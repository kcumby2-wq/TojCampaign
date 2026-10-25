-- 029: Pylon events · the run sheet's stop review, and the count its
-- "On sale and sent" stage needs (docs/gfs-workflow-sop.md; routes/gfs.js
-- PATCH /events/:id and eventCounts, utils/gfs.js runSheet).
--
-- Fourteen days after a stop wraps, Kyron reviews it and writes down any
-- change to the workflow SOP, or none. This records when, by whom, and that
-- one line. Until it runs, the run sheet shows the review stage without
-- tracking it, and marking a stop reviewed answers "Apply migration 029".
--
-- gfs_event_counts gains not_out: approved clips that aren't held or taken
-- down and haven't gone out (neither listed nor sent). A held clip can't go
-- out, so it must not keep the stage open. Until this runs, the stage leaves
-- that test out.

alter table public.gfs_events add column if not exists reviewed_at timestamptz;
alter table public.gfs_events add column if not exists reviewed_by text;
alter table public.gfs_events add column if not exists review_note text;

alter table public.gfs_events drop constraint if exists gfs_events_review_chk;
alter table public.gfs_events add constraint gfs_events_review_chk
  check ((reviewed_at is null) = (reviewed_by is null)
         and (reviewed_by is null or char_length(reviewed_by) <= 200)
         and (review_note is null or char_length(review_note) between 1 and 500));

-- The pipeline counts (migration 024), plus not_out.
drop function if exists public.gfs_event_counts(uuid[]);
create function public.gfs_event_counts(p_events uuid[])
returns table (
  event_id uuid, shot int, matched int, unmatched int, not_a_player int, tagged int, edited int,
  approved int, delivered int, listed int, held int, needs_removal int, to_family_only int, to_send int, to_list int,
  not_out int
)
language sql stable set search_path = '' as $$
  select c.event_id,
         count(*)::int,
         count(*) filter (where c.match = 'matched')::int,
         count(*) filter (where c.match = 'unmatched')::int,
         count(*) filter (where c.match = 'not_a_player')::int,
         count(*) filter (where c.stage in ('tagged', 'edited', 'approved'))::int,
         count(*) filter (where c.stage in ('edited', 'approved'))::int,
         count(*) filter (where c.stage = 'approved')::int,
         count(*) filter (where c.delivered_at is not null)::int,
         count(*) filter (where c.listed_at is not null and c.removed_at is null)::int,
         count(*) filter (where c.held)::int,
         count(*) filter (where (c.held or c.pull_reason = 'no_sale_consent')
                            and (c.listed_at is not null or c.delivered_at is not null) and c.removed_at is null)::int,
         count(*) filter (where c.pull_reason = 'not_public' and not c.held)::int,
         count(*) filter (where c.family_export_at is not null and c.delivered_at is null and c.removed_at is null
                            and c.stage = 'approved' and not c.held)::int,
         count(*) filter (where c.exported_at is not null and c.listed_at is null and c.removed_at is null
                            and c.stage = 'approved' and not c.held)::int,
         count(*) filter (where c.stage = 'approved' and not c.held and c.removed_at is null
                            and c.listed_at is null and c.delivered_at is null)::int
    from public.gfs_clips c
   where c.event_id = any (p_events)
   group by c.event_id
$$;
-- Callable by the server only, as in 024.
revoke all on function public.gfs_event_counts(uuid[]) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.gfs_event_counts(uuid[]) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.gfs_event_counts(uuid[]) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.gfs_event_counts(uuid[]) to service_role; end if;
end $$;
