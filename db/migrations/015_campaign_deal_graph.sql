-- 015: Campaign deal graph — schema "deal".
--
-- One versioned record of every deal term (parties, prices, splits, fees,
-- dates, obligations) per campaign. Documents (agreements, schedules, cover
-- letters, decks) are checked against it: claims point at facts, and the
-- consistency agent raises findings when the words and the facts disagree.
--
-- Why a separate schema: Supabase's REST API only exposes `public`, so nothing
-- here is reachable with the anon or authenticated keys. The app reaches it
-- server-side only (CAMPAIGN_DATABASE_URL, utils/campaign-db.js).
--
-- Rules that live in the database, not only in an agent's instructions:
--   * Facts change only through a proposed graph version; there is at most one
--     open (unapproved) version per campaign.
--   * Only an owner or approver approves a version, only as themselves, never
--     while a blocker finding on that version is open. Approved is final.
--   * A fact in an approved version never changes; a later version closes it.
--   * Approval requests are filed undecided; the requester can't decide them;
--     decisions are final.
--   * Nothing outbound is approved or sent without an approved approval for
--     that exact item.
--   * A waived finding records who waived it; blockers need owner/approver.
--   * Members are added by owners (the very first owner adds themselves).
--
-- "Who is acting" comes from the transaction setting deal.actor, set by the
-- server from the signed-in staff email (or 'agent:<role>' for agent tools).
-- Agents are never members, so every gate above refuses them.
--
-- Athlete and family records never enter this schema. Contacts are partner
-- staff only.
--
-- Not applied automatically. Kyron applies it after review.

create schema if not exists deal;

-- Who is acting in this transaction.
create or replace function deal.actor() returns text
language sql stable as $$
  select nullif(current_setting('deal.actor', true), '')
$$;

-- 1 · Tenancy ----------------------------------------------------------------
create table deal.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
  name        text not null,
  plan        text not null default 'internal'
              check (plan in ('internal', 'pilot', 'standard')),
  created_at  timestamptz not null default now()
);

create table deal.members (
  tenant_id   uuid not null references deal.tenants (id) on delete cascade,
  email       text not null check (email = lower(email) and email like '%_@_%'),
  role        text not null check (role in ('owner', 'approver', 'editor', 'viewer')),
  added_by    text not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, email)
);

-- The acting person's role in a tenant (null = not a member, e.g. an agent).
create or replace function deal.actor_role(p_tenant uuid) returns text
language sql stable as $$
  select m.role from deal.members m
  where m.tenant_id = p_tenant and m.email = deal.actor()
$$;

-- 2 · Packs: voice and rules (tenant_id null = a shared starter pack) --------
create table deal.packs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references deal.tenants (id) on delete cascade,
  name        text not null,
  version     int  not null default 1,
  voice       jsonb not null default '{}',              -- tone rules, banned words
  created_at  timestamptz not null default now()
);
create unique index packs_unique_tenant on deal.packs (tenant_id, name, version) where tenant_id is not null;
create unique index packs_unique_shared on deal.packs (name, version) where tenant_id is null;

create table deal.policies (
  id          uuid primary key default gen_random_uuid(),
  pack_id     uuid not null references deal.packs (id) on delete cascade,
  code        text not null,                            -- 'no_outcome_pay'
  severity    text not null check (severity in ('hard_stop', 'needs_approval', 'warning')),
  rule        jsonb not null,                           -- machine-checkable form
  why         text not null,                            -- the reason shown to a person
  unique (pack_id, code)
);

create table deal.clauses (
  id          uuid primary key default gen_random_uuid(),
  pack_id     uuid not null references deal.packs (id) on delete cascade,
  code        text not null,                            -- 'share.off_the_top'
  body        text not null,                            -- text with {{fact.key}} bindings
  binds       text[] not null default '{}',
  counsel_ok  date,                                     -- null = counsel has not reviewed it
  unique (pack_id, code)
);

-- 3 · Campaigns and the versioned deal graph ----------------------------------
create table deal.campaigns (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references deal.tenants (id) on delete cascade,
  pack_id     uuid references deal.packs (id),
  name        text not null,
  status      text not null default 'draft'
              check (status in ('draft', 'negotiating', 'signed', 'live', 'closed')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  unique (id, tenant_id)
);

create table deal.graph_versions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  number      int  not null check (number > 0),
  summary     text not null,
  proposed_by text not null,                            -- 'agent:intake' or a staff email
  approved_by text,                                     -- null until an owner/approver signs off
  approved_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (campaign_id, number),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);
create unique index graph_versions_one_open on deal.graph_versions (campaign_id) where approved_by is null;

create table deal.facts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  campaign_id  uuid not null,
  key          text not null check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),  -- 'split.pylon.event_sales'
  kind         text not null check (kind in ('party', 'role', 'offering', 'price', 'split', 'fee',
                 'obligation', 'milestone', 'constraint', 'assumption', 'disclosure')),
  value        jsonb not null,
  status       text not null check (status in ('proposed', 'agreed', 'signed', 'posted',
                 'hypothetical', 'measured')),
  source       text,                                    -- 'Pylon v11 §8(d)', 'call 2026-10-24'
  from_version int  not null,
  to_version   int,                                     -- null = still current
  check (to_version is null or to_version > from_version),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade,
  foreign key (campaign_id, from_version) references deal.graph_versions (campaign_id, number),
  foreign key (campaign_id, to_version)   references deal.graph_versions (campaign_id, number)
);
create unique index facts_one_current on deal.facts (campaign_id, key) where to_version is null;
create index facts_by_version on deal.facts (campaign_id, from_version, to_version);

-- The graph as it stood at one version
create or replace function deal.graph_at (p_campaign uuid, p_version int)
returns setof deal.facts language sql stable as $$
  select * from deal.facts
  where campaign_id = p_campaign
    and from_version <= p_version
    and (to_version is null or to_version > p_version)
$$;

-- What changed between two versions
create or replace function deal.graph_diff (p_campaign uuid, p_from int, p_to int)
returns table (key text, change text, old_value jsonb, new_value jsonb, old_status text, new_status text)
language sql stable as $$
  with a as (select f.key, f.value, f.status from deal.graph_at(p_campaign, p_from) f),
       b as (select f.key, f.value, f.status from deal.graph_at(p_campaign, p_to) f)
  select coalesce(a.key, b.key),
         case when a.key is null then 'added' when b.key is null then 'removed' else 'changed' end,
         a.value, b.value, a.status, b.status
  from a full join b on a.key = b.key
  where (a.value, a.status) is distinct from (b.value, b.status)
  order by 1
$$;

-- 4 · Documents and what they claim ------------------------------------------
create table deal.documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  kind        text not null check (kind in ('agreement', 'schedule', 'addendum', 'letter', 'model',
                'deck', 'plan', 'page', 'email', 'playbook')),
  title       text not null,
  audience    text not null check (audience in ('internal', 'partner', 'counsel', 'family', 'public')),
  origin      text not null check (origin in ('compiled', 'uploaded')),
  created_at  timestamptz not null default now(),
  unique (id, campaign_id),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

create table deal.document_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  campaign_id   uuid not null,
  document_id   uuid not null,
  number        int  not null check (number > 0),
  graph_version int,                                    -- the graph it was built or last checked against
  body          text not null,                          -- the text the agents read (private schema)
  status        text not null default 'draft'
                check (status in ('draft', 'in_review', 'approved', 'sent', 'signed', 'stale')),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  unique (document_id, number),
  unique (id, campaign_id),
  foreign key (document_id, campaign_id) references deal.documents (id, campaign_id) on delete cascade,
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

create table deal.claims (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  version_id  uuid not null,
  locator     text not null,                            -- 'Schedule M-6 ¶1', 'slide 9'
  quote       text not null,                            -- the words as they stand
  fact_keys   text[] not null default '{}',             -- empty = not tied to a fact yet
  stated      jsonb,                                    -- the value the words assert
  bound_by    text not null check (bound_by in ('compiler', 'extractor')),
  confidence  real check (confidence between 0 and 1),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  foreign key (version_id, campaign_id) references deal.document_versions (id, campaign_id) on delete cascade,
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

create table deal.findings (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  campaign_id   uuid not null,
  graph_version int  not null,
  version_id    uuid,                                   -- the document version it is about, if one
  kind          text not null check (kind in ('value_mismatch', 'stale', 'cross_document', 'arithmetic',
                  'policy', 'missing_disclosure', 'unbound_claim', 'banned_word')),
  severity      text not null check (severity in ('blocker', 'major', 'minor')),
  claim_ids     uuid[] not null default '{}',
  fact_key      text,
  message       text not null,                          -- what is wrong and where, in plain words
  fix           text,                                   -- the suggested change
  status        text not null default 'open' check (status in ('open', 'fixed', 'waived')),
  raised_by     text not null,
  resolved_by   text,
  resolved_at   timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  check ((status = 'open') = (resolved_by is null)),
  foreign key (campaign_id, graph_version) references deal.graph_versions (campaign_id, number) on delete cascade,
  foreign key (version_id, campaign_id) references deal.document_versions (id, campaign_id) on delete cascade,
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);
create index findings_open on deal.findings (campaign_id, graph_version) where status = 'open';

-- 5 · Approvals and outbound -----------------------------------------------------
create table deal.approvals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  campaign_id  uuid not null,
  subject      text not null check (subject in ('graph_version', 'document_version', 'outbound',
                 'publish', 'autonomy')),
  subject_id   uuid not null,
  policy_code  text,
  requested_by text not null,                           -- 'agent:outreach' or a staff email
  decided_by   text,
  decision     text check (decision in ('approved', 'rejected')),
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  check ((decision is null) = (decided_by is null)),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

create table deal.contacts (                            -- partner staff only
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references deal.tenants (id) on delete cascade,
  party_key   text not null,                            -- the party fact this person works for
  name        text not null,
  email       text,
  title       text,
  unique (id, tenant_id)
);

create table deal.outbound (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  campaign_id uuid not null,
  channel     text not null check (channel in ('email', 'sms', 'social', 'esign')),
  contact_id  uuid,                                     -- null for a public post
  subject     text,
  body        text not null,
  status      text not null default 'draft' check (status in ('draft', 'approved', 'sent', 'cancelled')),
  approval_id uuid references deal.approvals (id),
  sent_at     timestamptz,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  check (status not in ('approved', 'sent') or approval_id is not null),
  foreign key (contact_id, tenant_id) references deal.contacts (id, tenant_id),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

-- 6 · Agent run log: ids and outcomes, never identities ----------------------
create table deal.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  campaign_id   uuid not null,
  agent         text not null,                          -- role id, e.g. 'consistency'
  requested_by  text not null,                          -- staff email
  version_id    uuid,                                   -- document version in scope, if any
  task          text not null,
  status        text not null default 'running' check (status in ('running', 'completed', 'waiting', 'failed')),
  output        text,
  tool_calls    jsonb not null default '[]',            -- tool name + ids touched
  staged        jsonb,                                  -- what the accepted (or last) attempt staged
  committed     jsonb,                                  -- what was saved: counts and the version number
  eval_status   text,
  retry_count   int not null default 0,
  error         text,
  usage         jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  foreign key (version_id, campaign_id) references deal.document_versions (id, campaign_id) on delete set null (version_id),
  foreign key (campaign_id, tenant_id) references deal.campaigns (id, tenant_id) on delete cascade
);

-- 7 · Gates -------------------------------------------------------------------------

-- Members: owners add, change and remove members. The first member of a new
-- tenant may add themselves, and only as owner.
create or replace function deal.member_gate () returns trigger language plpgsql as $$
declare
  t uuid := coalesce(new.tenant_id, old.tenant_id);
begin
  if tg_op = 'INSERT' and not exists (select 1 from deal.members m where m.tenant_id = t) then
    if deal.actor() is null or new.email <> deal.actor() or new.role <> 'owner' then
      raise exception 'the first member of a tenant must be its owner, adding themselves';
    end if;
    return new;
  end if;
  if coalesce(deal.actor_role(t), '') <> 'owner' then
    raise exception 'only an owner can change members';
  end if;
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner')
     and not exists (select 1 from deal.members m
                     where m.tenant_id = t and m.role = 'owner' and m.email <> old.email) then
    raise exception 'a tenant must keep at least one owner';
  end if;
  return coalesce(new, old);
end $$;

create trigger member_gate before insert or update or delete on deal.members
  for each row execute function deal.member_gate();

-- Graph versions: numbered in order, one open at a time; only an owner or
-- approver approves, as themselves, with no open blocker findings; approved
-- is final and can't be deleted.
create or replace function deal.graph_version_gate () returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.approved_by is not null then
      raise exception 'graph version % is approved and final', old.number;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.number <> coalesce((select max(g.number) from deal.graph_versions g
                               where g.campaign_id = new.campaign_id), 0) + 1 then
      raise exception 'graph versions are numbered in order; next is %',
        coalesce((select max(g.number) from deal.graph_versions g where g.campaign_id = new.campaign_id), 0) + 1;
    end if;
    if new.approved_by is not null then
      raise exception 'a graph version is proposed first, then approved';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.approved_by is not null then
    raise exception 'graph version % is approved and final; propose a new version instead', old.number;
  end if;
  if (new.tenant_id, new.campaign_id, new.number) is distinct from (old.tenant_id, old.campaign_id, old.number) then
    raise exception 'a graph version cannot move';
  end if;
  if new.approved_by is not null then
    if deal.actor() is null or new.approved_by <> deal.actor()
       or coalesce(deal.actor_role(new.tenant_id), '') not in ('owner', 'approver') then
      raise exception 'only an owner or approver can approve graph version %, and only as themselves', new.number;
    end if;
    if exists (select 1 from deal.findings f
               where f.campaign_id = new.campaign_id and f.graph_version = new.number
                 and f.status = 'open' and f.severity = 'blocker') then
      raise exception 'graph version % has open blocker findings; fix or waive them first', new.number;
    end if;
    new.approved_at := now();
  end if;
  return new;
end $$;

create trigger graph_version_gate before insert or update or delete on deal.graph_versions
  for each row execute function deal.graph_version_gate();

-- Facts: added only to the open version; closed or reopened only by the open
-- version; a fact in an approved version never changes.
create or replace function deal.fact_gate () returns trigger language plpgsql as $$
declare
  open_v int;
begin
  if tg_op in ('UPDATE', 'DELETE')
     and exists (select 1 from deal.graph_versions g
                 where g.campaign_id = old.campaign_id and g.number = old.from_version
                   and g.approved_by is not null)
     and (tg_op = 'DELETE'
          or (old.tenant_id, old.campaign_id, old.key, old.kind, old.value, old.status, old.source, old.from_version)
             is distinct from
             (new.tenant_id, new.campaign_id, new.key, new.kind, new.value, new.status, new.source, new.from_version)) then
    raise exception 'fact % belongs to approved version %; change it in a new version', old.key, old.from_version;
  end if;

  if tg_op = 'DELETE' then return old; end if;

  select g.number into open_v from deal.graph_versions g
  where g.campaign_id = new.campaign_id and g.approved_by is null;

  if tg_op = 'INSERT' and (open_v is null or new.from_version <> open_v) then
    raise exception 'facts are added only to the open proposed version';
  end if;
  if tg_op = 'UPDATE' and new.to_version is distinct from old.to_version
     and not ((new.to_version is not null and new.to_version = open_v and old.to_version is null)
              or (new.to_version is null and old.to_version = open_v)) then
    raise exception 'a fact is closed (or reopened) only by the open proposed version';
  end if;
  return new;
end $$;

create trigger fact_gate before insert or update or delete on deal.facts
  for each row execute function deal.fact_gate();

-- Findings: resolving one records who did it; waiving a blocker needs an owner
-- or approver; agents (never members) can raise findings but not resolve them.
create or replace function deal.finding_gate () returns trigger language plpgsql as $$
declare
  r text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' then raise exception 'findings are raised open'; end if;
    return new;
  end if;
  if old.status <> 'open' then
    raise exception 'finding % is already %', old.id, old.status;
  end if;
  if (new.tenant_id, new.campaign_id, new.graph_version, new.kind, new.severity, new.message, new.raised_by)
     is distinct from (old.tenant_id, old.campaign_id, old.graph_version, old.kind, old.severity, old.message, old.raised_by) then
    raise exception 'a finding''s substance cannot be edited; raise a new one';
  end if;
  if new.status <> 'open' then
    r := deal.actor_role(new.tenant_id);
    if r is null or new.resolved_by is distinct from deal.actor() or r = 'viewer' then
      raise exception 'only a member (not a viewer, not an agent) can resolve a finding, as themselves';
    end if;
    if new.status = 'waived' and new.severity = 'blocker' and r not in ('owner', 'approver') then
      raise exception 'only an owner or approver can waive a blocker';
    end if;
    new.resolved_at := now();
  end if;
  return new;
end $$;

create trigger finding_gate before insert or update on deal.findings
  for each row execute function deal.finding_gate();

-- Approvals: filed undecided; decided once, by an owner or approver, as
-- themselves, never by whoever asked.
create or replace function deal.approval_gate () returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.decision is not null then raise exception 'an approval request is filed undecided'; end if;
    return new;
  end if;
  if old.decision is not null then
    raise exception 'approval % is already decided', old.id;
  end if;
  if (new.tenant_id, new.campaign_id, new.subject, new.subject_id, new.requested_by)
     is distinct from (old.tenant_id, old.campaign_id, old.subject, old.subject_id, old.requested_by) then
    raise exception 'an approval request cannot be edited';
  end if;
  if new.decision is not null then
    if deal.actor() is null or new.decided_by <> deal.actor()
       or coalesce(deal.actor_role(new.tenant_id), '') not in ('owner', 'approver') then
      raise exception 'only an owner or approver can decide, and only as themselves';
    end if;
    if new.decided_by = new.requested_by then
      raise exception 'whoever asked for an approval cannot decide it';
    end if;
    new.decided_at := now();
  end if;
  return new;
end $$;

create trigger approval_gate before insert or update on deal.approvals
  for each row execute function deal.approval_gate();

-- Outbound: nothing approved or sent without an approved approval for that exact item.
create or replace function deal.outbound_gate () returns trigger language plpgsql as $$
begin
  if new.status in ('approved', 'sent') and not exists (
       select 1 from deal.approvals a
       where a.id = new.approval_id and a.subject = 'outbound'
         and a.subject_id = new.id and a.decision = 'approved') then
    raise exception 'outbound % needs an approved approval before it can be %', new.id, new.status;
  end if;
  return new;
end $$;

create trigger outbound_gate before insert or update on deal.outbound
  for each row execute function deal.outbound_gate();

-- 8 · The only ways to approve or discard a version ---------------------------------
create or replace function deal.approve_graph_version (p_version uuid) returns deal.graph_versions
language plpgsql as $$
declare
  v deal.graph_versions;
begin
  update deal.graph_versions set approved_by = deal.actor()
  where id = p_version and approved_by is null
  returning * into v;
  if v.id is null then raise exception 'no open graph version %', p_version; end if;
  return v;
end $$;

-- Throw away the open version: its facts go, facts it closed reopen.
create or replace function deal.discard_graph_version (p_version uuid) returns void
language plpgsql as $$
declare
  v deal.graph_versions;
begin
  select * into v from deal.graph_versions where id = p_version for update;
  if v.id is null then raise exception 'no graph version %', p_version; end if;
  if v.approved_by is not null then raise exception 'graph version % is approved and final', v.number; end if;
  if coalesce(deal.actor_role(v.tenant_id), '') not in ('owner', 'approver', 'editor') then
    raise exception 'only an owner, approver or editor can discard a proposed version';
  end if;
  delete from deal.facts where campaign_id = v.campaign_id and from_version = v.number;
  update deal.facts set to_version = null where campaign_id = v.campaign_id and to_version = v.number;
  delete from deal.graph_versions where id = v.id;
end $$;

-- 9 · Nothing in this schema is reachable through Supabase's public API roles.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema deal from %I', r);
      execute format('revoke all on all tables in schema deal from %I', r);
      execute format('revoke all on all functions in schema deal from %I', r);
    end if;
  end loop;
end $$;
revoke all on schema deal from public;
revoke execute on all functions in schema deal from public;
