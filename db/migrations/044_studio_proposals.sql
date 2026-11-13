-- 044: kits proposed in the repo (agents/studio/proposals; routes/studio-agents.js
-- /proposals; docs/studio-films.md "Kits for every line of work"). Builds on 018.
--
--   * An approver makes a proposed kit a draft: a studio_kits row with
--     role 'proposal'. One open draft of a proposal per slug: two approvers
--     at once make one draft, and the other is pointed to it.

create unique index if not exists studio_kits_one_proposal_draft
  on public.studio_kits (slug) where status = 'draft' and role = 'proposal';
