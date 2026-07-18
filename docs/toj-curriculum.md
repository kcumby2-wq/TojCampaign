# TOJ Curriculum

**Companion to:** `docs/ai-notes-implementation-plan.md` (v3)
**Last updated:** 2026-07-18
**Purpose:** what the roster reads, what Kyron reads, what pilots are given. Named in the notes as a discipline — required reading is a mental-model source-of-truth so every agent (and every human) shares the same references. Not a syllabus. A load-order.

---

## The rule

Every agent's persona lists a **reading list** line naming the 2–4 primary sources it's built on. When a new team member reads the agent's persona, they can trace the roster's mental model back to its origins without asking Kyron.

Every skill file lists the primary reference in its Rules section — "the reasoning behind this skill lives in [source]."

**Nothing on this list is required for the operator (pilot) to consume before joining.** The pilot's reading list is separate and shorter — see the Pilot section below.

---

## Required for the whole roster (loaded into every agent's context)

### 1. Empire of AI — Karen Hao

**Why:** the notes name this specifically. It's the canonical honest read of who Anthropic, OpenAI, and the model-provider layer actually are — commercial pressures, technical realities, and the operator's relationship to a stack she doesn't own. Every TOJ agent operates on someone else's infrastructure. Reading this is what keeps the roster honest about its dependencies.

**Load-into:** Chief of Staff, CFO, CPO (when hired), any role reasoning about infra choices.

### 2. TOJ's own foundational docs

- `docs/toj-transition-plan.md` — the strategic transition; every role reads this before shipping anything
- `docs/six-week-foundational-playbook.md` — the client-side Principles-level curriculum; every client-facing role loads this
- `docs/ai-notes-implementation-plan.md` (v3) + all companion docs — the operating spec

---

## Per-role reading lists

Each role's persona should include a `readingList:` line. Content below can be pasted directly into new role files (or added as a comment for existing ones).

### Chief of Staff

- Empire of AI — Karen Hao
- Getting Things Done — David Allen (the Inbox → Next → Doing → Waiting → Done pattern)
- `docs/toj-transition-plan.md` + full companion doc set
- `docs/toj-worldview-operationalized.md` — for T/P/E tagging in the morning brief

### Content Strategist

- On Writing Well — William Zinsser (the source-of-truth for `toj-voice.md`'s "editorial not marketing" rule)
- Building a Second Brain — Tiago Forte (for the repurpose loop that Content Strategist coordinates)
- `agents/skills/toj-voice.md` + `agents/skills/brand-voice-checklist.md`
- `docs/toj-distribution-runbook.md`

### Research Assistant

- The Craft of Research — Booth, Colomb, Williams (source-quoting discipline)
- Sources of Power — Gary Klein (how experts read the same evidence non-experts miss)
- `agents/skills/pillar-diagnostic.md` + `five-pillars.md`

### The Closer

- Never Split the Difference — Chris Voss (mirroring, labels, calibrated questions — matches the "quote 3 things they said" rule in `sales-call-brief.md`)
- The Challenger Sale — Dixon & Adamson (for the "different, not better" positioning in outbound)
- `agents/skills/toj-voice.md` + `voice-matching.md`
- `agents/skills/different-not-better.md`

### CFO

- Financial Intelligence — Berman & Knight (for reasoning about client cash flow at diagnostic time)
- Refactoring Pricing — for the tier-value-lock work
- `agents/skills/paycheck-workflow.md`

### Concierge Coach

- The Coaching Habit — Michael Bungay Stanier (the 7 questions coaches ask — anchors the Concierge conversation model)
- `agents/skills/operator-self-audit.md`
- `docs/six-week-foundational-playbook.md`

### The Skeptic

- Thinking in Bets — Annie Duke (for calibrated confidence)
- Superforecasting — Tetlock (for red-team discipline)
- Every TOJ artifact type spec — Skeptic reads the goal-registry entry for the artifact it's red-teaming

### Waitlist Warmer

- Influence — Cialdini (7 principles — used to score outbound quality, not to manipulate)
- `agents/skills/email-quality.md` + `sales-call-brief.md`

### Foundation Score Intake

- The Mom Test — Rob Fitzpatrick (how to ask questions that get real answers)
- `agents/skills/pillar-diagnostic.md`

### Operational Transcript Drafter

- Reading is thin here on purpose; this role executes against `operational-transcript.md` primarily. Secondary: The Pyramid Principle — Barbara Minto (for the structure of the transcript's opening).

### Pillar Diagnostic (×5)

- Each pillar sub-agent reads the corresponding chapter of Kyron's foundational thinking (currently in `docs/six-week-foundational-playbook.md`). Chapter map:
  - `pillar-brand-identity` → Playbook Week 1
  - `pillar-operational-health` → Playbook Week 2
  - `pillar-revenue-architecture` → Playbook Week 3
  - `pillar-content-credibility` → Playbook Week 4
  - `pillar-growth-readiness` → Playbook Week 5

### Concierge Weekly Producer

- `agents/skills/concierge-weekly-drop.md`
- Each pilot's Operational Transcript

### Retention Watcher

- Predictable Success — Les McKeown (churn-signal patterns)
- Every active pilot's engagement time-series

### Ad Teardown Producer

- Breakthrough Advertising — Eugene Schwartz (mass-desire framework — used to anchor variant hooks in real buyer states, not gimmick)
- `docs/toj-distribution-runbook.md` § Meta Ads Runbook

### Vertical Positioner

- Positioning — Al Ries & Jack Trout (source of the "different, not better" axiom)
- `docs/toj-vertical-theses.md`

### Q&A Approval Bot

- No new reading — Q&A Approval Bot operates on approval hygiene. It reads every artifact's goal-registry entry to know what "passing" looks like.

### Repurpose Producer

- Building a Second Brain — Tiago Forte
- `agents/skills/content-repurpose.md`

### Foundation Audit Composer (new, Q3 2026)

- `agents/skills/foundation-audit-response.md`
- `five-pillars.md`

---

## Kyron's reading (operator-level)

Kyron's job at Level 6 (Agent Ecosystem) is Standard + Strategy + Relationships. His reading list reflects that:

- Empire of AI — Karen Hao (required)
- The Sovereign Individual — Davidson & Rees-Mogg (long arc of who wins in the transition to a network economy)
- Range — David Epstein (the operator advantage of breadth over specialization at this level)
- Poor Charlie's Almanack — Charlie Munger (mental-model discipline; the foundation-thinking Kyron already does natively)
- Working Backwards — Bryar & Carr (the write-a-press-release-first pattern — used for every roadmap decision)
- Currently reading (Kyron self-selects; Chief of Staff logs in the morning brief)

**Cadence:** 1 book/month sustained. When Chief of Staff notices the current-reading slot empty for > 21 days, it surfaces the gap in the morning brief.

---

## Pilot reading (client-side, given at intake or later)

**At intake:** none required. The Foundation Score conversation IS the intake experience. Extra reading before scoring makes the intake fail (client anchors on framework language before their honest state gets captured).

**Post-transcript (Founding):** the transcript itself. Nothing else.

**Post-transcript (Core, Month 1):** Kyron's north-star sentence in context — one long-form essay written to make "build the business that doesn't collapse when you step away" concrete for this pilot's vertical. Content Strategist ships the essay; Vertical Positioner adapts per vertical.

**Post-transcript (Premium, Month 2):** `docs/six-week-foundational-playbook.md` — the Principles-level companion. Delivered as a series of weekly emails (not a document dump).

**Cohort alumni (Q1 2027+):** open-source curriculum built from Kyron's teaching plus 3–5 guest lectures per cohort. Owned by the cohort program owner (role TBD).

---

## The Tools Section — every role should know these exist

Not required reading, but every role should have functional literacy of these tools if it interacts with them:

| Tool | What every role should know |
|------|----------------------------|
| Anthropic API + SDK | How to call it; how to reason about token cost; how tool-use works |
| Supabase | Postgres under the hood; row-level security exists; the schema is versioned |
| Vercel + Render | Deploy target; env var management; log surface |
| Stripe | Subscription lifecycle; webhook handling; PCI-scope containment |
| Resend | Transactional vs marketing; DKIM/SPF/DMARC basics; unsubscribe compliance |
| GHL | Internal-only; never client-facing; where the current pipeline lives during Phase 1 |
| Slack | Where CoS operates; how DM approvals work; the per-vertical channel structure |

Every role's Rules section should include: "if the task requires a tool the role doesn't have, say so — do not fabricate." This is already the pattern in `architect.js`. Extend everywhere.

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial · per-role reading lists, Kyron's reading, pilot reading, tools literacy | Claude |
