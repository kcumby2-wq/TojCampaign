# Hooks Agents · Consistency Review — 9/10 Quality × 10/10 Consistency

**Reviewed:** 2026-07-27
**Scope:** all 6 Hooks roles (Grader · Recruiter Liaison · Roster Pulse · NIL Strategist · Parent Communicator · Trainer Blueprint Coach), the eval spec, the tools file, the API contract.
**Framing:** the design thesis embedded in the standalone spec page is *"9/10 quality with 10/10 consistency."* This review grades the stack against that thesis and proposes concrete patches to close the gap.

---

## TL;DR grade

**Quality: 9.1 / 10** — the personas are strong, the retrieval discipline is real, the eval-spec catches the sharp-edged failures (fabricated measurables, head-coach drafts, hype vocabulary).

**Consistency: 6.5 / 10** — the ceiling that keeps the whole stack from feeling like a single product. Output shapes drift across roles, missing-data handling is worded differently in each persona, the human-review flag doesn't have one canonical format, and the eval spec applies uniformly regardless of role.

The upside: **every consistency gap identified below is a small, targeted patch — not a rewrite.** An hour of work gets the whole stack from 6.5 → 9+ on consistency without touching what already works.

---

## What's already right (don't break)

1. **Retrieval-first discipline is uniform.** All 6 roles instruct `retrieve_client_context` as step 0. The `invented_athlete_facts` auto-fail in the eval spec enforces it programmatically. This is the strongest single feature of the current stack.

2. **The eval spec is real, not decorative.**
   - 5 pass/fail questions covering athlete-specificity, EV discipline, Margin-time minimized, verified-not-plausible, leverage
   - 4 auto-fails with actual regex + LLM-check + trace patterns
   - Retry loop up to 3 attempts, then lands in `waiting` for human review
   - `fabricated_measurables` uses an `llm_check` — the right shape for a semantic risk

3. **Two roles (Trainer Blueprint Coach, Roster Pulse) already ship with fenced output templates.** Every generation lands in the same shape → downstream systems can parse. This is the pattern the other 4 roles need to inherit.

4. **The tools are minimal and disciplined.** 3 tools (list_athletes, get_athlete, retrieve_client_context). Zero temptation to reach beyond the RAG surface. Correct scope.

5. **The head-coach regex auto-fail is a real product-safety guard** — Margin drafts to head coaches personally; the agent draft would embarrass him.

---

## Where consistency drifts — 7 specific gaps

### Gap 1 · Output shape isn't uniform across roles

| Role | Has fenced output template? |
|---|---|
| Trainer Blueprint Coach | ✅ Yes (`===== BLUEPRINT CHECK-IN =====`) |
| Roster Pulse | ✅ Yes (`===== ROSTER PULSE — WEEK OF [date] =====`) |
| Grader | ⚠️ Referenced (in `athlete-grading-rubric` skill) but not inlined |
| Recruiter Liaison | ❌ No — freeform draft |
| NIL Strategist | ❌ No — split by mode but no shape |
| Parent Communicator | ⚠️ Structure listed as 5 bullets but no fenced template |

**Cost of the gap:** downstream systems (Optimum, CRM, email) can reliably parse 2 of 6 role outputs. The other 4 need fragile string matching. Every consumer implements their own parser.

**Patch:** add a fenced output template to Grader, Recruiter Liaison, NIL Strategist, and Parent Communicator matching the pattern the other two already use.

---

### Gap 2 · Missing-data exit isn't standardized

Each role handles "not enough info" differently:

- **Grader:** `"insufficient data — cannot produce a grade"`
- **Recruiter Liaison:** `"athlete's most recent shuttle time is unverified — flag before sending to a P4 program"`
- **NIL Strategist:** `"this athlete is not shown as a signed NIL client — confirm status before proceeding"`
- **Parent Communicator:** `"say so honestly and use the update to set up what's coming"`
- **Trainer Blueprint Coach:** (no explicit convention)
- **Roster Pulse:** `"schedule data not on file — capture from CRM before Sunday."`

**Cost of the gap:** an operator monitoring the queue can't grep for one pattern to find "the agent bailed on this because data was missing." Downstream automation can't distinguish "successful output flagged with a caveat" from "agent couldn't complete."

**Patch:** shared exit format for the thin-data case, prepended when the role can't fully complete:

```
===== INSUFFICIENT DATA — [ROLE] — [ATHLETE/TRAINER] =====
MISSING: [specific fields]
NEEDED FROM: [where the data lives OR who to ask]
NEXT STEP: [what unblocks]
```

---

### Gap 3 · Human-review flag has no canonical location or format

Referenced across roles but inconsistently:

- **Recruiter Liaison:** *"mark HUMAN REVIEW REQUIRED: yes on the output"*
- **Parent Communicator:** *"flag those as HUMAN REVIEW REQUIRED"*
- **NIL Strategist:** *"Every deal that scores APPROVE or NEGOTIATE gets flagged for TOJ Management handoff"*
- **Grader:** (no convention — implied by eval spec landing weak grades in `waiting`)
- **Trainer Blueprint Coach / Roster Pulse:** (no convention)

**Cost of the gap:** a queue watcher can't build one auto-router. Every downstream integration re-implements "is this ready to send or does Margin need to eyeball it first?"

**Patch:** every role output opens with a canonical header field:

```
HUMAN REVIEW REQUIRED: yes|no|conditional
REVIEW REASON: [one line if yes/conditional]
```

Regex-parseable, single location, every role.

---

### Gap 4 · Auto-fail regex has drift vs performance-principles

Direct comparison (both packs live in this repo):

| Auto-fail | hooks-principles | performance-principles |
|---|---|---|
| Hype vocab base set | ✅ `unlock, elevate, journey, next-level, game-changing` | ✅ Bigger set — adds `elite, generational, phenom, future star, unleash, supercharge, transform, in today's fast-paced, are you ready to, imagine a world where` |
| Adjective triples | ❌ Missing | ✅ Full regex |
| Exclamation marks in body | ❌ Missing | ✅ Regex |
| Pro comparison without basis | ❌ Missing | ✅ `the next / reminds me of / comparable to / in the mold of` + capitalized name |
| Fabricated measurables | ✅ (LLM check) | ⚠️ Not present (n/a — different domain) |
| Head-coach draft | ✅ Regex | n/a |

**Cost of the gap:** an agent could ship a Hooks output calling an athlete "the next [Justin Jefferson]" or writing `Marcus had an ELITE week!!!` and none of it would trigger an auto-fail. Coaches and parents burn that.

**Patch:** import the missing 3 auto-fails from performance-principles into hooks-principles. They're vocabulary rules that transcend domain.

---

### Gap 5 · Eval questions apply uniformly regardless of role

`applies_to: "*"` means every role gets the same 5 questions. But:

- **`verified_not_plausible`** matters hard for Grader / Recruiter Liaison / NIL Strategist (fabricated measurables are the sharpest failure mode) but is a weaker gate for Parent Communicator or Trainer Blueprint Coach (their outputs rarely include specific measurables).
- **`leverage_check`** ("uses an existing template") matters for Recruiter Liaison / Parent Communicator but is less relevant for one-off Grader work.
- **Missing role-specific checks:** Grader has no "grade calibrated to film, not parent hope" question. Recruiter Liaison has no "specificity matches coach type (position vs area vs coordinator)" check. Parent Communicator has no "3 specific wins from this week" structural check.

**Cost of the gap:** outputs pass the shared bar but drift on role-specific quality signals that aren't measured.

**Patch:** the orchestrator factory supports per-role overrides. Add an optional `role_specific_questions` block on each role definition that appends 1-2 targeted questions to the shared 5:

```javascript
module.exports = {
  id: "grader",
  ...
  eval_additions: [
    {
      id: "film_not_hope",
      prompt: "Is the grade calibrated to what the film shows, or does it drift toward what the parent/athlete hopes? Would Margin ship this exact grade to a P4 position coach without wincing?",
      pass_signal: "Grade matches film observations; no inflation from parent/athlete pressure",
      fail_signal: "Grade higher than film supports; hedged language covering an inflated projection",
    },
  ],
};
```

Requires a small change to `orchestrator-factory.js` (~10 lines) to merge role-additions into the eval spec at load time.

---

### Gap 6 · No shared preamble giving downstream context

Trainer Blueprint Coach opens with `===== BLUEPRINT CHECK-IN — [trainer name] — WEEK OF [date] =====`. Everyone should.

Every output should open with a canonical header block:

```
===== [ROLE LABEL] — [ATHLETE/TRAINER FIRST NAME] — [ISO DATE] =====
INPUT: [task summary in one line]
RETRIEVAL: [what was pulled] · confidence [high|medium|low]
HUMAN REVIEW REQUIRED: [yes|no|conditional]
REVIEW REASON: [one line if yes/conditional]
```

**Cost of the gap:** downstream systems have to re-derive "who/what/when" from prose. Adding it as a mandatory preamble makes every output routable + auditable in one shot.

**Patch:** add the preamble spec to `hooks-methodology` skill (which is already required by all 6 roles) so it inherits without touching each persona.

---

### Gap 7 · No cross-role uniformity test

The 6 roles are individually well-designed. There's no assertion that they behave as one coherent product.

**Cost of the gap:** a change to one role's persona can silently break the shape another role expects to hand off to (e.g., Roster Pulse identifies an athlete in `ATTENTION NEEDED` and Recruiter Liaison would ideally pick that up — but nothing enforces the ID format matches).

**Patch:** a simple test file `agents/hooks/tests/consistency.js` that boots every role and asserts:
- Every role definition has: `id`, `label`, `tagline`, `skills: string[]`, `persona` of ≥ 200 chars
- Every role's persona references `retrieve_client_context` as step 0
- Every role's persona names an output format
- Every role's persona covers ≥ 3 edge cases

Run in CI, block deploy on failure.

---

## The consistency scoreboard, patched

| Dimension | Before | After patches |
|---|---|---|
| Retrieval discipline | 10 | 10 |
| Voice guardrails | 8 | 10 (with imported autofails) |
| Output-shape uniformity | 5 | 10 (all 6 roles fenced) |
| Missing-data handling | 4 | 10 (shared exit format) |
| Human-review flag | 5 | 10 (canonical header field) |
| Eval calibration per role | 6 | 9 (per-role additions) |
| Cross-role uniformity | 3 | 8 (consistency test in CI) |
| **Overall consistency** | **6.5 / 10** | **9.5 / 10** |

Quality stays at 9.1. Consistency climbs from 6.5 to 9.5. Same personas, just held more tightly.

---

## Effort estimate

| Patch | Files touched | Effort |
|---|---|---|
| Gap 1 · fenced output templates for 4 roles | 4 role files | 30 min |
| Gap 2 · shared missing-data exit format | 1 skill file (`hooks-methodology.md`) + 6 role files | 20 min |
| Gap 3 · canonical human-review header | 1 skill file + 6 role files | 15 min |
| Gap 4 · import 3 autofails from performance-principles | 1 eval file | 5 min |
| Gap 5 · per-role eval additions | 1 factory tweak + 6 role additions | 45 min |
| Gap 6 · shared preamble in `hooks-methodology` | 1 skill file | 10 min |
| Gap 7 · consistency test | 1 new test file | 20 min |

**Total: ~2.5 hours** to move all 7 dials.

---

## The recommended sequence

Ship in this order — each patch strengthens the next:

1. **Gap 4 first** (5 min) — auto-fails import. Zero blast radius, immediate quality lift.
2. **Gap 6** (10 min) — shared preamble in `hooks-methodology`. All 6 roles inherit automatically.
3. **Gap 3** (15 min) — canonical human-review header. Uses the preamble established in step 2.
4. **Gap 2** (20 min) — missing-data exit format. Establishes shared vocabulary.
5. **Gap 1** (30 min) — fenced output templates for the 4 roles that lack them.
6. **Gap 7** (20 min) — consistency test. Locks in what steps 1-5 established.
7. **Gap 5** (45 min) — per-role eval additions. Last because it requires a small `orchestrator-factory.js` change.

---

## What NOT to do

- **Don't collapse the roles.** Six is right. Different phases of Margin's operation. Merging them saves nothing and loses the specialization advantage.
- **Don't rewrite the personas.** They're strong. Every patch above is additive or reformatting.
- **Don't chase 10/10 quality.** The whole 9/10-quality × 10/10-consistency thesis is that consistent 9/10 beats variable 10/10 for a real operating brain. The gap this review closes is the second half.
- **Don't add more tools.** 3 is right. Any new capability = new failure mode.

---

## Ready-to-ship or want a walkthrough first?

Every patch above is scoped small, reversible, and lands inside the existing pattern. The 2.5-hour lift moves the whole stack from *"good agents that happen to run"* to *"one product Margin can trust."*

Ready when you are — I can ship the patches in the recommended sequence.
