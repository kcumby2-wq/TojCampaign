-- 037: The Recruiting Concierge's messages to college coaches, and the
-- approval of each one by the athlete's family (routes/pylon-outreach.js,
-- routes/pylon-parent.js, public/parent-approval.html).
--
-- The hard line: nothing goes to a coach unless the person who signed up
-- for the Concierge (the athlete's parent or legal guardian, or the athlete
-- at 18 or older: the contact on the pylon_requests row) approved that exact
-- message, to that exact coach.
--
--   * Staff write a draft on a recruiting request, then ask for approval.
--     That emails the family a one-time link. Only the SHA-256 hash of the
--     link's token is stored; the link itself is never saved or shown to staff.
--   * The family reads the message as it will be sent and approves or declines
--     it on a public page that needs the link and nothing else.
--   * The database refuses: a decision recorded any other way than by burning
--     an issued link in the same update; a change to the words or the
--     recipient after approval; a send without approval; a draft that starts
--     out decided, linked or sent. Editing a draft while a link is out
--     cancels the link, so what's approved is always what goes out.
--   * Service role only: RLS on, no policies; the two functions the public
--     page uses can't be called by the API roles.

create table if not exists public.pylon_outreach (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.pylon_requests(id) on delete restrict,
  coach_name text not null check (char_length(coach_name) between 1 and 80),
  coach_email text not null check (
    coach_email = lower(coach_email) and char_length(coach_email) between 3 and 200
    and coach_email ~ '^[a-z0-9._+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$'),
  program_name text not null check (char_length(program_name) between 1 and 120),
  program_level text check (program_level is null or program_level in ('ncaa_d1', 'ncaa_d2', 'ncaa_d3', 'naia', 'juco', 'hbcu', 'mixed')),
  draft_subject text not null check (char_length(draft_subject) between 1 and 200),
  draft_body text not null check (char_length(draft_body) between 1 and 5000),
  created_by text not null check (char_length(created_by) between 1 and 200),
  parent_approval_token_hash text unique check (parent_approval_token_hash is null or parent_approval_token_hash ~ '^[0-9a-f]{64}$'),
  parent_approval_requested_at timestamptz,
  parent_approval_expires_at timestamptz,
  parent_decision text check (parent_decision is null or parent_decision in ('approved', 'declined')),
  parent_decided_at timestamptz,
  parent_decided_name text check (parent_decided_name is null or char_length(parent_decided_name) between 2 and 200),
  parent_approved boolean not null default false,
  approved_text_sha256 text check (approved_text_sha256 is null or approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  sent_at timestamptz,
  sent_by text check (sent_by is null or char_length(sent_by) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A link is out with its expiry, or not at all.
  constraint pylon_outreach_link_whole check ((parent_approval_token_hash is null) = (parent_approval_expires_at is null)),
  -- A decision is who, when and what, together; approved means the decision
  -- was approval, with the words' fingerprint at that moment.
  constraint pylon_outreach_decision_whole check (
    (parent_decision is null and parent_decided_at is null and parent_decided_name is null)
    or (parent_decision is not null and parent_decided_at is not null and parent_decided_name is not null)),
  constraint pylon_outreach_approved_is_decision check (
    parent_approved = (parent_decision is not distinct from 'approved')
    and (parent_approved = (approved_text_sha256 is not null))),
  -- Nothing is sent unless the family approved it.
  constraint pylon_outreach_sent_needs_approval check (sent_at is null or (parent_approved and sent_by is not null))
);

create index if not exists pylon_outreach_request_idx on public.pylon_outreach (request_id, created_at);

alter table public.pylon_outreach enable row level security;

-- The fingerprint of the words as they'd go out.
create or replace function public.pylon_outreach_text_sha256(subject text, body text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(subject, '') || E'\n' || coalesce(body, ''), 'UTF8')), 'hex')
$$;

create or replace function public.pylon_outreach_gate() returns trigger
language plpgsql set search_path = '' as $$
declare
  burning boolean := old.parent_approval_token_hash is not null and new.parent_approval_token_hash is null;
  words_changed boolean := new.draft_subject is distinct from old.draft_subject
    or new.draft_body is distinct from old.draft_body
    or new.coach_email is distinct from old.coach_email
    or new.coach_name is distinct from old.coach_name;
begin
  if tg_op = 'INSERT' then
    if new.parent_approved or new.sent_at is not null or new.parent_decision is not null
       or new.parent_approval_token_hash is not null or new.approved_text_sha256 is not null then
      raise exception 'a new outreach draft cannot start approved, decided, linked or sent';
    end if;
    -- Only the Recruiting Concierge writes to coaches.
    if not exists (select 1 from public.pylon_requests where id = new.request_id and kind = 'recruiting') then
      raise exception 'outreach belongs to a Recruiting Concierge request';
    end if;
    return new;
  end if;

  -- The draft belongs to its request for good.
  if new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by then
    raise exception 'outreach % keeps its request and its author', old.id;
  end if;

  -- 1. A decision is recorded only in the update that burns an issued link,
  --    and an approval only with the fingerprint of the words as they are.
  if new.parent_decision is distinct from old.parent_decision and new.parent_decision is not null then
    if not burning or old.parent_decision is not null then
      raise exception 'outreach % can only be decided by the family through their approval link', old.id;
    end if;
  end if;
  if new.parent_approved and not old.parent_approved then
    if not burning or new.parent_decision is distinct from 'approved'
       or new.approved_text_sha256 is distinct from public.pylon_outreach_text_sha256(new.draft_subject, new.draft_body) then
      raise exception 'outreach % can only be approved by the family through their approval link', old.id;
    end if;
  end if;

  -- 2. Once approved, nothing about the decision or the words changes, and it
  --    is sent at most once.
  if old.parent_approved then
    if not new.parent_approved or words_changed
       or new.parent_decision is distinct from old.parent_decision
       or new.parent_decided_at is distinct from old.parent_decided_at
       or new.parent_decided_name is distinct from old.parent_decided_name
       or new.approved_text_sha256 is distinct from old.approved_text_sha256
       or new.parent_approval_token_hash is not null then
      raise exception 'outreach % was approved; write a new draft instead of changing it', old.id;
    end if;
    if old.sent_at is not null and (new.sent_at is distinct from old.sent_at or new.sent_by is distinct from old.sent_by) then
      raise exception 'outreach % was already sent', old.id;
    end if;
  end if;

  -- 3. A decline is cleared only when a new link goes out (asking again).
  if old.parent_decision = 'declined' and new.parent_decision is null
     and (new.parent_approval_token_hash is null or new.parent_approval_token_hash is not distinct from old.parent_approval_token_hash) then
    raise exception 'outreach % was declined; only asking the family again clears that', old.id;
  end if;

  -- 4. Editing the words while a link is out cancels the link: the family
  --    always approves what would actually go out.
  if words_changed and new.parent_approval_token_hash is not null
     and new.parent_approval_token_hash is not distinct from old.parent_approval_token_hash then
    new.parent_approval_token_hash := null;
    new.parent_approval_expires_at := null;
  end if;

  return new;
end $$;

drop trigger if exists pylon_outreach_gate on public.pylon_outreach;
create trigger pylon_outreach_gate
  before insert or update on public.pylon_outreach
  for each row execute function public.pylon_outreach_gate();

-- What the family's link shows: the message as it will go out, the athlete's
-- first name, and who the link was sent to (so the page can say "parent or
-- guardian" or "you"). Nothing for a link that's used, expired or unknown.
create or replace function public.pylon_outreach_for_family(token_hash text)
returns table (
  approver text, athlete_first_name text, program_name text, program_level text,
  coach_name text, coach_email text, draft_subject text, draft_body text, expires_at timestamptz)
language sql stable set search_path = '' as $$
  select r.contact_role, split_part(btrim(r.athlete_name), ' ', 1), o.program_name, o.program_level,
         o.coach_name, o.coach_email, o.draft_subject, o.draft_body, o.parent_approval_expires_at
    from public.pylon_outreach o
    join public.pylon_requests r on r.id = o.request_id
   where o.parent_approval_token_hash = token_hash
     and o.parent_approval_expires_at > now()
     and o.parent_decision is null
     and o.sent_at is null
$$;

-- The family's decision, in one statement: the link is checked, burned and
-- the decision recorded together, so a link can never be used twice. The
-- outreach's id, or no row when the link isn't active.
create or replace function public.pylon_outreach_decide(token_hash text, decision text, decided_name text)
returns table (outreach_id uuid)
language sql volatile set search_path = '' as $$
  update public.pylon_outreach
     set parent_decision            = decision,
         parent_decided_at          = now(),
         parent_decided_name        = decided_name,
         parent_approved            = (decision = 'approved'),
         approved_text_sha256       = case when decision = 'approved'
                                        then public.pylon_outreach_text_sha256(draft_subject, draft_body) end,
         parent_approval_token_hash = null,
         parent_approval_expires_at = null,
         updated_at                 = now()
   where parent_approval_token_hash = token_hash
     and parent_approval_expires_at > now()
     and parent_decision is null
     and sent_at is null
     and decision in ('approved', 'declined')
     and char_length(btrim(coalesce(decided_name, ''))) between 2 and 200
  returning id
$$;

-- Only the server (service role) uses these.
do $$
declare r text;
begin
  revoke all on function public.pylon_outreach_for_family(text) from public;
  revoke all on function public.pylon_outreach_decide(text, text, text) from public;
  revoke all on function public.pylon_outreach_text_sha256(text, text) from public;
  revoke all on function public.pylon_outreach_gate() from public;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.pylon_outreach from %I', r);
      execute format('revoke all on function public.pylon_outreach_for_family(text) from %I', r);
      execute format('revoke all on function public.pylon_outreach_decide(text, text, text) from %I', r);
      execute format('revoke all on function public.pylon_outreach_text_sha256(text, text) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.pylon_outreach_for_family(text) to service_role';
    execute 'grant execute on function public.pylon_outreach_decide(text, text, text) to service_role';
    execute 'grant execute on function public.pylon_outreach_text_sha256(text, text) to service_role';
  end if;
end $$;
