# AI Notes → TOJcampaign.com Implementation Plan (v3)

**Author:** Kyron Cumby, Trail of Joy Management Group, LLC
**Focus:** TOJcampaign.com — the platform, the product, and the operator OS underneath
**Status:** Living working doc. Clients (Subject Report, Pylon7v7, Sky's The Limit WR, XpandSports, Optimum Grading, CollegeFootballRecruiting.com) are mentioned only where they change the design of a TOJcampaign agent, skill, or goal.
**Last updated:** 2026-07-18 (v3)
**North star:** TOJcampaign.com is a 9/10-quality, 10/10-consistency operator platform running three verticals on one agent spine.

---

## What changed from v2 → v3

The v2 plan was **the tactical roster** — roles, skills, evals, goals, loops, and the 30-day sequencing. It stands. v3 does not rewrite it. v3 **extends** it with the wider layers Kyron's notes cover that v2 under-drew:

1. **Worldview operationalized** — the 12 levels of creativity, 4 values of AI, 3 levels of learning, 7 levels of AI mastery as verbs the operator performs (not framings that hover above the work). Full doc: `docs/toj-worldview-operationalized.md`.
2. **Distribution runbook** — lead magnet, funnel spec, Meta ads runbook, pre-validation gate, guarantee scaffold, KPI baseline/ceiling/target discipline. Full doc: `docs/toj-distribution-runbook.md`.
3. **Media roadmap** — the 12–24 month path from static site to media empire (Foundation Score audit tool → podcast → cohort community platform → interactive media). Full doc: `docs/toj-media-roadmap.md`.
4. **Curriculum** — per-role reading lists so the roster's mental model is traceable; Kyron's reading; pilot reading. Full doc: `docs/toj-curriculum.md`.
5. **Vertical theses** — 5 market bets with go/no-go gates: NIL/youth prep, mastery-based education, spatial intelligence, D2C future, tokens as infrastructure. Full doc: `docs/toj-vertical-theses.md`.
6. **Community + cohort spec** — the retention layer TOJ was missing: cohort program, all-alumni community, private events, digital products, alumni board. Full doc: `docs/toj-community-cohort-spec.md`.

In-line additions (this doc, below):

7. **Agent archetype distribution** — the roster mapped to the 5 archetypes (Prototype / Builder / Sleeper / Grower / Maintainer) with the org-mix rule for pre-PMF vs. growing vs. strong PMF
8. **Weekly retrospective ritual** — the notes' 5-part self-learning loop (Define → Build → Measure → Learn → Iterate) as a Sunday-evening standing ritual that improves skills/cartridges/goal-registry off real fails
9. **KPI discipline** — every metric in the goal registry gets baseline/industry-ceiling/target the Clairvo way; no more "target: TBD"
10. **Chief of Staff extended** — T/P/E tagging in the morning brief, "attended-to today" as a first-class metric, target cycle time per Doing item, 3P (Principles/Patterns/Passion) as the daily brief structure
11. **Six new skills** — `hundred-mechanisms`, `four-week-pilot-playbook`, `paycheck-workflow`, `content-repurpose`, `operator-self-audit`, `different-not-better`
12. **One new role** — `repurpose-producer.js`
13. **Outcome-priced offering** — the $30/booked-job pattern productized without disrupting the tier structure (documented in `docs/toj-distribution-runbook.md`)
14. **Revised sequencing** — the 30-day sprint of v2 extends into a **6-week phased rollout** because the scope grew; interleave still holds

The v2 plan (roles, skills, evals, goals, loops, three plans) is preserved verbatim below, followed by the extension sections. **The tactical layer is how consistency gets enforced. The extension layer is how the quality ceiling rises. Both are needed.**

---

## Index of companion docs

Read these in order for a first pass. Each is designed to stand alone but they cross-link at every logical seam.

| # | Doc | What it covers |
|---|-----|---------------|
| 1 | `docs/ai-notes-implementation-plan.md` | This doc — the north-star index, roster, skills, evals, goals, loops, plans, sequencing |
| 2 | `docs/toj-worldview-operationalized.md` | The 4 abstract ladders → verbs per artifact type |
| 3 | `docs/toj-distribution-runbook.md` | Lead magnet, funnel, Meta ads, guarantee scaffold, outcome pricing |
| 4 | `docs/toj-media-roadmap.md` | 12–24 month media surface build order |
| 5 | `docs/toj-curriculum.md` | Per-role reading, Kyron's reading, pilot reading |
| 6 | `docs/toj-vertical-theses.md` | 5 market bets with go/no-go gates |
| 7 | `docs/toj-community-cohort-spec.md` | Cohort program + community platform + alumni layer |

Foundational docs (pre-existing, referenced throughout):

- `docs/toj-transition-plan.md` — the strategic transition to owned platform
- `docs/six-week-foundational-playbook.md` — the Principles-level client curriculum (amended per Thesis 2)

---

## The one-paragraph synthesis, sharpened (unchanged from v2)

The notes describe an operator platform in five moving parts: (1) a **short list of foundation agents** — Chief of Staff, Content Strategist, Research Assistant — that route every task, (2) an **agent roster organized by the Draft → Triage → Coordinate → Act ladder** so nothing gets over-automated, (3) a **skills library** written as markdown that defines HOW every artifact must be produced, (4) a **cartridge/eval layer** that scores every output before it ships and retries under a threshold, and (5) **four loop types** — turn, goal, time, proactive — that carry work through the system without you touching it. TOJcampaign already has the eval primitive (`agents/evals/toj-principles.js`), the architect agent that designs new agents, the six-role starter set, and a mature skill format. What is missing is the **foundation-agent trio**, the **Triage/Coordinate/Act tier agents** for concierge delivery, the **cartridge scoring layer**, ten specific **skills markdown files**, and a **goal registry** with numeric done-when thresholds. This doc names every one.

---

## Current state: exact inventory (do not rebuild)

### Roles that exist (`agents/roles/`)

| File | Label | Tier | What it does today |
|------|-------|------|---------------------|
| `architect.js` | The Architect | Meta | Designs new TOJ roles + skills. Outputs role .js + skill .md ready to drop in. |
| `cfo.js` | The CFO | Draft/Advisory | Money model, pricing, revenue architecture (pillar 03) |
| `closer.js` | The Closer | Draft | Outbound + sales copy in the client's voice. Retrieves via `retrieve_client_context`. |
| `concierge-coach.js` | Concierge Coach | Draft/Advisory | Weekly 1:1-style guidance for concierge clients. Grounded in Foundation Score + transcript. |
| `skeptic.js` | The Skeptic | Meta (red-team) | Challenges outputs — the guardrail against sycophancy |
| `waitlist-warmer.js` | Waitlist Warmer | Draft/Coordinate | Nurtures leads before onboarding |

**Added in v3 (this session):**
- `repurpose-producer.js` — expands one validated piece into a 4-tier asset stack across surfaces

### Skills that exist (`agents/skills/`)

- `toj-voice.md` — the 3-dial register/warmth/assertion voice DNA
- `voice-matching.md` — the retrieval protocol for client-voice mimicry
- `toj-methodology.md` — the TOJ core operating story every client-facing agent loads
- `five-pillars.md` — the Foundation Score scoring rubric (0–100 per pillar, evidence + gap)

**Added in v3 (this session):**
- `operator-self-audit.md` — Public/Private/Secret/Shadow selves + attention-tracking + frequency/cycles/flow-state discipline
- `hundred-mechanisms.md` — plateau-breaking brainstorm pattern (10 parallel × 10 mechanisms)
- `four-week-pilot-playbook.md` — reusable 0→100 execution plan for launching a new agent-supported workflow
- `paycheck-workflow.md` — 5-question scoring for whether a workflow is worth systemizing
- `content-repurpose.md` — one validated piece → 4-tier stack across surfaces
- `different-not-better.md` — positioning axiom enforced on every outbound piece

### Evals that exist (`agents/evals/`)

- `toj-principles.js` — the "was this the TOJ way?" gate. Threshold 7, 3 retries, falls to Waiting on fail. This is the goal-based-loop primitive from the notes, already in prod.

### Infra that exists

- `orchestrator.js` + `orchestrator-factory.js` — namespaced orchestrators; substrate for the Chief-of-Staff pattern
- `tools.js` — `listClients`, `getFoundationScore`, `retrieveClientContext`
- `hooks/` — hook system for pre/post-run intercepts (this is where the pre-deliver gate lands)
- `db/` local JSON storage; Supabase spec in `docs/foundation-score-supabase-spec.md`
- `routes/csv.js` — Module 01 of the platform per the transition plan
- CI verify workflow (`.github/workflows/ci-verify.yml`)

**The system is not a green field. The additions below plug into it.**

---

## The delta: what the notes call for that TOJcampaign does not yet have

### Missing agents (the roster the notes describe)

1. **Chief of Staff** — foundation agent that routes everything, holds the daily brief, decides which role handles the task (extended in v3 — see § Chief of Staff Extended below)
2. **Content Strategist** — foundation agent that plans/drafts everything for TOJcampaign.com (site copy, blog, social, teardowns)
3. **Research Assistant** — foundation agent that reads intakes, pillars, transcripts, and public data; returns 5-bullet briefs
4. **Pilot Intake Triage** — Triage-tier agent that classifies incoming interest by vertical (Personal Brand / Non-profit / Authority) and tier ($99/$199/$499), and routes to the right onboarding path
5. **Operational Transcript Drafter** — Draft-tier agent that produces the 72-hour deliverable at concierge threshold quality
6. **Foundation Score Intake** — Draft-tier agent that runs the pillar-diagnostic conversation from a form response into a scored pillar tree
7. **Concierge Weekly Producer** — Coordinate-tier agent that assembles Friday-noon weekly drops for Core and Premium tiers (CSV/campaign/pipeline artifact + one-page summary)
8. **Pillar Diagnostic** (×5 sub-agents, one per pillar) — deep-dive analyzers that produce evidence + gap per pillar (Brand Identity, Operational Health, Revenue Architecture, Content & Credibility, Growth Readiness)
9. **Retention Watcher** — Proactive-loop agent that watches for pillar-score movement, engagement drop-off, or missed weekly-drop opens; escalates to human before churn
10. **Ad Teardown Producer** — Draft-tier agent that turns organically-validated content into a paid-ad creative package (hook variations, image or clip cuts, targeting note)
11. **Vertical Positioner** — Draft-tier agent that adapts a piece of TOJcampaign.com copy for Personal Brand vs Authority vs Non-profit without breaking voice
12. **Q&A Approval Bot** — Coordinate-tier agent that sits at the approval gate: presents a diff, one-line rationale, and the exact "yes/no/edit" option to Kyron from mobile

**Added in v3:**

13. **Repurpose Producer** — expands one validated piece into a 4-tier asset stack (T1 long-form → T2 medium → T3 short → T4 micro) — see `agents/roles/repurpose-producer.js`
14. **Foundation Audit Composer** (v3, Q3 2026 ship) — produces the result page from the free Foundation Score self-audit — see `docs/toj-distribution-runbook.md` § Lead Magnet

### Missing skills (the markdown that defines HOW)

**From v2 (unchanged):**

1. `verify-toj-artifact.md`
2. `pillar-diagnostic.md`
3. `operational-transcript.md`
4. `foundation-score-intake.md`
5. `sales-call-brief.md`
6. `email-quality.md`
7. `webpage-quality.md`
8. `brand-voice-checklist.md`
9. `pilot-scoping.md`
10. `concierge-weekly-drop.md`
11. `vertical-positioner.md`
12. `ad-teardown.md`

**Added in v3 (shipped this session):**

13. `hundred-mechanisms.md`
14. `four-week-pilot-playbook.md`
15. `paycheck-workflow.md`
16. `content-repurpose.md`
17. `operator-self-audit.md`
18. `different-not-better.md`

**Queued (not yet shipped in v3):**

19. `foundation-audit-response.md` — the tone + shape of the free-audit result page (Q3 2026)
20. `mastery-progression.md` — ZPD-aware next-move logic for `six-week-foundational-playbook.md` (Q3 2026)
21. `nil-pillar-diagnostic.md` + `nil-guardrails.md` + `nil-vertical-positioner.md` — the NIL vertical bundle (Q4 2026 if go)

### Missing evals (the cartridges)

1. `humanity-cartridge.js`
2. `marketing-cartridge.js`
3. `open-rate-cartridge.js`
4. `pillar-evidence-cartridge.js`
5. `cartridge-runner.js`
6. `pre-deliver.js` (hook)

Unchanged from v2. Plan A ships these.

---

## Every missing agent, in the 7-question trusted-agent form

The notes reduce a trusted-agent spec to seven questions. Every new TOJcampaign agent below is written to that spec plus the same file shape as `architect.js` / `closer.js` — that's what makes them drop-in.

### 1. Chief of Staff — `agents/roles/chief-of-staff.js` (extended in v3)

**Purpose:** own the operator's day. Route inputs to the right role. Produce the morning brief and the evening close-out.

- **Wakes up:** at 6:30am (time loop), on any new capture into Inbox, on any @toj-cos mention in Slack/DMs, on any Foundation Score movement > 5 points.
- **Context:** current day's calendar, Inbox contents, `listClients` output, active pilots + tier, weekly-drop shipping schedule, last 7 days of Kyron's captures, current OKR set, **v3 additions:** last 7 days of Kyron's journal (`db/journal/`), current cycle-time targets, T/P/E ratio target for this quarter.
- **Tools:** `listClients`, `getFoundationScore`, `retrieveClientContext`, ability to invoke any other role via the orchestrator, ability to push a Slack DM to Kyron, ability to write to `db/inbox.json`.
- **Allowed to do itself:** triage Inbox → (Next / Doing / Waiting / Done), pick the day's ONE metric-moving move per vertical, book time on Kyron's calendar for approvals, draft the morning brief and evening close-out, prompt other roles for their piece of the day, **v3 additions:** assign target cycle time to each Doing item, tag each item T/P/E, produce the daily 3P (Principles/Patterns/Passion) trace, run the evening attention audit against the 4-selves scaffold from `operator-self-audit.md`.
- **Success looks like:** morning brief in Slack by 6:30am covering yesterday's Done, today's Doing, what's Waiting on Kyron specifically, one metric per vertical to move today; evening close-out by 7pm covering what moved, what didn't, tomorrow's top three, **v3 additions:** every Doing item tagged with target cycle time; every task traced to one of P/P/P; attention audit as a 1-line signal; T/P/E ratio for the day vs. quarterly target.
- **Approval required for:** anything that would send a message to a real human outside TOJ (client, prospect, partner), any pricing statement, any pillar-score sent to a client.
- **Escalates when:** two consecutive daily briefs land with no metric moved on a vertical; a pilot's engagement drops below the retention threshold; any output fails cartridges 3 times in a row; **v3 additions:** T/P/E ratio drifts more than 20% from quarterly target for 3 consecutive days; attention audit shows a divergence > 20% between stated priorities and actual attention for 2 consecutive weeks; a Doing item exceeds its target cycle time by 2×.
- **Loads skills:** `toj-voice`, `toj-methodology`, `verify-toj-artifact`, **v3 additions:** `operator-self-audit`, `paycheck-workflow` (when scoring new automation candidates), `hundred-mechanisms` (when flagging a plateau).

**v3 additions to the morning brief structure — the 3P frame:**

The notes: *"Success is based on principles and patterns, passion (PPP)."*

Every morning brief structures the top-three items so each traces to one of the three:

- **Principles** — an item that reinforces or applies a principle (e.g., "run every artifact through cartridges before delivery today")
- **Patterns** — an item that leverages a pattern already working (e.g., "repurpose Tuesday's high-engagement piece per `content-repurpose.md`")
- **Passion** — an item Kyron is genuinely energized by (e.g., "1:1 with a Premium client whose Foundation moved this week")

If all three items trace to the same category for 3 consecutive days, CoS flags an alignment issue.

**v3 additions to the evening close-out — the attention audit:**

One line per close-out, following `operator-self-audit.md`:

> **Attention audit:** Public 45% · Private 30% · Secret 20% · Shadow (attended) 5% · attended-to today: [1-line list]

Divergence > 20% from quarter-target for 2 consecutive weeks triggers a check-in with Concierge Coach.

**v3 additions — cycle-time discipline:**

Every Doing item includes a target cycle time (e.g., "sales-call brief · target: 45 min"). The evening close-out includes planned vs. actual per item. This turns speed into a measurable practice — the notes: *"It's about how quickly I can do a task for the day, not how much."*

Actual > 1.5× target for 3+ items in a week = Kyron reviews cycle-time targets (may be miscalibrated, may signal a genuine capacity issue).

### 2. Content Strategist — `agents/roles/content-strategist.js`

*(Unchanged from v2)*

**Purpose:** own TOJcampaign.com's content surface — homepage, teardown posts, social, and any thought-leadership piece.

- **Wakes up:** on the weekly content-plan trigger (Monday 8am), on any request from CoS, when Retention Watcher flags a piece that outperformed and warrants an ad teardown.
- **Context:** current TOJcampaign.com content calendar, last 90 days of engagement metrics, the vertical positioning notes, cartridge-passing archive of prior posts, `toj-voice` and `voice-matching` skills.
- **Tools:** `retrieveClientContext` (for anonymized composite examples), site copy read/write, Slack post, ability to invoke `ad-teardown-producer` **and (v3) `repurpose-producer`**.
- **Allowed to do itself:** draft posts, propose a weekly calendar, produce hook variations (must generate 10 hooks under 8 words per piece), decline pieces that fail its own brief.
- **Success looks like:** every published piece scores 27+/30 across Humanity + Marketing cartridges before publish; 10 hook variants generated per piece; per-piece done-when includes "reads aloud under 60 seconds" for scripts and "brand-voice checklist passed" for written.
- **Approval required for:** anything with a specific client name or a hard financial claim.
- **Escalates when:** a piece fails cartridges 3 times, or the topic requires legal/compliance judgment.
- **Loads skills:** `toj-voice`, `toj-methodology`, `voice-matching`, `brand-voice-checklist`, `webpage-quality`, `ad-teardown`, **v3 additions:** `content-repurpose`, `different-not-better`.

### 3. Research Assistant — `agents/roles/research-assistant.js`

*(Unchanged from v2 — with the reading list from `docs/toj-curriculum.md` added to its persona)*

### 4. Pilot Intake Triage — `agents/roles/pilot-intake-triage.js`

*(Unchanged from v2 — with **v3 addition**: also runs `paycheck-workflow.md` scoring on the prospect's stated workflow before proposing a tier. Any prospect scoring below 9 gets routed to Founding tier only. Any prospect scoring 13+ becomes eligible for the outcome-priced Placement Track offering per `docs/toj-distribution-runbook.md`.)*

### 5. Operational Transcript Drafter — `agents/roles/operational-transcript-drafter.js`

*(Unchanged from v2)*

### 6. Foundation Score Intake — `agents/roles/foundation-score-intake.js`

*(Unchanged from v2)*

### 7. Concierge Weekly Producer — `agents/roles/concierge-weekly-producer.js`

*(Unchanged from v2)*

### 8. Pillar Diagnostic — `agents/roles/pillar-*.js` (×5)

*(Unchanged from v2)*

### 9. Retention Watcher — `agents/roles/retention-watcher.js`

*(Unchanged from v2 — with **v3 addition**: also triggers `hundred-mechanisms` when a metric plateaus for 4+ weeks.)*

### 10. Ad Teardown Producer — `agents/roles/ad-teardown-producer.js`

*(Unchanged from v2 — with **v3 addition**: works with Repurpose Producer's medium/short output. Ad Teardown does NOT re-hook validated pieces; it swaps in variant hooks per the ad testing rules in `docs/toj-distribution-runbook.md` § Meta Ads Runbook.)*

### 11. Vertical Positioner — `agents/roles/vertical-positioner.js`

*(Unchanged from v2)*

### 12. Q&A Approval Bot — `agents/roles/qa-approval-bot.js`

*(Unchanged from v2)*

### 13. Repurpose Producer — `agents/roles/repurpose-producer.js` (NEW in v3)

**Purpose:** expand one organically-validated content piece into a 4-tier asset stack across surfaces.

- **Wakes up:** when Content Strategist flags a piece that crossed the organic threshold (per `docs/toj-distribution-runbook.md` § tier-down content pattern).
- **Context:** the source piece + its engagement data, `content-repurpose.md`, `toj-voice.md`, the T2/T3/T4 tier specs.
- **Tools:** access to the source piece, ability to invoke cartridges per tier, ability to write to the content calendar for scheduling.
- **Allowed to do itself:** extract hook + arc + evidence from source, produce 8 assets across T1/T2/T3/T4 tiers, propose a 7-day publish schedule.
- **Success looks like:** all 4 tiers produced within 3 days of source validation; every tier passes cartridges before publish; hook lock enforced (same hook 3–5s / first line across all tiers); 8 assets ship over 7 days per source piece.
- **Approval required for:** every asset before publish (routed through Q&A Approval Bot).
- **Escalates when:** source piece failed cartridges (Content Strategist owns fix); tier produces below-27/30 twice (spec problem, not Repurpose problem).
- **Loads skills:** `toj-voice`, `toj-methodology`, `content-repurpose`, `brand-voice-checklist`, `different-not-better`, `verify-toj-artifact`.

### 14. Foundation Audit Composer — `agents/roles/foundation-audit-composer.js` (NEW in v3, Q3 2026 ship)

**Purpose:** produce the result page for the free public Foundation Score self-audit lead magnet.

- **Wakes up:** on form submission at `tojcampaign.com/foundation-audit`.
- **Context:** the form submission, `five-pillars.md`, `foundation-audit-response.md` (skill to be written).
- **Tools:** write to `db/foundationAudits.json`, generate result-page HTML, send email confirmation.
- **Allowed to do itself:** produce the free-tier result page. Ranges (not exact scores) per pillar. One actionable one-step per pillar. Never scores above 60 on any pillar (self-report ceiling).
- **Success looks like:** result page generated within 60 seconds of form submission; content passes cartridges; soft path to Founding tier included; no "Operational Transcript" language (that's the paid deliverable).
- **Approval required for:** none (the free asset is deliberately un-approval-gated to preserve conversion; guardrails in the skill enforce quality).
- **Escalates when:** form submission is malformed or evidence is contradictory (routes to Research Assistant for cleanup).
- **Loads skills:** `foundation-audit-response.md` (to be written), `five-pillars.md`, `toj-voice.md`, `different-not-better.md`.

---

## The skills library, expanded (v3)

Every skill below is a markdown file under `agents/skills/`. Each follows the existing shape: **Purpose · How to use it · Rules · Anti-patterns · Fallback when data is missing.** Below is one-paragraph purpose per new skill so you can prioritize which to write first.

*(v2 skills unchanged: verify-toj-artifact, pillar-diagnostic, operational-transcript, foundation-score-intake, sales-call-brief, email-quality, webpage-quality, brand-voice-checklist, pilot-scoping, concierge-weekly-drop, vertical-positioner, ad-teardown)*

**v3 additions (shipped in this session):**

- **`operator-self-audit.md`** — the essence-level skill. Public/Private/Secret/Shadow selves scaffold; "what you repeatedly attend to" tracking; frequency/cycles/flow-state discipline. Loaded by Chief of Staff (evening close-out) and Concierge Coach (Premium working sessions).
- **`hundred-mechanisms.md`** — invoked when a KPI plateaus 4+ weeks. 10 parallel subagents × 10 mechanisms each across 7 lenses, deduplicated to a 5–7 item shortlist. Governance: not the default response to a bad week; the response to a plateau.
- **`four-week-pilot-playbook.md`** — reusable 0→100 execution plan for launching a new agent-supported workflow. Week 1 shadow + spec + eval set. Week 2 build + solo runs. Week 3 shadowed live runs. Week 4 cutover + tested-labor sign-off.
- **`paycheck-workflow.md`** — 5-question scoring for whether a workflow is worth systemizing. Scored on 0–15 scale. Ship-ready threshold: 11+. Used at pilot intake and internal-automation planning.
- **`content-repurpose.md`** — the tier-down asset production spec. One source piece → 8 assets over 7 days across long-form, medium, short, micro. Hook lock enforced. Cartridge-gated at every tier.
- **`different-not-better.md`** — positioning axiom enforcement. Every piece of copy about TOJ passes 3 tests: sign-it test (peer can't sign the piece and publish it as their own), chose-not-to surface (piece names one thing TOJ chooses NOT to do that peers do), peer-vocabulary check (no "solutions", "growth" as noun, "leverage", "transform", "elevate", etc.).

---

## Agent archetypes — the roster's lifecycle mix (v3 addition)

The notes name 5 archetypes for agents in a mature roster: **Prototype · Builder · Sleeper · Grower · Maintainer** — with an org-mix rule for stage:

- **Pre-PMF** (TOJcampaign SaaS status today): needs mostly Prototype + Builder + Sleeper
- **Growing** (post-Aug 2026 concierge launch, targeting Q1 2027 SaaS): needs Builder + Sleeper + Grower + some Maintainer
- **Strong PMF** (post-Q1 2027 SaaS with sustained growth): needs Sleeper + Grower + Maintainer + some Builder

### The archetypes defined

- **Prototype** — designs itself; discovers what the job actually is by trying; churns fast; not for production use. The Architect agent is TOJ's Prototype.
- **Builder** — takes a defined spec and ships to it; produces artifacts; leaves a trail of finished work. Content Strategist, Ad Teardown Producer, Repurpose Producer, Operational Transcript Drafter, Foundation Audit Composer, most of the 12 new roles.
- **Sleeper** — proactive-loop agents that watch and wake on trigger; noisy if too many, invisible if too few. Retention Watcher, Q&A Approval Bot, Chief of Staff (partial).
- **Grower** — takes a shipped agent's output and extends it (scale, quality, coverage). Vertical Positioner is a Grower — extends Content Strategist output across verticals. Repurpose Producer is a Grower — extends validated pieces across tiers.
- **Maintainer** — keeps existing systems running; low novelty, high reliability. The Skeptic is a Maintainer for quality. Concierge Coach is a Maintainer for client relationships. Every skill file is a Maintainer for its own consistency.

### TOJcampaign's archetype distribution (v3 read)

| Archetype | Current roster count | Roles in this archetype |
|-----------|----------------------|-------------------------|
| Prototype | 1 | Architect |
| Builder | 8 | CFO, Closer, Content Strategist, Operational Transcript Drafter, Foundation Score Intake, Ad Teardown Producer, Repurpose Producer, Foundation Audit Composer |
| Sleeper | 4 | Chief of Staff, Retention Watcher, Q&A Approval Bot, Pilot Intake Triage |
| Grower | 2 | Vertical Positioner, Repurpose Producer (dual-tags) |
| Maintainer | 3 | Skeptic, Concierge Coach, Waitlist Warmer |
| Pillar sub-agents | 5 | (Builder tag) |

**Total planned:** 23 roles when Plan B is fully shipped.

### The archetype-mix read (v3)

TOJcampaign is **pre-PMF on the SaaS** but **PMF-adjacent on the concierge product**. The roster mix reflects a transition:

- Strong on Builder (8) — right for a stage that's shipping the delivery product
- Understaffed on Sleeper — pre-PMF needs MORE proactive agents to notice signals humans can't. Retention Watcher exists; the notes suggest Foundation Score Movement Watcher, Pilot Fit-Check Watcher, and Content Engagement Watcher as candidates for Q4 2026 additions
- Weak on Grower (2) — Growth requires more agents that extend proven artifacts. Repurpose Producer helps; the notes suggest a Case-Study Extender (turn every successful pilot into a case study) and Cohort Curriculum Extender (Q1 2027, when cohort ships) as future candidates
- Right-sized on Maintainer — the Skeptic + Coach + Warmer cover the maintenance surface for now

### Ship additions (v3 roadmap)

- **Q4 2026:** 3 additional Sleepers (Foundation Score Movement Watcher, Pilot Fit-Check Watcher, Content Engagement Watcher)
- **Q1 2027:** 2 additional Growers (Case-Study Extender, Cohort Curriculum Extender)
- **Q2 2027:** 1 additional Maintainer (SOP Library Curator, once the SOP Library ships)

---

## The goal registry — done-when for every TOJcampaign artifact (v3 revision)

Every artifact type in the registry now includes **baseline / industry-ceiling / target** in the KPI columns — per the discipline in `docs/toj-distribution-runbook.md`. Where TOJ has no baseline yet, the entry says "measure for 30 days before optimization."

Same v2 registry structure; new columns:

| Artifact | Done-when threshold | Cartridges | Owning role | Baseline / Ceiling / Target |
|----------|--------------------|------------|-------------|------------------------------|
| Website copy block | Brand voice pass 8/8; page mobile load < 2s | Humanity + Marketing | Content Strategist | Baseline: measure 30d / Ceiling: 90 (mobile) / Target: 92 |
| Homepage hero | ≤ 12 words headline; ≤ 20 subhead; one primary CTA | Humanity + Marketing | Content Strategist | Baseline: measure 30d / Ceiling: 4% CTR / Target: 3% |
| Blog post / teardown | 10 hook variants; passes voice checklist; reads aloud ≤ 60s per 200-word section | Humanity + Marketing | Content Strategist | Baseline: measure 30d / Ceiling: 2× baseline engagement / Target: 1.5× |
| Social post | Hook < 8 words; 27+/30 combined cartridge | Humanity + Marketing | Content Strategist | Baseline: measure 30d / Ceiling: 5% engagement rate / Target: 3% |
| Marketing / nurture email | < 150 words, subject < 45 chars, one clear ask | Humanity + Marketing + Open-Rate | Waitlist Warmer | Baseline: measure 30d / Ceiling: 35% open / Target: 28% |
| Sales email (outbound) | < 120 words, subject < 45 chars, quotes prospect | Humanity + Marketing + Open-Rate | Closer | Baseline: measure 30d / Ceiling: 25% reply / Target: 15% |
| Sales-call brief | 1 page; every objection scripted; 3 quotes in follow-up | — (skill check) | Research Assistant | Baseline: n/a / Ceiling: 100% completion / Target: 100% |
| Foundation Score intake | Every pillar 0–100 with evidence + gap; no pillar > 40 without chunk | Pillar-evidence | Foundation Score Intake | Baseline: measure 30d / Ceiling: 90% completion in 20 min / Target: 75% |
| Operational Transcript | ≤ 72 hours; 27+/30 cartridges; weakest pillar unambiguous | Humanity + Pillar-evidence | OT Drafter | Baseline: n/a / Ceiling: 100% on-time / Target: 95% |
| Concierge weekly drop | Every Friday noon; 27+/30; decision-shaped | Humanity + Marketing | Concierge Weekly Producer | Baseline: n/a / Ceiling: 100% on-time / Target: 98% |
| Pilot proposal | Fills `pilot-scoping.md` shape; guarantee terms specific | Humanity | Closer | Baseline: measure 30d / Ceiling: 40% close rate / Target: 25% |
| Paid ad creative | Traces to organic-validated piece; 3–5 variants | Humanity + Marketing | Ad Teardown Producer | Baseline: measure 30d / Ceiling: 3% CTR / Target: 2% |
| Vertical adaptation | Diff summary ≤ 3 sentences; Humanity Cartridge pass | Humanity | Vertical Positioner | Baseline: measure 30d / Ceiling: 100% cartridge / Target: 95% |
| Morning brief | 6:30am; one metric-mover per vertical; ≤ 300 words | — | Chief of Staff | Baseline: n/a / Ceiling: 100% on-time / Target: 100% |
| Evening close-out | 7pm; what moved / didn't / top 3 tomorrow; ≤ 200 words | — | Chief of Staff | Baseline: n/a / Ceiling: 100% on-time / Target: 100% |
| Research brief | 5 bullets; every claim sourced; ≤ 10 min routine, ≤ 60 min prospect prep | — | Research Assistant | Baseline: measure 30d / Ceiling: 100% on-time / Target: 95% |
| Retention flag | Raised within 48h of first signal; includes proposed fix | — | Retention Watcher | Baseline: n/a / Ceiling: 100% surfaced / Target: 100% |
| **v3 additions:** | | | | |
| Repurpose asset stack (T1–T4) | 8 assets per validated source, 7-day schedule | Humanity + Marketing per tier | Repurpose Producer | Baseline: n/a / Ceiling: 100% stack ships / Target: 90% |
| Free Foundation Audit result page | Generated < 60s of form submit; cartridge pass; soft path visible | Humanity + Marketing | Foundation Audit Composer | Baseline: measure 30d / Ceiling: 10% audit-to-Founding at 90d / Target: 5% |
| Attention audit (evening close-out add-on) | 1 line; 4-selves ratios calculated; divergence flag if applicable | — | Chief of Staff | Baseline: 30-day rolling / Ceiling: within 20% of target every day / Target: within 20% for 90% of days |
| Paycheck workflow score | 5 questions, 0-15 total, band assignment, context notes | — (skill check) | Pilot Intake Triage / Research Assistant | Baseline: n/a / Ceiling: 100% scored / Target: 100% |

### KPI discipline

**Rule:** any row above where the baseline says "measure 30d" must have baseline data collected before Q4 2026. If baseline data isn't collected by Nov 1, 2026, that artifact type can't be optimized (no target movement without a starting point). Chief of Staff surfaces uncollected baselines in weekly retrospective.

**Rule:** targets are ceilings that TOJ can defend at 80%+ pass rate. Setting a target ≥ industry ceiling is a red flag — either the ceiling is stale (reset via Hundred Mechanisms) or the target is aspirational-not-operational (revise down).

---

## The four loops, mapped to TOJcampaign (unchanged from v2)

- **Turn loop.** Skill files exist and are tagged (`/verify-toj-artifact`). Every drafting role runs the applicable skill's verify at end-of-turn.
- **Goal-based loop.** Every artifact type in the goal registry has numeric thresholds. Retry up to 3 times, then Waiting.
- **Time-based loop.** Morning brief 6:30am. Evening close-out 7pm. Concierge weekly drops Thursday build → Friday noon send. Retention Watcher Monday 7am. Content Strategist weekly plan Monday 8am. **v3 additions:** Repurpose Producer runs Wednesday 8am; Foundation Audit Composer runs on-demand (event-triggered); weekly retrospective Sunday 6pm.
- **Proactive loop.** Retention Watcher (churn signals). Ad Teardown Producer (organic-threshold crossings). Chief of Staff daily-brief metric-mover flag. **v3 additions:** Hundred Mechanisms invocation on plateaus, attention audit divergence flag.

---

## Weekly retrospective ritual (v3 addition) — the 5-part self-learning loop

The notes give a 5-part loop that governs how the roster + skills + cartridges themselves IMPROVE over time: **Define → Build → Measure → Learn → Iterate**. This is not the same as the 4 loops (turn/goal/time/proactive) — it's the **meta-loop** that keeps the whole platform getting better.

### The Sunday 6pm ritual

Every Sunday at 6pm, Chief of Staff runs the retrospective ritual and delivers a 5-part report to Kyron:

**1. Define** — what does the platform aim to be doing better this month? (This is set at month-start; retrospective checks alignment.)

**2. Build** — what was actually shipped this week? (Roles, skills, cartridges, artifacts, all counted.)

**3. Measure** — how did each artifact type perform against goal registry thresholds? (Chief of Staff reads cartridge scores + delivery rates + KPI movement.)

**4. Learn** — where did we fail? Every artifact that scored below threshold, every escalation, every kill-triggered ad, every missed deadline — logged with the root cause named. Root causes fall into 4 buckets:
- **Spec problem** — the skill or goal-registry entry needs a fix
- **Role problem** — the persona needs a fix
- **Retrieval problem** — the underlying data wasn't there
- **Judgment problem** — the human (Kyron) called it differently than the eval expected — this is the calibration signal

**5. Iterate** — what specific fix ships this week? Not "we'll improve X"; a specific commit target. Every retrospective produces at least one fix to a skill, a cartridge, or a goal registry entry.

### File output

Every retrospective lands as `docs/retrospectives/YYYY-MM-DD.md`. Format:

```markdown
# Weekly Retrospective — YYYY-MM-DD

## Define (month goal recap)
[1 sentence]

## Build (this week)
- Roles shipped: [list]
- Skills shipped: [list]
- Cartridges shipped/updated: [list]
- Artifacts delivered: [count by type]

## Measure
[KPI snapshot table for the week — every artifact type + score vs target]

## Learn
[Every fail with root cause, categorized as spec/role/retrieval/judgment]

## Iterate
- Fix 1: [specific commit, ship target]
- Fix 2: [specific commit, ship target]
- (etc)

## Signature
Chief of Staff · Approved by Kyron on [date]
```

### The skill+cartridge+goal-registry footer rule

Every skill.md, every cartridge.js, and every goal-registry entry gets a footer:

```
Last iterated: YYYY-MM-DD
Change log: [1 line per iteration]
```

The retrospective touches at least one of these three surfaces per week. If a retrospective produces no iteration for 3 consecutive weeks, that's a signal that either the platform is stable (fine) OR the retrospective isn't finding real fails (concerning) — Kyron reviews.

### Sunday retrospective + `hundred-mechanisms`

The retrospective is where plateaus get detected. If a KPI has been flat for 4+ weeks (per Sunday's data), Chief of Staff triggers Hundred Mechanisms next Monday morning. See `agents/skills/hundred-mechanisms.md`.

---

## The three plans (rewritten, TOJcampaign-first) — v2 unchanged, v3 sequencing revised

*(Plans A, B, and C are unchanged from v2. See v2 sections above for the specifics.)*

### The revised sequencing (v3)

v2 laid out a 30-day sprint. v3's added scope pushes this to **6 weeks phased rollout** with the same interleave discipline. The alternative — cramming everything into 30 days — sacrifices quality for pace, which violates the 9/10 north star.

**Weeks 1–2 · Foundation layer (Plan A + core skills)**

- Ship cartridges (Humanity, Marketing, Open-Rate, Pillar-Evidence) + runner + pre-deliver hook
- Ship `verify-toj-artifact.md`, `brand-voice-checklist.md`, `different-not-better.md`
- Ship goal registry v1 with baseline/ceiling/target columns populated with "measure 30d" placeholders where needed

**Weeks 2–4 · Roster layer (Plan B, interleaved)**

- Week 2: Chief of Staff (with v3 extensions) + Content Strategist + Research Assistant
- Week 3: Pilot Intake Triage + Foundation Score Intake + Operational Transcript Drafter + 5 Pillar Diagnostic sub-agents (parallel invocation pattern)
- Week 4: Concierge Weekly Producer + Retention Watcher + Ad Teardown Producer + Vertical Positioner + Q&A Approval Bot + Repurpose Producer

**Weeks 3–5 · Skills library (Plan C, interleaved with roles)**

- Weeks 3–4: The 12 v2 skills, 2 per day
- Week 5: The 6 v3 skills (already shipped in this session), plus `foundation-audit-response.md`
- Week 5: Mobile capture ingress + Slack workspace wiring

**Week 6 · Verify + retrospective ritual + Q3 launch**

- Day 36–39: End-to-end verify — one synthetic pilot lifecycle
- Day 40: First weekly retrospective ritual runs
- Day 41–42: Fix at source; ship Free Foundation Audit lead magnet public

**Anti-plan:** launching Aug 1 without weeks 3–4 shipped. The Aug 1 launch depends on the delivery layer being cartridge-gated. If weeks 3–4 slip, the Aug 1 launch date holds but the concierge pilot count for month 1 caps at what Kyron can hand-QA (~10 pilots) instead of the roster's target (~40).

---

## The next 72 hours (the six moves)

*(Unchanged from v2)*

1. **Merge this v3 doc.** Archive v2 as `docs/archive/ai-notes-implementation-plan-v2.md` if desired (v3 preserves everything v2 has).
2. **Ship `agents/evals/humanity-cartridge.js`** — 5 scored dimensions using `toj-voice.md`, `brand-voice-checklist.md`, and (v3) `different-not-better.md` as sources of truth.
3. **Write `agents/skills/verify-toj-artifact.md`** — the analog of the notes' `verify-frontend-change`, tailored to TOJcampaign artifacts.
4. **Use `architect.js` to draft `chief-of-staff.js`** — the notes' Chief of Staff with v3 extensions (T/P/E tagging, cycle-time discipline, attention audit, 3P daily brief).
5. **Publish the goal registry as `agents/goals/registry.js`** — machine-readable done-when table with baseline/ceiling/target columns.
6. **Pick the ONE metric per surface** that TOJcampaign is optimizing this month. Suggested: TOJcampaign.com organic pieces published passing cartridges (Content), Foundation Score intakes completed within 72h (Delivery), concierge pilots signed at any tier (Revenue), Kyron coordination hours spent per week (Operator).

---

## What this plan is not

*(Unchanged from v2 — see v2 section above)*

- Not a rebrand · Not a stack change · Not a client-work plan · Not a promise on a slide.

---

## Levels-of-the-11, mapped to TOJcampaign this quarter (v3 revision — 11 levels, not 12)

*(v2 mapped 12 levels. Framework locked at 11 in Q3 2026. Level 12 slot is reserved — see `docs/toj-worldview-operationalized.md` § Level 12 · Open slot for the fill candidates.)*

| Level | Manifestation on TOJcampaign this quarter |
|-------|-------------------------------------------|
| 1 Intention | Every artifact has a done-when in the goal registry; if it isn't in the registry, it isn't produced |
| 2 Inspiration | The Aug 1 launch is the forcing function — the calendar drives the roster |
| 3 Illumination | Every pilot's Foundation Score is a learning event — Retention Watcher captures what moves and what doesn't |
| 4 Identification | Every agent has a named label ("The Closer," "Chief of Staff") — no anonymous background jobs |
| 5 Separation | Vocabulary defended — Foundation ≠ framework, Operational Transcript is the paid deliverable, Non-profit is hyphenated (see `toj-voice.md`) |
| 6 Segmentation | Never work all three plans on the same day; interleave per the sequence above |
| 7 Systemization | The roster + skills + cartridges IS the system — push a button, artifacts ship at 9/10 |
| 8 Delegation | Every artifact type has an owning role; nothing routed to "Kyron will do it" |
| 9 Automation | Time loops (morning brief, weekly drops) and proactive loops (Retention Watcher, Ad Teardown Producer) run without prompting |
| 10 Culmination | Q1 2027 self-serve SaaS launches on top of the roster — the platform Kyron shipped internally IS the product externally |
| 11 Relaxation | Chief of Staff owns coordination; Kyron owns Standard + Strategy + Relationships; the culmination is stable enough that Kyron steps back |

Full operationalization per level (verb per artifact type) in `docs/toj-worldview-operationalized.md`.

---

## The 90-day success line (v3 revision)

- 13 new roles in `agents/roles/`, 18 new skills in `agents/skills/`, 4 new cartridges + runner in `agents/evals/`, 1 goal registry, 1 pre-deliver hook, 1 mobile capture ingress, 1 Slack workspace with per-vertical channels.
- Every artifact TOJcampaign.com produces gated by cartridges — zero deliverables below 27/30 shipped to a paying pilot.
- Concierge tier capacity at 40+ pilots per vertical without Kyron editing every artifact.
- **Free Foundation Audit lead magnet live** at tojcampaign.com/foundation-audit, converting > 5% to Founding within 90 days.
- Aug 1 Personal Brand + Authority launch happens on time, deliverable-ready.
- Kyron coordination hours per week down 50%+ month-over-month.
- One organic-validated TOJcampaign.com teardown per week driving one paid-ad campaign that has already been proven.
- **Weekly retrospective ritual running continuously** — every Sunday, a shipped fix to a skill/cartridge/goal-registry entry.
- **Attention audit stable within 20% of target ratios** on 80%+ of days.

That is a 9/10 quality, 10/10 consistency operator platform in market. Not a promise on a slide — every element above is a file path.

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-15 (approx) | v2 initial — roles/skills/evals/goals/loops/plans/sequencing/72-hr moves | Prior Claude session |
| 2026-07-18 | v3 · added worldview operationalized, distribution runbook, media roadmap, curriculum, vertical theses, community/cohort spec (6 companion docs); added agent archetype distribution, weekly retrospective ritual, KPI baseline/ceiling/target discipline, Chief of Staff v3 extensions (T/P/E, attention audit, 3P daily brief, cycle-time), 6 new skills (operator-self-audit, hundred-mechanisms, four-week-pilot-playbook, paycheck-workflow, content-repurpose, different-not-better), Repurpose Producer role, Foundation Audit Composer role, outcome-priced offering, revised sequencing to 6-week phased rollout, level 12 slot reserved per framework lock | Claude |
