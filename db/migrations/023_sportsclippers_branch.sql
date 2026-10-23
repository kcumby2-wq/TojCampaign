-- 023: SportsClippers replaces Flippa Highlights as an onboarding branch
-- (routes/onboarding.js, VALID_BRANCHES).
--
-- Ground Floor Sports moved its marketplace from Flippa Highlights to
-- SportsClippers in October 2026. New intakes are stored under
-- 'sportsclippers'; the route still accepts 'flippa-highlights' from old forms
-- and saved links and stores it under the new name, and the CRM filters match
-- both until this migration has run.
--
-- The comment on onboarding_intakes.branch in 009 lists the old name. 009 is
-- left as it was applied; this file is the record of the rename.
--
-- Safe to run more than once.

update public.onboarding_intakes
   set branch = 'sportsclippers'
 where branch = 'flippa-highlights';

comment on column public.onboarding_intakes.branch is
  'subject-medias | subject-report | subject-skillz | coached-by-hooks | sportsclippers | optimum-grading | pylon | trail-of-joy';
