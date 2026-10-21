-- 016_live_post_approval.sql
-- Live Event Console cards pass the Pylon approver gate, like every other
-- content asset (Kyron, 2026-10-18). Before this migration any signed-in user,
-- or any holder of PYLON_API_KEY, could publish a card straight from the
-- console tray with no approval.
--
-- Now:
--   * A new card starts 'queued'.
--   * Only a PYLON_APPROVERS approver moves it to 'approved' or 'rejected'
--     (enforced in routes/pylon.js; the database records who decided and when).
--   * The database refuses to publish a card that wasn't approved, and refuses
--     to change what a card shows after it was approved, so the approver signs
--     off on exactly what posts.
--
-- Also adds the metadata column POST /live-posts has always written (stat type,
-- stat value, score). Migration 008 never created it, so that insert failed.

alter table pylon_live_posts
  add column if not exists metadata    jsonb not null default '{}'::jsonb,
  add column if not exists status      text not null default 'queued',
  add column if not exists decided_by  text,
  add column if not exists decided_at  timestamptz;

-- Cards that went out before the gate existed count as published.
update pylon_live_posts
   set status = 'published',
       decided_by = coalesce(decided_by, 'pre-016'),
       decided_at = coalesce(decided_at, posted_at)
 where posted_at is not null and status = 'queued';

alter table pylon_live_posts drop constraint if exists pylon_live_posts_status_chk;
alter table pylon_live_posts add constraint pylon_live_posts_status_chk
  check (status in ('queued', 'approved', 'rejected', 'published'));

-- Nothing is posted unless it is published, and nothing is published undecided.
alter table pylon_live_posts drop constraint if exists pylon_live_posts_posted_needs_publish_chk;
alter table pylon_live_posts add constraint pylon_live_posts_posted_needs_publish_chk
  check (posted_at is null or status = 'published');

alter table pylon_live_posts drop constraint if exists pylon_live_posts_decision_recorded_chk;
alter table pylon_live_posts add constraint pylon_live_posts_decision_recorded_chk
  check (status = 'queued' or (decided_by is not null and decided_at is not null));

create index if not exists pylon_live_posts_queue_idx
  on pylon_live_posts (event_id, created_at)
  where status in ('queued', 'approved');

create or replace function pylon_live_posts_gate() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status is distinct from 'queued' or new.posted_at is not null or new.decided_by is not null then
      raise exception 'a new live card must start queued for approval';
    end if;
    return new;
  end if;

  -- Allowed moves: queued -> approved | rejected, approved -> published | rejected.
  if new.status is distinct from old.status
     and not ((old.status = 'queued'   and new.status in ('approved', 'rejected'))
           or (old.status = 'approved' and new.status in ('published', 'rejected'))) then
    raise exception 'live card % cannot move from % to %', old.id, old.status, new.status;
  end if;

  -- Once a decision is made, what the card shows is fixed.
  if old.status <> 'queued'
     and (new.post_type   is distinct from old.post_type
       or new.asset_url   is distinct from old.asset_url
       or new.sponsor_tag is distinct from old.sponsor_tag
       or new.athlete_id  is distinct from old.athlete_id
       or new.team_id     is distinct from old.team_id
       or new.event_id    is distinct from old.event_id
       or new.metadata    is distinct from old.metadata) then
    raise exception 'live card % was already % ; queue a new card instead of editing it', old.id, old.status;
  end if;

  return new;
end $$;

drop trigger if exists pylon_live_posts_gate on pylon_live_posts;
create trigger pylon_live_posts_gate
  before insert or update on pylon_live_posts
  for each row execute function pylon_live_posts_gate();
