-- 041: Studio real words, three directions and the taste library
-- (routes/studio-words.js, routes/studio-taste.js, routes/studio-agents.js,
-- agents/studio-words, agents/studio-directions, agents/studio-brief;
-- docs/studio-films.md). Builds on 039 and 040. Service role only.
--
--   * A transcript is one speaker's own words from the edit (DaVinci
--     Resolve's export, read in the browser: only that speaker's cues reach
--     the server). Adults first: a minor's words wait for a later review.
--     The speaker's card is cleared, their release covers their voice and
--     their consent stands. A pulled consent, a card corrected to a minor, or
--     a release that stops covering their voice deletes their transcripts,
--     and with them every line picked from them and anything built on those
--     lines.
--   * A line is kept only as the transcript has it: the exact words, inside
--     the cues it names, with its times inside those cues. The server works
--     the times out (public/app/transcript-parse.js); this checks them.
--     Writes take the film's lock first (migration 039's order).
--   * Claude reads a transcript only while "Claude reads transcripts" is on
--     (studio_tool_approvals, migration 039): the server checks it.
--   * The taste library is notes on work worth learning from, with a link to
--     it: never a photo or a copy of it.
--   * A brief that came back is started or set aside; Today lists the rest.
--   * Three directions for a film: what came back, and the one picked.

-- ── Transcripts ───────────────────────────────────────────────────────────
create table if not exists public.studio_transcripts (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  person_id uuid not null references public.studio_film_people(id) on delete cascade,
  -- "Interview 1", "Sunday sit-down": never a name (the gate checks it).
  label text not null check (char_length(btrim(label)) between 1 and 60),
  frames boolean not null default false,
  fps numeric(6, 3) check (fps is null or fps in (23.976, 24, 25, 29.97, 30, 50, 59.94, 60)),
  -- DF timecode (";" before the frames: 29.97 and 59.94 skip some frame
  -- labels), as the file had it.
  df_timecode boolean not null default false,
  -- [{ n, s, e, t, gap }]: the cue's number (1, 2, ...), its start and end
  -- in milliseconds, and its words; gap: true when it comes after someone
  -- else's words (a question the browser left out) or a long pause, which a
  -- line never reaches across.
  cues jsonb not null check (jsonb_typeof(cues) = 'array' and jsonb_array_length(cues) between 1 and 5000),
  cue_count int not null,
  words int not null check (words >= 0),
  duration_ms int not null check (duration_ms between 0 and 36000000),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  constraint studio_transcripts_fps check ((fps is not null) = frames),
  constraint studio_transcripts_df check (not df_timecode or fps in (29.97, 59.94))
);
create index if not exists studio_transcripts_film_idx on public.studio_transcripts (film_id, created_at);
create index if not exists studio_transcripts_person_idx on public.studio_transcripts (person_id);
alter table public.studio_transcripts enable row level security;

-- ── Lines, structures, cutdowns, captions ─────────────────────────────────
--   line       a strongest line, and why
--   structure  a way to build the film: a name, a logline, and its beats
--   cutdown    a short cut: a name, why, and its beats (the first one is the
--              hook, which lands in the first two seconds)
--   beat       one line of a structure or a cutdown, in order, with what we
--              see under it
--   caption    the post's words, under 60, opening on the speaker's line
create table if not exists public.studio_words (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  kind text not null check (kind in ('line', 'structure', 'cutdown', 'beat', 'caption')),
  transcript_id uuid references public.studio_transcripts(id) on delete cascade,
  person_id uuid references public.studio_film_people(id) on delete cascade,
  group_id uuid references public.studio_words(id) on delete cascade,
  position smallint check (position is null or position between 1 and 12),
  from_cue int check (from_cue is null or from_cue >= 1),
  to_cue int check (to_cue is null or to_cue >= 1),
  quote text check (quote is null or char_length(quote) between 1 and 2000),
  start_ms int check (start_ms is null or start_ms between 0 and 36000000),
  end_ms int check (end_ms is null or end_ms between 0 and 36000000),
  title text check (title is null or char_length(btrim(title)) between 1 and 80),
  note text check (note is null or char_length(btrim(note)) between 1 and 300),
  text text check (text is null or char_length(text) between 1 and 1500),
  -- The agent run that picked it (agent_runs); null when a person did.
  run_id uuid references public.agent_runs(id) on delete set null,
  made_by text not null check (made_by = 'claude' or char_length(made_by) between 3 and 200),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  constraint studio_words_quoted check (
    (kind in ('line', 'beat', 'caption')) = (transcript_id is not null)
    and (transcript_id is null) = (quote is null) and (quote is null) = (from_cue is null)
    and (from_cue is null) = (to_cue is null) and (to_cue is null) = (start_ms is null)
    and (start_ms is null) = (end_ms is null)),
  constraint studio_words_beat check ((kind = 'beat') = (group_id is not null) and (group_id is null) = (position is null)),
  constraint studio_words_header check ((kind in ('structure', 'cutdown')) = (title is not null)),
  constraint studio_words_caption check ((kind = 'caption') = (text is not null))
);
create index if not exists studio_words_film_idx on public.studio_words (film_id, created_at);
create index if not exists studio_words_transcript_idx on public.studio_words (transcript_id) where transcript_id is not null;
create index if not exists studio_words_person_idx on public.studio_words (person_id) where person_id is not null;
create unique index if not exists studio_words_beat_place on public.studio_words (group_id, position) where group_id is not null;
alter table public.studio_words enable row level security;

-- ── The taste library ─────────────────────────────────────────────────────
-- Notes on work worth learning from (a film, a cut, a look, a sound, a
-- graphic, a caption) and a link to it. Never a photo of it: a link to an
-- image file is refused. Briefs cite an entry as "Taste <ref_no>", so an
-- entry is archived, never deleted.
create table if not exists public.studio_taste (
  id uuid primary key default gen_random_uuid(),
  ref_no int generated always as identity unique,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  url text not null check (char_length(url) <= 500 and url ~ '^https://[^\s/?#]+\.[^\s/?#]+([/?#]\S*)?$'
    and url !~* '\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)([?#]\S*)?$'),
  kind text not null default 'film' check (kind in ('film', 'cut', 'look', 'sound', 'graphic', 'caption', 'other')),
  note text not null check (char_length(btrim(note)) between 1 and 1000),
  take text check (take is null or char_length(btrim(take)) between 1 and 500),
  leave text check (leave is null or char_length(btrim(leave)) between 1 and 500),
  tags text[] not null default '{}' check (cardinality(tags) <= 8),
  search tsvector,
  added_by text not null check (char_length(added_by) between 3 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by text check (archived_by is null or char_length(archived_by) between 3 and 200),
  constraint studio_taste_archived_whole check ((archived_at is null) = (archived_by is null))
);
create index if not exists studio_taste_search_idx on public.studio_taste using gin (search);
create index if not exists studio_taste_tags_idx on public.studio_taste using gin (tags);
create index if not exists studio_taste_recent_idx on public.studio_taste (created_at desc) where archived_at is null;
alter table public.studio_taste enable row level security;

-- ── Briefs started or set aside ───────────────────────────────────────────
create table if not exists public.studio_brief_marks (
  brief_run_id uuid primary key references public.agent_runs(id) on delete cascade,
  started_run_id uuid references public.agent_runs(id) on delete set null,
  direction smallint check (direction is null or direction between 1 and 3),
  started_by text check (started_by is null or char_length(started_by) between 3 and 200),
  started_at timestamptz,
  set_aside_by text check (set_aside_by is null or char_length(set_aside_by) between 3 and 200),
  set_aside_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint studio_brief_marks_started_whole check ((started_at is null) = (started_by is null)),
  constraint studio_brief_marks_set_aside_whole check ((set_aside_at is null) = (set_aside_by is null)),
  constraint studio_brief_marks_something check (started_at is not null or set_aside_at is not null)
);
alter table public.studio_brief_marks enable row level security;

-- ── Three directions for a film ───────────────────────────────────────────
create table if not exists public.studio_film_directions (
  id uuid primary key default gen_random_uuid(),
  film_id uuid not null references public.studio_films(id) on delete restrict,
  run_id uuid references public.agent_runs(id) on delete set null,
  directions jsonb not null check (jsonb_typeof(directions) = 'array' and jsonb_array_length(directions) = 3),
  recommended smallint check (recommended is null or recommended between 1 and 3),
  why_recommended text check (why_recommended is null or char_length(why_recommended) between 1 and 300),
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) <= 3),
  picked smallint check (picked is null or picked between 1 and 3),
  picked_by text check (picked_by is null or char_length(picked_by) between 3 and 200),
  picked_at timestamptz,
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now(),
  constraint studio_film_directions_picked_whole check ((picked is null) = (picked_by is null) and (picked_by is null) = (picked_at is null))
);
create index if not exists studio_film_directions_film_idx on public.studio_film_directions (film_id, created_at desc);
alter table public.studio_film_directions enable row level security;

-- ── A film's agent runs ───────────────────────────────────────────────────
-- Which agent_runs rows are this film's (the Real-Words Editor, Three
-- Directions), so the room can show what's running. A words run's row keeps
-- no words: its output is counts, its trace only which tools ran.
create table if not exists public.studio_film_runs (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  film_id uuid not null references public.studio_films(id) on delete restrict,
  kind text not null check (kind in ('words', 'directions')),
  created_by text not null check (char_length(created_by) between 3 and 200),
  created_at timestamptz not null default now()
);
create index if not exists studio_film_runs_film_idx on public.studio_film_runs (film_id, created_at desc);
alter table public.studio_film_runs enable row level security;

-- One words run and one directions run at a time for a film: under the
-- film's row lock, the check and the run's two rows in one step (a run
-- quiet for 90 minutes counts as ended).
create or replace function public.studio_film_run_start(p_film uuid, p_kind text, p_role text, p_task text, p_by text)
returns table (run_id uuid)
language plpgsql volatile set search_path = '' as $$
declare
  f public.studio_films;
  r uuid;
begin
  select * into f from public.studio_films where id = p_film for update;
  if f.id is null then
    raise exception 'no film %', p_film;
  end if;
  if f.pulled_at is not null or f.archived_at is not null then
    raise exception 'film % is closed', f.id;
  end if;
  if exists (select 1 from public.studio_film_runs x join public.agent_runs a on a.id = x.run_id
              where x.film_id = p_film and x.kind = p_kind and a.status = 'running' and a.created_at > now() - interval '90 minutes') then
    raise exception 'already running: a % run is going for this film', p_kind;
  end if;
  insert into public.agent_runs (role, client_id, task, status, created_by) values (p_role, null, p_task, 'running', p_by) returning id into r;
  insert into public.studio_film_runs (run_id, film_id, kind, created_by) values (r, p_film, p_kind, p_by);
  return query select r;
end $$;

-- ── Gates ─────────────────────────────────────────────────────────────────
-- Whose words can be kept: an adult speaker whose card is cleared, whose
-- release covers their voice, and whose consent stands. null when they can
-- be, otherwise why not.
create or replace function public.studio_words_why_not(p public.studio_film_people) returns text
language sql immutable set search_path = '' as $$
  select case
    when p.id is null then 'not on this film'
    when p.is_minor then 'adults first: a minor''s words wait for a later review'
    when not p.speaker then 'their card doesn''t say they speak in the film'
    when p.consent_pulled_at is not null then 'their consent was pulled'
    when p.cleared_at is null then 'their card isn''t cleared'
    when coalesce(p.covers->>'voice', 'false') <> 'true' then 'their release doesn''t cover their voice'
    else null end
$$;

-- Whether a quote is in a text from a whole word to a whole word: not
-- inside "4.4", "1,000", "5:30", "can't" (or "can´t", "can′t"),
-- "well-known" or "1990–95" (public/app/transcript-parse.js JOIN).
create or replace function public.studio_quote_whole(p_text text, p_quote text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  n int := char_length(coalesce(p_quote, ''));
  off int := 0;
  p int;
  w text := '^[[:alnum:]À-ÖØ-öø-ɏͰ-ϿЀ-ӿ]$';
  j text := '^[.,''’‘`/:´′ʼ＇‐‑‒–—―-]$';
  b1 text;
  b2 text;
  a1 text;
  a2 text;
begin
  if n = 0 or p_text is null then
    return false;
  end if;
  loop
    p := position(p_quote in substr(p_text, off + 1));
    exit when p = 0;
    p := p + off;
    b1 := case when p > 1 then substr(p_text, p - 1, 1) else '' end;
    b2 := case when p > 2 then substr(p_text, p - 2, 1) else '' end;
    a1 := substr(p_text, p + n, 1);
    a2 := substr(p_text, p + n + 1, 1);
    if b1 !~ w and not (b1 ~ j and b2 ~ w) and a1 !~ w and not (a1 ~ j and a2 ~ w) then
      return true;
    end if;
    off := p;
  end loop;
  return false;
end $$;

-- One word of a minor's name on the film's cards (not an everyday word) run
-- into another word, where it's the name for certain without an English
-- word list: where camelCase starts and ends it ("#PrayForJamie",
-- "JamieStrong", "#PrayForKai", "KaiStrong": three letters or more), or,
-- four letters or more, with only words a tag or a file name runs a name
-- into on either side ("#teamjamie", "jamiestrong", "#prayforjamie",
-- "jamiequote", "#letsgojamie", "#bigjamieenergy"). The app reads more, with English words
-- (utils/studio-films.js minorRunIns: "#jordanfootball", "#bigjamieenergy"),
-- and it holds a card back, or takes a corrected minor's lines with them,
-- for what it reads (routes/studio-films.js keptRunIns); an English word
-- that holds a name ("island" for an Isla) is asked there and kept once the
-- writer says it isn't one, so it's never read here. utils/studio-words.js
-- runIns: a three-letter one in a lower-case tag is asked about. 039's
-- studio_names_in reads whole words.
create or replace function public.studio_minor_run_in(p_film uuid, p_text text) returns boolean
language sql stable set search_path = '' as $$
  with w as (
    select distinct x as word
      from public.studio_film_people p, lateral regexp_split_to_table(lower(p.name), '[^[:alpha:]]+') as x
     where p.film_id = p_film and p.is_minor and char_length(x) >= 3
       and not (x = any (array[
         'ace', 'april', 'archer', 'art', 'ash', 'august', 'autumn', 'baker', 'bear', 'bell', 'best', 'bill', 'bird',
         'bishop', 'black', 'bliss', 'blue', 'bond', 'booth', 'brook', 'brooks', 'brown', 'buck', 'buddy', 'bush',
         'butler', 'carter', 'case', 'cash', 'chance', 'chase', 'church', 'clay', 'cliff', 'colt', 'cook', 'cooper',
         'crow', 'dale', 'dash', 'dawn', 'day', 'deal', 'dean', 'don', 'dot', 'dove', 'drew', 'duke', 'dusty', 'early',
         'earl', 'echo', 'eve', 'fair', 'faith', 'fern', 'field', 'fields', 'fisher', 'flint', 'ford', 'forest', 'fox',
         'frank', 'free', 'frost', 'gale', 'gene', 'gold', 'golden', 'grace', 'grant', 'gray', 'green', 'grey', 'guy',
         'hall', 'hardy', 'hart', 'haven', 'hawk', 'hazel', 'heath', 'hero', 'hill', 'hills', 'holly', 'honey',
         'honor', 'hood', 'hope', 'house', 'hunt', 'hunter', 'ivy', 'jack', 'jade', 'jay', 'jet', 'jewel', 'joy',
         'judge', 'june', 'justice', 'kind', 'king', 'kit', 'knight', 'lake', 'lance', 'lane', 'lark', 'laurel',
         'legend', 'liberty', 'light', 'lily', 'link', 'long', 'lord', 'love', 'lucky', 'major', 'march', 'mark',
         'marsh', 'mason', 'max', 'may', 'meadow', 'mercy', 'miles', 'misty', 'moon', 'noble', 'north', 'ocean',
         'page', 'park', 'pat', 'patience', 'peace', 'pearl', 'penny', 'pepper', 'pierce', 'piper', 'pope', 'porter',
         'power', 'price', 'pride', 'prince', 'queen', 'rain', 'ranger', 'raven', 'ray', 'read', 'rebel', 'reed',
         'rice', 'rich', 'ridge', 'river', 'rob', 'rock', 'rocky', 'rose', 'royal', 'ruby', 'rush', 'rusty', 'sage',
         'saint', 'sandy', 'scout', 'shade', 'shadow', 'shepherd', 'shore', 'short', 'silver', 'sky', 'small', 'smith',
         'snow', 'sonny', 'south', 'spring', 'star', 'steel', 'sterling', 'stone', 'storm', 'stormy', 'strong', 'sue',
         'summer', 'sunday', 'sunny', 'sweet', 'swift', 'tad', 'tank', 'true', 'trust', 'tucker', 'valor', 'violet',
         'wade', 'walker', 'ward', 'warren', 'waters', 'way', 'wells', 'west', 'white', 'will', 'willow', 'winter',
         'wise', 'wolf', 'wood', 'woods', 'worth', 'wren', 'young',
         'amber', 'angel', 'carol', 'christian', 'crystal', 'daisy', 'destiny', 'genesis', 'glen', 'harmony', 'iris', 'jasmine',
         'journey', 'lyric', 'melody', 'olive', 'robin', 'trinity']))
  ), beside as (
    -- utils/studio-films.js runBeside: the file words, the tags' last words,
    -- and the words a tag starts a name with.
    select b from unnest(array[
      'quote', 'quotes', 'card', 'cards', 'promo', 'promos', 'cut', 'cuts', 'edit', 'edits', 'final', 'finals', 'reel', 'reels', 'slide', 'slides',
      'story', 'stories', 'clip', 'clips', 'cover', 'covers', 'title', 'titles', 'draft', 'drafts', 'strong', 'team', 'hero', 'heroes', 'teaser',
      'teasers', 'trailer', 'intro', 'outro', 'broll', 'bts', 'vo', 'mix', 'master', 'export', 'exports', 'select', 'selects', 'graphic', 'graphics',
      'gfx', 'thumb', 'thumbs', 'thumbnail', 'poster', 'posters', 'still', 'stills', 'photo', 'photos', 'pic', 'pics', 'carousel', 'post', 'posts',
      'short', 'shorts', 'frame', 'frames', 'spot', 'spots', 'sizzle', 'recap', 'highlight', 'highlights', 'feature', 'profile', 'interview',
      'interviews', 'sitdown',
      'nation', 'fam', 'family', 'gang', 'forever', 'crew', 'squad', 'army', 'pride', 'power', 'time', 'era', 'way', 'life', 'season', 'szn', 'mode',
      'legacy', 'love', 'fans', 'stan', 'club', 'world', 'vibes', 'energy', 'effect', 'magic', 'made', 'proud', 'hype', 'goat', 'goats',
      'go', 'letsgo', 'gogo', 'pray', 'prayfor', 'thanks', 'thankyou', 'welove', 'weloveyou', 'thegoat', 'allday', 'happy', 'happybirthday', 'birthday', 'bday', 'congrats', 'congratulations', 'proudof',
      'proudofyou', 'coach', 'dear', 'hey', 'shoutout', 'welcome', 'free', 'justice', 'lil', 'big', 'our', 'my', 'iloveyou', 'loveyou', 'missyou',
      'ilove', 'rip', 'day', 'week', 'night', 'watch', 'game', 'games', 'show', 'hoops', 'ball', 'bball', 'mvp']) as b
  ), hay as (
    select ' ' || btrim(regexp_replace(lower(regexp_replace(coalesce(p_text, ''), '([[:lower:]])([[:upper:]])', '\1 \2', 'g')), '[^[:alpha:]]+', ' ', 'g')) || ' ' as split,
           ' ' || btrim(regexp_replace(lower(coalesce(p_text, '')), '[^[:alpha:]]+', ' ', 'g')) || ' ' as plain
  ), alt as (
    select '(?:' || string_agg(b, '|' order by char_length(b) desc) || ')*' as a from beside
  )
  -- A name's letters first (cheap), then the pattern, built once.
  select p_text is not null and exists (
    select 1 from w, hay, alt
     where strpos(hay.plain, w.word) > 0
       and (hay.split like '% ' || w.word || ' %'
            or char_length(w.word) >= 4 and hay.plain ~ (' ' || alt.a || w.word || alt.a || ' ')))
$$;

create or replace function public.studio_transcripts_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films;
  p public.studio_film_people;
  why text;
  i int := 0;
  x jsonb;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if row(new.film_id, new.person_id, new.frames, new.fps, new.df_timecode, new.cues, new.cue_count, new.words, new.duration_ms, new.created_by, new.created_at)
       is distinct from row(old.film_id, old.person_id, old.frames, old.fps, old.df_timecode, old.cues, old.cue_count, old.words, old.duration_ms, old.created_by, old.created_at) then
      raise exception 'a transcript is kept as it came: remove it and add it again';
    end if;
    if public.studio_names_in(new.film_id, new.label) then
      raise exception 'a transcript''s label keeps no names: write the code instead';
    end if;
    return new;
  end if;
  -- The film's row lock first (migration 039's order).
  select * into f from public.studio_films where id = new.film_id for update;
  if f.id is null then
    raise exception 'no film %', new.film_id;
  end if;
  if f.pulled_at is not null or f.archived_at is not null then
    raise exception 'film % is closed', f.id;
  end if;
  select * into p from public.studio_film_people where id = new.person_id and film_id = new.film_id;
  why := public.studio_words_why_not(p);
  if why is not null then
    raise exception 'their words can''t be kept: %', why;
  end if;
  if public.studio_names_in(new.film_id, new.label) then
    raise exception 'a transcript''s label keeps no names: write the code instead';
  end if;
  for x in select value from jsonb_array_elements(new.cues) loop
    i := i + 1;
    if jsonb_typeof(x) <> 'object' or jsonb_typeof(x->'n') <> 'number' or jsonb_typeof(x->'s') <> 'number'
       or jsonb_typeof(x->'e') <> 'number' or jsonb_typeof(x->'t') <> 'string'
       or (x->>'n')::numeric <> i or (x->>'s')::numeric < 0 or (x->>'e')::numeric < (x->>'s')::numeric
       or (x->>'e')::numeric > 36000000 or char_length(x->>'t') not between 1 and 2000
       or (x->>'s')::numeric <> round((x->>'s')::numeric) or (x->>'e')::numeric <> round((x->>'e')::numeric)
       or (x ? 'gap' and jsonb_typeof(x->'gap') <> 'boolean') then
      raise exception 'cue % isn''t a numbered cue with its times and words', i;
    end if;
  end loop;
  new.cue_count := i;
  new.created_at := now();
  return new;
end $$;

create or replace function public.studio_words_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films;
  tr public.studio_transcripts;
  p public.studio_film_people;
  g public.studio_words;
  why text;
  joined text;
  s_from int;
  e_to int;
  n_words int;
begin
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- Only the run that picked it may go (its agent_runs row deleted).
    if new.run_id is null and old.run_id is not null and (to_jsonb(new) - 'run_id') = (to_jsonb(old) - 'run_id') then
      return new;
    end if;
    raise exception 'a line is kept as it was picked: remove it and pick again';
  end if;
  select * into f from public.studio_films where id = new.film_id for update;
  if f.id is null then
    raise exception 'no film %', new.film_id;
  end if;
  if f.pulled_at is not null or f.archived_at is not null then
    raise exception 'film % is closed', f.id;
  end if;
  -- Words in our own voice (a title, a note, a caption): no names.
  if public.studio_names_in(new.film_id, new.title) or public.studio_names_in(new.film_id, new.note)
     or public.studio_minor_run_in(new.film_id, concat_ws(' ', new.title, new.note)) then
    raise exception 'what''s written about a line keeps no names: write the code or the role instead';
  end if;
  if new.kind in ('structure', 'cutdown') then
    new.person_id := null;
    new.created_at := now();
    return new;
  end if;
  if new.kind = 'beat' then
    select * into g from public.studio_words where id = new.group_id;
    if g.id is null or g.film_id <> new.film_id or g.kind not in ('structure', 'cutdown') then
      raise exception 'a beat belongs to a structure or a cutdown of its film';
    end if;
  end if;
  select * into tr from public.studio_transcripts where id = new.transcript_id;
  if tr.id is null or tr.film_id <> new.film_id then
    raise exception 'a line comes from one of its film''s transcripts';
  end if;
  select * into p from public.studio_film_people where id = tr.person_id;
  why := public.studio_words_why_not(p);
  if why is not null then
    raise exception 'their words can''t be used: %', why;
  end if;
  new.person_id := tr.person_id;
  if new.from_cue > new.to_cue or new.to_cue > tr.cue_count or new.to_cue - new.from_cue > 11 then
    raise exception 'a line names cues % to % of its transcript (it has %)', new.from_cue, new.to_cue, tr.cue_count;
  end if;
  select string_agg(x->>'t', ' ' order by (x->>'n')::int) into joined
    from jsonb_array_elements(tr.cues) as x
   where (x->>'n')::int between new.from_cue and new.to_cue;
  if joined is null or not public.studio_quote_whole(joined, new.quote) then
    raise exception 'a line is the speaker''s exact words, in the cues it names, from a whole word to a whole word';
  end if;
  -- Never across someone else's words (a question left out), a long pause,
  -- or words the transcript marks as missing.
  if exists (select 1 from jsonb_array_elements(tr.cues) as x
              where (x->>'n')::int > new.from_cue and (x->>'n')::int <= new.to_cue and x->>'gap' = 'true') then
    raise exception 'a line doesn''t reach across someone else''s words or a long pause';
  end if;
  if position(U&'\27E8\2026\27E9' in new.quote) > 0 then
    raise exception 'a line doesn''t reach across words the transcript marks as missing';
  end if;
  select (x->>'s')::int into s_from from jsonb_array_elements(tr.cues) as x where (x->>'n')::int = new.from_cue;
  select (x->>'e')::int into e_to from jsonb_array_elements(tr.cues) as x where (x->>'n')::int = new.to_cue;
  if new.start_ms > new.end_ms or new.start_ms < s_from or new.end_ms > e_to then
    raise exception 'a line''s times are inside its cues';
  end if;
  if public.studio_names_in(new.film_id, new.quote) or public.studio_minor_run_in(new.film_id, new.quote) then
    raise exception 'that line names someone on the film''s cards: pick another';
  end if;
  if new.kind = 'caption' then
    if public.studio_names_in(new.film_id, new.text) or public.studio_minor_run_in(new.film_id, new.text) then
      raise exception 'a caption keeps no names beyond what the speaker said';
    end if;
    if left(new.text, char_length(new.quote) + 2) <> '“' || new.quote || '”' then
      raise exception 'a caption opens on the speaker''s own line, in quotes';
    end if;
    -- Words as the app counts them: letters and numbers, an apostrophe
    -- inside a word kept ("don't").
    select count(*) into n_words from regexp_matches(translate(new.text, '’', ''''), '[[:alnum:]]+(''[[:alnum:]]+)*', 'g');
    if n_words >= 60 then
      raise exception 'a caption is under 60 words (this one has %)', n_words;
    end if;
  end if;
  new.created_at := now();
  return new;
end $$;

-- A structure or a cutdown is built from its lines: when one of them goes
-- (a consent pulled, a transcript removed), the whole of it goes.
create or replace function public.studio_words_gone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.kind = 'beat' then
    delete from public.studio_words where id = old.group_id;
  end if;
  return null;
end $$;

-- Their words go when they can't be kept any more: consent pulled, the card
-- corrected to a minor, no longer a speaker, or the release no longer
-- covering their voice. (A card waiting to be cleared again keeps them, but
-- nothing is picked from them or read by Claude until it is.)
create or replace function public.studio_people_words() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.consent_pulled_at is not null and old.consent_pulled_at is null)
     or (new.is_minor and not old.is_minor)
     or (old.speaker and not new.speaker)
     or (coalesce(old.covers->>'voice', 'false') = 'true' and coalesce(new.covers->>'voice', 'false') <> 'true')
     or (old.release_on_file and not new.release_on_file) then
    delete from public.studio_transcripts where person_id = new.id;
  end if;
  return null;
end $$;

-- A card added or renamed is read against what the film keeps in words: a
-- kept line, caption, title or note, a transcript's label, or the
-- directions. If any names this person, the card waits until those are
-- removed (Real words), as the title and the story do, and the refusal says
-- which. A card corrected to a minor is the safety step itself, so it never
-- waits: what names them goes with it (lines and directions; a label is
-- given the transcript's own code). Runs after studio_people_words (its
-- name sorts after it), so their own transcripts and lines are gone first.
create or replace function public.studio_people_kept_names() returns trigger
language plpgsql set search_path = '' as $$
declare
  words_in text := 'select 1';
begin
  if tg_op = 'UPDATE' and row(new.name, new.reviewer_name, new.is_minor) is not distinct from row(old.name, old.reviewer_name, old.is_minor) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.is_minor and not old.is_minor then
    delete from public.studio_words w where w.film_id = new.film_id and w.kind <> 'beat'
       and (public.studio_names_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note))
            or public.studio_minor_run_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note)));
    delete from public.studio_words w where w.film_id = new.film_id and w.kind = 'beat'
       and (public.studio_names_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note))
            or public.studio_minor_run_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note)));
    update public.studio_transcripts t
       set label = coalesce((select p.person_code from public.studio_film_people p where p.id = t.person_id), 'A speaker') || ' transcript'
     where t.film_id = new.film_id and public.studio_people_label_names(t.label, new.name, new.reviewer_name, true);
    perform set_config('studio.correcting', new.id::text, true);
    delete from public.studio_film_directions d where d.film_id = new.film_id
       and public.studio_names_in(new.film_id, public.studio_json_strings(d.directions) || ' ' || coalesce(d.why_recommended, '') || ' ' || public.studio_json_strings(d.questions));
    perform set_config('studio.correcting', '', true);
    return null;
  end if;
  if exists (select 1 from public.studio_words w where w.film_id = new.film_id
               and (public.studio_names_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note))
                    or new.is_minor and public.studio_minor_run_in(new.film_id, concat_ws(' ', w.quote, w.text, w.title, w.note)))) then
    raise exception 'a line, caption, title or note kept on this film names someone on this card: remove it (Real words) first';
  end if;
  if exists (select 1 from public.studio_transcripts t where t.film_id = new.film_id
               and (public.studio_names_in(new.film_id, t.label) or public.studio_people_label_names(t.label, new.name, new.reviewer_name, new.is_minor))) then
    raise exception 'a transcript''s label on this film has a word of a name on this card: rename it (Real words) first';
  end if;
  if exists (select 1 from public.studio_film_directions d where d.film_id = new.film_id
               and public.studio_names_in(new.film_id, public.studio_json_strings(d.directions) || ' ' || coalesce(d.why_recommended, '') || ' ' || public.studio_json_strings(d.questions))) then
    raise exception 'the film''s directions name someone on this card: talk to Kyron before adding it';
  end if;
  return null;
end $$;

-- A card added or renamed, and a correction to a minor: 039's
-- studio_people_title_names (one definition, so running 039 again keeps it).

-- Whether a transcript's label has a word of this name (a label carries no
-- word of anyone's name at all: three letters or more, two for a minor, not
-- a two-letter everyday word; its words split where they run together).
create or replace function public.studio_people_label_names(p_label text, p_name text, p_reviewer text, p_minor boolean) returns boolean
language sql immutable set search_path = '' as $$
  select exists (
    select 1 from regexp_split_to_table(lower(concat_ws(' ', p_name, p_reviewer)), '[^[:alpha:]]+') as w
     where char_length(w) >= (case when p_minor then 2 else 3 end)
       and w <> all (array['he', 'do', 'an', 'so', 'go', 'oh', 'no', 'me', 'my', 'we', 'us', 'it', 'in', 'on', 'at', 'to', 'be', 'by', 'of',
         'or', 'up', 'as', 'is', 'am', 'if', 'hi', 'ok', 'ah', 'eh', 'uh', 'um', 'yo', 'ya', 'ha', 'ho', 'lo', 'la', 'ma', 'pa', 'ye', 'ow', 'ox', 'ax',
         'id', 're', 'vs'])
       and (' ' || btrim(regexp_replace(lower(regexp_replace(coalesce(p_label, ''), '([[:lower:]])([[:upper:]])', '\1 \2', 'g')), '[^[:alpha:]]+', ' ', 'g')) || ' ') like '% ' || w || ' %')
$$;

-- Every string in a JSON value, one to a line (a name after a line break
-- is a name).
create or replace function public.studio_json_strings(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select coalesce(string_agg(x #>> '{}', E'\n'), '') from jsonb_path_query(coalesce(p, 'null'::jsonb), 'strict $.**') as x where jsonb_typeof(x) = 'string'
$$;

-- A link to a picture or a video file, as far as its address shows: the
-- file's own ending (any case, a trailing "/" or ";v=2", "%2E" for the dot),
-- an image service's address, or format=jpg in the query. (A link that
-- redirects to one can't be told.)
create or replace function public.studio_taste_file_link(p_url text) returns boolean
language sql immutable set search_path = '' as $$
  with u as (
    select lower(coalesce(p_url, '')) as url,
           lower(regexp_replace(regexp_replace(coalesce(p_url, ''), '^https://[^/?#]*', ''), '[?#].*$', '')) as path,
           lower(coalesce(substring(p_url from '\?([^#]*)'), '')) as query,
           lower(coalesce(substring(p_url from '^https://([^/?#:]+)'), '')) as host
  ), p as (
    select url, query, host, replace(replace(path, '%2e', '.'), '%2f', '/') as path from u
  )
  select (rtrim(regexp_replace(path, ';[^/]*', '', 'g'), '/') ~ '\.(jpe?g|jpe|jfif|pjpeg|pjp|png|apng|gif|webp|heic|heif|avif|bmp|dib|tiff?|svgz?|ico|jxl|jp2|j2k|dng|cr2|nef|arw|raw|psd|mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|ts|m3u8)$')
      -- Instagram's /p/<id>/media/ address sends the picture itself.
      or (host ~ '(^|\.)instagram\.com$' and rtrim(path, '/') ~ '^/(p|reel|tv)/[^/]+/media$')
      -- Cloudinary's delivery addresses, and Google Drive's download address.
      or (host ~ '(^|\.)cloudinary\.com$' and path ~ '/(image|video)/(upload|fetch|private|authenticated)/')
      or (host = 'drive.google.com' and path ~ '^/uc' and query ~ '(^|&)export=')
      or host ~ '(^|\.)(drive\.usercontent\.google\.com|images\.ctfassets\.net|videos\.ctfassets\.net)$'
      or query ~ '(^|&)(format|fm|ext|type|mime)=(jpe?g|png|gif|webp|avif|heic|svg|bmp|image%2f[a-z]+|image/[a-z]+)(&|$)'
      or host ~ '(^|\.)(pbs\.twimg\.com|images\.unsplash\.com|plus\.unsplash\.com|i\.imgur\.com|i\.redd\.it|preview\.redd\.it|lh[0-9]\.googleusercontent\.com|media\.licdn\.com|scontent[a-z0-9.-]*\.fbcdn\.net|scontent[a-z0-9.-]*\.cdninstagram\.com|i\.pinimg\.com|images\.squarespace-cdn\.com|cdn\.shopify\.com|i\.ytimg\.com|img\.youtube\.com|i\.vimeocdn\.com|media\.giphy\.com|i\.giphy\.com|images\.pexels\.com|cdn\.pixabay\.com|live\.staticflickr\.com|farm[0-9]+\.staticflickr\.com|upload\.wikimedia\.org|video\.twimg\.com|v[0-9]+\.cdninstagram\.com)$'
    from p
$$;

create or replace function public.studio_taste_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  t text;
begin
  if tg_op = 'DELETE' then
    raise exception 'a taste note is archived, not deleted: briefs cite it';
  end if;
  if tg_op = 'UPDATE' and row(new.ref_no, new.added_by, new.created_at) is distinct from row(old.ref_no, old.added_by, old.created_at) then
    raise exception 'taste note % keeps who added it and when', old.ref_no;
  end if;
  foreach t in array new.tags loop
    if t is null or t !~ '^[a-z0-9][a-z0-9 -]{0,23}$' then
      raise exception 'a tag is a short lower-case word or two';
    end if;
  end loop;
  -- Every film reads the taste library: no name on any film's cards in it.
  -- Read when its words are written or change (archiving one written before
  -- a card always goes through).
  if (tg_op = 'INSERT' or row(new.title, new.note, new.take, new.leave, new.tags) is distinct from row(old.title, old.note, old.take, old.leave, old.tags))
     and public.studio_names_in_any(concat_ws(E'\n', new.title, new.note, new.take, new.leave, array_to_string(new.tags, ' '))) then
    raise exception 'taste notes keep no names: they''re read for every film';
  end if;
  -- A link to the work, never to a picture or a video file of it.
  if (tg_op = 'INSERT' or new.url is distinct from old.url) and public.studio_taste_file_link(new.url) then
    raise exception 'a taste note links to the work, not to a picture or a video file of it';
  end if;
  new.search := setweight(to_tsvector('english', coalesce(new.title, '')), 'A')
    || setweight(to_tsvector('simple', array_to_string(new.tags, ' ')), 'A')
    || setweight(to_tsvector('english', coalesce(new.note, '') || ' ' || coalesce(new.take, '') || ' ' || coalesce(new.leave, '')), 'B');
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.studio_film_directions_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  f public.studio_films;
begin
  if tg_op = 'DELETE' then
    -- Only when a card on its film is corrected to a minor, and they name
    -- them (studio_people_kept_names, in that one statement).
    if coalesce(current_setting('studio.correcting', true), '') <> '' and pg_trigger_depth() > 1
       and exists (select 1 from public.studio_film_people p where p.id::text = current_setting('studio.correcting', true) and p.film_id = old.film_id and p.is_minor) then
      return old;
    end if;
    raise exception 'directions are kept';
  end if;
  if tg_op = 'UPDATE' then
    if row(new.film_id, new.directions, new.recommended, new.why_recommended, new.questions, new.created_by, new.created_at)
       is distinct from row(old.film_id, old.directions, old.recommended, old.why_recommended, old.questions, old.created_by, old.created_at)
       or (new.run_id is distinct from old.run_id and new.run_id is not null) then
      raise exception 'directions are kept as they came back; only the pick changes';
    end if;
    if new.run_id is distinct from old.run_id then
      -- Its run was deleted: nothing else changes.
      return new;
    end if;
    if new.picked is not null and new.picked_by is null then
      raise exception 'who picked it';
    end if;
    new.picked_at := case when new.picked is null then null else now() end;
    return new;
  end if;
  select * into f from public.studio_films where id = new.film_id for update;
  if f.id is null then
    raise exception 'no film %', new.film_id;
  end if;
  if f.pulled_at is not null or f.archived_at is not null then
    raise exception 'film % is closed', f.id;
  end if;
  if public.studio_names_in(new.film_id, public.studio_json_strings(new.directions) || E'\n' || coalesce(new.why_recommended, '') || E'\n' || public.studio_json_strings(new.questions)) then
    raise exception 'directions keep no names: the code or the role instead';
  end if;
  if new.picked is not null then
    raise exception 'a direction is picked after it comes back';
  end if;
  new.created_at := now();
  return new;
end $$;

-- A brief set aside can come back (its mark goes); a started one stays started.
create or replace function public.studio_brief_marks_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- The brief's own run deleted: its mark goes with it.
    if old.started_at is not null and exists (select 1 from public.agent_runs r where r.id = old.brief_run_id) then
      raise exception 'a brief that was started stays started';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.started_at is not null and new.started_at is null then
    raise exception 'a brief that was started stays started';
  end if;
  -- A start stays as it was: the first kit run it started, and its direction.
  if tg_op = 'UPDATE' and old.started_at is not null
     and (row(new.direction, new.started_by, new.started_at) is distinct from row(old.direction, old.started_by, old.started_at)
          or (new.started_run_id is distinct from old.started_run_id and new.started_run_id is not null)) then
    raise exception 'a brief that was started stays as it was started';
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace trigger studio_transcripts_gate before insert or update or delete on public.studio_transcripts
  for each row execute function public.studio_transcripts_gate();
create or replace trigger studio_words_gate before insert or update or delete on public.studio_words
  for each row execute function public.studio_words_gate();
create or replace trigger studio_words_gone after delete on public.studio_words
  for each row execute function public.studio_words_gone();
create or replace trigger studio_film_people_words after update on public.studio_film_people
  for each row execute function public.studio_people_words();
-- After studio_film_people_words (triggers run in name order).
create or replace trigger studio_film_people_words_kept after insert or update on public.studio_film_people
  for each row execute function public.studio_people_kept_names();
create or replace trigger studio_taste_gate before insert or update or delete on public.studio_taste
  for each row execute function public.studio_taste_gate();
create or replace trigger studio_film_directions_gate before insert or update or delete on public.studio_film_directions
  for each row execute function public.studio_film_directions_gate();
create or replace trigger studio_brief_marks_gate before insert or update or delete on public.studio_brief_marks
  for each row execute function public.studio_brief_marks_gate();
do $$
declare
  t text;
begin
  foreach t in array array['studio_transcripts', 'studio_words', 'studio_taste', 'studio_brief_marks', 'studio_film_directions', 'studio_film_runs'] loop
    execute format('create or replace trigger %I before truncate on public.%I for each statement execute function public.studio_keep()', t || '_keep', t);
  end loop;
end $$;

-- ── What the server calls ─────────────────────────────────────────────────
-- Remove a transcript (and every line from it), film first.
create or replace function public.studio_transcript_remove(p_transcript uuid)
returns setof public.studio_transcripts
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_transcripts where id = p_transcript);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query delete from public.studio_transcripts t where t.id = p_transcript returning t.*;
end $$;

-- Remove a line, a caption, or a whole structure or cutdown, film first.
create or replace function public.studio_words_remove(p_word uuid)
returns setof public.studio_words
language plpgsql volatile set search_path = '' as $$
declare
  fid uuid := (select film_id from public.studio_words where id = p_word);
begin
  if fid is null then return; end if;
  perform 1 from public.studio_films where id = fid for update;
  return query delete from public.studio_words w where w.id = p_word returning w.*;
end $$;

-- Keep a set of lines (checked by the server, and again by the gate), film
-- first: structures and cutdowns, then their beats and the rest. With
-- p_replace, what Claude picked for the film before goes first. Returns how
-- many rows were kept.
create or replace function public.studio_words_save(p_film uuid, p_run uuid, p_made_by text, p_by text, p_rows jsonb, p_replace boolean)
returns int
language plpgsql volatile set search_path = '' as $$
declare
  n int := 0;
  k int;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'a set of lines is a list of 200 at most';
  end if;
  perform 1 from public.studio_films where id = p_film for update;
  if p_replace then
    delete from public.studio_words where film_id = p_film and made_by = 'claude' and kind <> 'beat';
  end if;
  insert into public.studio_words (id, film_id, kind, title, note, run_id, made_by, created_by)
  select coalesce(r.id, gen_random_uuid()), p_film, r.kind, r.title, r.note, p_run, p_made_by, p_by
    from jsonb_to_recordset(p_rows) as r(id uuid, kind text, title text, note text)
   where r.kind in ('structure', 'cutdown');
  get diagnostics k = row_count;
  n := n + k;
  insert into public.studio_words (film_id, kind, transcript_id, group_id, position, from_cue, to_cue, quote, start_ms, end_ms, note, text, run_id, made_by, created_by)
  select p_film, r.kind, r.transcript_id, r.group_id, r.position, r.from_cue, r.to_cue, r.quote, r.start_ms, r.end_ms, r.note, r.text, p_run, p_made_by, p_by
    from jsonb_to_recordset(p_rows) as r(kind text, transcript_id uuid, group_id uuid, position smallint, from_cue int, to_cue int, quote text, start_ms int, end_ms int, note text, text text)
   where r.kind is null or r.kind not in ('structure', 'cutdown');
  get diagnostics k = row_count;
  return n + k;
end $$;

-- The taste library, searched: words (any form, "running" finds "run"), a
-- tag, or the newest first.
create or replace function public.studio_taste_search(p_q text, p_tag text, p_limit int)
returns setof public.studio_taste
language sql stable set search_path = '' as $$
  with q as (
    select nullif(btrim(coalesce(p_q, '')), '') as words,
           replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') as like_part
  )
  select t.* from public.studio_taste t, q
   where t.archived_at is null
     and (p_tag is null or p_tag = any (t.tags))
     and (q.words is null
          or t.search @@ websearch_to_tsquery('english', q.words)
          or t.title ilike '%' || q.like_part || '%'
          or t.url ilike '%' || q.like_part || '%')
   order by case when q.words is null then 0 else ts_rank(t.search, websearch_to_tsquery('english', q.words)) end desc, t.created_at desc
   limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array[
    'public.studio_words_why_not(public.studio_film_people)', 'public.studio_transcripts_gate()', 'public.studio_words_gate()',
    'public.studio_words_gone()', 'public.studio_people_words()', 'public.studio_taste_gate()', 'public.studio_film_directions_gate()',
    'public.studio_brief_marks_gate()', 'public.studio_transcript_remove(uuid)', 'public.studio_words_remove(uuid)',
    'public.studio_words_save(uuid, uuid, text, text, jsonb, boolean)', 'public.studio_taste_search(text, text, int)',
    'public.studio_quote_whole(text, text)', 'public.studio_people_kept_names()', 'public.studio_json_strings(jsonb)',
    'public.studio_taste_file_link(text)', 'public.studio_minor_run_in(uuid, text)', 'public.studio_people_label_names(text, text, text, boolean)',
    'public.studio_film_run_start(uuid, text, text, text, text)'] loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_transcripts, public.studio_words, public.studio_taste, public.studio_brief_marks, '
        'public.studio_film_directions, public.studio_film_runs from %I', r);
      execute format('revoke all on sequence public.studio_taste_ref_no_seq from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke truncate, trigger, references on public.studio_transcripts, public.studio_words, public.studio_taste, '
      'public.studio_brief_marks, public.studio_film_directions, public.studio_film_runs from service_role';
    execute 'grant execute on function public.studio_transcript_remove(uuid), public.studio_words_remove(uuid), '
      'public.studio_words_save(uuid, uuid, text, text, jsonb, boolean), public.studio_taste_search(text, text, int), '
      'public.studio_words_why_not(public.studio_film_people), public.studio_quote_whole(text, text), public.studio_json_strings(jsonb), '
      'public.studio_taste_file_link(text), public.studio_minor_run_in(uuid, text), public.studio_people_label_names(text, text, text, boolean), '
      'public.studio_film_run_start(uuid, text, text, text, text) to service_role';
  end if;
end $$;
