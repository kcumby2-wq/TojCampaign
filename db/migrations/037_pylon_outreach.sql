-- 037: The Recruiting Concierge's messages to college coaches, and the
-- approval of each one by the athlete's family (routes/pylon-outreach.js,
-- routes/pylon-parent.js, public/parent-approval.html).
--
-- The hard line: nothing goes to a coach unless the person who signed up
-- for the Concierge (the athlete's parent or legal guardian, or the athlete
-- at 18 or older: the contact on the pylon_requests row, whom staff have
-- checked on a call or in person) approved that exact message, to that
-- exact coach and program.
--
--   * Staff write a draft on a recruiting request, then ask for approval.
--     That emails the contact a one-time link. The link carries a token; the
--     server turns it into a proof (sha256 of the token) and the table keeps
--     only sha256 of the proof. Nothing that can read the table can make the
--     proof, so nobody can decide without the family's link: not the API,
--     not a direct UPDATE (the trigger checks the proof the decide function
--     passes it).
--   * Links go out only while the request is open and its contact checked
--     (pylon_requests.contact_verified_at), and stop working if that changes.
--   * The family reads the message as it will be sent (the coach, the
--     program, its level, the subject and the words) and approves or
--     declines it. The approval carries the fingerprint of everything they
--     were shown when the link went out; any change since cancels the link.
--   * The database refuses: a decision without the live link's proof; a
--     change to anything shown after approval; a send without approval, or
--     after the family took it back; a draft that starts decided, linked or
--     sent; rewriting who declined and when; deleting a message with a link,
--     a decision or a send on record.
--   * Every link, decision, cancellation, withdrawal and send is written to
--     pylon_outreach_events by the database itself, and that history is
--     never changed. Staff add coach replies and notes to it.
--   * Service role only: RLS on, no policies, nothing granted to anon or
--     authenticated; the functions the public page uses are the server's.

create table if not exists public.pylon_outreach (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.pylon_requests(id) on delete restrict,
  coach_name text not null check (char_length(coach_name) between 1 and 80),
  coach_email text not null check (
    coach_email = lower(coach_email) and char_length(coach_email) between 3 and 200
    and coach_email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  program_name text not null check (char_length(program_name) between 1 and 120),
  program_level text check (program_level is null or program_level in ('ncaa_d1', 'ncaa_d2', 'ncaa_d3', 'naia', 'juco', 'hbcu', 'mixed')),
  -- A subject goes into an email header: no control characters.
  draft_subject text not null check (char_length(draft_subject) between 1 and 200 and draft_subject !~ '[[:cntrl:]]'),
  draft_body text not null check (char_length(draft_body) between 1 and 5000),
  created_by text not null check (char_length(created_by) between 1 and 200),
  -- The staff member behind the last change (for the history).
  changed_by text check (changed_by is null or char_length(changed_by) between 1 and 200),
  -- sha256 of the link's proof, while a link is out.
  parent_approval_token_hash text unique check (parent_approval_token_hash is null or parent_approval_token_hash ~ '^[0-9a-f]{64}$'),
  parent_approval_requested_at timestamptz,
  parent_approval_expires_at timestamptz,
  -- What the live link is for: the fingerprint of everything the family is
  -- shown, set by the database when the link goes out.
  asked_text_sha256 text check (asked_text_sha256 is null or asked_text_sha256 ~ '^[0-9a-f]{64}$'),
  parent_decision text check (parent_decision is null or parent_decision in ('approved', 'declined')),
  parent_decided_at timestamptz,
  parent_decided_name text check (parent_decided_name is null or char_length(parent_decided_name) between 2 and 200),
  parent_approved boolean not null default false,
  approved_text_sha256 text check (approved_text_sha256 is null or approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  -- The family took their approval back (they told staff): never sent.
  withdrawn_at timestamptz,
  withdrawn_by text check (withdrawn_by is null or char_length(withdrawn_by) between 1 and 200),
  sent_at timestamptz,
  sent_by text check (sent_by is null or char_length(sent_by) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A link is out with its expiry, or not at all.
  constraint pylon_outreach_link_whole check ((parent_approval_token_hash is null) = (parent_approval_expires_at is null)),
  -- A decision is who, when and what, together; approved means the decision
  -- was approval, with the fingerprint of what was shown.
  constraint pylon_outreach_decision_whole check (
    (parent_decision is null and parent_decided_at is null and parent_decided_name is null)
    or (parent_decision is not null and parent_decided_at is not null and parent_decided_name is not null)),
  constraint pylon_outreach_approved_is_decision check (
    parent_approved = (parent_decision is not distinct from 'approved')
    and (parent_approved = (approved_text_sha256 is not null))),
  -- Nothing is sent unless the family approved it and still does.
  constraint pylon_outreach_sent_needs_approval check (sent_at is null or (parent_approved and sent_by is not null and withdrawn_at is null)),
  constraint pylon_outreach_withdrawn_whole check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null or parent_approved))
);

create index if not exists pylon_outreach_request_idx on public.pylon_outreach (request_id, created_at);

alter table public.pylon_outreach enable row level security;

-- The history of each message: written by the database for links,
-- decisions, cancellations, withdrawals and sends; by staff for coach
-- replies and notes. Never changed or removed.
create table if not exists public.pylon_outreach_events (
  id bigint generated always as identity primary key,
  outreach_id uuid not null references public.pylon_outreach(id) on delete restrict,
  event text not null check (event in ('asked', 'approved', 'declined', 'link_cancelled', 'withdrawn', 'sent', 'reply', 'note')),
  at timestamptz not null default now(),
  by_staff text check (by_staff is null or char_length(by_staff) between 1 and 200),
  by_family text check (by_family is null or char_length(by_family) between 2 and 200),
  note text check (note is null or char_length(note) between 1 and 500),
  text_sha256 text check (text_sha256 is null or text_sha256 ~ '^[0-9a-f]{64}$')
);

create index if not exists pylon_outreach_events_idx on public.pylon_outreach_events (outreach_id, at);

alter table public.pylon_outreach_events enable row level security;

-- The fingerprint of everything the family's page shows, with no ambiguity
-- between fields.
drop function if exists public.pylon_outreach_text_sha256(text, text);
create or replace function public.pylon_outreach_fingerprint(coach_name text, coach_email text, program_name text, program_level text, subject text, body text) returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_array(coach_name, coach_email, program_name, program_level, subject, body)::text, 'UTF8')), 'hex')
$$;

create or replace function public.pylon_outreach_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  shown_changed boolean;
  new_link boolean;
  proof text;
begin
  -- A message with a link, a decision or a send on record stays on record.
  if tg_op = 'DELETE' then
    if old.parent_approval_token_hash is not null or old.parent_decision is not null or old.sent_at is not null then
      raise exception 'outreach % has a link, a decision or a send on record and is kept', old.id;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.parent_approved or new.sent_at is not null or new.parent_decision is not null
       or new.parent_approval_token_hash is not null or new.approved_text_sha256 is not null
       or new.asked_text_sha256 is not null or new.withdrawn_at is not null then
      raise exception 'a new outreach draft cannot start approved, decided, linked, withdrawn or sent';
    end if;
    -- Only the Recruiting Concierge writes to coaches.
    if not exists (select 1 from public.pylon_requests where id = new.request_id and kind = 'recruiting') then
      raise exception 'outreach belongs to a Recruiting Concierge request';
    end if;
    return new;
  end if;

  shown_changed := new.draft_subject is distinct from old.draft_subject
    or new.draft_body is distinct from old.draft_body
    or new.coach_email is distinct from old.coach_email
    or new.coach_name is distinct from old.coach_name
    or new.program_name is distinct from old.program_name
    or new.program_level is distinct from old.program_level;
  new_link := new.parent_approval_token_hash is not null
    and new.parent_approval_token_hash is distinct from old.parent_approval_token_hash;

  -- The draft belongs to its request and its author for good.
  if new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by then
    raise exception 'outreach % keeps its request and its author', old.id;
  end if;
  -- The database keeps the fingerprints; nobody writes them.
  new.asked_text_sha256 := old.asked_text_sha256;
  if new.approved_text_sha256 is distinct from old.approved_text_sha256 and not (new.parent_approved and not old.parent_approved) then
    raise exception 'outreach % approved_text_sha256 is the database''s to set', old.id;
  end if;
  -- A live link keeps its expiry; a new one lasts 14 days at most (an
  -- hour's grace for the server's clock), and goes out only on an open
  -- request whose contact staff have checked.
  if not new_link and new.parent_approval_token_hash is not null
     and new.parent_approval_expires_at is distinct from old.parent_approval_expires_at then
    raise exception 'outreach % link keeps its expiry', old.id;
  end if;
  if new_link then
    if new.parent_approval_expires_at > now() + interval '14 days 1 hour' then
      raise exception 'outreach % link can last 14 days at most', old.id;
    end if;
    if not exists (select 1 from public.pylon_requests r where r.id = new.request_id
                    and r.contact_verified_at is not null and r.status not in ('done', 'closed')) then
      raise exception 'outreach %: a link goes out only on an open request whose contact staff have checked', old.id;
    end if;
  end if;

  -- 1. A decision: only with the proof of the family's live link, in the
  --    update that burns it, with nothing they were shown changing.
  if new.parent_decision is distinct from old.parent_decision and new.parent_decision is not null then
    proof := nullif(current_setting('pylon.outreach_proof', true), '');
    if proof is null or old.parent_approval_token_hash is null
       or encode(sha256(convert_to(proof, 'UTF8')), 'hex') <> old.parent_approval_token_hash
       or old.parent_decision is not null
       or new.parent_approval_token_hash is not null
       or old.parent_approval_expires_at <= now()
       or shown_changed then
      raise exception 'outreach % can only be decided by the family through their approval link', old.id;
    end if;
    new.parent_approval_expires_at := null;
    new.parent_approved := (new.parent_decision = 'approved');
    if new.parent_approved then
      if old.asked_text_sha256 is distinct from public.pylon_outreach_fingerprint(new.coach_name, new.coach_email, new.program_name, new.program_level, new.draft_subject, new.draft_body) then
        raise exception 'outreach % changed since the family''s link was sent', old.id;
      end if;
      new.approved_text_sha256 := old.asked_text_sha256;
    else
      new.approved_text_sha256 := null;
    end if;
  elsif new.parent_approved and not old.parent_approved then
    raise exception 'outreach % can only be approved by the family through their approval link', old.id;
  end if;

  -- 2. Once approved: nothing the family saw or decided changes; sent at
  --    most once; withdrawn at most once, and a withdrawn approval is never sent.
  if old.parent_approved then
    if not new.parent_approved or shown_changed
       or new.parent_decision is distinct from old.parent_decision
       or new.parent_decided_at is distinct from old.parent_decided_at
       or new.parent_decided_name is distinct from old.parent_decided_name
       or new.approved_text_sha256 is distinct from old.approved_text_sha256
       or new.parent_approval_requested_at is distinct from old.parent_approval_requested_at
       or new.parent_approval_token_hash is not null then
      raise exception 'outreach % was approved; write a new draft instead of changing it', old.id;
    end if;
    if old.sent_at is not null and (new.sent_at is distinct from old.sent_at or new.sent_by is distinct from old.sent_by
       or new.withdrawn_at is distinct from old.withdrawn_at) then
      raise exception 'outreach % was already sent', old.id;
    end if;
    if old.withdrawn_at is not null and (new.withdrawn_at is distinct from old.withdrawn_at
       or new.withdrawn_by is distinct from old.withdrawn_by or new.sent_at is not null) then
      raise exception 'outreach % was withdrawn by the family and is never sent', old.id;
    end if;
  elsif new.withdrawn_at is not null then
    raise exception 'outreach % has no approval to withdraw', old.id;
  end if;

  -- 3. A decline is cleared only by asking again; who declined and when stay
  --    as recorded until then (and in the history for good).
  if old.parent_decision = 'declined' then
    if new.parent_decision is null then
      if not new_link then
        raise exception 'outreach % was declined; only asking the family again clears that', old.id;
      end if;
    elsif new.parent_decided_at is distinct from old.parent_decided_at or new.parent_decided_name is distinct from old.parent_decided_name then
      raise exception 'outreach % decline stays as the family recorded it', old.id;
    end if;
  end if;

  -- 4. A new link is for everything as it is now; changing anything the
  --    family is shown while a link is out cancels it.
  if new_link then
    new.asked_text_sha256 := public.pylon_outreach_fingerprint(new.coach_name, new.coach_email, new.program_name, new.program_level, new.draft_subject, new.draft_body);
  elsif shown_changed and new.parent_approval_token_hash is not null then
    new.parent_approval_token_hash := null;
    new.parent_approval_expires_at := null;
  end if;
  if new.parent_approval_token_hash is null and not new.parent_approved then
    new.asked_text_sha256 := null;
  end if;
  return new;
end $$;

drop trigger if exists pylon_outreach_gate on public.pylon_outreach;
create trigger pylon_outreach_gate
  before insert or update or delete on public.pylon_outreach
  for each row execute function public.pylon_outreach_gate();

-- The history, as each change lands. It runs as the table's owner, so the
-- history is written whoever made the change (whatever row security they're
-- under), and the change fails if it can't be.
create or replace function public.pylon_outreach_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  shown_changed boolean := new.draft_subject is distinct from old.draft_subject
    or new.draft_body is distinct from old.draft_body
    or new.coach_email is distinct from old.coach_email
    or new.coach_name is distinct from old.coach_name
    or new.program_name is distinct from old.program_name
    or new.program_level is distinct from old.program_level;
begin
  perform set_config('pylon.outreach_logging', 'on', true);
  if new.parent_approval_token_hash is not null and new.parent_approval_token_hash is distinct from old.parent_approval_token_hash then
    insert into public.pylon_outreach_events (outreach_id, event, by_staff, text_sha256)
      values (new.id, 'asked', new.changed_by, new.asked_text_sha256);
  elsif old.parent_approval_token_hash is not null and new.parent_approval_token_hash is null
        and new.parent_decision is not distinct from old.parent_decision then
    insert into public.pylon_outreach_events (outreach_id, event, by_staff, note)
      values (new.id, 'link_cancelled', new.changed_by, case when shown_changed then 'The message changed, so the link stopped working.' end);
  end if;
  if new.parent_decision is not null and new.parent_decision is distinct from old.parent_decision then
    insert into public.pylon_outreach_events (outreach_id, event, by_family, text_sha256)
      values (new.id, new.parent_decision, new.parent_decided_name, coalesce(new.approved_text_sha256, old.asked_text_sha256));
  end if;
  if new.withdrawn_at is not null and old.withdrawn_at is null then
    insert into public.pylon_outreach_events (outreach_id, event, by_staff) values (new.id, 'withdrawn', new.withdrawn_by);
  end if;
  if new.sent_at is not null and old.sent_at is null then
    insert into public.pylon_outreach_events (outreach_id, event, by_staff, text_sha256) values (new.id, 'sent', new.sent_by, new.approved_text_sha256);
  end if;
  perform set_config('pylon.outreach_logging', '', true);
  return null;
end $$;

drop trigger if exists pylon_outreach_log on public.pylon_outreach;
create trigger pylon_outreach_log
  after update on public.pylon_outreach
  for each row execute function public.pylon_outreach_log();

-- The history is append-only. What the database writes (links, decisions,
-- cancellations, withdrawals, sends) only it writes; a coach reply is for a
-- message that went out; nobody backdates anything.
create or replace function public.pylon_outreach_events_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'the outreach history is kept as it was written';
  end if;
  if new.event in ('asked', 'approved', 'declined', 'link_cancelled', 'withdrawn', 'sent')
     and current_setting('pylon.outreach_logging', true) is distinct from 'on' then
    raise exception 'outreach history: % is written by the database', new.event;
  end if;
  if new.event in ('reply', 'note') and (new.by_staff is null or new.note is null or new.by_family is not null or new.text_sha256 is not null) then
    raise exception 'outreach history: a % is a staff member''s note', new.event;
  end if;
  if new.event = 'reply' and not exists (select 1 from public.pylon_outreach where id = new.outreach_id and sent_at is not null) then
    raise exception 'outreach history: a coach reply is for a message that was sent';
  end if;
  new.at := now();
  return new;
end $$;

drop trigger if exists pylon_outreach_events_gate on public.pylon_outreach_events;
create trigger pylon_outreach_events_gate
  before insert or update or delete on public.pylon_outreach_events
  for each row execute function public.pylon_outreach_events_gate();
drop trigger if exists pylon_outreach_events_keep on public.pylon_outreach_events;
create trigger pylon_outreach_events_keep
  before truncate on public.pylon_outreach_events
  for each statement execute function public.pylon_outreach_events_gate();

-- What the family's link shows: the message as it will go out, the athlete's
-- first name, and who the link was sent to (so the page can say "parent or
-- guardian" or "you"). token_hash is the link's proof (sha256 of the token);
-- the table holds sha256 of that. Nothing for a link that's used, expired,
-- unknown, or on a request that's closed or no longer checked.
drop function if exists public.pylon_outreach_for_family(text);
create function public.pylon_outreach_for_family(token_hash text)
returns table (
  approver text, athlete_first_name text, program_name text, program_level text,
  coach_name text, coach_email text, draft_subject text, draft_body text, expires_at timestamptz)
language sql stable set search_path = '' as $$
  select r.contact_role, split_part(btrim(r.athlete_name), ' ', 1), o.program_name, o.program_level,
         o.coach_name, o.coach_email, o.draft_subject, o.draft_body, o.parent_approval_expires_at
    from public.pylon_outreach o
    join public.pylon_requests r on r.id = o.request_id
   where o.parent_approval_token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex')
     and o.parent_approval_expires_at > now()
     and o.parent_decision is null
     and o.sent_at is null
     and r.contact_verified_at is not null
     and r.status not in ('done', 'closed')
$$;

-- The family's decision, in one statement: the trigger checks the proof
-- against the link it burns, so a link works once and only for its holder.
-- The outreach's id, or no row when the link isn't active.
drop function if exists public.pylon_outreach_decide(text, text, text);
create function public.pylon_outreach_decide(token_hash text, decision text, decided_name text)
returns table (outreach_id uuid)
language sql volatile set search_path = '' as $$
  select set_config('pylon.outreach_proof', coalesce(token_hash, ''), true);
  update public.pylon_outreach o
     set parent_decision            = decision,
         parent_decided_at          = now(),
         parent_decided_name        = btrim(decided_name),
         parent_approval_token_hash = null,
         updated_at                 = now()
    from public.pylon_requests r
   where r.id = o.request_id
     and r.contact_verified_at is not null
     and r.status not in ('done', 'closed')
     and o.parent_approval_token_hash = encode(sha256(convert_to(token_hash, 'UTF8')), 'hex')
     and o.parent_approval_expires_at > now()
     and o.parent_decision is null
     and o.sent_at is null
     and decision in ('approved', 'declined')
     and char_length(btrim(coalesce(decided_name, ''))) between 2 and 200
  returning o.id;
$$;

-- Only the server (service role) uses these.
do $$
declare r text;
begin
  revoke all on function public.pylon_outreach_for_family(text) from public;
  revoke all on function public.pylon_outreach_decide(text, text, text) from public;
  revoke all on function public.pylon_outreach_fingerprint(text, text, text, text, text, text) from public;
  revoke all on function public.pylon_outreach_gate() from public;
  revoke all on function public.pylon_outreach_log() from public;
  revoke all on function public.pylon_outreach_events_gate() from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.pylon_outreach, public.pylon_outreach_events from %I', r);
      execute format('revoke all on sequence public.pylon_outreach_events_id_seq from %I', r);
      execute format('revoke all on function public.pylon_outreach_for_family(text) from %I', r);
      execute format('revoke all on function public.pylon_outreach_decide(text, text, text) from %I', r);
      execute format('revoke all on function public.pylon_outreach_fingerprint(text, text, text, text, text, text) from %I', r);
      execute format('revoke all on function public.pylon_outreach_gate() from %I', r);
      execute format('revoke all on function public.pylon_outreach_log() from %I', r);
      execute format('revoke all on function public.pylon_outreach_events_gate() from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.pylon_outreach_for_family(text) to service_role';
    execute 'grant execute on function public.pylon_outreach_decide(text, text, text) to service_role';
    execute 'grant execute on function public.pylon_outreach_fingerprint(text, text, text, text, text, text) to service_role';
  end if;
end $$;
