-- 043: a speaker's own page (routes/studio-speaker.js, public/my-films.html;
-- docs/studio-films.md). Builds on 039. Service role only.
--
--   * Anyone whose email is on a cleared clearance card as the one who
--     approves (the speaker themself, or a minor's parent or guardian) can get a link to
--     their own page: every film they (or their child) are in, where it is,
--     what they approved, what's posted, the words of theirs that were kept,
--     and a way to take their consent back themselves.
--   * The link's token never reaches the database: the server sends the
--     token's hash (the proof); this keeps the proof's hash. A link lasts 7
--     days, a new one stops the old ones for that email once its email is
--     accepted, and signing out stops it.
--   * Taking consent back from the page is the same pull as staff make
--     (039's studio_pull_consent), with source 'speaker', and only for a
--     person whose cleared card names that email (for a parent, where the
--     athlete now approves for themself, the films a parent or guardian
--     approves, kept on those cards as pull_scope 'not_self': 039's card
--     gate, replaced below with that one change, lets the athlete's own new
--     cards in past such a pull).

create table if not exists public.studio_speaker_links (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  proof_hash text not null unique check (proof_hash ~ '^[0-9a-f]{64}$'),
  -- 'self' (asked for on the page) or the staff member who sent it.
  sent_by text not null check (char_length(sent_by) between 3 and 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- When its email was accepted (studio_speaker_supersede).
  sent_at timestamptz
);
alter table public.studio_speaker_links add column if not exists sent_at timestamptz;
create index if not exists studio_speaker_links_email_idx on public.studio_speaker_links (email, created_at desc);
alter table public.studio_speaker_links enable row level security;

-- How far a card's pull went: null, the whole code's (039's pull, and the
-- page's otherwise); 'not_self', the films a parent or guardian approves,
-- taken back on their page where the athlete approves for themself.
alter table public.studio_film_people add column if not exists pull_scope text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_film_people_pull_scope_known') then
    alter table public.studio_film_people add constraint studio_film_people_pull_scope_known
      check (pull_scope is null or (pull_scope = 'not_self' and consent_pulled_at is not null));
  end if;
end $$;

-- 039's card gate, with pull_scope: a new card starts without one; a pull
-- sets it from studio.pull_scope, and nothing else changes it; a new card
-- the athlete approves for themself isn't held by a 'not_self' pull; and a
-- card of theirs doesn't become a parent's or guardian's after one without
-- the family's new consent. Otherwise as 039 wrote it.
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
    if new.cleared_at is not null or new.cleared_by is not null or new.consent_pulled_at is not null or new.pull_scope is not null then
      raise exception 'a new card starts not cleared';
    end if;
    if f.pulled_at is not null or f.archived_at is not null then
      raise exception 'film % is closed', f.id;
    end if;
    -- A pulled consent stays pulled: the code comes back only once its
    -- takedown is done, with the family's new consent recorded on the first
    -- card after the pull. (043) A parent's or guardian's pull of their
    -- child's films, where the athlete is an adult now (pull_scope
    -- 'not_self'), didn't touch the adult's own consent: a new card of the
    -- adult's (not a minor's, and no parent or guardian approving) isn't
    -- held by it.
    pulled_last := (select max(x.consent_pulled_at) from public.studio_film_people x
                     where x.person_code = new.person_code
                       and not (x.pull_scope is not distinct from 'not_self'
                                and not coalesce(new.is_minor or new.reviewer_relation in ('parent', 'guardian'), false)));
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
  -- (043) How far a pull went is the pull's own to say, once.
  if new.pull_scope is distinct from old.pull_scope and not (new.consent_pulled_at is not null and old.consent_pulled_at is null) then
    raise exception 'how far a pull went is set by the pull';
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
    -- (043) The page's pull of the films a parent or guardian approves says
    -- so; any other pull is the whole code's.
    new.pull_scope := nullif(current_setting('studio.pull_scope', true), '');
    if new.pull_scope is not null and new.pull_scope <> 'not_self' then
      raise exception 'a pull is the whole code''s, or the films a parent or guardian approves';
    end if;
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
  -- (043) An adult's card, where a parent or guardian has since taken back
  -- their child's films, doesn't become a minor's or one a parent or
  -- guardian approves without the family's new consent.
  if not coalesce(old.is_minor or old.reviewer_relation in ('parent', 'guardian'), false)
     and coalesce(new.is_minor or new.reviewer_relation in ('parent', 'guardian'), false) then
    pulled_last := (select max(x.consent_pulled_at) from public.studio_film_people x
                     where x.person_code = old.person_code and x.pull_scope = 'not_self');
    if pulled_last is not null and not exists (
         select 1 from public.studio_film_people x
          where x.person_code = old.person_code and x.reconsent_note is not null and x.consent_pulled_at is null and x.created_at > pulled_last) then
      raise exception 'a parent or guardian took consent back for %: a card they approve needs the family''s new consent, recorded by the producer', old.person_code;
    end if;
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

create or replace function public.studio_speaker_links_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a page link is kept (stop it instead)';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.expires_at := now() + interval '7 days';
    new.last_used_at := null;
    new.revoked_at := null;
    new.sent_at := null;
    -- The older links for that email are stopped once this one's email is
    -- accepted (studio_speaker_supersede), not here: an ask that can't be
    -- sent leaves the working link as it was.
    return new;
  end if;
  if row(new.email, new.proof_hash, new.sent_by, new.created_at, new.expires_at)
     is distinct from row(old.email, old.proof_hash, old.sent_by, old.created_at, old.expires_at) then
    raise exception 'a page link stays as it was made';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a stopped link stays stopped';
  end if;
  if old.sent_at is not null and new.sent_at is distinct from old.sent_at then
    raise exception 'a link is sent once';
  end if;
  return new;
end $$;

create or replace trigger studio_speaker_links_gate before insert or update or delete on public.studio_speaker_links
  for each row execute function public.studio_speaker_links_gate();
create or replace trigger studio_speaker_links_keep before truncate on public.studio_speaker_links
  for each statement execute function public.studio_keep();

-- A link never marked sent, made ten minutes or more ago, while a newer
-- live link for the email was: its supersede never ran, and the newer
-- email is the one that works. Never someone's only link, and never the
-- newest (an older sent link doesn't stop it: the newer email may still be
-- the one on top).
create or replace function public.studio_speaker_link_stale(p_id uuid)
returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.studio_speaker_links l
                  where l.id = p_id and l.sent_at is null and l.created_at < now() - interval '10 minutes'
                    and exists (select 1 from public.studio_speaker_links o
                                 where o.email = l.email and o.id <> l.id and o.revoked_at is null
                                   and o.expires_at > now() and o.sent_at is not null and o.created_at > l.created_at));
$$;

-- The email a live link is for (and the link marked used), or nothing.
create or replace function public.studio_speaker_email(p_proof text)
returns text
language plpgsql volatile set search_path = '' as $$
declare
  e text;
begin
  update public.studio_speaker_links l set last_used_at = now()
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and l.revoked_at is null and l.expires_at > now()
     and not public.studio_speaker_link_stale(l.id)
  returning l.email into e;
  return e;
end $$;

-- Stop a live link (signing out).
create or replace function public.studio_speaker_sign_out(p_proof text)
returns boolean
language plpgsql volatile set search_path = '' as $$
begin
  update public.studio_speaker_links l set revoked_at = now()
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and l.revoked_at is null;
  return found;
end $$;

-- Once a link's email is accepted: it's marked sent, and every other live
-- link for that email whose own email went before it stops, under the
-- email's lock. A link still waiting on its email is left alone: when that
-- email goes, it stops this one. So the newest email in their inbox is the
-- one that works. p_after_ms is how long after the link was made its email
-- was accepted, as the server timed it (so a retry keeps it, and one clock
-- orders them: the database's created_at plus that): links are ordered by
-- it, and a call that comes late for a link whose email went before
-- another's stops its own link, not the newer one. A link never marked sent
-- (its own call never came: a restart) and made ten minutes or more ago
-- stops too.
create or replace function public.studio_speaker_supersede(p_proof text, p_after_ms integer default null)
returns integer
language plpgsql volatile set search_path = '' as $$
declare
  me record;
  mine timestamptz;
  n integer;
begin
  select l.id, l.email, l.created_at into me from public.studio_speaker_links l
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex');
  if me.id is null then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('studio.page:' || me.email, 0));
  update public.studio_speaker_links l
     set sent_at = case when p_after_ms is null then clock_timestamp()
                        else least(clock_timestamp(), me.created_at + make_interval(secs => greatest(p_after_ms, 0) / 1000.0)) end
   where l.id = me.id and l.sent_at is null;
  select l.sent_at into mine from public.studio_speaker_links l
   where l.id = me.id and l.revoked_at is null and l.expires_at > now();
  if mine is null then
    return 0;
  end if;
  -- Another live link's email went after this one's: this one is the older.
  if exists (select 1 from public.studio_speaker_links l
              where l.email = me.email and l.id <> me.id and l.revoked_at is null and l.expires_at > now() and l.sent_at > mine) then
    update public.studio_speaker_links l set revoked_at = now() where l.id = me.id;
    return 0;
  end if;
  update public.studio_speaker_links l set revoked_at = now()
   where l.email = me.email and l.id <> me.id and l.revoked_at is null and l.expires_at > now()
     and (l.sent_at <= mine or (l.sent_at is null and l.created_at < now() - interval '10 minutes'));
  get diagnostics n = row_count;
  return n;
end $$;

-- Take consent back from the page: the link has to be live, and a cleared
-- card for that person has to name the link's email as the one who
-- approves. Either parent or guardian of a minor takes it back for every
-- film. A parent or guardian, where the athlete now approves for themself
-- on a live, cleared card (an adult now), takes back every film a parent or
-- guardian approves (every card but the athlete's own, any parent's: either
-- parent takes it back for all of those); the athlete's own go on, and the
-- team talks to them (only_theirs). Then
-- it's 039's pull, with source 'speaker', written as who they are to the
-- person (never their email or name).
create or replace function public.studio_speaker_pull(p_proof text, p_person_code text, p_note text)
returns table (takedown_id uuid, only_theirs boolean)
language plpgsql volatile set search_path = '' as $$
declare
  e text;
  code text := upper(btrim(coalesce(p_person_code, '')));
  rel text;
  mine_only boolean;
  by_whom text;
begin
  -- The link row is held until the pull is in, so signing out in the same
  -- instant waits for it (or wins, and then nothing is pulled).
  select l.email into e from public.studio_speaker_links l
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and l.revoked_at is null and l.expires_at > now()
     and not public.studio_speaker_link_stale(l.id)
   for update;
  if e is null then
    raise exception 'this page link is not active';
  end if;
  select p.reviewer_relation into rel from public.studio_film_people p
   where p.person_code = code and lower(p.reviewer_email) = e and p.cleared_at is not null
   order by p.created_at desc limit 1;
  if rel is null then
    raise exception 'that person is not on a card this link is for';
  end if;
  -- The code's lock (039's pull takes it too), so two taps at once are one
  -- pull: the second finds nothing left and says so.
  perform pg_advisory_xact_lock(hashtextextended('studio.code:' || code, 0));
  -- Narrowed where the athlete is an adult now: a live, cleared card of
  -- theirs (not a minor's, no parent or guardian approving), speaking or not.
  mine_only := rel <> 'self' and exists (select 1 from public.studio_film_people p
              where p.person_code = code and p.consent_pulled_at is null and p.cleared_at is not null
                and not coalesce(p.is_minor or p.reviewer_relation in ('parent', 'guardian'), false));
  if not exists (select 1 from public.studio_film_people p where p.person_code = code and p.consent_pulled_at is null
                   and (not mine_only or coalesce(p.is_minor or p.reviewer_relation in ('parent', 'guardian'), false))) then
    raise exception 'consent is already taken back';
  end if;
  update public.studio_speaker_links l set last_used_at = now()
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex');
  by_whom := case rel when 'self' then 'the speaker, on their page' when 'parent' then 'their parent, on their page' else 'their guardian, on their page' end;
  if not mine_only then
    return query select x.takedown_id, false from public.studio_pull_consent(code, by_whom, 'speaker', p_note) x;
    return;
  end if;
  -- As 039's pull does it, for every card but the athlete's own: its source
  -- for the takedown and how far it goes, then the films in one order, then
  -- the cards.
  perform set_config('studio.pull_source', 'speaker', true);
  perform set_config('studio.pull_scope', 'not_self', true);
  perform 1 from public.studio_films f
   where f.id in (select x.film_id from public.studio_film_people x
                   where x.person_code = code and x.consent_pulled_at is null and coalesce(x.is_minor or x.reviewer_relation in ('parent', 'guardian'), false))
   order by f.id for update;
  update public.studio_film_people
     set consent_pulled_at = now(), pulled_by = by_whom, pulled_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
   where person_code = code and consent_pulled_at is null and coalesce(is_minor or reviewer_relation in ('parent', 'guardian'), false);
  perform set_config('studio.pull_scope', '', true);
  return query select t.id, true from public.studio_takedowns t where t.person_code = code and t.closed_at is null
                order by t.requested_at desc limit 1;
end $$;

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array['public.studio_speaker_links_gate()', 'public.studio_speaker_email(text)', 'public.studio_speaker_sign_out(text)',
                            'public.studio_speaker_supersede(text, integer)', 'public.studio_speaker_link_stale(uuid)', 'public.studio_speaker_pull(text, text, text)'] loop
    execute format('revoke all on function %s from public', fn);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', fn, r);
      end if;
    end loop;
  end loop;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.studio_speaker_links from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke truncate, trigger, references on public.studio_speaker_links from service_role';
    execute 'grant execute on function public.studio_speaker_email(text), public.studio_speaker_sign_out(text), '
      'public.studio_speaker_supersede(text, integer), public.studio_speaker_link_stale(uuid), public.studio_speaker_pull(text, text, text) to service_role';
  end if;
end $$;
