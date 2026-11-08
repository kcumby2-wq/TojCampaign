-- 042: the kit learns from the work (routes/studio-learn.js, routes/studio-agents.js,
-- public/app/learn.js; docs/studio-films.md). Builds on 039, 040 and 041.
-- Service role only.
--
--   * A wrap-up: what worked on a film, what missed, and what the kit should
--     change, from whoever made it. It keeps no names (the history's rule),
--     and it's folded into one refresh, once.
--   * A suggested edit to a kit card, from anyone with Studio: open until an
--     approver folds it into a refresh or declines it, with a reason. A kit
--     never carries a name, so neither does a suggestion.
--   * A review-note label (040's studio_notes) used three times is a rule in
--     the making. An approver folds it into a refresh or declines it; a
--     declined one comes back after three more uses.
--   * Each refresh started from these (the month's) or as a gear re-check is
--     marked, so Today knows what's due, with what it was given. What it was
--     given is folded in only once it has saved a draft: a run that fails, or
--     needs no change, leaves it all open for the next one.
--   * Rules in the making are counted per kit (a label on that kit's films),
--     and every decision about one is kept.

-- ── Wrap-ups ──────────────────────────────────────────────────────────────
create table if not exists public.studio_film_wraps (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  worked text not null check (char_length(btrim(worked)) between 1 and 600),
  missed text check (missed is null or char_length(btrim(missed)) between 1 and 600),
  change text check (change is null or char_length(btrim(change)) between 1 and 600),
  -- The kit card it's about, by its title (optional).
  card_title text check (card_title is null or char_length(btrim(card_title)) between 1 and 200),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  folded_run_id uuid references public.agent_runs(id) on delete set null,
  folded_at timestamptz,
  constraint studio_film_wraps_folded_whole check (folded_run_id is null or folded_at is not null)
);
create index if not exists studio_film_wraps_film_idx on public.studio_film_wraps (film_id, created_at);
create index if not exists studio_film_wraps_open_idx on public.studio_film_wraps (created_at) where folded_at is null;
alter table public.studio_film_wraps enable row level security;

-- ── Suggested edits to a kit card ─────────────────────────────────────────
create table if not exists public.studio_kit_suggestions (
  id uuid primary key default gen_random_uuid(),
  kit_slug text not null check (kit_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kit_version int not null check (kit_version >= 1),
  column_name text not null check (char_length(btrim(column_name)) between 1 and 120),
  card_title text not null check (char_length(btrim(card_title)) between 1 and 200),
  suggestion text not null check (char_length(btrim(suggestion)) between 3 and 1000),
  why text check (why is null or char_length(btrim(why)) between 1 and 500),
  status text not null default 'open' check (status in ('open', 'declined', 'folded')),
  decided_by text check (decided_by is null or char_length(decided_by) between 3 and 200),
  decided_at timestamptz,
  decided_note text check (decided_note is null or char_length(btrim(decided_note)) between 3 and 300),
  folded_run_id uuid references public.agent_runs(id) on delete set null,
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  constraint studio_kit_suggestions_decided check ((status = 'open') = (decided_at is null) and (decided_at is null) = (decided_by is null)),
  constraint studio_kit_suggestions_declined_why check (status <> 'declined' or decided_note is not null)
);
create index if not exists studio_kit_suggestions_open_idx on public.studio_kit_suggestions (kit_slug, created_at) where status = 'open';
alter table public.studio_kit_suggestions enable row level security;

-- ── Rules in the making (review-note labels) ─────────────────────────────
-- One row for every decision (kept, never rewritten): the latest one for a
-- kit and a label is where it stands.
create table if not exists public.studio_label_marks (
  id uuid primary key default gen_random_uuid(),
  kit_slug text not null check (kit_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  label text not null check (label = lower(label) and char_length(label) between 2 and 60),
  status text not null check (status in ('folded', 'declined')),
  -- How many of the kit's notes had it when it was decided: a declined one
  -- comes back after three more.
  uses_at int not null check (uses_at >= 0),
  run_id uuid references public.agent_runs(id) on delete set null,
  note text check (note is null or char_length(btrim(note)) between 3 and 300),
  decided_by text not null check (char_length(decided_by) between 3 and 200),
  decided_at timestamptz not null default now(),
  constraint studio_label_marks_declined_why check (status <> 'declined' or note is not null)
);
create index if not exists studio_label_marks_kit_idx on public.studio_label_marks (kit_slug, label, decided_at desc);
alter table public.studio_label_marks enable row level security;

-- ── Refreshes started from what the team learned ─────────────────────────
create table if not exists public.studio_refresh_marks (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  kit_slug text not null check (kit_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind text not null check (kind in ('monthly', 'gear')),
  month date not null check (extract(day from month) = 1),
  started_by text not null check (char_length(started_by) between 3 and 200),
  started_at timestamptz not null default now(),
  -- How it ended: a draft saved, no change needed, or no draft. Null while
  -- it runs (a run quiet for 90 minutes counts as ended without a draft).
  outcome text check (outcome in ('drafted', 'no_changes', 'failed')),
  ended_at timestamptz,
  constraint studio_refresh_marks_ended check ((outcome is null) = (ended_at is null))
);
create index if not exists studio_refresh_marks_kind_idx on public.studio_refresh_marks (kit_slug, kind, started_at desc);
alter table public.studio_refresh_marks enable row level security;

-- What a month's refresh was given: wrap-ups, suggested edits and rules in
-- the making (with how many notes each had). Folded in when it saves a draft.
create table if not exists public.studio_refresh_sources (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.studio_refresh_marks(run_id) on delete cascade,
  kind text not null check (kind in ('wrap', 'suggestion', 'label')),
  ref_id uuid,
  label text check (label is null or (label = lower(label) and char_length(label) between 2 and 60)),
  uses int check (uses is null or uses >= 0),
  constraint studio_refresh_sources_shape check ((kind = 'label') = (label is not null) and (kind = 'label') = (ref_id is null))
);
create unique index if not exists studio_refresh_sources_item on public.studio_refresh_sources (run_id, kind, coalesce(ref_id::text, label));
create index if not exists studio_refresh_sources_ref_idx on public.studio_refresh_sources (kind, ref_id) where ref_id is not null;
alter table public.studio_refresh_sources enable row level security;

-- ── Gates ─────────────────────────────────────────────────────────────────
create or replace function public.studio_film_wraps_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.folded_at is not null then
      raise exception 'a wrap-up folded into a refresh is kept';
    end if;
    if public.studio_refresh_holds('wrap', old.id, null, null) then
      raise exception 'a refresh is drawing on this wrap-up right now: change it when that run ends';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.film_id <> old.film_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'wrap-up % keeps its film and who wrote it', old.id;
    end if;
    if old.folded_at is not null then
      -- Only its run going (agent_runs on delete set null) changes it now.
      if row(new.worked, new.missed, new.change, new.card_title, new.folded_at)
         is distinct from row(old.worked, old.missed, old.change, old.card_title, old.folded_at)
         or new.folded_run_id is not null and new.folded_run_id is distinct from old.folded_run_id then
        raise exception 'a wrap-up folded into a refresh stays as it was';
      end if;
      return new;
    end if;
    -- While a refresh draws on it, it stays as that refresh read it.
    if row(new.worked, new.missed, new.change, new.card_title) is distinct from row(old.worked, old.missed, old.change, old.card_title)
       and public.studio_refresh_holds('wrap', old.id, null, null) then
      raise exception 'a refresh is drawing on this wrap-up right now: change it when that run ends';
    end if;
  end if;
  -- No names: the film's cards (the history's rule), and every film's, since
  -- wrap-ups go into the kit's refresh (040's studio_names_in_any).
  if public.studio_names_in(new.film_id, concat_ws(' ', new.worked, new.missed, new.change, new.card_title))
     or public.studio_names_in_any(concat_ws(' ', new.worked, new.missed, new.change, new.card_title)) then
    raise exception 'wrap-ups keep no names: write the code instead';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.folded_run_id := null;
    new.folded_at := null;
  elsif new.folded_at is not null and (new.folded_run_id is null or not exists (
          select 1 from public.studio_refresh_sources x join public.studio_refresh_marks m on m.run_id = x.run_id
           where x.run_id = new.folded_run_id and x.kind = 'wrap' and x.ref_id = new.id and m.outcome = 'drafted')) then
    -- Folded only into a refresh that was given it and saved a draft.
    raise exception 'a wrap-up is folded into a refresh it was given to, once it saved a draft';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.studio_kit_suggestions_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a suggested edit is kept: decline it instead';
  end if;
  if tg_op = 'INSERT' then
    -- A kit never carries a name (040's studio_names_in_any: every film's cards).
    if public.studio_names_in_any(concat_ws(' ', new.suggestion, new.why, new.decided_note)) then
      raise exception 'a suggested edit keeps no names';
    end if;
    if new.status <> 'open' then
      raise exception 'a suggested edit starts open';
    end if;
    new.created_at := now();
    return new;
  end if;
  if row(new.kit_slug, new.kit_version, new.column_name, new.card_title, new.suggestion, new.why, new.created_by, new.created_at)
     is distinct from row(old.kit_slug, old.kit_version, old.column_name, old.card_title, old.suggestion, old.why, old.created_by, old.created_at) then
    raise exception 'suggested edit % stays as it was written', old.id;
  end if;
  if old.status <> 'open' then
    -- Only its run going (agent_runs on delete set null) changes it now.
    if row(new.status, new.decided_by, new.decided_at, new.decided_note) is distinct from row(old.status, old.decided_by, old.decided_at, old.decided_note)
       or new.folded_run_id is not null and new.folded_run_id is distinct from old.folded_run_id then
      raise exception 'suggested edit % was decided already', old.id;
    end if;
    return new;
  end if;
  if new.decided_note is not null and public.studio_names_in_any(new.decided_note) then
    raise exception 'a decision keeps no names';
  end if;
  if old.status = 'open' and new.status <> 'open' then
    new.decided_at := now();
    if new.status = 'declined' and public.studio_refresh_holds('suggestion', old.id, null, null) then
      raise exception 'a refresh is drawing on this suggested edit right now: decide when that run ends';
    end if;
    if new.status = 'folded' and (new.folded_run_id is null or not exists (
          select 1 from public.studio_refresh_sources x join public.studio_refresh_marks m on m.run_id = x.run_id
           where x.run_id = new.folded_run_id and x.kind = 'suggestion' and x.ref_id = new.id and m.outcome = 'drafted')) then
      raise exception 'a suggested edit is folded into a refresh it was given to, once it saved a draft';
    end if;
  end if;
  return new;
end $$;

create or replace function public.studio_label_marks_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- Only its run going (agent_runs on delete set null) touches it.
    raise exception 'a rule decision is kept';
  end if;
  if tg_op = 'UPDATE' then
    if new.run_id is null and old.run_id is not null and (to_jsonb(new) - 'run_id') = (to_jsonb(old) - 'run_id') then
      return new;
    end if;
    raise exception 'a rule decision is kept as it was made: decide again instead';
  end if;
  if public.studio_names_in_any(concat_ws(' ', new.label, new.note)) then
    raise exception 'a rule decision keeps no names';
  end if;
  -- Declined by a person; folded only into a refresh of the kit that was
  -- given it and saved a draft.
  if new.status = 'declined' and new.run_id is not null then
    raise exception 'a declined rule isn''t part of a refresh';
  end if;
  if new.status = 'folded' and (new.run_id is null or not exists (
       select 1 from public.studio_refresh_sources x join public.studio_refresh_marks m on m.run_id = x.run_id
        where x.run_id = new.run_id and x.kind = 'label' and x.label = new.label and m.kit_slug = new.kit_slug and m.outcome = 'drafted')) then
    raise exception 'a rule is folded into a refresh of its kit it was given to, once it saved a draft';
  end if;
  new.decided_at := now();
  return new;
end $$;

create or replace function public.studio_refresh_marks_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- Only with its run (agent_runs on delete cascade).
    if exists (select 1 from public.agent_runs where id = old.run_id) then
      raise exception 'a refresh mark is kept as it was made';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- How it ended, once; nothing else changes.
    if old.outcome is not null or new.outcome is null
       or row(new.run_id, new.kit_slug, new.kind, new.month, new.started_by, new.started_at)
          is distinct from row(old.run_id, old.kit_slug, old.kind, old.month, old.started_by, old.started_at) then
      raise exception 'a refresh mark is kept as it was made';
    end if;
    new.ended_at := now();
    return new;
  end if;
  new.started_at := now();
  new.month := date_trunc('month', now() at time zone 'America/Chicago')::date;
  new.outcome := null;
  new.ended_at := null;
  return new;
end $$;

create or replace function public.studio_refresh_sources_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- Only with its mark (its run deleted).
    if exists (select 1 from public.studio_refresh_marks where run_id = old.run_id) then
      raise exception 'what a refresh was given is kept';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'what a refresh was given is kept';
  end if;
  return new;
end $$;

create or replace trigger studio_film_wraps_gate before insert or update or delete on public.studio_film_wraps
  for each row execute function public.studio_film_wraps_gate();
create or replace trigger studio_kit_suggestions_gate before insert or update or delete on public.studio_kit_suggestions
  for each row execute function public.studio_kit_suggestions_gate();
create or replace trigger studio_label_marks_gate before insert or update or delete on public.studio_label_marks
  for each row execute function public.studio_label_marks_gate();
create or replace trigger studio_refresh_marks_gate before insert or update or delete on public.studio_refresh_marks
  for each row execute function public.studio_refresh_marks_gate();
create or replace trigger studio_refresh_sources_gate before insert or update or delete on public.studio_refresh_sources
  for each row execute function public.studio_refresh_sources_gate();
do $$
declare
  t text;
begin
  foreach t in array array['studio_film_wraps', 'studio_kit_suggestions', 'studio_label_marks', 'studio_refresh_marks', 'studio_refresh_sources'] loop
    execute format('create or replace trigger %I before truncate on public.%I for each statement execute function public.studio_keep()', t || '_keep', t);
  end loop;
end $$;

-- ── What the server calls ─────────────────────────────────────────────────
-- A kit's rules in the making: labels on its films' review notes, used three
-- times or more, never decided, or declined and used three more times since.
create or replace function public.studio_rule_candidates(p_slug text)
returns table (label text, notes int, films int, declined_before boolean, samples text[])
language sql stable set search_path = '' as $$
  with used as (
    select n.label, count(*)::int as notes, count(distinct n.film_id)::int as films,
           (array_agg(n.note order by n.created_at desc))[1:3] as samples
      from public.studio_notes n join public.studio_films f on f.id = n.film_id
     where f.kit_slug = p_slug and n.label is not null
     group by n.label
  ), latest as (
    select distinct on (m.label) m.label, m.status, m.uses_at
      from public.studio_label_marks m where m.kit_slug = p_slug
     order by m.label, m.decided_at desc, m.id
  )
  select u.label, u.notes, u.films, l.label is not null, u.samples
    from used u left join latest l on l.label = u.label
   where u.notes >= 3 and (l.label is null or (l.status = 'declined' and u.notes >= l.uses_at + 3))
   order by u.notes desc, u.label
$$;

-- A kit's open wrap-ups (not folded), with their films.
create or replace function public.studio_open_wraps(p_slug text)
returns table (id uuid, film_id uuid, worked text, missed text, change text, card_title text, created_by text, created_at timestamptz,
               athlete_id text, format text)
language sql stable set search_path = '' as $$
  select w.id, w.film_id, w.worked, w.missed, w.change, w.card_title, w.created_by, w.created_at, f.athlete_id, f.format
    from public.studio_film_wraps w join public.studio_films f on f.id = w.film_id
   where f.kit_slug = p_slug and w.folded_at is null
   order by w.created_at
   limit 200
$$;

-- A refresh still running: not ended, and not quiet for 90 minutes.
create or replace function public.studio_refresh_live(m public.studio_refresh_marks) returns boolean
language sql stable set search_path = '' as $$
  select m.outcome is null and m.started_at > now() - interval '90 minutes'
$$;

-- Whether a running refresh was given this wrap-up, suggested edit or (for
-- a kit) rule in the making: while it runs, those stay as it read them.
create or replace function public.studio_refresh_holds(p_kind text, p_ref uuid, p_slug text, p_label text) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.studio_refresh_sources s join public.studio_refresh_marks m on m.run_id = s.run_id
     where s.kind = p_kind and public.studio_refresh_live(m)
       and (case when p_kind = 'label' then s.label = p_label and m.kit_slug = p_slug else s.ref_id = p_ref end))
$$;

-- Start a refresh from what the team learned (a gear re-check, or the
-- month's): one of each at a time for a kit. The month's is given wrap-ups
-- (of the kit's films), suggested edits (to the kit) and rules in the making
-- (the kit's), each still open and in no other running refresh, or nothing
-- starts. A second one in a month only when asked for (p_again). Returns how
-- many it was given; with no run (p_run null), only checks it could start.
create or replace function public.studio_refresh_start(p_run uuid, p_slug text, p_kind text, p_by text,
                                                       p_wraps uuid[], p_suggestions uuid[], p_labels text[], p_again boolean)
returns table (given int)
language plpgsql volatile set search_path = '' as $$
declare
  w uuid[] := array(select distinct x from unnest(coalesce(p_wraps, '{}'::uuid[])) as x where x is not null order by x);
  sg uuid[] := array(select distinct x from unnest(coalesce(p_suggestions, '{}'::uuid[])) as x where x is not null order by x);
  lb text[] := array(select distinct lower(x) from unnest(coalesce(p_labels, '{}'::text[])) as x where x is not null order by 1);
  this_month date := date_trunc('month', now() at time zone 'America/Chicago')::date;
  n int := 0;
begin
  if p_kind not in ('monthly', 'gear') then
    raise exception 'a refresh is the month''s or a gear re-check';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio.refresh:' || p_slug, 0));
  if exists (select 1 from public.studio_refresh_marks m where m.kit_slug = p_slug and m.kind = p_kind and public.studio_refresh_live(m)) then
    raise exception '%', case when p_kind = 'gear' then 'a gear re-check is running already: open that run'
                              else 'this month''s refresh is running already: open that run' end;
  end if;
  if p_kind = 'monthly' then
    if not coalesce(p_again, false) and exists (
         select 1 from public.studio_refresh_marks m where m.kit_slug = p_slug and m.kind = 'monthly'
            and m.month = this_month and m.outcome in ('drafted', 'no_changes')) then
      raise exception 'this month''s refresh has run already: start another on purpose';
    end if;
    if cardinality(w) + cardinality(sg) + cardinality(lb) = 0 then
      raise exception 'a month''s refresh is given something: a wrap-up, a suggested edit or a rule in the making';
    end if;
    -- Held while it starts: an edit or a decision made meanwhile waits, then
    -- sees this refresh has them.
    perform 1 from public.studio_film_wraps x where x.id = any (w) order by x.id for share;
    perform 1 from public.studio_kit_suggestions x where x.id = any (sg) order by x.id for share;
    -- Each one still open, this kit's, and in no running refresh.
    if (select count(*) from public.studio_film_wraps x join public.studio_films f on f.id = x.film_id
         where x.id = any (w) and x.folded_at is null and f.kit_slug = p_slug
           and not public.studio_refresh_holds('wrap', x.id, null, null)) <> cardinality(w)
       or (select count(*) from public.studio_kit_suggestions x
            where x.id = any (sg) and x.status = 'open' and x.kit_slug = p_slug
              and not public.studio_refresh_holds('suggestion', x.id, null, null)) <> cardinality(sg)
       or (select count(*) from public.studio_rule_candidates(p_slug) c
            where c.label = any (lb) and not public.studio_refresh_holds('label', null, p_slug, c.label)) <> cardinality(lb) then
      raise exception 'some of what was picked isn''t open for this kit now (decided, folded, another kit''s, or picked up by another refresh meanwhile): open the month''s brief again';
    end if;
  end if;
  if p_kind = 'monthly' then
    n := cardinality(w) + cardinality(sg) + cardinality(lb);
  end if;
  if p_run is null then
    return query select n;
    return;
  end if;
  insert into public.studio_refresh_marks (run_id, kit_slug, kind, started_by) values (p_run, p_slug, p_kind, p_by);
  if p_kind = 'monthly' then
    insert into public.studio_refresh_sources (run_id, kind, ref_id) select p_run, 'wrap', x from unnest(w) as x;
    insert into public.studio_refresh_sources (run_id, kind, ref_id) select p_run, 'suggestion', x from unnest(sg) as x;
    insert into public.studio_refresh_sources (run_id, kind, label, uses)
    select p_run, 'label', c.label, c.notes from public.studio_rule_candidates(p_slug) c where c.label = any (lb);
  end if;
  return query select n;
end $$;

-- How a refresh ended. Only a month's refresh that saved a draft folds in
-- what it was given, each one that's still open, in one order (wrap-ups,
-- suggested edits, rules); one that can't be folded now (a name came on a
-- card since) is left open and counted. Returns { folded, skipped }.
create or replace function public.studio_refresh_end(p_run uuid, p_outcome text)
returns table (folded int, skipped int)
language plpgsql volatile set search_path = '' as $$
declare
  m public.studio_refresh_marks;
  x record;
  f int := 0;
  sk int := 0;
begin
  select * into m from public.studio_refresh_marks where run_id = p_run;
  if m.run_id is null then
    return query select 0, 0;
    return;
  end if;
  -- The kit's lock first (as a start takes it), then the mark.
  perform pg_advisory_xact_lock(hashtextextended('studio.refresh:' || m.kit_slug, 0));
  select * into m from public.studio_refresh_marks where run_id = p_run for update;
  if m.outcome is not null then
    raise exception 'that refresh has ended already';
  end if;
  update public.studio_refresh_marks set outcome = p_outcome where run_id = p_run;
  if m.kind = 'monthly' and p_outcome = 'drafted' then
    for x in select s.ref_id from public.studio_refresh_sources s where s.run_id = p_run and s.kind = 'wrap' order by s.ref_id loop
      begin
        update public.studio_film_wraps set folded_run_id = p_run, folded_at = now() where id = x.ref_id and folded_at is null;
        if found then f := f + 1; end if;
      exception when others then
        sk := sk + 1;
      end;
    end loop;
    for x in select s.ref_id from public.studio_refresh_sources s where s.run_id = p_run and s.kind = 'suggestion' order by s.ref_id loop
      begin
        update public.studio_kit_suggestions set status = 'folded', folded_run_id = p_run, decided_by = m.started_by
         where id = x.ref_id and status = 'open';
        if found then f := f + 1; end if;
      exception when others then
        sk := sk + 1;
      end;
    end loop;
    for x in select s.label, s.uses from public.studio_refresh_sources s where s.run_id = p_run and s.kind = 'label' order by s.label loop
      begin
        -- Still a rule in the making for this kit (not decided meanwhile).
        if exists (select 1 from public.studio_rule_candidates(m.kit_slug) c where c.label = x.label) then
          insert into public.studio_label_marks (kit_slug, label, status, uses_at, run_id, decided_by)
          values (m.kit_slug, x.label, 'folded', coalesce(x.uses, 0), p_run, m.started_by);
          f := f + 1;
        end if;
      exception when others then
        sk := sk + 1;
      end;
    end loop;
  end if;
  return query select f, sk;
end $$;

-- An approver declines a rule in the making for a kit, with a reason: a new
-- decision (the earlier ones are kept). Not while a running refresh has it.
create or replace function public.studio_label_decline(p_slug text, p_label text, p_note text, p_by text)
returns table (uses int)
language plpgsql volatile set search_path = '' as $$
declare
  n int;
begin
  perform pg_advisory_xact_lock(hashtextextended('studio.refresh:' || p_slug, 0));
  select c.notes into n from public.studio_rule_candidates(p_slug) c where c.label = p_label;
  if n is null then
    raise exception 'that label isn''t a rule in the making for this kit now (decided already, or not used three times)';
  end if;
  if public.studio_refresh_holds('label', null, p_slug, p_label) then
    raise exception 'a refresh is drawing on this rule right now: decide when that run ends';
  end if;
  insert into public.studio_label_marks (kit_slug, label, status, uses_at, note, decided_by)
  values (p_slug, p_label, 'declined', n, p_note, p_by);
  return query select n;
end $$;

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array[
    'public.studio_film_wraps_gate()', 'public.studio_kit_suggestions_gate()', 'public.studio_label_marks_gate()',
    'public.studio_refresh_marks_gate()', 'public.studio_refresh_sources_gate()', 'public.studio_rule_candidates(text)',
    'public.studio_open_wraps(text)', 'public.studio_refresh_live(public.studio_refresh_marks)',
    'public.studio_refresh_start(uuid, text, text, text, uuid[], uuid[], text[], boolean)', 'public.studio_refresh_end(uuid, text)',
    'public.studio_refresh_holds(text, uuid, text, text)', 'public.studio_label_decline(text, text, text, text)'] loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_film_wraps, public.studio_kit_suggestions, public.studio_label_marks, '
        'public.studio_refresh_marks, public.studio_refresh_sources from %I', r);
      execute format('revoke all on sequence public.studio_refresh_sources_id_seq from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke truncate, trigger, references on public.studio_film_wraps, public.studio_kit_suggestions, '
      'public.studio_label_marks, public.studio_refresh_marks, public.studio_refresh_sources from service_role';
    execute 'grant execute on function public.studio_rule_candidates(text), public.studio_open_wraps(text), '
      'public.studio_refresh_live(public.studio_refresh_marks), '
      'public.studio_refresh_start(uuid, text, text, text, uuid[], uuid[], text[], boolean), public.studio_refresh_end(uuid, text), '
      'public.studio_refresh_holds(text, uuid, text, text), public.studio_label_decline(text, text, text, text) to service_role';
  end if;
end $$;
