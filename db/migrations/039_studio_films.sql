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
--   * Minors appear only unidentifiable: no face, no name, no jersey number
--     (Kyron's rule; the kit's for Texas youth). A pulled consent stays
--     pulled: a new card for that code needs the family's new consent.
--   * A speaker approves their own cut (a minor's parent or guardian does),
--     on a one-time review link that expires. The link carries a token; the
--     server turns it into a proof (sha256 of the token) and the table keeps
--     only sha256 of the proof, so nothing that can read the table can
--     decide. The approval is for that exact file (its sha256), from the
--     reviewer the card names now: a card change cancels its live links.
--   * The speaker review names the cuts that go on; the rights check and the
--     final sign-off (with Coach Hooks's yes, recorded after the rights check)
--     are for those cuts, and only those cuts are posted, with every speaker's
--     yes and everyone in them cleared.
--   * Writes to a film take the film's row lock first, so two changes that
--     are each allowed alone can't both land (a post during a pull). The
--     order is always: the person code (an advisory lock), then films in id
--     order, then a film's rows, then takedowns in id order (a post's line
--     coming down locks every takedown listing that post). A change to one row that a
--     cascade can also reach goes through a function here that locks the film
--     first (studio_card_save, studio_step_done, studio_review_cancel, ...),
--     so a single-row update never holds its row while waiting on the film.
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
  -- Who makes a change says so with that change: changed_by is taken by the
  -- gate (it's empty again after every write), and kept as last_changed_by.
  changed_by text check (changed_by is null or char_length(changed_by) between 3 and 200),
  last_changed_by text check (last_changed_by is null or char_length(last_changed_by) between 3 and 200),
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
  -- Speaker review onward: the cuts every speaker in them approved, which the
  -- rights check and the final sign-off are for and which alone are posted
  -- (a hero film's 9:16 and its 4:5). cut_id is the first of them.
  cut_ids uuid[],
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
  -- Who changes a card says so with that change (as on studio_films).
  changed_by text check (changed_by is null or char_length(changed_by) between 3 and 200),
  last_changed_by text check (last_changed_by is null or char_length(last_changed_by) between 3 and 200),
  consent_pulled_at timestamptz,
  pulled_by text check (pulled_by is null or char_length(pulled_by) between 3 and 200),
  pulled_note text check (pulled_note is null or char_length(pulled_note) between 1 and 500),
  -- A code whose consent was pulled comes back only with the family's new
  -- consent, recorded by the producer (how and when), once its takedown is done.
  reconsent_note text check (reconsent_note is null or char_length(reconsent_note) between 3 and 500),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (film_id, person_code),
  constraint studio_film_people_cleared_whole check ((cleared_at is null) = (cleared_by is null)),
  constraint studio_film_people_cleared_release check (cleared_at is null or release_on_file),
  constraint studio_film_people_pulled_whole check ((consent_pulled_at is null) = (pulled_by is null)),
  -- Minors appear only unidentifiable: no face, no name, no jersey number.
  -- Texas youth athletes are minors (and stay so until counsel clears it).
  constraint studio_film_people_texas_youth check (not texas_youth or is_minor),
  constraint studio_film_people_minor check (not is_minor or (
    coalesce(covers->>'face', 'false') = 'false' and coalesce(covers->>'name', 'false') = 'false'
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
  -- The uploaded file's fingerprint (the file that will post): every
  -- approval is for it. Set when the cut is ready.
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  -- The fingerprint of the copy the speakers watch, made from that file. Its
  -- storage key carries the start of it, and neither changes once ready.
  preview_sha256 text check (preview_sha256 is null or preview_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'uploaded' check (status in ('uploaded', 'processing', 'ready', 'failed')),
  error text check (error is null or char_length(error) <= 500),
  attempts int not null default 0 check (attempts between 0 and 10),
  claimed_at timestamptz,
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (film_id, format, ratio, version),
  constraint studio_film_cuts_ready check (status <> 'ready' or (sha256 is not null and (kind = 'slides' or (preview_key is not null and duration_ms is not null and preview_sha256 is not null))))
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

-- ── Files to remove from storage ──────────────────────────────────────────
-- A deleted cut's files and a pulled film's files, listed by the database in
-- the same change, so a removal that fails is retried (utils/studio-review-
-- worker.js) instead of forgotten.
create table if not exists public.studio_storage_removals (
  key text primary key check (char_length(key) between 1 and 300),
  reason text not null check (reason in ('cut_deleted', 'consent_pulled', 'left_over')),
  requested_at timestamptz not null default now(),
  done_at timestamptz,
  tries int not null default 0 check (tries >= 0),
  last_error text check (last_error is null or char_length(last_error) <= 300)
);
create index if not exists studio_storage_removals_todo_idx on public.studio_storage_removals (requested_at) where done_at is null;
alter table public.studio_storage_removals enable row level security;

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
-- yes to this exact file and still does, through the reviewer their card
-- names now.
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
                 and r.withdrawn_at is null and r.approved_fingerprint = c.sha256
                 and r.reviewer_email = p.reviewer_email and r.reviewer_relation = p.reviewer_relation))
  )
$$;

-- Whether a note names someone on the film's cards for certain: their whole
-- name (or their reviewer's), or the name run together ("JamieRivers"), as
-- utils/studio-films.js namesIn does with { strong: true }; or any word of a
-- minor's name ("Jamie's mom called"), as its minorWords does. Such a note
-- stays out of the history. A single word of an adult's name ("Will",
-- "Mark") is the app's to ask about, not the database's to refuse; a child's
-- name has no such question. Two-letter name words that are everyday words
-- ("he" for a child named Bo He) are left to the app, which counts them only
-- with a capital mid-sentence; the whole name is refused here regardless.
create or replace function public.studio_names_in(p_film uuid, p_text text) returns boolean
language sql stable set search_path = '' as $$
  with hay as (
    select ' ' || btrim(regexp_replace(lower(coalesce(p_text, '')), '[^[:alpha:]]+', ' ', 'g')) || ' ' as words,
           regexp_replace(lower(coalesce(p_text, '')), '[^[:alpha:]]+', '', 'g') as letters
  ), names as (
    select btrim(regexp_replace(lower(n.full_name), '[^[:alpha:]]+', ' ', 'g')) as spaced, n.minor
      from public.studio_film_people p, lateral (values (p.name, p.is_minor), (p.reviewer_name, false)) as n(full_name, minor)
     where p.film_id = p_film and n.full_name is not null
  ), minor_words as (
    select w from names, lateral regexp_split_to_table(names.spaced, ' ') as w
     where names.minor and char_length(w) >= 2
       and not (char_length(w) = 2 and w = any (array['he', 'do', 'an', 'so', 'go', 'oh', 'no', 'me', 'my', 'we', 'us', 'it', 'in', 'on',
         'at', 'to', 'be', 'by', 'of', 'or', 'up', 'as', 'is', 'am', 'if', 'hi', 'ok', 'ah', 'eh', 'uh', 'um', 'yo', 'ya', 'ha', 'ho', 'lo',
         'la', 'ma', 'pa', 'ye', 'ow', 'ox', 'ax', 'id', 're', 'vs']))
  )
  select p_text is not null and p_film is not null and (exists (
    select 1 from names, hay
     where (names.spaced like '% %' and hay.words like '% ' || names.spaced || ' %')
        or (names.spaced like '% %' and char_length(replace(names.spaced, ' ', '')) >= 5
            and hay.letters like '%' || replace(names.spaced, ' ', '') || '%'))
    or exists (select 1 from minor_words, hay where hay.words like '% ' || minor_words.w || ' %'))
$$;

-- Every file a cut keeps in storage, made or not yet, each once: the
-- upload, its review copy and poster, and for a set of slides (migration
-- 040) each slide and each slide's copy, kept in the copies' own folder
-- (preview_key ends in "/"; the poster is copy 1). The one definition, so
-- running this file again never loses the slides.
create or replace function public.studio_cut_files(c public.studio_film_cuts) returns setof text
language sql stable set search_path = '' as $$
  select distinct k from (
    select c.object_key as k union all select c.preview_key union all select c.poster_key
    union all select unnest(coalesce(c.slide_keys, '{}'::text[]))
    union all select c.preview_key || g.n || '.jpg'
      from generate_series(1, coalesce(cardinality(c.slide_keys), 0)) as g(n)
     where c.kind = 'slides' and c.preview_key like '%/'
  ) as x where k is not null and k not like '%/'
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
declare
  who text;
begin
  if tg_op = 'DELETE' then
    raise exception 'a film is archived, not deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.pulled_at is not null or new.archived_at is not null then
      raise exception 'a new film starts active';
    end if;
    new.changed_by := null;
    new.last_changed_by := null;
    return new;
  end if;
  -- Who's making this change, said with it (never carried over).
  who := new.changed_by;
  new.changed_by := null;
  new.last_changed_by := coalesce(who, old.last_changed_by);
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
      if who is null then raise exception 'who brought film % back', old.id; end if;
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
begin
  if tg_op = 'DELETE' then
    raise exception 'a film keeps its ten steps';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'todo' or new.done_at is not null or new.done_by is not null or new.cut_id is not null or new.cut_ids is not null
       or new.second_yes_by is not null or new.second_yes_at is not null then
      raise exception 'a film step starts as to do';
    end if;
    return new;
  end if;

  if new.film_id <> old.film_id or new.step <> old.step or new.position <> old.position then
    raise exception 'a step keeps its film and its place';
  end if;
  -- The film's row lock first: one change to a film at a time.
  select * into f from public.studio_films where id = new.film_id for update;

  -- A done step stays as it was; only a reopen changes it.
  if old.status = 'done' and new.status = 'done' then
    if row(new.done_at, new.done_by, new.note, new.cut_id, new.cut_ids, new.second_yes_by, new.second_yes_at, new.second_yes_note)
       is distinct from row(old.done_at, old.done_by, old.note, old.cut_id, old.cut_ids, old.second_yes_by, old.second_yes_at, old.second_yes_note) then
      raise exception 'the % step is done: reopen it to change it', old.step;
    end if;
    return new;
  end if;

  -- Still to do: a note, and the second yes for the final sign-off, given
  -- for the cuts the rights check passed (so only once it's done).
  if old.status = 'todo' and new.status = 'todo' then
    if new.done_at is not null or new.done_by is not null or new.cut_id is distinct from old.cut_id or new.cut_ids is distinct from old.cut_ids then
      raise exception 'the % step is still to do', old.step;
    end if;
    if new.second_yes_by is distinct from old.second_yes_by or new.second_yes_note is distinct from old.second_yes_note then
      if new.second_yes_by is not null then
        if f.pulled_at is not null or f.archived_at is not null then
          raise exception 'film % is closed', f.id;
        end if;
        if not exists (select 1 from public.studio_film_steps s where s.film_id = new.film_id and s.step = 'rights_check' and s.status = 'done') then
          raise exception '% says yes to the cuts the rights check passed: the rights check comes first', coalesce(f.second_yes_label, 'the second yes');
        end if;
      end if;
      new.second_yes_at := case when new.second_yes_by is null then null else now() end;
      if new.second_yes_by is null then new.second_yes_note := null; end if;
    else
      new.second_yes_at := old.second_yes_at;
    end if;
    return new;
  end if;

  -- Reopen: the last done step only (later ones first), never the publish,
  -- and not while anything of the film is out.
  if old.status = 'done' and new.status = 'todo' then
    if old.step = 'publish' then
      raise exception 'a published film is taken down, not reopened';
    end if;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    if exists (select 1 from public.studio_film_posts po where po.film_id = new.film_id and po.removed_at is null) then
      raise exception 'this film is out: take its posts down first, then reopen';
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
    new.cut_ids := null;
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
    -- The cuts that go on: one or more of this film's, each approved.
    if new.cut_ids is null and new.cut_id is not null then
      new.cut_ids := array[new.cut_id];
    end if;
    if new.cut_ids is null or cardinality(new.cut_ids) not between 1 and 10
       or (select count(distinct u) from unnest(new.cut_ids) as u) <> cardinality(new.cut_ids)
       or exists (select 1 from unnest(new.cut_ids) as u(cid)
                   where not exists (select 1 from public.studio_film_cuts c where c.id = u.cid and c.film_id = f.id)) then
      raise exception 'which of this film''s cuts did the speakers approve?';
    end if;
    if exists (select 1 from unnest(new.cut_ids) as u(cid) where not public.studio_cut_approved(u.cid)) then
      raise exception 'every speaker in those cuts has to say yes to them first';
    end if;
    new.cut_id := new.cut_ids[1];
  elsif new.step in ('rights_check', 'final_signoff', 'publish') then
    select s.cut_ids into new.cut_ids from public.studio_film_steps s where s.film_id = f.id and s.step = 'speaker_review';
    new.cut_id := new.cut_ids[1];
    if new.cut_ids is null or exists (select 1 from unnest(new.cut_ids) as u(cid) where not public.studio_cut_approved(u.cid)) then
      raise exception 'the approved cuts are no longer approved: a speaker took it back or a card changed';
    end if;
    if new.step = 'final_signoff' and f.second_yes_label is not null and new.second_yes_at is null then
      raise exception '% says yes too, or it waits', f.second_yes_label;
    end if;
    if new.step = 'publish' and not exists (select 1 from public.studio_film_posts p where p.film_id = f.id and p.removed_at is null) then
      raise exception 'record where it went out first';
    end if;
  else
    new.cut_id := null;
    new.cut_ids := null;
  end if;
  return new;
end $$;

create or replace function public.studio_film_people_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films%rowtype;
  card_changed boolean;
  pulled_last timestamptz;
  who text;
begin
  if tg_op = 'DELETE' then
    perform 1 from public.studio_films where id = old.film_id for update;
    if old.cleared_at is not null or old.consent_pulled_at is not null
       or exists (select 1 from public.studio_film_cuts c where c.film_id = old.film_id and old.id = any (c.people))
       or exists (select 1 from public.studio_reviews r where r.person_id = old.id) then
      raise exception 'a card that was cleared, pulled or put in a cut is kept';
    end if;
    return old;
  end if;
  -- A new card takes its person code's lock first (a pull of that code takes
  -- it too), then the film's row lock: one change to a film at a time.
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('studio.code:' || new.person_code, 0));
  end if;
  select * into f from public.studio_films where id = new.film_id for update;
  if tg_op = 'INSERT' then
    if new.cleared_at is not null or new.cleared_by is not null or new.consent_pulled_at is not null then
      raise exception 'a new card starts not cleared';
    end if;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    -- A pulled consent stays pulled: the code comes back only once its
    -- takedown is done, with the family's new consent recorded on the first
    -- card after the pull.
    pulled_last := (select max(x.consent_pulled_at) from public.studio_film_people x where x.person_code = new.person_code);
    if pulled_last is not null and not exists (
         select 1 from public.studio_film_people x
          where x.person_code = new.person_code and x.reconsent_note is not null and x.consent_pulled_at is null and x.created_at > pulled_last) then
      if exists (select 1 from public.studio_takedowns t where t.person_code = new.person_code and t.closed_at is null) then
        raise exception 'consent for % was pulled and its takedown is still open', new.person_code;
      end if;
      if new.reconsent_note is null then
        raise exception 'consent for % was pulled: a new card needs the family''s new consent, recorded by the producer', new.person_code;
      end if;
    elsif new.reconsent_note is not null then
      raise exception 'a new consent is recorded only for a code whose consent was pulled';
    end if;
    new.created_at := now();
    new.changed_by := null;
    new.last_changed_by := null;
    return new;
  end if;
  -- Who's making this change, said with it (never carried over).
  who := new.changed_by;
  new.changed_by := null;
  new.last_changed_by := coalesce(who, old.last_changed_by);

  if new.film_id <> old.film_id or new.person_code <> old.person_code or new.created_by <> old.created_by
     or new.reconsent_note is distinct from old.reconsent_note then
    raise exception 'a card keeps its film, its code, its author and its consent note';
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

  -- A card in something live doesn't change, or get uncleared, at all: take
  -- the post down or pull consent instead.
  if (card_changed or (new.cleared_at is null and old.cleared_at is not null))
     and exists (select 1 from public.studio_film_posts p join public.studio_film_cuts c on c.id = p.cut_id
                  where p.film_id = old.film_id and p.removed_at is null and old.id = any (c.people)) then
    raise exception 'the card for % is in something posted: take it down or pull consent instead', old.person_code;
  end if;
  if card_changed and who is null then
    raise exception 'who changed the card for %', old.person_code;
  end if;
  if card_changed and old.cleared_at is not null then
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
    if who is null then
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
    perform 1 from public.studio_films where id = old.film_id for update;
    if exists (select 1 from public.studio_reviews r where r.cut_id = old.id)
       or exists (select 1 from public.studio_film_posts p where p.cut_id = old.id) then
      raise exception 'a cut that went to review or out is kept';
    end if;
    return old;
  end if;
  -- The film's row lock first: one change to a film at a time.
  select * into f from public.studio_films where id = new.film_id for update;
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
    if new.status <> 'ready' or row(new.sha256, new.preview_sha256, new.preview_key, new.poster_key, new.slide_keys, new.bytes, new.duration_ms, new.width, new.height)
       is distinct from row(old.sha256, old.preview_sha256, old.preview_key, old.poster_key, old.slide_keys, old.bytes, old.duration_ms, old.width, old.height) then
      raise exception 'cut % is ready: its file stays as it was', old.id;
    end if;
  elsif new.status is distinct from old.status then
    if not ((old.status = 'uploaded' and new.status in ('processing', 'failed'))
         or (old.status = 'processing' and new.status in ('ready', 'failed', 'uploaded'))
         or (old.status = 'failed' and new.status = 'processing')) then
      raise exception 'cut % can''t go from % to %', old.id, old.status, new.status;
    end if;
    -- Nothing more is made for a closed film (a pull's sweep has run).
    if new.status in ('processing', 'ready') and (f.pulled_at is not null or f.archived_at is not null) then
      raise exception 'film % is closed: no more review copies', f.id;
    end if;
    -- A video's review copy and poster are named by the copy's fingerprint.
    if new.status = 'ready' and new.kind = 'video'
       and (new.preview_key is distinct from format('films/%s/previews/%s-%s.mp4', new.film_id, new.id, left(new.preview_sha256, 16))
            or new.poster_key is distinct from format('films/%s/previews/%s-%s.jpg', new.film_id, new.id, left(new.preview_sha256, 16))) then
      raise exception 'cut %''s review copy is kept under its own fingerprint', old.id;
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
  -- The film's row lock first: one change to a film at a time.
  select * into f from public.studio_films where id = new.film_id for update;
  select * into c from public.studio_film_cuts where id = new.cut_id;
  select * into p from public.studio_film_people where id = new.person_id;

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
       or p.cleared_at is null or p.consent_pulled_at is not null or f.pulled_at is not null or f.archived_at is not null
       or old.reviewer_email is distinct from p.reviewer_email or old.reviewer_relation is distinct from p.reviewer_relation
       or not public.studio_tool_on('review_copies') then
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
  -- The film's row lock first: one change to a film at a time.
  select * into f from public.studio_films where id = new.film_id for update;
  if tg_op = 'INSERT' then
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', new.film_id;
    end if;
    if new.removed_at is not null then
      raise exception 'a new post is live';
    end if;
    if not exists (select 1 from public.studio_film_steps s where s.film_id = new.film_id and s.step = 'final_signoff' and s.status = 'done') then
      raise exception 'nothing goes out before the final sign-off';
    end if;
    if not exists (select 1 from public.studio_film_steps s where s.film_id = new.film_id and s.step = 'final_signoff' and new.cut_id = any (s.cut_ids)) then
      raise exception 'only the cuts the final sign-off was for go out';
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
  -- The film's row lock first: one change to a film at a time; then the
  -- takedown's, so "the last line closes it" sees every other line.
  perform 1 from public.studio_films where id = new.film_id for update;
  perform 1 from public.studio_takedowns where id = new.takedown_id for update;
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

-- A changed or uncleared card stops its live review links: an approval comes
-- from the reviewer the card names now.
-- A pulled consent pulls the film, stops its live review links, lists its
-- files for removal from storage, and puts every live post of it on the
-- person's open takedown (one per person code), with a line for everything
-- outside the app.
create or replace function public.studio_people_cascade() returns trigger
language plpgsql set search_path = '' as $$
declare
  td uuid;
begin
  if old.consent_pulled_at is null and new.consent_pulled_at is null
     and (row(new.name, new.role, new.is_minor, new.texas_youth, new.speaker, new.release_on_file, new.covers,
              new.reviewer_relation, new.reviewer_name, new.reviewer_email)
          is distinct from row(old.name, old.role, old.is_minor, old.texas_youth, old.speaker, old.release_on_file, old.covers,
              old.reviewer_relation, old.reviewer_name, old.reviewer_email)
          or (new.cleared_at is null and old.cleared_at is not null)) then
    update public.studio_reviews set link_hash = null, expires_at = null, changed_by = coalesce(new.last_changed_by, 'the app'), updated_at = now()
     where person_id = new.id and link_hash is not null;
    return null;
  end if;
  if not (new.consent_pulled_at is not null and old.consent_pulled_at is null) then
    return null;
  end if;
  update public.studio_films set pulled_at = now(), updated_at = now() where id = new.film_id and pulled_at is null;
  insert into public.studio_storage_removals (key, reason)
  select k, 'consent_pulled' from public.studio_film_cuts c, lateral public.studio_cut_files(c) as k
   where c.film_id = new.film_id
  on conflict (key) do update set done_at = null, tries = 0
    where public.studio_storage_removals.done_at is not null;
  update public.studio_reviews set link_hash = null, expires_at = null, changed_by = new.pulled_by, updated_at = now()
   where film_id = new.film_id and link_hash is not null;
  select t.id into td from public.studio_takedowns t where t.person_code = new.person_code and t.closed_at is null
   order by t.requested_at desc limit 1 for update;
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

-- A step before the final sign-off reopened: Coach Hooks's yes was for the
-- cuts as they were, so it goes.
create or replace function public.studio_film_steps_after() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'done' and new.status = 'todo' and new.position < 9 then
    update public.studio_film_steps set second_yes_by = null, second_yes_note = null, updated_at = now()
     where film_id = new.film_id and step = 'final_signoff' and status = 'todo' and second_yes_by is not null;
  end if;
  return null;
end $$;

-- A deleted cut's files go on the removal list in the same change.
create or replace function public.studio_film_cuts_deleted() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.studio_storage_removals (key, reason)
  select k, 'cut_deleted' from public.studio_cut_files(old) as k
  on conflict (key) do nothing;
  return null;
end $$;

-- Review copies turned off: the live links stop (the copies they show are
-- what was turned off).
create or replace function public.studio_tool_approvals_after() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.tool = 'review_copies' and old.is_on and not new.is_on then
    perform 1 from public.studio_films f
     where f.id in (select r.film_id from public.studio_reviews r where r.link_hash is not null)
     order by f.id for update;
    update public.studio_reviews set link_hash = null, expires_at = null, changed_by = new.decided_by, updated_at = now()
     where link_hash is not null;
  end if;
  return null;
end $$;

-- Studio records are kept: no truncating them.
create or replace function public.studio_keep() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Studio records (%) are kept', tg_table_name;
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
-- function's owner, with its mark on); staff add notes. No names go in it: a
-- reviewer is written as who they are to the speaker, their note stays on
-- the review, and a staff note that names someone on the film's cards is
-- left out.
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
      k := 'film_unarchived'; bys := new.last_changed_by;
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
      k := 'person_uncleared'; bys := new.last_changed_by;
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
      k := 'review_' || new.decision;
      byr := case new.reviewer_relation when 'self' then 'the speaker' when 'parent' then 'their parent' else 'their guardian' end;
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
      k := 'takedown_opened'; bys := new.requested_by;
    elsif new.closed_at is not null and old.closed_at is null then
      k := 'takedown_closed'; bys := new.closed_by;
    end if;
  elsif tg_table_name = 'studio_takedown_items' then
    if tg_op = 'UPDATE' and new.done_at is not null and old.done_at is null then
      k := 'takedown_item_done'; fid := new.film_id; bys := new.done_by; subj := new.what; nt := new.note; rf := new.takedown_id;
    end if;
  end if;
  if k is not null then
    if nt is not null and public.studio_names_in(fid, nt) then
      nt := '(left out: it named someone on a card)';
    end if;
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
  if new.kind = 'note' and public.studio_names_in(new.film_id, new.note) then
    raise exception 'the history keeps no names: write the note with the code instead';
  end if;
  new.at := now();
  return new;
end $$;

create or replace trigger studio_tool_approvals_gate before insert or update or delete on public.studio_tool_approvals
  for each row execute function public.studio_tool_approvals_gate();
create or replace trigger studio_tool_approvals_log after update on public.studio_tool_approvals
  for each row execute function public.studio_log();
create or replace trigger studio_tool_approvals_then after update on public.studio_tool_approvals
  for each row execute function public.studio_tool_approvals_after();

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
create or replace trigger studio_film_steps_then after update on public.studio_film_steps
  for each row execute function public.studio_film_steps_after();

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
create or replace trigger studio_film_cuts_then after delete on public.studio_film_cuts
  for each row execute function public.studio_film_cuts_deleted();

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
do $$
declare
  t text;
begin
  foreach t in array array['studio_tool_approvals', 'studio_films', 'studio_film_steps', 'studio_film_people', 'studio_film_cuts',
                           'studio_reviews', 'studio_film_posts', 'studio_takedowns', 'studio_takedown_items', 'studio_storage_removals'] loop
    execute format('create or replace trigger %I before truncate on public.%I for each statement execute function public.studio_keep()', t || '_keep', t);
  end loop;
end $$;

-- ── What the server calls ─────────────────────────────────────────────────
-- What the reviewer's link shows: the cut to watch and what they approve.
-- p_proof is the link's proof (sha256 of the token); the table holds sha256
-- of that. Nothing for a link that's used, expired, cancelled or unknown, on
-- a film or card that's closed, for a reviewer the card no longer names, or
-- while review copies are off.
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
     and r.reviewer_email = p.reviewer_email and r.reviewer_relation = p.reviewer_relation
     and public.studio_tool_on('review_copies')
$$;

-- The reviewer's decision, in one statement: the gate checks the proof
-- against the link it burns, so a link works once and only for its holder.
-- The review's id, or no row when the link isn't active.
create or replace function public.studio_review_decide(p_proof text, p_decision text, p_name text, p_note text)
returns table (review_id uuid)
language sql volatile set search_path = '' as $$
  select set_config('studio.review_proof', coalesce(p_proof, ''), true);
  -- The film first (see the lock order at the top).
  select 1 from public.studio_films f
   where f.id = (select r.film_id from public.studio_reviews r
                  where r.link_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex'))
     for update;
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
     and r.reviewer_email = p.reviewer_email and r.reviewer_relation = p.reviewer_relation
     and public.studio_tool_on('review_copies')
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
  -- The code's lock first, so a card being added for it waits for the pull
  -- (and is then refused); then every film of the code, locked in one order,
  -- so two pulls never wait on each other the wrong way round.
  perform pg_advisory_xact_lock(hashtextextended('studio.code:' || code, 0));
  perform 1 from public.studio_films f
   where f.id in (select x.film_id from public.studio_film_people x where x.person_code = code and x.consent_pulled_at is null)
   order by f.id for update;
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
  perform 1 from public.studio_films where id = p_film for update;
  select position into target from public.studio_film_steps where film_id = p_film and step = p_step;
  if target is null then
    raise exception 'no such step';
  end if;
  for s in select step from public.studio_film_steps where film_id = p_film and position >= target and status = 'done' order by position desc loop
    update public.studio_film_steps set status = 'todo', changed_by = p_by, note = p_note, updated_at = now()
     where film_id = p_film and step = s.step;
  end loop;
end $$;

-- The single-row writes a cascade can also reach (see the lock order at the
-- top): each locks the film first, then makes the change. They return the
-- changed row, or nothing if it didn't match (already done, or changed
-- meanwhile).
create or replace function public.studio_card_save(p_person uuid, p_seen timestamptz, p_patch jsonb, p_by text)
returns setof public.studio_film_people
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_film_people where id = p_person);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query
  update public.studio_film_people x set
    name = case when p_patch ? 'name' then p_patch->>'name' else x.name end,
    role = case when p_patch ? 'role' then p_patch->>'role' else x.role end,
    is_minor = case when p_patch ? 'is_minor' then (p_patch->>'is_minor')::boolean else x.is_minor end,
    texas_youth = case when p_patch ? 'texas_youth' then (p_patch->>'texas_youth')::boolean else x.texas_youth end,
    speaker = case when p_patch ? 'speaker' then (p_patch->>'speaker')::boolean else x.speaker end,
    release_on_file = case when p_patch ? 'release_on_file' then (p_patch->>'release_on_file')::boolean else x.release_on_file end,
    covers = case when p_patch ? 'covers' then p_patch->'covers' else x.covers end,
    reviewer_relation = case when p_patch ? 'reviewer_relation' then p_patch->>'reviewer_relation' else x.reviewer_relation end,
    reviewer_name = case when p_patch ? 'reviewer_name' then p_patch->>'reviewer_name' else x.reviewer_name end,
    reviewer_email = case when p_patch ? 'reviewer_email' then p_patch->>'reviewer_email' else x.reviewer_email end,
    changed_by = p_by, updated_at = now()
   where x.id = p_person and x.updated_at = p_seen
  returning x.*;
end $$;

create or replace function public.studio_card_clear(p_person uuid, p_seen timestamptz, p_by text)
returns setof public.studio_film_people
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_film_people where id = p_person);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query
  update public.studio_film_people x set cleared_at = now(), cleared_by = p_by, updated_at = now()
   where x.id = p_person and x.updated_at = p_seen
  returning x.*;
end $$;

create or replace function public.studio_card_remove(p_person uuid)
returns setof uuid
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_film_people where id = p_person);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query delete from public.studio_film_people x where x.id = p_person returning x.id;
end $$;

create or replace function public.studio_step_done(p_film uuid, p_step text, p_by text, p_note text, p_cut_ids uuid[])
returns setof public.studio_film_steps
language plpgsql volatile set search_path = '' as $$
begin
  perform 1 from public.studio_films where id = p_film for update;
  return query
  update public.studio_film_steps s set status = 'done', done_by = p_by, note = p_note, cut_ids = p_cut_ids, updated_at = now()
   where s.film_id = p_film and s.step = p_step and s.status = 'todo'
  returning s.*;
end $$;

create or replace function public.studio_second_yes(p_film uuid, p_by text, p_note text)
returns setof public.studio_film_steps
language plpgsql volatile set search_path = '' as $$
begin
  perform 1 from public.studio_films where id = p_film for update;
  return query
  update public.studio_film_steps s set second_yes_by = p_by, second_yes_note = p_note, updated_at = now()
   where s.film_id = p_film and s.step = 'final_signoff' and s.status = 'todo'
  returning s.*;
end $$;

create or replace function public.studio_review_cancel(p_review uuid, p_by text)
returns setof public.studio_reviews
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_reviews where id = p_review);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query
  update public.studio_reviews r set link_hash = null, expires_at = null, changed_by = p_by, updated_at = now()
   where r.id = p_review and r.link_hash is not null and r.decision is null
  returning r.*;
end $$;

create or replace function public.studio_review_withdraw(p_review uuid, p_by text)
returns setof public.studio_reviews
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_reviews where id = p_review);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query
  update public.studio_reviews r set withdrawn_at = now(), withdrawn_by = p_by, updated_at = now()
   where r.id = p_review and r.decision = 'approved' and r.withdrawn_at is null
  returning r.*;
end $$;

-- A post coming down ticks its line on every takedown that lists it (two
-- people in one film, both pulled): those takedowns are locked first, in id
-- order, so two of these at once never wait on each other the wrong way round.
create or replace function public.studio_post_remove(p_post uuid, p_by text)
returns setof public.studio_film_posts
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_film_posts where id = p_post);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  perform 1 from public.studio_takedowns t
   where t.id in (select i.takedown_id from public.studio_takedown_items i where i.post_id = p_post and i.done_at is null)
   order by t.id for update;
  return query
  update public.studio_film_posts po set removed_at = now(), removed_by = p_by
   where po.id = p_post and po.removed_at is null
  returning po.*;
end $$;

create or replace function public.studio_takedown_item_done(p_item uuid, p_by text, p_note text)
returns setof public.studio_takedown_items
language plpgsql volatile set search_path = '' as $$
declare
  it record;
begin
  select film_id, takedown_id, post_id into it from public.studio_takedown_items where id = p_item;
  if it.film_id is null then return; end if;
  perform 1 from public.studio_films where id = it.film_id for update;
  -- A post's line coming down takes the post down, which ticks that post's
  -- lines on other takedowns: this one and those are locked now, in id order.
  perform 1 from public.studio_takedowns t
   where t.id = it.takedown_id
      or (it.post_id is not null and t.id in (select i.takedown_id from public.studio_takedown_items i where i.post_id = it.post_id and i.done_at is null))
   order by t.id for update;
  return query
  update public.studio_takedown_items i set done_at = now(), done_by = p_by, note = p_note
   where i.id = p_item and i.done_at is null
  returning i.*;
end $$;

-- The files due for removal, oldest first. A left-over that a ready cut of
-- an open film lists is kept, and marked done: copies are named by their
-- content, so an attempt that failed can leave the very keys the next
-- attempt made ready. A pull's and a deleted cut's are never kept back.
create or replace function public.studio_removals_due(p_limit int)
returns setof public.studio_storage_removals
language plpgsql volatile set search_path = '' as $$
begin
  update public.studio_storage_removals r set done_at = now(), last_error = 'kept: a ready cut uses it'
   where r.done_at is null and r.reason = 'left_over'
     and exists (select 1 from public.studio_film_cuts c join public.studio_films f on f.id = c.film_id
                  where c.status = 'ready' and f.pulled_at is null and r.key in (select public.studio_cut_files(c)));
  return query select r.* from public.studio_storage_removals r where r.done_at is null
                order by r.requested_at limit least(greatest(coalesce(p_limit, 500), 1), 1000);
end $$;

-- A takedown with nothing left to do closes (the last line usually closes it;
-- this is the worker's safety net). Returns how many it closed.
create or replace function public.studio_close_finished_takedowns()
returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int := 0;
  tid uuid;
begin
  -- One at a time: a takedown that someone is changing right now is left
  -- for the next pass, and so is one that got a new line meanwhile (looked
  -- at again once it's locked), so one busy takedown never stops the others.
  for tid in
    select t.id from public.studio_takedowns t
     where t.closed_at is null
       and not exists (select 1 from public.studio_takedown_items i where i.takedown_id = t.id and i.done_at is null)
     order by t.id
  loop
    perform 1 from public.studio_takedowns t where t.id = tid and t.closed_at is null for update skip locked;
    continue when not found;
    continue when exists (select 1 from public.studio_takedown_items i where i.takedown_id = tid and i.done_at is null);
    update public.studio_takedowns t set closed_at = now(), closed_by = 'the app' where t.id = tid;
    n := n + 1;
  end loop;
  return n;
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
    'public.studio_names_in(uuid, text)', 'public.studio_cut_files(public.studio_film_cuts)', 'public.studio_film_steps_after()',
    'public.studio_film_cuts_deleted()', 'public.studio_tool_approvals_after()', 'public.studio_keep()',
    'public.studio_card_save(uuid, timestamptz, jsonb, text)', 'public.studio_card_clear(uuid, timestamptz, text)',
    'public.studio_card_remove(uuid)', 'public.studio_step_done(uuid, text, text, text, uuid[])',
    'public.studio_second_yes(uuid, text, text)', 'public.studio_review_cancel(uuid, text)',
    'public.studio_review_withdraw(uuid, text)', 'public.studio_post_remove(uuid, text)',
    'public.studio_takedown_item_done(uuid, text, text)', 'public.studio_close_finished_takedowns()', 'public.studio_removals_due(int)',
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
        'public.studio_takedown_items, public.studio_events, public.studio_storage_removals from %I', r);
      execute format('revoke all on sequence public.studio_events_id_seq from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    -- The server reads and writes rows; it never empties a table, hangs a
    -- trigger on one, or points a foreign key at one.
    execute 'revoke truncate, trigger, references on public.studio_tool_approvals, public.studio_films, public.studio_film_steps, '
      'public.studio_film_people, public.studio_film_cuts, public.studio_reviews, public.studio_film_posts, public.studio_takedowns, '
      'public.studio_takedown_items, public.studio_events, public.studio_storage_removals from service_role';
    execute 'grant execute on function public.studio_review_for_reviewer(text) to service_role';
    execute 'grant execute on function public.studio_review_decide(text, text, text, text) to service_role';
    execute 'grant execute on function public.studio_pull_consent(text, text, text, text) to service_role';
    execute 'grant execute on function public.studio_film_reopen(uuid, text, text, text) to service_role';
    execute 'grant execute on function public.studio_cut_approved(uuid) to service_role';
    execute 'grant execute on function public.studio_tool_on(text) to service_role';
    -- Called by the gates and the cascade, which run as the caller.
    execute 'grant execute on function public.studio_names_in(uuid, text) to service_role';
    execute 'grant execute on function public.studio_cut_files(public.studio_film_cuts) to service_role';
    execute 'grant execute on function public.studio_card_save(uuid, timestamptz, jsonb, text), public.studio_card_clear(uuid, timestamptz, text), '
      'public.studio_card_remove(uuid), public.studio_step_done(uuid, text, text, text, uuid[]), public.studio_second_yes(uuid, text, text), '
      'public.studio_review_cancel(uuid, text), public.studio_review_withdraw(uuid, text), public.studio_post_remove(uuid, text), '
      'public.studio_takedown_item_done(uuid, text, text), public.studio_close_finished_takedowns(), public.studio_removals_due(int) to service_role';
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
