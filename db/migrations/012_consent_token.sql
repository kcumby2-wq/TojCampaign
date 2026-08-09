-- 012_consent_token.sql
-- Guardian-consent request → capture loop.
-- Each minor intake gets a one-time consent_token. The operator shares the link
-- (/consent.html?token=…) with the guardian; the guardian grants a visibility
-- level (c1/c3/c4) on a public page; the backend flips consent_status to granted
-- and (for c3+) embeds to the agent RAG — auto-unlocking the agent hand-off.
alter table public.onboarding_intakes add column if not exists consent_token text;
create unique index if not exists onboarding_intakes_consent_token_idx
  on public.onboarding_intakes (consent_token) where consent_token is not null;
