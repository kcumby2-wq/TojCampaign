-- 040: Studio craft (routes/studio-films.js, docs/studio-films.md): notes on
-- a cut at a timecode, with a label that can become a rule; the delivery
-- checks run on exported files; and stills and slides (a parent card, a quote
-- card, a carousel) going to speaker review like a video cut. Builds on 039.
-- Service role only.

-- ── Notes on a cut ────────────────────────────────────────────────────────
-- "Open on the fact", "music under the voice": a note says where (the cut and
-- the moment) and what. A label groups notes that say the same thing, so the
-- same note made three times can be proposed as a rule. The editor marks a
-- note done; a note is never rewritten or deleted. A note on a cut that's
-- then deleted (a cut never reviewed or posted can be) stays, with what the
-- cut was ("hero 9x16 v2") and no timecode.
create table if not exists public.studio_notes (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  cut_id uuid references public.studio_film_cuts(id) on delete set null,
  cut_label text check (cut_label is null or char_length(cut_label) between 1 and 60),
  at_ms int check (at_ms is null or at_ms between 0 and 36000000),
  note text not null check (char_length(btrim(note)) between 1 and 1000),
  label text check (label is null or (label = lower(label) and char_length(label) between 2 and 60 and label ~ '^[a-z0-9][a-z0-9 ''-]*[a-z0-9]$')),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text check (resolved_by is null or char_length(resolved_by) between 3 and 200),
  constraint studio_notes_resolved_whole check ((resolved_at is null) = (resolved_by is null)),
  constraint studio_notes_timecode_on_a_cut check (at_ms is null or cut_id is not null)
);
create index if not exists studio_notes_film_idx on public.studio_notes (film_id, created_at);
create index if not exists studio_notes_label_idx on public.studio_notes (label) where label is not null;
alter table public.studio_notes enable row level security;

-- ── Delivery checks ───────────────────────────────────────────────────────
-- What the browser read from an exported file (nothing uploads), checked by
-- the server against the kit's specs: length, size, the name pattern and
-- names kept out of file names. Kept as checked.
create table if not exists public.studio_delivery_checks (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  created_by text not null check (char_length(created_by) between 3 and 200),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name !~ '[/\\[:cntrl:]]'),
  format text not null check (format in ('hero', 'cutdown', 'sit_down', 'parent_card', 'quote_card', 'same_drill', 'own_words', 'on_the_mic')),
  ratio text not null check (ratio in ('9x16', '4x5', '1x1', '16x9')),
  duration_ms int check (duration_ms is null or duration_ms between 0 and 36000000),
  width int check (width is null or width between 1 and 20000),
  height int check (height is null or height between 1 and 20000),
  bytes bigint check (bytes is null or bytes > 0),
  passed boolean not null,
  results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  created_at timestamptz not null default now()
);
create index if not exists studio_delivery_checks_by_idx on public.studio_delivery_checks (created_by, created_at desc);
create index if not exists studio_delivery_checks_film_idx on public.studio_delivery_checks (film_id, created_at desc);

-- ── Stills and slides for review ──────────────────────────────────────────
-- A cut of kind 'slides' is 1 to 10 images (PNG or JPEG), in order: a parent
-- card is one, a carousel is five to seven. They were uploaded from the
-- editor's own tools, or made in the app with the graphics system (which
-- needs Kyron's approval first: the route checks it). The speakers watch
-- copies marked REVIEW COPY; the fingerprint they approve is of the files
-- themselves.
alter table public.studio_film_cuts add column if not exists made_with text
  check (made_with is null or made_with in ('upload', 'graphics'));

-- Where a set's files are is fixed by its film and its id, and never moves:
--   slides  films/<film>/slides/<id>/<n>.(png|jpg)
--   copies  films/<film>/previews/<id>-<the copies' fingerprint, 16>/<n>.jpg
-- (A video's are held by migration 039.)
create or replace function public.studio_film_cuts_files() returns trigger
language plpgsql set search_path = '' as $$
declare
  base text := format('films/%s/', new.film_id);
  i int;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'video' then
      if new.object_key is null or new.slide_keys is not null or new.made_with is not null then
        raise exception 'a video cut is one uploaded file';
      end if;
      return new;
    end if;
    if new.object_key is not null or new.made_with is null or new.slide_keys is null
       or cardinality(new.slide_keys) not between 1 and 10 then
      raise exception 'a set of slides is 1 to 10 images';
    end if;
    if new.made_with = 'graphics' and not public.studio_tool_on('graphics_system') then
      raise exception 'the graphics system is off: Kyron turns it on (Studio, Films, Tool approvals)';
    end if;
    for i in 1 .. cardinality(new.slide_keys) loop
      if new.slide_keys[i] is null
         or new.slide_keys[i] not in (format('%sslides/%s/%s.png', base, new.id, i), format('%sslides/%s/%s.jpg', base, new.id, i)) then
        raise exception 'slide % isn''t where this set keeps it', i;
      end if;
    end loop;
    return new;
  end if;
  if new.slide_keys is distinct from old.slide_keys or new.made_with is distinct from old.made_with then
    raise exception 'cut % keeps its files', old.id;
  end if;
  if new.kind = 'slides' and new.status = 'ready' and old.status <> 'ready' then
    if new.preview_sha256 is null or new.preview_key is distinct from format('%spreviews/%s-%s/', base, new.id, left(new.preview_sha256, 16))
       or new.poster_key is distinct from new.preview_key || '1.jpg' then
      raise exception 'cut %''s review copies are kept under their own fingerprint', old.id;
    end if;
  end if;
  return new;
end $$;

alter table public.studio_delivery_checks enable row level security;

create or replace function public.studio_notes_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  c public.studio_film_cuts;
begin
  if tg_op = 'DELETE' then
    raise exception 'a note is marked done, never deleted';
  end if;
  if tg_op = 'INSERT' then
    -- The film's row lock first (migration 039's order), then the cut.
    perform 1 from public.studio_films where id = new.film_id for update;
    if new.resolved_at is not null then
      raise exception 'a new note is open';
    end if;
    if new.cut_id is not null then
      select * into c from public.studio_film_cuts where id = new.cut_id and film_id = new.film_id;
      if c.id is null then
        raise exception 'a note is on one of its film''s cuts';
      end if;
      new.cut_label := format('%s %s v%s', c.format, c.ratio, c.version);
    else
      new.cut_label := null;
    end if;
    -- Notes are kept for good: no names in them (write the code instead).
    -- A label is shared by every film, so it's checked against every card.
    if public.studio_names_in(new.film_id, new.note) or public.studio_names_in_any(new.label) then
      raise exception 'notes keep no names: write the code instead';
    end if;
    new.created_at := now();
    return new;
  end if;
  -- Its cut was deleted: the note stays, without the cut or a timecode.
  if old.cut_id is not null and new.cut_id is null
     and not exists (select 1 from public.studio_film_cuts where id = old.cut_id) then
    new.at_ms := null;
  elsif new.cut_id is distinct from old.cut_id or new.at_ms is distinct from old.at_ms then
    raise exception 'note % stays as it was written', old.id;
  end if;
  if row(new.film_id, new.note, new.label, new.cut_label, new.created_by, new.created_at)
     is distinct from row(old.film_id, old.note, old.label, old.cut_label, old.created_by, old.created_at) then
    raise exception 'note % stays as it was written', old.id;
  end if;
  if new.resolved_at is distinct from old.resolved_at or new.resolved_by is distinct from old.resolved_by then
    if old.resolved_at is not null or new.resolved_by is null then
      raise exception 'note % is marked done once, by a named staff member', old.id;
    end if;
    new.resolved_at := now();
  end if;
  return new;
end $$;

-- Whether a text names someone on any film's cards for certain (a label is
-- shared by every film): migration 039's studio_names_in, across films.
create or replace function public.studio_names_in_any(p_text text) returns boolean
language sql stable set search_path = '' as $$
  select p_text is not null and exists (
    select 1 from (select distinct film_id from public.studio_film_people) as f
     where public.studio_names_in(f.film_id, p_text))
$$;

create or replace function public.studio_delivery_checks_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'a delivery check is kept as it was checked';
  end if;
  -- Kept for good: a file name with a name in it is kept without it.
  if public.studio_names_in(new.film_id, regexp_replace(new.file_name, '[_.-]+', ' ', 'g')) then
    new.file_name := '(a file name with a name in it)';
  end if;
  new.created_at := now();
  return new;
end $$;

-- The graphics system needs Kyron's yes (studio_tool_approvals, 039): a set
-- made with it isn't kept while it's off, no review link goes out for one,
-- and turning it off stops the live links for them (as review copies do).
create or replace function public.studio_reviews_graphics() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.studio_film_cuts c where c.id = new.cut_id and c.made_with = 'graphics')
     and not public.studio_tool_on('graphics_system') then
    raise exception 'the graphics system is off: no review links for sets made with it';
  end if;
  return new;
end $$;

create or replace function public.studio_tool_approvals_graphics() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tool = 'graphics_system' and old.is_on and not new.is_on then
    perform 1 from public.studio_films f
     where f.id in (select r.film_id from public.studio_reviews r join public.studio_film_cuts c on c.id = r.cut_id
                     where r.link_hash is not null and c.made_with = 'graphics')
     order by f.id for update;
    update public.studio_reviews r set link_hash = null, expires_at = null, changed_by = new.decided_by, updated_at = now()
     where r.link_hash is not null and r.cut_id in (select c.id from public.studio_film_cuts c where c.made_with = 'graphics');
  end if;
  return null;
end $$;

-- Delete a cut never reviewed or posted (039's gate says which), film first:
-- a note being added to it takes the film first too.
create or replace function public.studio_cut_remove(p_cut uuid)
returns setof public.studio_film_cuts
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_film_cuts where id = p_cut);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query delete from public.studio_film_cuts c where c.id = p_cut returning c.*;
end $$;

-- (The list of every file a cut keeps, a set's copies included, is 039's
-- studio_cut_files: one definition, so running 039 again loses nothing.)

create or replace trigger studio_film_cuts_files before insert or update on public.studio_film_cuts
  for each row execute function public.studio_film_cuts_files();
create or replace trigger studio_notes_gate before insert or update or delete on public.studio_notes
  for each row execute function public.studio_notes_gate();
create or replace trigger studio_delivery_checks_gate before insert or update or delete on public.studio_delivery_checks
  for each row execute function public.studio_delivery_checks_gate();
create or replace trigger studio_delivery_checks_keep before truncate on public.studio_delivery_checks
  for each statement execute function public.studio_delivery_checks_gate();
create or replace trigger studio_notes_keep before truncate on public.studio_notes
  for each statement execute function public.studio_keep();
create or replace trigger studio_reviews_graphics before insert on public.studio_reviews
  for each row execute function public.studio_reviews_graphics();
create or replace trigger studio_tool_approvals_graphics after update on public.studio_tool_approvals
  for each row execute function public.studio_tool_approvals_graphics();

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array['public.studio_notes_gate()', 'public.studio_delivery_checks_gate()', 'public.studio_film_cuts_files()',
                            'public.studio_names_in_any(text)', 'public.studio_reviews_graphics()', 'public.studio_tool_approvals_graphics()',
                            'public.studio_cut_remove(uuid)'] loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_notes, public.studio_delivery_checks from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Rows only, as for 039's tables.
    execute 'revoke truncate, trigger, references on public.studio_notes, public.studio_delivery_checks from service_role';
    execute 'grant execute on function public.studio_names_in_any(text), public.studio_cut_remove(uuid) to service_role';
  end if;
end $$;
