# Skill: Paycheck Workflow

Purpose: score any candidate workflow — inbound client's OR TOJ's internal — using the notes' 5-question paycheck evaluation. Determines whether the workflow is worth systemizing (via the Four-Week Pilot Playbook) OR whether it belongs elsewhere. Applied at pilot intake and at internal-automation planning.

## When to load

- **Pilot Intake Triage** — every inbound pilot request gets scored on the 5 questions before Kyron sees a proposal
- **Research Assistant** — when evaluating an internal TOJ workflow candidate for automation
- **CFO** — when pricing the outcome-priced tier (`docs/toj-distribution-runbook.md` § outcome-priced offering)

## The 5 questions

Each answered on a 0–3 scale. Total 0–15. Ship-ready threshold: ≥ 11.

### Q1 · How easy is done?

Can the workflow's success or failure be observed from outside the operator's head?

- **0** — Impossible; success is a feeling. (Not automatable. Not pilot-ready.)
- **1** — Requires operator narration to know if it worked. Hard to score.
- **2** — Observable but subjective. Different reviewers might score differently.
- **3** — Observable and objective. A checklist or a metric confirms done.

### Q2 · How often?

How many times per week/month does the workflow run?

- **0** — Ad-hoc. Runs less than once a month. (Not worth automation investment.)
- **1** — 1–3× per month.
- **2** — 1–3× per week.
- **3** — Daily or more.

### Q3 · How expensive is the pain?

What does it cost when the workflow runs badly or not at all?

- **0** — Nothing measurable. Nice-to-have. (Not pilot-priority.)
- **1** — Time cost (hours/week) but no revenue impact.
- **2** — Time cost + secondary revenue impact (missed follow-ups, delayed shipping).
- **3** — Direct revenue at stake per event. Losing sales, losing clients, missing deadlines with consequence.

### Q4 · What tools already exist?

How much infrastructure is already in place for this workflow?

- **0** — Nothing. Would need to build a new tool AND design the process.
- **1** — Some pieces exist but scattered across systems.
- **2** — Most tools exist but they don't talk to each other.
- **3** — Tools are integrated. The gap is orchestration, not tooling.

### Q5 · Who owns the budget?

Is there a defined budget owner for this workflow?

- **0** — Nobody. "We should probably figure this out." (Not a real workflow — it's a wish.)
- **1** — Split ownership. Multiple parties partially responsible.
- **2** — Single owner but budget authority is unclear.
- **3** — Single owner with clear budget authority for the fix.

## Scoring bands

| Score | Interpretation | Action |
|-------|---------------|--------|
| **13–15** | Prime candidate. Systemize immediately. | Route to Four-Week Pilot Playbook. Propose Premium tier ($499) or outcome-priced offering. |
| **11–12** | Ship-ready. Systemize this quarter. | Route to Four-Week Pilot Playbook. Propose Core tier ($199). |
| **9–10** | Marginal. Systemize if capacity allows. | Waitlist. Revisit when Q-scores update. |
| **6–8** | Not yet. Foundational work needed first. | Redirect to Foundation Score intake — the workflow won't automate cleanly until the Foundation moves. |
| **0–5** | Not automatable at TOJ's altitude. | Decline the pilot for now OR redirect to Founding tier ($99) for the Foundation Score alone (no workflow automation). |

## Output format

Every scoring produces:

```yaml
workflow: [name]
scored_by: [role/human]
scored_at: [YYYY-MM-DD]
questions:
  Q1_how_easy_done: [0-3]
  Q2_how_often: [0-3]
  Q3_pain_cost: [0-3]
  Q4_tools_exist: [0-3]
  Q5_budget_owner: [0-3]
total: [0-15]
band: [Prime | Ship-ready | Marginal | Not-yet | Decline]
recommended_tier: [Premium | Core | Founding | Decline]
notes: [1-3 sentences of context]
```

Store at `docs/paycheck-scores/[client-slug]-[workflow-slug].yaml`. Every pilot proposal references its paycheck score.

## Rules

- Every scoring includes 1–3 sentence context notes. A bare number is not a signal.
- Never score without observation. If the requester can't demonstrate the workflow in a shadow, use "Not-yet" and require the Foundation Score first.
- Never revise a score without documenting why (context changed, workflow scoped differently, tools shifted).
- Never score TOJ's own workflows on a different scale than clients' — the discipline applies to both.

## Anti-patterns

- Scoring high because you like the client — the numbers are the numbers.
- Scoring low to justify not doing something — surface the honest number and let the band suggest an alternative offer.
- Averaging scores across multiple workflows for the same client — score each workflow independently.

## Fallback when data is missing

If any of the 5 questions can't be answered with confidence, default to 1 for that question. Note in the output which questions were guess-scored. Any output with 2+ guess-scored questions is not eligible for the Prime or Ship-ready bands regardless of total.

---

**References:** the notes' 5-question paycheck evaluation. Feeds `agents/skills/four-week-pilot-playbook.md` for pilots that pass the ship-ready gate. Feeds `docs/toj-distribution-runbook.md` § outcome-priced offering for eligibility.
