-- 028: Pylon events · a creator's age is checked before they work
-- (routes/gfs.js creators, utils/gfs.js credentialProblems, public/app/gfs.js).
--
-- Until now a new creator was an adult unless someone said otherwise, with no
-- age or guardian on file. One wrong field let a minor lead a crew, count as
-- the adult a youth creator needs on site, or appear on a stop's public page.
-- Now it fails closed, the way the roster already treats an athlete with no
-- verified age as under 13:
--
--   * A new creator is youth until Kyron records an age check. Adult (18+)
--     needs one on file.
--   * Nobody is invited to or confirmed on a crew until their age is checked,
--     and only a checked adult counts as the adult on site.
--   * A youth creator (16–17) also needs a guardian of record: the parent who
--     signs the Youth Creator Agreement. An adult has none on file.
--
-- The check records when and by whom, never a birth date: the same rule the
-- roster follows. The adult and guardian rules apply when a row is added or
-- its tier, age check or guardian changes, so an adult saved before this
-- migration can still be paused or edited; the crew rule below keeps them off
-- crews until their age is checked.

alter table public.gfs_creators add column if not exists age_checked_on date;
alter table public.gfs_creators add column if not exists age_checked_by text;
alter table public.gfs_creators add column if not exists guardian_name text;
alter table public.gfs_creators add column if not exists guardian_email text;

alter table public.gfs_creators alter column tier set default 'youth';

alter table public.gfs_creators drop constraint if exists gfs_creators_age_fields_chk;
alter table public.gfs_creators add constraint gfs_creators_age_fields_chk
  check ((age_checked_by is null or char_length(age_checked_by) <= 200)
         and (age_checked_on is null) = (age_checked_by is null)
         and (guardian_name is null or char_length(guardian_name) between 1 and 80)
         and (guardian_email is null or (guardian_email = lower(guardian_email) and char_length(guardian_email) <= 200)));

-- Adult only with an age check on file; a guardian of record belongs to a
-- youth creator only. Checked when the row is added or these fields change.
create or replace function public.gfs_creators_age_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tier = 'adult' and new.age_checked_on is null
     and (tg_op = 'INSERT' or new.tier is distinct from old.tier or new.age_checked_on is distinct from old.age_checked_on) then
    raise exception 'gfs_adult_needs_age_check';
  end if;
  if new.tier = 'adult' and (new.guardian_name is not null or new.guardian_email is not null)
     and (tg_op = 'INSERT' or new.tier is distinct from old.tier
          or new.guardian_name is distinct from old.guardian_name or new.guardian_email is distinct from old.guardian_email) then
    raise exception 'gfs_adult_has_guardian';
  end if;
  return new;
end $$;
drop trigger if exists gfs_creators_age_check on public.gfs_creators;
create trigger gfs_creators_age_check before insert or update on public.gfs_creators
  for each row execute function public.gfs_creators_age_check();

-- Screened for an event now includes the age check, so only a checked adult
-- counts as the adult on site (migration 024's crew rules use this).
create or replace function public.gfs_creator_ok(c public.gfs_creators, on_date date) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(c.status = 'active' and c.contract_signed_on is not null
                  and c.background_check_on >= (on_date - interval '1 year')::date
                  and c.safety_training_on >= (on_date - interval '1 year')::date
                  and c.age_checked_on is not null, false)
$$;

-- Nobody joins a crew before their age is checked; a youth creator also needs
-- a guardian of record. Runs before 024's gfs_crew_check (triggers fire in
-- name order) and skips the changes that one skips too.
create or replace function public.gfs_crew_age_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  c public.gfs_creators%rowtype;
begin
  if tg_op = 'UPDATE' and new.role = old.role and new.status = old.status then return new; end if;
  if new.status not in ('invited', 'confirmed') then return new; end if;
  select * into c from public.gfs_creators
   where id = case when tg_op = 'UPDATE' then old.creator_id else new.creator_id end;
  if c.age_checked_on is null then raise exception 'crew_age_not_checked'; end if;
  if c.tier = 'youth' and c.guardian_email is null then raise exception 'crew_youth_no_guardian'; end if;
  return new;
end $$;
drop trigger if exists gfs_crew_age_check on public.gfs_crew;
create trigger gfs_crew_age_check before insert or update on public.gfs_crew
  for each row execute function public.gfs_crew_age_check();
