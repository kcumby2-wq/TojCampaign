-- 043: a speaker's own page (routes/studio-speaker.js, public/my-films.html;
-- docs/studio-films.md). Builds on 039. Service role only.
--
--   * Anyone whose email is on a clearance card as the one who approves (the
--     speaker themself, or a minor's parent or guardian) can get a link to
--     their own page: every film they (or their child) are in, where it is,
--     what they approved, what's posted, the words of theirs that were kept,
--     and a way to take their consent back themselves.
--   * The link's token never reaches the database: the server sends the
--     token's hash (the proof); this keeps the proof's hash. A link lasts 7
--     days, a new one stops the old ones for that email, and signing out
--     stops it.
--   * Taking consent back from the page is the same pull as staff make
--     (039's studio_pull_consent), with source 'speaker', and only for a
--     person whose card names that email.

create table if not exists public.studio_speaker_links (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  proof_hash text not null unique check (proof_hash ~ '^[0-9a-f]{64}$'),
  -- 'self' (asked for on the page) or the staff member who sent it.
  sent_by text not null check (char_length(sent_by) between 3 and 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists studio_speaker_links_email_idx on public.studio_speaker_links (email, created_at desc);
alter table public.studio_speaker_links enable row level security;

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
    -- A new link stops the older ones for that email.
    update public.studio_speaker_links set revoked_at = now()
     where email = new.email and revoked_at is null and expires_at > now();
    return new;
  end if;
  if row(new.email, new.proof_hash, new.sent_by, new.created_at, new.expires_at)
     is distinct from row(old.email, old.proof_hash, old.sent_by, old.created_at, old.expires_at) then
    raise exception 'a page link stays as it was made';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a stopped link stays stopped';
  end if;
  return new;
end $$;

create or replace trigger studio_speaker_links_gate before insert or update or delete on public.studio_speaker_links
  for each row execute function public.studio_speaker_links_gate();
create or replace trigger studio_speaker_links_keep before truncate on public.studio_speaker_links
  for each statement execute function public.studio_keep();

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

-- Take consent back from the page: the link has to be live, and a card for
-- that person has to name the link's email as the one who approves. Then
-- it's 039's pull, with source 'speaker', written as who they are to the
-- person (never their email or name).
create or replace function public.studio_speaker_pull(p_proof text, p_person_code text, p_note text)
returns table (takedown_id uuid)
language plpgsql volatile set search_path = '' as $$
declare
  e text;
  code text := upper(btrim(coalesce(p_person_code, '')));
  rel text;
begin
  -- The link row is held until the pull is in, so signing out in the same
  -- instant waits for it (or wins, and then nothing is pulled).
  select l.email into e from public.studio_speaker_links l
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex')
     and l.revoked_at is null and l.expires_at > now()
   for update;
  if e is null then
    raise exception 'this page link is not active';
  end if;
  select p.reviewer_relation into rel from public.studio_film_people p
   where p.person_code = code and lower(p.reviewer_email) = e
   order by p.created_at desc limit 1;
  if rel is null then
    raise exception 'that person is not on a card this link is for';
  end if;
  -- The code's lock (039's pull takes it too), so two taps at once are one
  -- pull: the second finds nothing left and says so.
  perform pg_advisory_xact_lock(hashtextextended('studio.code:' || code, 0));
  if not exists (select 1 from public.studio_film_people p where p.person_code = code and p.consent_pulled_at is null) then
    raise exception 'consent is already taken back';
  end if;
  update public.studio_speaker_links l set last_used_at = now()
   where l.proof_hash = encode(sha256(convert_to(coalesce(p_proof, ''), 'UTF8')), 'hex');
  return query select * from public.studio_pull_consent(code,
    case rel when 'self' then 'the speaker, on their page' when 'parent' then 'their parent, on their page' else 'their guardian, on their page' end,
    'speaker', p_note);
end $$;

do $$
declare
  r text;
  fn text;
begin
  foreach fn in array array['public.studio_speaker_links_gate()', 'public.studio_speaker_email(text)', 'public.studio_speaker_sign_out(text)',
                            'public.studio_speaker_pull(text, text, text)'] loop
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
      'public.studio_speaker_pull(text, text, text) to service_role';
  end if;
end $$;
