-- 013_recruiting_parent_approval.sql
-- Recruiting Concierge hard line: no outreach is sent without the PARENT's
-- approval of that exact draft. Before this migration any signed-in staff user
-- (or holder of PYLON_API_KEY) could flip parent_approved=true.
--
-- Now:
--   * Staff can only REQUEST approval. That issues a one-time link for the parent.
--     Only a SHA-256 hash of the token is stored; the token itself is never saved.
--   * The parent approves or declines on a public, token-gated page.
--   * The database refuses to mark a draft approved unless the same update burns
--     an issued parent token, refuses to send an unapproved draft, and refuses to
--     change the text of a draft after the parent approved it.
--   * Editing a draft while a link is out cancels that link, so the parent always
--     approves the text that will actually be sent.

alter table pylon_recruiting_outreach
  add column if not exists parent_approval_token_hash   text,
  add column if not exists parent_approval_requested_at timestamptz,
  add column if not exists parent_approval_expires_at   timestamptz,
  add column if not exists parent_decision              text,
  add column if not exists parent_decided_at            timestamptz,
  add column if not exists parent_decided_name          text,
  add column if not exists approved_text_sha256         text;

alter table pylon_recruiting_outreach
  drop constraint if exists pylon_recruiting_outreach_decision_chk;
alter table pylon_recruiting_outreach
  add constraint pylon_recruiting_outreach_decision_chk
  check (parent_decision is null or parent_decision in ('approved', 'declined'));

-- Nothing is sent unless the parent approved it.
alter table pylon_recruiting_outreach
  drop constraint if exists pylon_recruiting_outreach_sent_needs_parent_chk;
alter table pylon_recruiting_outreach
  add constraint pylon_recruiting_outreach_sent_needs_parent_chk
  check (sent_at is null or parent_approved = true);

create unique index if not exists pylon_recruiting_outreach_token_idx
  on pylon_recruiting_outreach (parent_approval_token_hash)
  where parent_approval_token_hash is not null;

create or replace function pylon_recruiting_outreach_parent_gate() returns trigger
language plpgsql as $$
begin
  -- 1. Approval can only be recorded in the same update that burns an issued parent token.
  if new.parent_approved and not coalesce(old.parent_approved, false) then
    if old.parent_approval_token_hash is null
       or new.parent_approval_token_hash is not null
       or new.parent_decision is distinct from 'approved' then
      raise exception 'outreach % can only be approved by the parent through their approval link', old.id;
    end if;
  end if;

  -- 2. Once approved, the words and the recipient are fixed.
  if coalesce(old.parent_approved, false)
     and (new.draft_subject is distinct from old.draft_subject
          or new.draft_body  is distinct from old.draft_body
          or new.coach_email is distinct from old.coach_email) then
    raise exception 'outreach % was approved by the parent; create a new draft instead of editing it', old.id;
  end if;

  -- 3. Editing a draft while a link is out cancels the link.
  if old.parent_approval_token_hash is not null
     and new.parent_approval_token_hash is not distinct from old.parent_approval_token_hash
     and (new.draft_subject is distinct from old.draft_subject
          or new.draft_body  is distinct from old.draft_body
          or new.coach_email is distinct from old.coach_email) then
    new.parent_approval_token_hash := null;
    new.parent_approval_expires_at := null;
  end if;

  return new;
end $$;

drop trigger if exists pylon_recruiting_outreach_parent_gate on pylon_recruiting_outreach;
create trigger pylon_recruiting_outreach_parent_gate
  before update on pylon_recruiting_outreach
  for each row execute function pylon_recruiting_outreach_parent_gate();

-- A draft can't be born approved or sent.
create or replace function pylon_recruiting_outreach_insert_gate() returns trigger
language plpgsql as $$
begin
  if coalesce(new.parent_approved, false) or new.sent_at is not null
     or new.parent_decision is not null then
    raise exception 'a new outreach draft cannot start approved or sent';
  end if;
  return new;
end $$;

drop trigger if exists pylon_recruiting_outreach_insert_gate on pylon_recruiting_outreach;
create trigger pylon_recruiting_outreach_insert_gate
  before insert on pylon_recruiting_outreach
  for each row execute function pylon_recruiting_outreach_insert_gate();
