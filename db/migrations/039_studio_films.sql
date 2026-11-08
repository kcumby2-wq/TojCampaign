-- 039: Studio films. A room for every film made from a Studio kit
-- (routes/studio-films.js, routes/studio-review.js, public/film-review.html;
-- docs/studio-films.md).
--
-- A kit (migration 018) is the playbook. A film is one piece of work made
-- from it, and the kit's ten steps become that film's steps, each with its
-- owner. The rules the kit asks people to follow by hand are held here:
--
--   * One step at a time, in the kit's order. "No card, no shoot": the
--     clearance step needs a cleared card for everyone on camera, and the
--     shoot needs them still cleared.
--   * A speaker approves their own cut (a minor's parent or guardian does),
--     on a one-time review link that expires. The link carries a token; the
--     server turns it into a proof (sha256 of the token) and the table keeps
--     only sha256 of the proof, so nothing that can read the table can
--     decide. The approval is for that exact file (its sha256).
--   * Nothing is posted before the final sign-off, and only cuts every
--     speaker in them approved, with everyone in them cleared.
--   * The clip log: every cut lists who is in it. A pulled consent pulls the
--     film: every film the person is in stops, every live post of those films
--     goes on a takedown list, and the 72-hour clock starts.
--   * New tools that touch footage stay off until the producer checks their
--     terms and turns them on, with a one-line reason (the kit's own rule).
--   * Everything above is written to studio_events by the database itself,
--     and that history is never changed. Staff add notes.
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated.

-- ── Tools the producer approves ───────────────────────────────────────────
create table if not exists public.studio_tool_approvals (
  tool text primary key check (tool in ('review_copies', 'claude_transcripts', 'graphics_system')),
  is_on boolean not null default false,
  decided_by text check (decided_by is null or char_length(decided_by) between 3 and 200),
  decided_at timestamptz,
  note text check (note is null or char_length(note) between 1 and 500),
  updated_at timestamptz not null default now(),
  constraint studio_tool_approvals_decided check ((decided_at is null) = (decided_by is null)),
  constraint studio_tool_approvals_on_has_reason check (not is_on or (decided_at is not null and note is not null))
);
insert into public.studio_tool_approvals (tool)
select v.tool from (values ('review_copies'), ('claude_transcripts'), ('graphics_system')) as v(tool)
 where not exists (select 1 from public.studio_tool_approvals a where a.tool = v.tool);
alter table public.studio_tool_approvals enable row level security;

-- ── Films ─────────────────────────────────────────────────────────────────
create table if not exists public.studio_films (
  id uuid primary key default gen_random_uuid(),
  kit_slug text not null check (kit_slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  kit_id text not null check (char_length(kit_id) between 1 and 80),
  kit_version int not null check (kit_version >= 1),
  -- A working title. Never a person's name (the route checks it against the
  -- film's cards): projects carry the athlete ID, as the kit says.
  title text not null check (char_length(btrim(title)) between 1 and 120),
  lane text not null check (lane in ('nfl', 'college', 'youth', 'parent')),
  athlete_id text not null check (athlete_id ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  format text not null check (format in ('hero', 'cutdown', 'sit_down', 'parent_card', 'quote_card', 'same_drill', 'own_words', 'on_the_mic')),
  one_sentence text check (one_sentence is null or char_length(btrim(one_sentence)) between 1 and 300),
  post_date date,
  board_url text check (board_url is null or (board_url ~ '^https://[^\s]+$' and char_length(board_url) <= 500)),
  -- The board's structured parts (references, the speaker, quotes and
  -- questions, must-have shots, the frame pair, schedule): utils/studio-films.js.
  plan jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object'),
  director_email text check (director_email is null or (director_email = lower(director_email) and director_email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$')),
  editor_email text check (editor_email is null or (editor_email = lower(editor_email) and editor_email ~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$')),
  -- Who else signs off with the producer (Same Work: Coach Hooks). Set from
  -- the kit's film template when the film starts.
  second_yes_label text check (second_yes_label is null or char_length(second_yes_label) between 2 and 80),
  gfs_event_id uuid,
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text check (archived_by is null or char_length(archived_by) between 3 and 200),
  -- A pulled consent pulls the film, for good.
  pulled_at timestamptz,
  constraint studio_films_archived_whole check ((archived_at is null) = (archived_by is null))
);
create index if not exists studio_films_active_idx on public.studio_films (archived_at, created_at desc);
alter table public.studio_films enable row level security;

-- ── The ten steps ─────────────────────────────────────────────────────────
create table if not exists public.studio_film_steps (
  film_id uuid not null references public.studio_films(id) on delete restrict,
  step text not null check (step in ('brief', 'board', 'clearance', 'shoot', 'selects', 'rough_cut', 'speaker_review', 'rights_check', 'final_signoff', 'publish')),
  position smallint not null check (position between 1 and 10),
  status text not null default 'todo' check (status in ('todo', 'done')),
  done_at timestamptz,
  done_by text check (done_by is null or char_length(done_by) between 3 and 200),
  -- The staff member behind a reopen (for the history).
  changed_by text check (changed_by is null or char_length(changed_by) between 3 and 200),
  note text check (note is null or char_length(note) between 1 and 500),
  -- Speaker review onward: the cut every speaker in it approved.
  cut_id uuid,
  second_yes_by text check (second_yes_by is null or char_length(second_yes_by) between 2 and 200),
  second_yes_at timestamptz,
  second_yes_note text check (second_yes_note is null or char_length(second_yes_note) between 1 and 300),
  updated_at timestamptz not null default now(),
  primary key (film_id, step),
  unique (film_id, position),
  constraint studio_film_steps_done_whole check ((status = 'done') = (done_at is not null) and (done_at is null) = (done_by is null)),
  constraint studio_film_steps_second_yes check (step = 'final_signoff' or (second_yes_by is null and second_yes_at is null and second_yes_note is null)),
  constraint studio_film_steps_second_yes_whole check ((second_yes_by is null) = (second_yes_at is null))
);
alter table public.studio_film_steps enable row level security;

-- ── The clearance cards ───────────────────────────────────────────────────
create table if not exists public.studio_film_people (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  -- The same person has the same code in every film (the athlete ID; a
  -- parent adds -P1): that's how a pulled consent finds every film.
  person_code text not null check (person_code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  role text not null check (role in ('athlete', 'parent', 'guardian', 'coach', 'other')),
  is_minor boolean not null default false,
  texas_youth boolean not null default false,
  -- Their words are in the film: they approve the cut (a minor's parent or
  -- guardian does).
  speaker boolean not null default false,
  release_on_file boolean not null default false,
  -- What the release covers: face, name, jersey, voice, and which formats.
  covers jsonb not null default '{}'::jsonb check (jsonb_typeof(covers) = 'object'),
  reviewer_relation text check (reviewer_relation is null or reviewer_relation in ('self', 'parent', 'guardian')),
  reviewer_name text check (reviewer_name is null or char_length(btrim(reviewer_name)) between 2 and 80),
  reviewer_email text check (reviewer_email is null or (reviewer_email = lower(reviewer_email) and char_length(reviewer_email) between 3 and 200
    and reviewer_email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$')),
  cleared_at timestamptz,
  cleared_by text check (cleared_by is null or char_length(cleared_by) between 3 and 200),
  changed_by text check (changed_by is null or char_length(changed_by) between 3 and 200),
  consent_pulled_at timestamptz,
  pulled_by text check (pulled_by is null or char_length(pulled_by) between 3 and 200),
  pulled_note text check (pulled_note is null or char_length(pulled_note) between 1 and 500),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (film_id, person_code),
  constraint studio_film_people_cleared_whole check ((cleared_at is null) = (cleared_by is null)),
  constraint studio_film_people_cleared_release check (cleared_at is null or release_on_file),
  constraint studio_film_people_pulled_whole check ((consent_pulled_at is null) = (pulled_by is null)),
  -- Texas youth athletes appear only unidentifiable until counsel clears it:
  -- no face, no name, no jersey number.
  constraint studio_film_people_texas_youth check (not texas_youth or (is_minor
    and coalesce(covers->>'face', 'false') = 'false' and coalesce(covers->>'name', 'false') = 'false'
    and coalesce(covers->>'jersey', 'false') = 'false')),
  -- An adult approves their own cut; a minor's parent or legal guardian does.
  constraint studio_film_people_reviewer check (reviewer_relation is null
    or (is_minor and reviewer_relation in ('parent', 'guardian'))
    or (not is_minor and reviewer_relation = 'self')),
  constraint studio_film_people_reviewer_whole check ((reviewer_relation is null) = (reviewer_email is null) and (reviewer_email is null) = (reviewer_name is null)),
  -- A speaker's card names who approves before it's cleared.
  constraint studio_film_people_speaker_reviewer check (not speaker or cleared_at is null or reviewer_email is not null)
);
create index if not exists studio_film_people_code_idx on public.studio_film_people (person_code);
alter table public.studio_film_people enable row level security;

-- ── Cuts and the clip log ─────────────────────────────────────────────────
create table if not exists public.studio_film_cuts (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  kind text not null default 'video' check (kind in ('video', 'slides')),
  format text not null check (format in ('hero', 'cutdown', 'sit_down', 'parent_card', 'quote_card', 'same_drill', 'own_words', 'on_the_mic')),
  ratio text not null check (ratio in ('9x16', '4x5', '1x1', '16x9')),
  version int not null check (version between 1 and 999),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name !~ '[/\\[:cntrl:]]'),
  -- The clip log: everyone in this cut (cards on this film).
  people uuid[] not null default '{}',
  object_key text check (object_key is null or object_key ~ '^films/[0-9a-f-]{36}/cuts/[0-9a-f-]{36}\.(mp4|mov|m4v)$'),
  preview_key text check (preview_key is null or char_length(preview_key) <= 200),
  poster_key text check (poster_key is null or char_length(poster_key) <= 200),
  slide_keys text[],
  bytes bigint check (bytes is null or bytes > 0),
  duration_ms int check (duration_ms is null or duration_ms >= 0),
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  -- The fingerprint of the file the speakers watch, set when it's ready.
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  error text check (error is null or char_length(error) <= 500),
  attempts int not null default 0 check (attempts between 0 and 10),
  claimed_at timestamptz,
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (film_id, format, ratio, version),
  constraint studio_film_cuts_ready check (status <> 'ready' or (sha256 is not null and (kind = 'slides' or (preview_key is not null and duration_ms is not null))))
);
create index if not exists studio_film_cuts_film_idx on public.studio_film_cuts (film_id, created_at);
create index if not exists studio_film_cuts_work_idx on public.studio_film_cuts (status, created_at) where status in ('uploaded', 'processing');
alter table public.studio_film_cuts enable row level security;

-- ── Speaker review links ──────────────────────────────────────────────────
create table if not exists public.studio_reviews (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  cut_id uuid not null references public.studio_film_cuts(id) on delete restrict,
  person_id uuid not null references public.studio_film_people(id) on delete restrict,
  reviewer_email text not null check (char_length(reviewer_email) between 3 and 200),
  reviewer_relation text not null check (reviewer_relation in ('self', 'parent', 'guardian')),
  -- sha256 of the link's proof, while the link is out.
  link_hash text unique check (link_hash is null or link_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default now(),
  expires_at timestamptz,
  -- The file the link was for (the cut's sha256 when it went out).
  asked_fingerprint text not null check (asked_fingerprint ~ '^[0-9a-f]{64}$'),
  asked_by text not null check (char_length(asked_by) between 3 and 200),
  changed_by text check (changed_by is null or char_length(changed_by) between 3 and 200),
  decision text check (decision is null or decision in ('approved', 'changes')),
  decided_at timestamptz,
  decided_name text check (decided_name is null or char_length(decided_name) between 2 and 200),
  note text check (note is null or char_length(note) between 1 and 1000),
  approved_fingerprint text check (approved_fingerprint is null or approved_fingerprint ~ '^[0-9a-f]{64}$'),
  -- The speaker took their yes back (they told the producer).
  withdrawn_at timestamptz,
  withdrawn_by text check (withdrawn_by is null or char_length(withdrawn_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_reviews_link_whole check ((link_hash is null) = (expires_at is null)),
  constraint studio_reviews_decision_whole check ((decision is null) = (decided_at is null) and (decision is null) = (decided_name is null)),
  constraint studio_reviews_approved check ((decision is not distinct from 'approved') = (approved_fingerprint is not null)),
  constraint studio_reviews_withdrawn check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null or decision = 'approved'))
);
create unique index if not exists studio_reviews_one_live_link on public.studio_reviews (cut_id, person_id) where link_hash is not null;
create index if not exists studio_reviews_cut_idx on public.studio_reviews (cut_id, person_id);
create index if not exists studio_reviews_film_idx on public.studio_reviews (film_id, created_at);
alter table public.studio_reviews enable row level security;

-- ── Where it was posted ───────────────────────────────────────────────────
create table if not exists public.studio_film_posts (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  cut_id uuid not null references public.studio_film_cuts(id) on delete restrict,
  platform text not null check (platform in ('instagram', 'tiktok', 'youtube', 'facebook', 'x', 'threads', 'other')),
  url text not null check (url ~ '^https://[^\s]+$' and char_length(url) <= 500),
  posted_at timestamptz not null default now(),
  posted_by text not null check (char_length(posted_by) between 3 and 200),
  removed_at timestamptz,
  removed_by text check (removed_by is null or char_length(removed_by) between 3 and 200),
  created_at timestamptz not null default now(),
  constraint studio_film_posts_removed_whole check ((removed_at is null) = (removed_by is null))
);
create index if not exists studio_film_posts_film_idx on public.studio_film_posts (film_id);
alter table public.studio_film_posts enable row level security;

-- ── Takedowns: the 72-hour clock ──────────────────────────────────────────
create table if not exists public.studio_takedowns (
  id uuid primary key default gen_random_uuid(),
  person_code text not null check (person_code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  requested_at timestamptz not null default now(),
  due_at timestamptz not null default (now() + interval '72 hours'),
  source text not null default 'staff' check (source in ('staff', 'speaker')),
  requested_by text not null check (char_length(requested_by) between 3 and 200),
  note text check (note is null or char_length(note) between 1 and 500),
  closed_at timestamptz,
  closed_by text check (closed_by is null or char_length(closed_by) between 3 and 200),
  constraint studio_takedowns_closed_whole check ((closed_at is null) = (closed_by is null))
);
create index if not exists studio_takedowns_open_idx on public.studio_takedowns (person_code) where closed_at is null;
alter table public.studio_takedowns enable row level security;

create table if not exists public.studio_takedown_items (
  id uuid primary key default gen_random_uuid(),
  takedown_id uuid not null references public.studio_takedowns(id) on delete restrict,
  film_id uuid not null references public.studio_films(id) on delete restrict,
  -- A live post, or everything outside the app for that film (drives, the
  -- Milanote board, the editor's machine), or something staff add.
  what text not null check (what in ('post', 'elsewhere', 'other')),
  post_id uuid references public.studio_film_posts(id) on delete restrict,
  label text check (label is null or char_length(label) between 1 and 200),
  done_at timestamptz,
  done_by text check (done_by is null or char_length(done_by) between 3 and 200),
  note text check (note is null or char_length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  constraint studio_takedown_items_done_whole check ((done_at is null) = (done_by is null)),
  constraint studio_takedown_items_shape check ((what = 'post') = (post_id is not null) and (what <> 'other' or label is not null))
);
create unique index if not exists studio_takedown_items_post on public.studio_takedown_items (takedown_id, post_id) where post_id is not null;
create unique index if not exists studio_takedown_items_elsewhere on public.studio_takedown_items (takedown_id, film_id) where what = 'elsewhere';
alter table public.studio_takedown_items enable row level security;

-- ── The history ───────────────────────────────────────────────────────────
create table if not exists public.studio_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  film_id uuid references public.studio_films(id) on delete restrict,
  kind text not null check (kind in (
    'tool_on', 'tool_off',
    'film_created', 'film_archived', 'film_unarchived', 'film_pulled',
    'step_done', 'step_reopened', 'second_yes',
    'person_added', 'person_cleared', 'person_uncleared', 'consent_pulled',
    'cut_added', 'cut_ready', 'cut_failed',
    'review_asked', 'review_approved', 'review_changes', 'review_link_cancelled', 'review_withdrawn',
    'posted', 'post_removed',
    'takedown_opened', 'takedown_item_done', 'takedown_closed',
    'note')),
  by_staff text check (by_staff is null or char_length(by_staff) between 1 and 200),
  by_reviewer text check (by_reviewer is null or char_length(by_reviewer) between 2 and 200),
  -- A step, a person code, a cut, a platform, a tool. Never a name.
  subject text check (subject is null or char_length(subject) between 1 and 120),
  note text check (note is null or char_length(note) between 1 and 1000),
  ref uuid
);
create index if not exists studio_events_film_idx on public.studio_events (film_id, at);
alter table public.studio_events enable row level security;

-- ── Helpers ───────────────────────────────────────────────────────────────
-- A cut is approved when it's ready, has a speaker in it, everyone in it is
-- cleared and nobody in it has pulled consent, and every speaker in it said
-- yes to this exact file and still does.
create or replace function public.studio_cut_approved(p_cut uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.studio_film_cuts c
     where c.id = p_cut and c.status = 'ready' and c.sha256 is not null
       and exists (select 1 from public.studio_film_people p where p.id = any (c.people) and p.speaker and p.film_id = c.film_id)
       and not exists (
         select 1 from unnest(c.people) as u(pid)
           left join public.studio_film_people p on p.id = u.pid
          where p.id is null or p.film_id <> c.film_id or p.cleared_at is null or p.consent_pulled_at is not null)
       and not exists (
         select 1 from public.studio_film_people p
          where p.id = any (c.people) and p.speaker
            and not exists (
              select 1 from public.studio_reviews r
               where r.cut_id = c.id and r.person_id = p.id and r.decision = 'approved'
                 and r.withdrawn_at is null and r.approved_fingerprint = c.sha256))
  )
$$;

create or replace function public.studio_tool_on(p_tool text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select is_on from public.studio_tool_approvals where tool = p_tool), false)
$$;

-- ── Gates ─────────────────────────────────────────────────────────────────
create or replace function public.studio_tool_approvals_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'the approved-tools list has its three tools, kept for good';
  end if;
  if new.tool <> old.tool then
    raise exception 'a tool keeps its name';
  end if;
  if new.is_on is distinct from old.is_on or new.note is distinct from old.note then
    if new.decided_by is null then
      raise exception 'who decided about %', old.tool;
    end if;
    if new.is_on and new.note is null then
      raise exception 'turning on % needs a one-line reason: what you checked', old.tool;
    end if;
    new.decided_at := now();
  else
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.studio_films_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a film is archived, not deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.pulled_at is not null or new.archived_at is not null then
      raise exception 'a new film starts active';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.kit_slug <> old.kit_slug or new.kit_id <> old.kit_id or new.kit_version <> old.kit_version
     or new.created_by <> old.created_by or new.created_at <> old.created_at
     or new.second_yes_label is distinct from old.second_yes_label then
    raise exception 'film % keeps its kit, its author and its sign-offs', old.id;
  end if;
  if old.pulled_at is not null then
    if new.pulled_at is distinct from old.pulled_at then
      raise exception 'film % was pulled, for good', old.id;
    end if;
    if row(new.title, new.lane, new.athlete_id, new.format, new.one_sentence, new.post_date, new.board_url, new.plan,
           new.director_email, new.editor_email, new.gfs_event_id)
       is distinct from row(old.title, old.lane, old.athlete_id, old.format, old.one_sentence, old.post_date, old.board_url, old.plan,
           old.director_email, old.editor_email, old.gfs_event_id) then
      raise exception 'film % was pulled: it changes no more', old.id;
    end if;
  elsif new.pulled_at is not null then
    new.pulled_at := now();
  end if;
  if new.athlete_id <> old.athlete_id and exists (
       select 1 from public.studio_film_steps s where s.film_id = old.id and s.step = 'clearance' and s.status = 'done') then
    raise exception 'film % was cleared: its athlete ID stays', old.id;
  end if;
  if new.archived_at is distinct from old.archived_at then
    if new.archived_at is not null and old.archived_at is null then
      if new.archived_by is null then raise exception 'who archived film %', old.id; end if;
      new.archived_at := now();
    elsif new.archived_at is null then
      new.archived_by := null;
    else
      raise exception 'film % was archived at %', old.id, old.archived_at;
    end if;
  end if;
  return new;
end $$;

create or replace function public.studio_film_steps_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films%rowtype;
  prev text;
  later text;
  approved_cut uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'a film keeps its ten steps';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'todo' or new.done_at is not null or new.done_by is not null or new.cut_id is not null
       or new.second_yes_by is not null or new.second_yes_at is not null then
      raise exception 'a film step starts as to do';
    end if;
    return new;
  end if;

  if new.film_id <> old.film_id or new.step <> old.step or new.position <> old.position then
    raise exception 'a step keeps its film and its place';
  end if;
  select * into f from public.studio_films where id = new.film_id;

  -- A done step stays as it was; only a reopen changes it.
  if old.status = 'done' and new.status = 'done' then
    if row(new.done_at, new.done_by, new.note, new.cut_id, new.second_yes_by, new.second_yes_at, new.second_yes_note)
       is distinct from row(old.done_at, old.done_by, old.note, old.cut_id, old.second_yes_by, old.second_yes_at, old.second_yes_note) then
      raise exception 'the % step is done: reopen it to change it', old.step;
    end if;
    return new;
  end if;

  -- Still to do: a note, and the second yes for the final sign-off.
  if old.status = 'todo' and new.status = 'todo' then
    if new.done_at is not null or new.done_by is not null or new.cut_id is distinct from old.cut_id then
      raise exception 'the % step is still to do', old.step;
    end if;
    if new.second_yes_by is distinct from old.second_yes_by or new.second_yes_note is distinct from old.second_yes_note then
      if f.pulled_at is not null or f.archived_at is not null then
        raise exception 'film % is closed', f.id;
      end if;
      new.second_yes_at := case when new.second_yes_by is null then null else now() end;
    else
      new.second_yes_at := old.second_yes_at;
    end if;
    return new;
  end if;

  -- Reopen: the last done step only (later ones first), never the publish.
  if old.status = 'done' and new.status = 'todo' then
    if old.step = 'publish' then
      raise exception 'a published film is taken down, not reopened';
    end if;
    select status into later from public.studio_film_steps where film_id = new.film_id and position = new.position + 1;
    if later = 'done' then
      raise exception 'reopen the later steps first';
    end if;
    if new.changed_by is null or new.note is null then
      raise exception 'reopening the % step needs who and why', old.step;
    end if;
    new.done_at := null;
    new.done_by := null;
    new.cut_id := null;
    if new.step = 'final_signoff' then
      new.second_yes_by := null;
      new.second_yes_at := null;
      new.second_yes_note := null;
    end if;
    return new;
  end if;

  -- To do → done.
  if f.pulled_at is not null then
    raise exception 'consent was pulled: film % is pulled', f.id;
  end if;
  if f.archived_at is not null then
    raise exception 'film % is archived', f.id;
  end if;
  if new.done_by is null then
    raise exception 'who did the % step', new.step;
  end if;
  if new.position > 1 then
    select status into prev from public.studio_film_steps where film_id = new.film_id and position = new.position - 1;
    if prev is distinct from 'done' then
      raise exception 'one step at a time: the step before % comes first', new.step;
    end if;
  end if;
  new.done_at := now();
  new.changed_by := null;

  if new.step = 'brief' then
    if f.one_sentence is null then
      raise exception 'the brief needs the one-sentence story';
    end if;
  elsif new.step in ('clearance', 'shoot') then
    if not exists (select 1 from public.studio_film_people p where p.film_id = f.id) then
      raise exception 'no card, no shoot: add everyone who will be on camera';
    end if;
    if exists (select 1 from public.studio_film_people p where p.film_id = f.id and (p.cleared_at is null or p.consent_pulled_at is not null)) then
      raise exception 'no card, no shoot: everyone on camera needs a cleared card';
    end if;
  elsif new.step = 'speaker_review' then
    if new.cut_id is null or not exists (select 1 from public.studio_film_cuts c where c.id = new.cut_id and c.film_id = f.id) then
      raise exception 'which of this film''s cuts did the speakers approve?';
    end if;
    if not public.studio_cut_approved(new.cut_id) then
      raise exception 'every speaker in that cut has to say yes to it first';
    end if;
  elsif new.step in ('rights_check', 'final_signoff', 'publish') then
    select s.cut_id into approved_cut from public.studio_film_steps s where s.film_id = f.id and s.step = 'speaker_review';
    new.cut_id := approved_cut;
    if approved_cut is null or not public.studio_cut_approved(approved_cut) then
      raise exception 'the approved cut is no longer approved: a speaker took it back or a card changed';
    end if;
    if new.step = 'final_signoff' and f.second_yes_label is not null and new.second_yes_at is null then
      raise exception '% says yes too, or it waits', f.second_yes_label;
    end if;
    if new.step = 'publish' and not exists (select 1 from public.studio_film_posts p where p.film_id = f.id and p.removed_at is null) then
      raise exception 'record where it went out first';
    end if;
  else
    new.cut_id := null;
  end if;
  return new;
end $$;

create or replace function public.studio_film_people_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films%rowtype;
  card_changed boolean;
begin
  if tg_op = 'DELETE' then
    if old.cleared_at is not null or old.consent_pulled_at is not null
       or exists (select 1 from public.studio_film_cuts c where c.film_id = old.film_id and old.id = any (c.people))
       or exists (select 1 from public.studio_reviews r where r.person_id = old.id) then
      raise exception 'a card that was cleared, pulled or put in a cut is kept';
    end if;
    return old;
  end if;
  select * into f from public.studio_films where id = new.film_id;
  if tg_op = 'INSERT' then
    if new.cleared_at is not null or new.cleared_by is not null or new.consent_pulled_at is not null then
      raise exception 'a new card starts not cleared';
    end if;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    return new;
  end if;

  if new.film_id <> old.film_id or new.person_code <> old.person_code or new.created_by <> old.created_by then
    raise exception 'a card keeps its film, its code and its author';
  end if;
  if old.consent_pulled_at is not null then
    raise exception 'consent was pulled: the card for % is closed', old.person_code;
  end if;

  -- Pulling consent: that and nothing else in the same change.
  if new.consent_pulled_at is not null then
    if row(new.name, new.role, new.is_minor, new.texas_youth, new.speaker, new.release_on_file, new.covers,
           new.reviewer_relation, new.reviewer_name, new.reviewer_email, new.cleared_at, new.cleared_by)
       is distinct from row(old.name, old.role, old.is_minor, old.texas_youth, old.speaker, old.release_on_file, old.covers,
           old.reviewer_relation, old.reviewer_name, old.reviewer_email, old.cleared_at, old.cleared_by) then
      raise exception 'pulling consent changes nothing else on the card';
    end if;
    new.consent_pulled_at := now();
    return new;
  end if;
  if f.pulled_at is not null or f.archived_at is not null then
    raise exception 'film % is closed', f.id;
  end if;

  card_changed := row(new.name, new.role, new.is_minor, new.texas_youth, new.speaker, new.release_on_file, new.covers,
                      new.reviewer_relation, new.reviewer_name, new.reviewer_email)
                  is distinct from row(old.name, old.role, old.is_minor, old.texas_youth, old.speaker, old.release_on_file, old.covers,
                      old.reviewer_relation, old.reviewer_name, old.reviewer_email);

  if card_changed and old.cleared_at is not null then
    if exists (select 1 from public.studio_film_posts p join public.studio_film_cuts c on c.id = p.cut_id
                where p.film_id = old.film_id and p.removed_at is null and old.id = any (c.people)) then
      raise exception 'the card for % is in something posted: take it down or pull consent instead', old.person_code;
    end if;
    if new.changed_by is null then
      raise exception 'who changed the card for %', old.person_code;
    end if;
    -- A changed card is cleared again before anything goes on.
    new.cleared_at := null;
    new.cleared_by := null;
    return new;
  end if;

  if new.cleared_at is not null and old.cleared_at is null then
    if new.cleared_by is null then
      raise exception 'who cleared the card for %', old.person_code;
    end if;
    if not new.release_on_file then
      raise exception 'no release, no card: % has no release on file', old.person_code;
    end if;
    if new.speaker and new.reviewer_email is null then
      raise exception 'a speaker''s card says who approves the cut';
    end if;
    new.cleared_at := now();
  elsif new.cleared_at is null and old.cleared_at is not null then
    if new.changed_by is null then
      raise exception 'who uncleared the card for %', old.person_code;
    end if;
    new.cleared_by := null;
  elsif new.cleared_at is distinct from old.cleared_at or new.cleared_by is distinct from old.cleared_by then
    raise exception 'the card for % keeps when and by whom it was cleared', old.person_code;
  end if;
  return new;
end $$;

create or replace function public.studio_film_cuts_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films%rowtype;
  asked boolean;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.studio_reviews r where r.cut_id = old.id)
       or exists (select 1 from public.studio_film_posts p where p.cut_id = old.id) then
      raise exception 'a cut that went to review or out is kept';
    end if;
    return old;
  end if;
  select * into f from public.studio_films where id = new.film_id;
  -- Everyone in it is on this film's cards, and nobody in it pulled consent.
  if exists (select 1 from unnest(new.people) as u(pid)
               left join public.studio_film_people p on p.id = u.pid
              where p.id is null or p.film_id <> new.film_id or (p.consent_pulled_at is not null and not (tg_op = 'UPDATE' and p.id = any (old.people)))) then
    raise exception 'a cut lists the people on this film''s cards, and nobody who pulled consent';
  end if;
  if tg_op = 'INSERT' then
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    if new.status <> 'uploaded' or new.sha256 is not null or new.preview_key is not null or new.poster_key is not null
       or new.duration_ms is not null or new.attempts <> 0 or new.claimed_at is not null then
      raise exception 'a new cut starts as uploaded';
    end if;
    return new;
  end if;

  if new.film_id <> old.film_id or new.kind <> old.kind or new.format <> old.format or new.ratio <> old.ratio
     or new.version <> old.version or new.object_key is distinct from old.object_key or new.created_by <> old.created_by
     or new.file_name <> old.file_name then
    raise exception 'cut % keeps its film, its file and its version', old.id;
  end if;
  asked := exists (select 1 from public.studio_reviews r where r.cut_id = old.id);
  if new.people is distinct from old.people and asked then
    raise exception 'cut % went to review: who is in it stays as it was', old.id;
  end if;
  if old.status = 'ready' then
    if new.status <> 'ready' or row(new.sha256, new.preview_key, new.poster_key, new.slide_keys, new.bytes, new.duration_ms, new.width, new.height)
       is distinct from row(old.sha256, old.preview_key, old.poster_key, old.slide_keys, old.bytes, old.duration_ms, old.width, old.height) then
      raise exception 'cut % is ready: its file stays as it was', old.id;
    end if;
  elsif new.status is distinct from old.status then
    if not ((old.status = 'uploaded' and new.status = 'processing')
         or (old.status = 'processing' and new.status in ('ready', 'failed', 'uploaded'))
         or (old.status = 'failed' and new.status = 'processing')) then
      raise exception 'cut % can''t go from % to %', old.id, old.status, new.status;
    end if;
  end if;
  return new;
end $$;

create or replace function public.studio_reviews_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  p public.studio_film_people%rowtype;
  c public.studio_film_cuts%rowtype;
  f public.studio_films%rowtype;
  proof text;
begin
  if tg_op = 'DELETE' then
    raise exception 'a review is kept';
  end if;
  select * into c from public.studio_film_cuts where id = new.cut_id;
  select * into p from public.studio_film_people where id = new.person_id;
  select * into f from public.studio_films where id = new.film_id;

  if tg_op = 'INSERT' then
    if new.decision is not null or new.decided_at is not null or new.approved_fingerprint is not null or new.withdrawn_at is not null then
      raise exception 'a review starts undecided';
    end if;
    if new.link_hash is null or new.expires_at is null or new.expires_at > now() + interval '7 days 1 hour' then
      raise exception 'a review link lasts 7 days at most';
    end if;
    if not public.studio_tool_on('review_copies') then
      raise exception 'review copies are off until the producer approves storing them (Studio → Tool approvals)';
    end if;
    if f.id is null or c.film_id is distinct from f.id or p.film_id is distinct from f.id then
      raise exception 'a review is for a cut and a card on the same film';
    end if;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    if c.status <> 'ready' or c.sha256 is null then
      raise exception 'the cut isn''t ready to review yet';
    end if;
    if not (p.id = any (c.people)) or not p.speaker then
      raise exception 'only a speaker in this cut reviews it';
    end if;
    if p.cleared_at is null or p.consent_pulled_at is not null then
      raise exception 'no card, no review: % isn''t cleared', p.person_code;
    end if;
    if new.reviewer_email <> p.reviewer_email or new.reviewer_relation <> p.reviewer_relation then
      raise exception 'the link goes to the reviewer on the card';
    end if;
    if exists (select 1 from public.studio_reviews r where r.cut_id = new.cut_id and r.person_id = new.person_id
                and r.decision = 'approved' and r.withdrawn_at is null) then
      raise exception '% already approved this cut', p.person_code;
    end if;
    new.asked_fingerprint := c.sha256;
    new.requested_at := now();
    return new;
  end if;

  if new.film_id <> old.film_id or new.cut_id <> old.cut_id or new.person_id <> old.person_id
     or new.reviewer_email <> old.reviewer_email or new.reviewer_relation <> old.reviewer_relation
     or new.requested_at <> old.requested_at or new.asked_fingerprint <> old.asked_fingerprint or new.asked_by <> old.asked_by then
    raise exception 'review % keeps its cut, its reviewer and its file', old.id;
  end if;

  -- A decision: only with the proof of the reviewer's live link, in the update
  -- that burns it, for the file the link was for.
  if old.decision is null and new.decision is not null then
    proof := nullif(current_setting('studio.review_proof', true), '');
    if proof is null or old.link_hash is null
       or encode(sha256(convert_to(proof, 'UTF8')), 'hex') <> old.link_hash
       or old.expires_at <= now()
       or new.link_hash is not null then
      raise exception 'review % is decided only by the reviewer, through their link', old.id;
    end if;
    if c.status <> 'ready' or c.sha256 is distinct from old.asked_fingerprint
       or p.cleared_at is null or p.consent_pulled_at is not null or f.pulled_at is not null or f.archived_at is not null then
      raise exception 'review % can''t be decided now', old.id;
    end if;
    if new.decision = 'changes' and char_length(btrim(coalesce(new.note, ''))) < 3 then
      raise exception 'asking for a change says what to change';
    end if;
    new.decided_at := now();
    new.expires_at := null;
    new.approved_fingerprint := case when new.decision = 'approved' then old.asked_fingerprint else null end;
    return new;
  end if;
  if new.decision is distinct from old.decision or new.decided_at is distinct from old.decided_at
     or new.decided_name is distinct from old.decided_name or new.approved_fingerprint is distinct from old.approved_fingerprint
     or (old.decision is not null and new.note is distinct from old.note) then
    raise exception 'review % stays as the reviewer decided it', old.id;
  end if;

  -- The speaker takes their yes back (they told the producer).
  if new.withdrawn_at is distinct from old.withdrawn_at or new.withdrawn_by is distinct from old.withdrawn_by then
    if old.withdrawn_at is not null or old.decision is distinct from 'approved' or new.withdrawn_by is null then
      raise exception 'only an approval is withdrawn, once, by a named staff member';
    end if;
    if exists (select 1 from public.studio_film_posts po where po.cut_id = old.cut_id and po.removed_at is null) then
      raise exception 'this cut is out: take the posts down (or pull consent) first';
    end if;
    new.withdrawn_at := now();
    return new;
  end if;

  -- Cancelling a live link.
  if new.link_hash is distinct from old.link_hash or new.expires_at is distinct from old.expires_at then
    if old.link_hash is null or new.link_hash is not null or old.decision is not null then
      raise exception 'a review link is only ever cancelled';
    end if;
    new.expires_at := null;
    return new;
  end if;
  if new.note is distinct from old.note then
    raise exception 'review % keeps its note', old.id;
  end if;
  return new;
end $$;

create or replace function public.studio_film_posts_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'a post is marked removed, never deleted';
  end if;
  if tg_op = 'INSERT' then
    select * into f from public.studio_films where id = new.film_id;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', new.film_id;
    end if;
    if new.removed_at is not null then
      raise exception 'a new post is live';
    end if;
    if not exists (select 1 from public.studio_film_steps s where s.film_id = new.film_id and s.step = 'final_signoff' and s.status = 'done') then
      raise exception 'nothing goes out before the final sign-off';
    end if;
    if not exists (select 1 from public.studio_film_cuts c where c.id = new.cut_id and c.film_id = new.film_id) then
      raise exception 'a post is for one of this film''s cuts';
    end if;
    if not public.studio_cut_approved(new.cut_id) then
      raise exception 'only a cut every speaker in it approved goes out, with everyone in it cleared';
    end if;
    new.posted_at := now();
    return new;
  end if;
  if row(new.film_id, new.cut_id, new.platform, new.url, new.posted_at, new.posted_by)
     is distinct from row(old.film_id, old.cut_id, old.platform, old.url, old.posted_at, old.posted_by) then
    raise exception 'post % stays as recorded', old.id;
  end if;
  if new.removed_at is distinct from old.removed_at or new.removed_by is distinct from old.removed_by then
    if old.removed_at is not null or new.removed_by is null then
      raise exception 'post % is removed once, by a named staff member', old.id;
    end if;
    new.removed_at := now();
  end if;
  return new;
end $$;

create or replace function public.studio_takedowns_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a takedown is kept';
  end if;
  if tg_op = 'INSERT' then
    if new.closed_at is not null then
      raise exception 'a takedown starts open';
    end if;
    new.requested_at := now();
    new.due_at := now() + interval '72 hours';
    return new;
  end if;
  if row(new.person_code, new.requested_at, new.due_at, new.source, new.requested_by, new.note)
     is distinct from row(old.person_code, old.requested_at, old.due_at, old.source, old.requested_by, old.note) then
    raise exception 'takedown % stays as it was opened', old.id;
  end if;
  if new.closed_at is distinct from old.closed_at or new.closed_by is distinct from old.closed_by then
    if old.closed_at is not null or new.closed_by is null then
      raise exception 'takedown % closes once', old.id;
    end if;
    if exists (select 1 from public.studio_takedown_items i where i.takedown_id = old.id and i.done_at is null) then
      raise exception 'takedown % closes when everything on it is down', old.id;
    end if;
    new.closed_at := now();
  end if;
  return new;
end $$;

create or replace function public.studio_takedown_items_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a takedown item is kept';
  end if;
  if tg_op = 'INSERT' then
    if new.done_at is not null then
      raise exception 'a takedown item starts to do';
    end if;
    if exists (select 1 from public.studio_takedowns t where t.id = new.takedown_id and t.closed_at is not null) then
      raise exception 'takedown % is closed', new.takedown_id;
    end if;
    if new.post_id is not null and not exists (select 1 from public.studio_film_posts p where p.id = new.post_id and p.film_id = new.film_id) then
      raise exception 'a takedown item names a post of its film';
    end if;
    return new;
  end if;
  if row(new.takedown_id, new.film_id, new.what, new.post_id, new.label)
     is distinct from row(old.takedown_id, old.film_id, old.what, old.post_id, old.label) then
    raise exception 'takedown item % stays as it was listed', old.id;
  end if;
  if new.done_at is distinct from old.done_at or new.done_by is distinct from old.done_by then
    if old.done_at is not null or new.done_by is null then
      raise exception 'takedown item % is done once, by a named staff member', old.id;
    end if;
    new.done_at := now();
  elsif new.note is distinct from old.note and old.done_at is not null then
    raise exception 'takedown item % is done', old.id;
  end if;
  return new;
end $$;

-- ── What follows from a change ────────────────────────────────────────────
-- These fire on every update (the gates set the timestamps themselves, so an
-- UPDATE OF column trigger would miss them) and are named to run after the
-- history's trigger, so the history reads cause first.
-- A new film gets the kit's ten steps.
create or replace function public.studio_films_steps() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.studio_film_steps (film_id, step, position)
  select new.id, s.step, s.position
    from (values ('brief', 1), ('board', 2), ('clearance', 3), ('shoot', 4), ('selects', 5), ('rough_cut', 6),
                 ('speaker_review', 7), ('rights_check', 8), ('final_signoff', 9), ('publish', 10)) as s(step, position);
  return null;
end $$;

-- A pulled consent pulls the film, stops its live review links, and puts
-- every live post of it on the person's open takedown (one per person code),
-- with a line for everything outside the app.
create or replace function public.studio_people_cascade() returns trigger
language plpgsql set search_path = '' as $$
declare
  td uuid;
begin
  if not (new.consent_pulled_at is not null and old.consent_pulled_at is null) then
    return null;
  end if;
  update public.studio_films set pulled_at = now(), updated_at = now() where id = new.film_id and pulled_at is null;
  update public.studio_reviews set link_hash = null, expires_at = null, changed_by = new.pulled_by, updated_at = now()
   where film_id = new.film_id and link_hash is not null;
  select t.id into td from public.studio_takedowns t where t.person_code = new.person_code and t.closed_at is null
   order by t.requested_at desc limit 1;
  if td is null then
    insert into public.studio_takedowns (person_code, source, requested_by, note)
    values (new.person_code, coalesce(nullif(current_setting('studio.pull_source', true), ''), 'staff'), new.pulled_by, new.pulled_note)
    returning id into td;
  end if;
  insert into public.studio_takedown_items (takedown_id, film_id, what, post_id)
  select td, p.film_id, 'post', p.id from public.studio_film_posts p where p.film_id = new.film_id and p.removed_at is null
  on conflict (takedown_id, post_id) where post_id is not null do nothing;
  insert into public.studio_takedown_items (takedown_id, film_id, what)
  values (td, new.film_id, 'elsewhere')
  on conflict (takedown_id, film_id) where what = 'elsewhere' do nothing;
  return null;
end $$;

-- A takedown item done takes its post down; the last one closes the takedown.
create or replace function public.studio_takedown_items_after() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not (new.done_at is not null and old.done_at is null) then
    return null;
  end if;
  if new.post_id is not null then
    update public.studio_film_posts set removed_at = now(), removed_by = new.done_by where id = new.post_id and removed_at is null;
  end if;
  if not exists (select 1 from public.studio_takedown_items i where i.takedown_id = new.takedown_id and i.done_at is null) then
    update public.studio_takedowns set closed_at = now(), closed_by = new.done_by where id = new.takedown_id and closed_at is null;
  end if;
  return null;
end $$;

-- A post taken down by hand ticks its takedown item.
create or replace function public.studio_film_posts_after() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    update public.studio_takedown_items set done_at = now(), done_by = new.removed_by
     where post_id = new.id and done_at is null;
  end if;
  return null;
end $$;

-- ── The history, written by the database ──────────────────────────────────
-- Runs as the tables' owner, so the history is written whoever made the
-- change, and the change fails if it can't be. Only this function writes the
-- database's own entries (studio_events_gate checks it's running as this
-- function's owner, with its mark on); staff add notes.
create or replace function public.studio_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
  fid uuid;
  bys text;
  byr text;
  subj text;
  nt text;
  rf uuid;
  code text;
begin
  perform set_config('studio.logging', 'on', true);
  if tg_table_name = 'studio_tool_approvals' then
    if new.is_on is distinct from old.is_on then
      k := case when new.is_on then 'tool_on' else 'tool_off' end;
      bys := new.decided_by; subj := new.tool; nt := new.note;
    end if;
  elsif tg_table_name = 'studio_films' then
    fid := new.id; rf := new.id;
    if tg_op = 'INSERT' then
      k := 'film_created'; bys := new.created_by; subj := new.format;
    elsif new.pulled_at is not null and old.pulled_at is null then
      k := 'film_pulled'; bys := 'the app';
    elsif new.archived_at is not null and old.archived_at is null then
      k := 'film_archived'; bys := new.archived_by;
    elsif new.archived_at is null and old.archived_at is not null then
      k := 'film_unarchived'; bys := old.archived_by;
    end if;
  elsif tg_table_name = 'studio_film_steps' then
    fid := new.film_id; subj := new.step;
    if old.status = 'todo' and new.status = 'done' then
      k := 'step_done'; bys := new.done_by; nt := new.note; rf := new.cut_id;
    elsif old.status = 'done' and new.status = 'todo' then
      k := 'step_reopened'; bys := new.changed_by; nt := new.note;
    elsif new.second_yes_at is not null and new.second_yes_at is distinct from old.second_yes_at then
      k := 'second_yes'; byr := new.second_yes_by; nt := new.second_yes_note;
    end if;
  elsif tg_table_name = 'studio_film_people' then
    fid := new.film_id; subj := new.person_code; rf := new.id;
    if tg_op = 'INSERT' then
      k := 'person_added'; bys := new.created_by;
    elsif new.consent_pulled_at is not null and old.consent_pulled_at is null then
      k := 'consent_pulled'; bys := new.pulled_by; nt := new.pulled_note;
    elsif new.cleared_at is not null and old.cleared_at is null then
      k := 'person_cleared'; bys := new.cleared_by;
    elsif new.cleared_at is null and old.cleared_at is not null then
      k := 'person_uncleared'; bys := new.changed_by;
    end if;
  elsif tg_table_name = 'studio_film_cuts' then
    fid := new.film_id; rf := new.id; subj := new.format || ' ' || new.ratio || ' v' || new.version;
    if tg_op = 'INSERT' then
      k := 'cut_added'; bys := new.created_by;
    elsif new.status = 'ready' and old.status <> 'ready' then
      k := 'cut_ready'; bys := 'the app';
    elsif new.status = 'failed' and old.status <> 'failed' then
      k := 'cut_failed'; bys := 'the app'; nt := new.error;
    end if;
  elsif tg_table_name = 'studio_reviews' then
    fid := new.film_id; rf := new.id;
    select person_code into code from public.studio_film_people where id = new.person_id;
    subj := code;
    if tg_op = 'INSERT' then
      k := 'review_asked'; bys := new.asked_by;
    elsif new.decision is not null and old.decision is null then
      k := 'review_' || new.decision; byr := new.decided_name; nt := new.note;
    elsif new.withdrawn_at is not null and old.withdrawn_at is null then
      k := 'review_withdrawn'; bys := new.withdrawn_by;
    elsif new.link_hash is null and old.link_hash is not null and new.decision is null then
      k := 'review_link_cancelled'; bys := coalesce(new.changed_by, 'the app');
    end if;
  elsif tg_table_name = 'studio_film_posts' then
    fid := new.film_id; rf := new.id; subj := new.platform;
    if tg_op = 'INSERT' then
      k := 'posted'; bys := new.posted_by;
    elsif new.removed_at is not null and old.removed_at is null then
      k := 'post_removed'; bys := new.removed_by;
    end if;
  elsif tg_table_name = 'studio_takedowns' then
    rf := new.id; subj := new.person_code;
    if tg_op = 'INSERT' then
      k := 'takedown_opened'; bys := new.requested_by; nt := new.note;
    elsif new.closed_at is not null and old.closed_at is null then
      k := 'takedown_closed'; bys := new.closed_by;
    end if;
  elsif tg_table_name = 'studio_takedown_items' then
    if tg_op = 'UPDATE' and new.done_at is not null and old.done_at is null then
      k := 'takedown_item_done'; fid := new.film_id; bys := new.done_by; subj := new.what; nt := new.note; rf := new.takedown_id;
    end if;
  end if;
  if k is not null then
    insert into public.studio_events (film_id, kind, by_staff, by_reviewer, subject, note, ref)
    values (fid, k, bys, byr, left(subj, 120), left(nt, 1000), rf);
  end if;
  perform set_config('studio.logging', '', true);
  return null;
end $$;

create or replace function public.studio_events_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'the Studio history is kept as it was written';
  end if;
  if new.kind <> 'note' and (
       current_user is distinct from (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.studio_log()'::regprocedure)
       or current_setting('studio.logging', true) is distinct from 'on') then
    raise exception 'studio history: % is written by the database', new.kind;
  end if;
  if new.kind = 'note' and (new.by_staff is null or new.note is null or new.film_id is null or new.by_reviewer is not null) then
    raise exception 'studio history: a note is a staff member''s, on a film';
  end if;
  new.at := now();
  return new;
end $$;

create or replace trigger studio_tool_approvals_gate before insert or update or delete on public.studio_tool_approvals
  for each row execute function public.studio_tool_approvals_gate();
create or replace trigger studio_tool_approvals_log after update on public.studio_tool_approvals
  for each row execute function public.studio_log();

create or replace trigger studio_films_gate before insert or update or delete on public.studio_films
  for each row execute function public.studio_films_gate();
create or replace trigger studio_films_steps after insert on public.studio_films
  for each row execute function public.studio_films_steps();
create or replace trigger studio_films_log after insert or update on public.studio_films
  for each row execute function public.studio_log();

create or replace trigger studio_film_steps_gate before insert or update or delete on public.studio_film_steps
  for each row execute function public.studio_film_steps_gate();
create or replace trigger studio_film_steps_log after update on public.studio_film_steps
  for each row execute function public.studio_log();

create or replace trigger studio_film_people_gate before insert or update or delete on public.studio_film_people
  for each row execute function public.studio_film_people_gate();
create or replace trigger studio_film_people_then after update on public.studio_film_people
  for each row execute function public.studio_people_cascade();
create or replace trigger studio_film_people_log after insert or update on public.studio_film_people
  for each row execute function public.studio_log();

create or replace trigger studio_film_cuts_gate before insert or update or delete on public.studio_film_cuts
  for each row execute function public.studio_film_cuts_gate();
create or replace trigger studio_film_cuts_log after insert or update on public.studio_film_cuts
  for each row execute function public.studio_log();

create or replace trigger studio_reviews_gate before insert or update or delete on public.studio_reviews
  for each row execute function public.studio_reviews_gate();
create or replace trigger studio_reviews_log after insert or update on public.studio_reviews
  for each row execute function public.studio_log();

create or replace trigger studio_film_posts_gate before insert or update or delete on public.studio_film_posts
  for each row execute function public.studio_film_posts_gate();
create or replace trigger studio_film_posts_then after update on public.studio_film_posts
  for each row execute function public.studio_film_posts_after();
create or replace trigger studio_film_posts_log after insert or update on public.studio_film_posts
  for each row execute function public.studio_log();

create or replace trigger studio_takedowns_gate before insert or update or delete on public.studio_takedowns
  for each row execute function public.studio_takedowns_gate();
create or replace trigger studio_takedowns_log after insert or update on public.studio_takedowns
  for each row execute function public.studio_log();

create or replace trigger studio_takedown_items_gate before insert or update or delete on public.studio_takedown_items
  for each row execute function public.studio_takedown_items_gate();
create or replace trigger studio_takedown_items_then after update on public.studio_takedown_items
  for each row execute function public.studio_takedown_items_after();
create or replace trigger studio_takedown_items_log after update on public.studio_takedown_items
  for each row execute function public.studio_log();

create or replace trigger studio_events_gate before insert or update or delete on public.studio_events
  for each row execute function public.studio_events_gate();
create or replace trigger studio_events_keep before truncate on public.studio_events
  for each statement execute function public.studio_events_gate();

-- ── What the server calls ─────────────────────────────────────────────────
-- What the reviewer's link shows: the cut to watch and what they approve.
-- p_proof is the link's proof (sha256 of the token); the table holds sha256
-- of that. Nothing for a link that's used, expired, cancelled or unknown, or
-- on a film or card that's closed.
create or replace function public.studio_review_for_reviewer(p_proof text)
returns table (review_id uuid, kit_slug text, format text, ratio text, version int, kind text, duration_ms int,
               one_sentence text, relation text, reviewer_name text, preview_key text, poster_key text,
               slide_keys text[], expires_at timestamptz)
language sql stable set search_path = '' as $$
  select r.id, f.kit_slug, c.format, c.ratio, c.version, c.kind, c.duration_ms, f.one_sentence,
         r.reviewer_relation, p.reviewer_name, c.preview_key, c.poster_key, c.slide_keys, r.expires_at
    from public.studio_reviews r
    join public.studio_film_cuts c on c.id = r.cut_id
    join public.studio_films f on f.id = r.film_id
    join public.studio_film_people p on p.id = r.person_id
   where r.link_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and r.expires_at > now() and r.decision is null
     and c.status = 'ready' and c.sha256 = r.asked_fingerprint
     and f.pulled_at is null and f.archived_at is null
     and p.cleared_at is not null and p.consent_pulled_at is null
$$;

-- The reviewer's decision, in one statement: the gate checks the proof
-- against the link it burns, so a link works once and only for its holder.
-- The review's id, or no row when the link isn't active.
create or replace function public.studio_review_decide(p_proof text, p_decision text, p_name text, p_note text)
returns table (review_id uuid)
language sql volatile set search_path = '' as $$
  select set_config('studio.review_proof', coalesce(p_proof, ''), true);
  update public.studio_reviews r
     set decision = p_decision,
         decided_name = btrim(p_name),
         note = nullif(btrim(coalesce(p_note, '')), ''),
         link_hash = null,
         updated_at = now()
    from public.studio_film_cuts c, public.studio_films f, public.studio_film_people p
   where c.id = r.cut_id and f.id = r.film_id and p.id = r.person_id
     and r.link_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and r.expires_at > now() and r.decision is null
     and c.status = 'ready' and c.sha256 = r.asked_fingerprint
     and f.pulled_at is null and f.archived_at is null
     and p.cleared_at is not null and p.consent_pulled_at is null
     and p_decision in ('approved', 'changes')
     and char_length(btrim(coalesce(p_name, ''))) between 2 and 200
  returning r.id;
$$;

-- Pull a person's consent everywhere they appear (by person code). Returns
-- the open takedown, or nothing if there was nothing left to pull.
create or replace function public.studio_pull_consent(p_person_code text, p_by text, p_source text, p_note text)
returns table (takedown_id uuid)
language plpgsql volatile set search_path = '' as $$
declare
  code text := upper(btrim(coalesce(p_person_code, '')));
begin
  if p_source is null or p_source not in ('staff', 'speaker') then
    raise exception 'a pull comes from staff or the speaker';
  end if;
  if p_by is null or char_length(p_by) < 3 then
    raise exception 'who pulled it';
  end if;
  perform set_config('studio.pull_source', p_source, true);
  update public.studio_film_people
     set consent_pulled_at = now(), pulled_by = p_by, pulled_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where person_code = code and consent_pulled_at is null;
  return query select t.id from public.studio_takedowns t where t.person_code = code and t.closed_at is null
                order by t.requested_at desc limit 1;
end $$;

-- Reopen a step: it and every later done step go back to to do, latest
-- first (the gate refuses a published film).
create or replace function public.studio_film_reopen(p_film uuid, p_step text, p_by text, p_note text)
returns void
language plpgsql volatile set search_path = '' as $$
declare
  target smallint;
  s record;
begin
  select position into target from public.studio_film_steps where film_id = p_film and step = p_step;
  if target is null then
    raise exception 'no such step';
  end if;
  for s in select step from public.studio_film_steps where film_id = p_film and position >= target and status = 'done' order by position desc loop
    update public.studio_film_steps set status = 'todo', changed_by = p_by, note = p_note, updated_at = now()
     where film_id = p_film and step = s.step;
  end loop;
end $$;

-- Only the server (service role) uses these.
do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array[
    'public.studio_cut_approved(uuid)', 'public.studio_tool_on(text)',
    'public.studio_tool_approvals_gate()', 'public.studio_films_gate()', 'public.studio_film_steps_gate()',
    'public.studio_film_people_gate()', 'public.studio_film_cuts_gate()', 'public.studio_reviews_gate()',
    'public.studio_film_posts_gate()', 'public.studio_takedowns_gate()', 'public.studio_takedown_items_gate()',
    'public.studio_films_steps()', 'public.studio_people_cascade()', 'public.studio_takedown_items_after()',
    'public.studio_film_posts_after()', 'public.studio_log()', 'public.studio_events_gate()',
    'public.studio_review_for_reviewer(text)', 'public.studio_review_decide(text, text, text, text)',
    'public.studio_pull_consent(text, text, text, text)', 'public.studio_film_reopen(uuid, text, text, text)'] loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_tool_approvals, public.studio_films, public.studio_film_steps, public.studio_film_people, '
        'public.studio_film_cuts, public.studio_reviews, public.studio_film_posts, public.studio_takedowns, '
        'public.studio_takedown_items, public.studio_events from %I', r);
      execute format('revoke all on sequence public.studio_events_id_seq from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.studio_review_for_reviewer(text) to service_role';
    execute 'grant execute on function public.studio_review_decide(text, text, text, text) to service_role';
    execute 'grant execute on function public.studio_pull_consent(text, text, text, text) to service_role';
    execute 'grant execute on function public.studio_film_reopen(uuid, text, text, text) to service_role';
    execute 'grant execute on function public.studio_cut_approved(uuid) to service_role';
    execute 'grant execute on function public.studio_tool_on(text) to service_role';
  end if;
end $$;

-- The private bucket for review copies (Supabase only; a bare Postgres in
-- tests has no storage schema). Video and images only. On Supabase's free
-- plan the project's own 50 MB limit wins.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('studio-films', 'studio-films', false, 2147483648,
            array['video/mp4', 'video/quicktime', 'video/x-m4v', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end $$;
