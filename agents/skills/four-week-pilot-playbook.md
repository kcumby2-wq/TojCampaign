# Skill: Four-Week Pilot Playbook

Purpose: the reusable 0→100 execution plan the notes describe for launching a new agent-supported workflow — for any client, any vertical. Invoked whenever TOJ takes on a new client-side workflow to systemize. Ships one new module in 4 weeks with signed-off metrics.

## When to load

- Pilot Intake Triage — after tier + vertical classification, if the pilot is Core or Premium and their scoped workflow fits this pattern
- Concierge Weekly Producer — when adding a new module to a pilot's Weekly Drop rotation
- Kyron — when scoping a new pilot conversation

## The 4-week arc

### Week 1 — Shadow + Spec

**Days 1–3 — Shadow.** Watch 10–20 real runs of the client's current workflow (screen recording OR live observation OR async note captures). Narrate every step in the operator's own words.

**Days 4–5 — Extract.** Turn the shadow into the trusted-agent spec (7 questions from `docs/ai-notes-implementation-plan.md`):

1. Wakes up (trigger)
2. Context (data + memory scope)
3. Tools (allowed surface)
4. Autonomy (what it does without approval)
5. Success (definition of done)
6. Approval gates
7. Escalation conditions

**Days 6–7 — Eval set.** Build 15–20 real examples from the shadow (input + expected output). This is the pass criteria for shipping.

**Success signal for Week 1:** operator signs off on the spec + the eval set. If either is contested, extend Week 1.

### Week 2 — Build + Solo Runs

**Days 8–10 — Build.** Use the Architect agent to draft the role + skill files. Ship the role into the orchestrator on a namespaced test surface — never touching the operator's live workflow yet.

**Days 11–14 — Solo runs.** Run the agent against the eval set. Score each output against the expected result. Track pass rate.

**Success signal for Week 2:** pass rate > 60% against the eval set. If below, return to shadow (spec is wrong).

### Week 3 — Shadowed Live Runs

**Days 15–17 — Parallel runs.** Agent runs alongside operator; operator produces their normal output; agent produces theirs; compare each day. Kyron reviews delta.

**Days 18–21 — Fix at source.** Every mismatch between operator output and agent output = fix in the role or the skill (not in the eval). Operator does NOT change how they work.

**Success signal for Week 3:** pass rate > 85% against real work (not just eval set). Below that = extend to Week 3.5.

### Week 4 — Cutover

**Days 22–24 — Cutover.** Agent produces the primary output. Operator reviews before the artifact ships to real client(s). Kyron sees every artifact for review.

**Days 25–27 — Iterate.** Any operator or Kyron notes get fed back into the role/skill. Not a rewrite — targeted fixes.

**Day 28 — Handoff.** Operator + Kyron sign the "tested labor" report:
- Pass rate against eval set: [X%]
- Pass rate against real work: [Y%]
- Approval-required rate: [Z% of outputs required operator or Kyron approval]
- Time saved per week: [hours]
- Kill criteria met? [yes/no]

**Success signal for Week 4:** operator uses the agent as their primary tool for that workflow going forward. If they revert to manual within 30 days = spec failed.

## Deliverables per pilot

For every pilot workflow run through this playbook, TOJ ships:

- `agents/roles/[client]-[workflow].js` (namespaced under the pilot)
- `agents/skills/[workflow].md`
- `data/shadow-logs/[client]-[workflow]/` — the shadow recordings + transcripts
- `data/eval-sets/[client]-[workflow].md` — the 15–20 example set
- `docs/pilot-reports/[client]-[workflow]-week-4-signoff.md` — the tested-labor report

## When to abort

- **End of Week 1:** operator can't articulate their own workflow. That's not a TOJ problem — that's a client-side clarity gap. Reschedule pilot for later.
- **End of Week 2:** pass rate < 30% against the eval set. The workflow may not be automatable at all; return to operator with a "here's what to do with humans first" report.
- **End of Week 3:** pass rate < 60% against real work. The eval set may not have captured real edge cases; consider extending shadow to 30+ runs before continuing.

## Rules

- Never skip the shadow. If nobody watched the human do it 10+ times, the spec is fiction.
- Never build against a spec the operator hasn't signed off on.
- Never accept an eval set with fewer than 15 real examples (invented examples don't count).
- Never cutover before Week 3's shadowed-live pass rate hits 85%.
- Never claim "tested labor" without the Day 28 signoff report.

## Anti-patterns

- "Let's just have the agent try it and see what happens" — no. That's how you build vague automation, not tested labor.
- Fixing the eval set to match the agent's output — the eval set represents the operator's real work; the agent adapts, not the eval.
- Skipping Week 3 because "it looks good in solo runs" — no. Solo runs run against the eval set (curated); Week 3 tests against reality (uncurated).

## Fallback when data is missing

If the operator can't shadow (they're too busy, or the workflow is intermittent), extend Week 1 to 4 weeks total and observe fewer runs at higher fidelity. Never invent a shadow to hit the timeline.

---

**References:** the notes' 0→100 plan for launching a new agent-SaaS niche; `agents/skills/paycheck-workflow.md` (used at pilot-intake time to score whether the workflow is worth 4-week-playbook investment).
