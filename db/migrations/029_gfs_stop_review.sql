-- 029: Pylon events · the stop review, the run sheet's last stage
-- (docs/gfs-workflow-sop.md; routes/gfs.js PATCH /events/:id, utils/gfs.js
-- runSheet).
--
-- Fourteen days after a stop wraps, Kyron reviews it and writes down any
-- change to the workflow SOP, or none. This records when, by whom, and that
-- one line. Until it runs, the run sheet shows the review stage without
-- tracking it, and marking a stop reviewed answers "Apply migration 029".

alter table public.gfs_events add column if not exists reviewed_at timestamptz;
alter table public.gfs_events add column if not exists reviewed_by text;
alter table public.gfs_events add column if not exists review_note text;

alter table public.gfs_events drop constraint if exists gfs_events_review_chk;
alter table public.gfs_events add constraint gfs_events_review_chk
  check ((reviewed_at is null) = (reviewed_by is null)
         and (reviewed_by is null or char_length(reviewed_by) <= 200)
         and (review_note is null or char_length(review_note) between 1 and 500));
