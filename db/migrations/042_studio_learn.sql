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
--     marked, so Today knows what's due.

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
create table if not exists public.studio_label_marks (
  label text primary key check (label = lower(label) and char_length(label) between 2 and 60),
  status text not null check (status in ('folded', 'declined')),
  -- How many notes had it when it was decided: a declined one comes back
  -- after three more.
  uses_at int not null check (uses_at >= 0),
  run_id uuid references public.agent_runs(id) on delete set null,
  note text check (note is null or char_length(btrim(note)) between 3 and 300),
  decided_by text not null check (char_length(decided_by) between 3 and 200),
  decided_at timestamptz not null default now(),
  constraint studio_label_marks_declined_why check (status <> 'declined' or note is not null)
);
alter table public.studio_label_marks enable row level security;

-- ── Refreshes started from what the team learned ─────────────────────────
create table if not exists public.studio_refresh_marks (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  kit_slug text not null check (kit_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  kind text not null check (kind in ('monthly', 'gear')),
  month date not null check (extract(day from month) = 1),
  started_by text not null check (char_length(started_by) between 3 and 200),
  started_at timestamptz not null default now()
);
create index if not exists studio_refresh_marks_kind_idx on public.studio_refresh_marks (kit_slug, kind, started_at desc);
alter table public.studio_refresh_marks enable row level security;

-- ── Gates ─────────────────────────────────────────────────────────────────
create or replace function public.studio_film_wraps_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.folded_at is not null then
      raise exception 'a wrap-up folded into a refresh is kept';
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
  end if;
  -- No names: the history's rule (039's studio_names_in, film by film).
  if public.studio_names_in(new.film_id, concat_ws(' ', new.worked, new.missed, new.change, new.card_title)) then
    raise exception 'wrap-ups keep no names: write the code instead';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.folded_run_id := null;
    new.folded_at := null;
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
    if public.studio_names_in_any(concat_ws(' ', new.suggestion, new.why)) then
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
  if old.status = 'open' and new.status <> 'open' then
    new.decided_at := now();
    if new.decided_note is not null and public.studio_names_in_any(new.decided_note) then
      raise exception 'a decision keeps no names';
    end if;
  end if;
  return new;
end $$;

create or replace function public.studio_label_marks_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a rule decision is kept';
  end if;
  if tg_op = 'UPDATE' and new.run_id is null and old.run_id is not null
     and row(new.label, new.status, new.uses_at, new.note, new.decided_by) is not distinct from row(old.label, old.status, old.uses_at, old.note, old.decided_by) then
    return new;
  end if;
  if new.note is not null and public.studio_names_in_any(new.note) then
    raise exception 'a rule decision keeps no names';
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
  if tg_op <> 'INSERT' then
    raise exception 'a refresh mark is kept as it was made';
  end if;
  new.started_at := now();
  new.month := date_trunc('month', now() at time zone 'America/Chicago')::date;
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
do $$
declare
  t text;
begin
  foreach t in array array['studio_film_wraps', 'studio_kit_suggestions', 'studio_label_marks', 'studio_refresh_marks'] loop
    execute format('create or replace trigger %I before truncate on public.%I for each statement execute function public.studio_keep()', t || '_keep', t);
  end loop;
end $$;

-- ── What the server calls ─────────────────────────────────────────────────
-- A refresh started from what the team learned: mark it, and fold in the
-- wrap-ups (of that kit's films), suggested edits (to that kit) and rules
-- in the making it drew on, each once. Returns how many were folded.
create or replace function public.studio_refresh_fold(p_run uuid, p_slug text, p_kind text, p_by text,
                                                      p_wraps uuid[], p_suggestions uuid[], p_labels text[], p_label_uses int[])
returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int := 0;
  k int;
begin
  insert into public.studio_refresh_marks (run_id, kit_slug, kind, month, started_by)
  values (p_run, p_slug, p_kind, date_trunc('month', now())::date, p_by);
  if p_kind <> 'monthly' then
    return 0;
  end if;
  update public.studio_film_wraps w set folded_run_id = p_run, folded_at = now()
   where w.id = any (coalesce(p_wraps, '{}'::uuid[])) and w.folded_at is null
     and exists (select 1 from public.studio_films f where f.id = w.film_id and f.kit_slug = p_slug);
  get diagnostics k = row_count;
  n := n + k;
  update public.studio_kit_suggestions s set status = 'folded', folded_run_id = p_run, decided_by = p_by, decided_at = now()
   where s.id = any (coalesce(p_suggestions, '{}'::uuid[])) and s.status = 'open' and s.kit_slug = p_slug;
  get diagnostics k = row_count;
  n := n + k;
  insert into public.studio_label_marks (label, status, uses_at, run_id, decided_by)
  select l.label, 'folded', coalesce(l.uses, 0), p_run, p_by
    from unnest(coalesce(p_labels, '{}'::text[]), coalesce(p_label_uses, '{}'::int[])) as l(label, uses)
   where l.label is not null
  on conflict (label) do update set status = 'folded', uses_at = excluded.uses_at, run_id = excluded.run_id, note = null,
                                    decided_by = excluded.decided_by;
  get diagnostics k = row_count;
  n := n + k;
  return n;
end $$;

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array[
    'public.studio_film_wraps_gate()', 'public.studio_kit_suggestions_gate()', 'public.studio_label_marks_gate()',
    'public.studio_refresh_marks_gate()', 'public.studio_refresh_fold(uuid, text, text, text, uuid[], uuid[], text[], int[])'] loop
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
        'public.studio_refresh_marks from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke truncate, trigger, references on public.studio_film_wraps, public.studio_kit_suggestions, '
      'public.studio_label_marks, public.studio_refresh_marks from service_role';
    execute 'grant execute on function public.studio_refresh_fold(uuid, text, text, text, uuid[], uuid[], text[], int[]) to service_role';
  end if;
end $$;
