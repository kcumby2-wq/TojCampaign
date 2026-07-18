# TOJ Worldview, Operationalized

**Companion to:** `docs/ai-notes-implementation-plan.md` (v3)
**Last updated:** 2026-07-18
**Purpose:** turn the four abstract ladders in Kyron's July 2026 AI notes — 12 levels of creativity, 4 values of AI, 3 levels of learning, 7 levels of AI mastery — into **verbs the operator or agent performs**, not framings that hang above the work.

---

## Why this doc exists

The v2 plan mapped the 12 levels of creativity into a table with one-line manifestations. That was enough to prove they applied. It isn't enough to run against. Every level here becomes an action attached to a specific TOJcampaign artifact type or role, so the operator can look at any surface (a homepage headline, a $499 Premium pilot onboarding, a Chief of Staff morning brief) and say "which level am I performing right now?" — and know what the next level asks of them.

The 4 values of AI, 3 levels of learning, and 7 levels of AI mastery get the same treatment. The result is a single reference the whole roster reads before designing an artifact, and the whole system reads before scoring one.

---

## 1. The 12 Levels of Creativity — as verbs per artifact type

The notes give 12 levels: Intention · Inspiration · Illumination · Identification · Separation · Segmentation · Systemization · Delegation · Automation · Culmination · Relaxation · (12th slot open). This doc treats them as an operator ladder, and every ladder rung is a **verb the operator or agent must perform** on the artifact in front of them.

Read this table as: "if you're producing artifact X, level N means doing verb Y before moving to N+1." An artifact isn't finished when a draft exists — it's finished when every applicable level has been performed.

### Level 01 · Intention — verb: **name the outcome**

- **Homepage headline** → name what a stranger should be able to describe back after 4 seconds. If you can't, no headline is written yet.
- **$499 Premium pilot onboarding** → name the pillar you're moving first, in one sentence, in the client's words.
- **Chief of Staff morning brief** → name the ONE metric to move per vertical today. Not five candidates.
- **Ad Teardown Producer variant** → name which pillar of the buyer's pain this ad speaks to.
- **Operational Transcript** → name the weakest pillar in the cover sentence. Never bury it.

Fail signal: the artifact starts without a nameable outcome. Retry: refuse to produce; return "outcome undefined" to the requester.

### Level 02 · Inspiration — verb: **anchor to a specific referent**

- **Homepage headline** → anchor to a specific operator profile (the modern network marketer with 3,000 IG followers, the coach with 6 clients).
- **Concierge weekly drop** → anchor to a moment in this pilot's last 7 days that the client will recognize.
- **Sales-call brief** → anchor to a phrase the prospect actually said in intake.
- **Chief of Staff evening close-out** → anchor to the top-3 tomorrow by inspiration from what shifted today, not a generic list.

Fail signal: the artifact could be produced for any pilot equally — it isn't anchored to this one.

### Level 03 · Illumination — verb: **retrieve the evidence**

- **Pillar Diagnostic sub-agent** → retrieve at least one chunk of the client's own material before scoring above 40.
- **Content Strategist post** → retrieve the last 90 days of engagement data; produce a hook that reflects what actually worked, not what should work.
- **Research Assistant brief** → every claim carries a source (chunk id, URL, or "asked the client"). No source, no claim.
- **Retention Watcher flag** → retrieve the engagement time-series; the flag names the specific week the trend broke.

Fail signal: the artifact makes claims not backed by retrieval. Retry: `pillar-evidence-cartridge.js` blocks delivery.

### Level 04 · Identification — verb: **give it a name that becomes a handle**

Every artifact, every agent, every failure mode gets an identity legible in a search or a Slack DM.

- **Every agent** — a persistent label ("The Closer", "Chief of Staff"). Never anonymous background jobs.
- **Every artifact type** — enum in the goal registry. If it isn't named, it doesn't get produced.
- **Every failure mode** — named entry in `docs/failure-modes.md` (to be created in the Command Center rollout).
- **Every pilot** — canonical id `pilot-[lastname]-[vertical]-[tier]-YYYY-MM`. Referenced everywhere.
- **Every module** — the Core-tier workflow module has a name: CRM Cadence, Content Calendar, Intake Automation. If a client asks "which one am I on this week?" the answer is a name, not a description.

Fail signal: two Slack messages reference the same thing with different words.

### Level 05 · Separation / Distinction — verb: **guard the meaning**

The notes: "become super vigilant when communicating a word/message to people for the first time." TOJcampaign's vocabulary carries load. Every word below is protected — used only in the way defined, corrected in the moment when misused.

- **"Operator"** ≠ "user" ≠ "client-facing person". Enforced in `toj-voice.md`.
- **"Foundation"** ≠ "framework". Foundation is the 5-pillar structural layer; framework is the meta-idea.
- **"Operational Transcript"** ≠ "report" ≠ "audit". Always the full phrase, always capitalized.
- **"Non-profit"** ≠ "nonprofit". Always hyphenated. Corrected inline every time.
- **"Concierge"** ≠ "consulting" ≠ "coaching". Concierge is the delivery mode of the tier ladder; consulting is what TOJ isn't anymore.
- **"5 Pillars"** ≠ "5 pillars of Foundation". The canonical order (Brand Identity → Operational Health → Revenue Architecture → Content & Credibility → Growth Readiness) never rearranges.

Fail signal: `brand-voice-checklist.md` flags a distinction violation. Retry: reject the artifact until the word is corrected AND the source of confusion is logged (was the writer under-informed? Is the vocabulary drifting? Is there a legitimate need for a new word?).

### Level 06 · Segmentation — verb: **finish one phase before the next**

- **Cartridge deployment** — publish Humanity + Marketing + Open-Rate + Pillar-Evidence in that order. Never work on Marketing while Humanity is still being calibrated.
- **Roster build-out** — Chief of Staff → Content Strategist → Research Assistant → the delivery lifecycle roles → the proactive/support roles. Never skip a tier.
- **Weekly production** — Thursday builds the drop, Friday sends. Never build and send on the same day.
- **Foundation Score intake** — pillar 1 → pillar 2 → pillar 3 → pillar 4 → pillar 5. Never score multiple pillars in parallel in the same conversation.

Fail signal: two phases are being worked simultaneously and one starts failing because the other isn't done. Retry: park the second; finish the first.

### Level 07 · Systemization — verb: **make it push-button**

- **Concierge weekly drop** → the Producer's output for the Concierge Coach is generated by clicking one button in the orchestrator. Kyron never touches the artifact until approval time.
- **Foundation Score intake** → form submission triggers the pillar-diagnostic sub-agent fan-out. Zero manual routing.
- **Ad Teardown Producer** → organic-threshold crossing triggers the variant fan-out. Kyron sees 3–5 ad drafts in Slack, not a "here's the top post, please generate ads."
- **Morning brief** → 6:30am cron triggers CoS. Never waits for Kyron to ask.

Fail signal: an artifact type still requires Kyron to initiate. Retry: `docs/operator-runbook.md` records the manual step and the ship-target date for its automation.

### Level 08 · Delegation — verb: **the artifact type has an owning role**

Every artifact type in the goal registry has exactly one owning role. Nothing is routed to "Kyron will do it" or "whoever's around."

- **Website copy** → Content Strategist owns; Vertical Positioner adapts; Kyron approves.
- **Operational Transcript** → Operational Transcript Drafter owns; the 5 Pillar Diagnostic sub-agents feed evidence.
- **Weekly drop** → Concierge Weekly Producer owns; Retention Watcher flags at-risk clients before the drop is built.
- **Ad creative** → Ad Teardown Producer owns; Content Strategist feeds source; Kyron approves spend.
- **Approval decisions** → Q&A Approval Bot presents; Kyron decides.

Fail signal: an artifact is being produced by "whoever's in Slack." Retry: name the owner in the goal registry before proceeding.

### Level 09 · Automation — verb: **the trigger fires without prompting**

- **Time triggers** — 6:30am morning brief, 7pm evening close-out, Thursday 6am build, Friday noon send, Monday 7am retention scan, Monday 8am content plan.
- **Event triggers** — form submission, pillar-score movement, organic-threshold crossing, missed weekly-drop open, cartridge fail-count reaching 3.
- **Escalation triggers** — 24h Kyron-approval miss, 48h engagement-signal drop, 2 consecutive weeks of decline.

Fail signal: a repeatable trigger still requires a human observing to fire it. Retry: add the trigger to `docs/loop-triggers.md` (to be created) with a ship date.

### Level 10 · Culmination — verb: **name the artifact this all builds toward**

Culmination isn't a milestone. It's the artifact everything upstream produces evidence for. This quarter's culmination artifact for TOJcampaign is the **Q1 2027 self-serve SaaS launch** — which means every roster addition, every cartridge, every skill, every pilot lifecycle run is producing evidence that the platform is ready to install itself onto a new operator without Kyron in the room.

Every artifact produced should be readable as evidence for that culmination. If it can't be, it isn't culmination-shaped and probably shouldn't be produced this quarter.

Fail signal: an artifact doesn't trace to the culmination. Retry: name the trace, or park the artifact.

### Level 11 · Relaxation — verb: **step off; the system runs**

Relaxation is a **structural condition**, not a mood. It exists when:

- Chief of Staff owns the daily coordination loop; Kyron doesn't run standups.
- Retention Watcher owns the churn-signal loop; Kyron doesn't scan engagement metrics.
- Cartridges own the quality loop; Kyron doesn't line-edit every deliverable.
- The goal registry owns the "what should we make?" question; Kyron doesn't debate scope in Slack.

The Q1 2027 SaaS launch is when this becomes true externally too — the operator subscribes, and the SaaS runs the same loops the roster runs internally. Culmination and Relaxation are two sides of the same artifact.

Fail signal: Kyron is doing the coordination that Chief of Staff should be doing. Retry: the failure of the CoS spec is the fix, not more Kyron.

### Level 12 · Open slot

Reserved. The notes described 11 named levels. TOJcampaign will fill the 12th slot when the culmination pattern makes it obvious what the next verb is — likely one of **Multiplication** (the culmination becomes installable in others: the SaaS makes the roster available to any operator), **Legacy** (the framework outlives Kyron's direct involvement), or **Consecration** (the finished system is set apart for its dedicated purpose). Chief of Staff's Q4 2026 retrospective proposes the fill.

---

## 2. The 4 Values of AI — mapped to the tier ladder with income ranges

The notes give four values of AI, each with a defensible income range: **Implementation** (up to ~$80k), **Unification** ($40k–$300k), **Communication** ($100k–$100M), **Imagination** ($1M–∞).

TOJcampaign's tier ladder maps 1:1 to values. Which value each tier delivers is the positioning skeleton — every piece of copy for that tier must reflect the value it's selling.

| Tier | Value delivered | What that means concretely | Income ceiling on this tier alone |
|------|-----------------|-----------------------------|-----------------------------------|
| **Founding · $99/mo** | **Implementation** | The Foundation Score + Operational Transcript get produced. TOJ handles the doing. The operator gets steps. | Up to ~$80k/year of operator revenue if they execute the steps. Capped by their own labor. |
| **Core · $199/mo** | **Unification** | The five pillars get unified into one operating system. Weekly drops make the workflow modules interlock. The operator moves from execution to coordination. | $40k–$300k/year. Capped by how well the modules integrate into their real business. |
| **Premium · $499/mo** | **Communication** | Custom SOP + monthly working session install the *voice* that scales the operator's decisions across their team. This is where the operator stops being the bottleneck. | $100k–$100M/year. Capped by their audience size, not TOJ's delivery. |
| **Q1 2027 SaaS** (post-launch, self-serve) | **Imagination** | Self-serve platform gives the operator agents that produce artifacts they couldn't have produced themselves. Chief of Staff writes their morning brief in their voice. | $1M+. Capped by the operator's ambition, not their attention. |

**Consequence:** every piece of TOJcampaign.com copy targeting a specific tier must sell the value that tier delivers. A $99 landing page selling "Imagination" is a category error — the buyer won't get that value at that price. A $499 landing page selling "Implementation" is under-selling to the wrong buyer.

Add to `agents/skills/toj-voice.md` a `tier_value_lock` rule: any copy tagged for a specific tier passes only if it sells the value that tier delivers. Vertical Positioner enforces.

---

## 3. The 3 Levels of Learning — mapped to the client journey

The notes give three learning levels: **Tactics · Principles · Essence** (with Essence being character + nature + inclination of God). This maps to the client journey through TOJcampaign — not the ladder from $99 to $499, but the internal transformation the client goes through as they engage.

| Level | What TOJ teaches at this level | Client tier where this lands | Skill file that governs it |
|-------|-------------------------------|------------------------------|----------------------------|
| **Tactics** | "Here is the step to take this week." The Weekly Drop is a Tactic. | Founding + early Core | `concierge-weekly-drop.md` |
| **Principles** | "Here is the pattern underneath the tactic — apply it yourself." The Six-Week Foundational Playbook is Principles-heavy. The Operational Transcript identifies principles. | Late Core + all of Premium | `operational-transcript.md`, `docs/six-week-foundational-playbook.md` |
| **Essence** | "Here is who you become as you keep operating this way." Character, nature, inclination. This is what Concierge Coach and Kyron's monthly working sessions land in. | Premium + SaaS after 6+ months | (new) `agents/skills/operator-self-audit.md` |

**Design consequence for the Six-Week Foundational Playbook:** the playbook is Principles-heavy by design and should say so on page 1. Add a note to `docs/six-week-foundational-playbook.md` marking it as the Principles-level companion to whatever Tactics the Core weekly drop is delivering. Do not confuse it with Tactics-level content — that would over-invest in reading and under-invest in doing.

**Design consequence for Chief of Staff:** the CoS morning brief should tag each item T/P/E so Kyron can see across the day whether he's spending time on Tactics (fast, delegable), Principles (slower, teachable), or Essence (his character showing up in the work). Every brief should show the ratio: TOJ operator target is T:60% / P:30% / E:10% during pilot phase; shifts to T:30% / P:40% / E:30% by SaaS launch.

**Design consequence for the SaaS pivot:** the SaaS delivers Tactics + Principles at scale; Essence stays with human coaches (Concierge Coach agent handoffs to Kyron for Premium clients). This is what keeps the SaaS defensible — the essence layer can't be commoditized.

---

## 4. The 7 Levels of AI Mastery — where TOJcampaign is today, roadmap to 6 + 7

The notes name seven levels of AI mastery: **Anticipation → Question Mastery → Asset Assembly → Automation → Agentic Systems → Agent Ecosystem → Custom LLM**. This is the growth path of TOJcampaign the *platform itself* — not the pilot's journey, but the operator's (Kyron's + the roster's).

### Honest read of where TOJcampaign is today (July 2026)

| Level | Status | Evidence |
|-------|--------|----------|
| **1 · Anticipation** | ✅ | Kyron predicted the transition to owned-SaaS and started building the roster before the transition became urgent. |
| **2 · Question Mastery** | ✅ | The 7-question trusted-agent spec, the 5-pillar diagnostic, the Foundation Score intake all reflect internalized question-crafting. |
| **3 · Asset Assembly** | ✅ | `agents/roles/`, `agents/skills/`, `agents/evals/` are alive with real files that ship real artifacts. |
| **4 · Automation** | 🟡 partial | `agents/evals/toj-principles.js` runs. Cartridges + goal registry + time-triggered CoS brief still to build (Plan A + Plan C of v2). |
| **5 · Agentic Systems** | 🟡 partial | 6 roles exist and reason within their scope. The 12 missing agents (v2 delta) will close this. |
| **6 · Agent Ecosystem** | ❌ not yet | Ecosystem = agents coordinating without Kyron in the loop. This is the SaaS-ready state. Requires the goal registry + cartridges + full roster + retention loop. |
| **7 · Custom LLM** | ❌ not yet | A TOJ-tuned model that natively embodies `toj-voice.md`, `toj-methodology.md`, and the pillar rubric. Q1 2027 candidate; not before. |

### Roadmap to Level 6 (Agent Ecosystem) — the 30–45 day plan

**Necessary conditions to claim Level 6:**

1. Cartridges live and enforced (Plan A shipped).
2. Chief of Staff + Content Strategist + Research Assistant live (Plan B partial).
3. Full pilot lifecycle roles live (Intake Triage → Foundation Score Intake → Operational Transcript Drafter → Concierge Weekly Producer).
4. Retention Watcher live and proactively surfacing signals.
5. Goal registry driving artifact scheduling (Plan C shipped).
6. Q&A Approval Bot is the only surface Kyron uses to interact with the ecosystem for routine work.
7. One full week runs where Kyron makes zero routing decisions.

**Ship target:** end of September 2026, in time for the Aug 1 launch's 60-day mark.

### Roadmap to Level 7 (Custom LLM) — Q1 2027 candidate

**Necessary conditions to claim Level 7:**

1. Level 6 sustained for 90 days.
2. Enough passing cartridge-scored artifacts to be a training corpus (target: 500+ passing artifacts across all types).
3. A TOJ-tuned model (fine-tune of Claude via API or an open-weights model on Anthropic-compatible infra) that ships pass-first-time cartridge scores at rate > 90% on TOJ artifact types.
4. The tuned model runs behind Concierge Weekly Producer + Operational Transcript Drafter, freeing capacity on Claude Sonnet/Opus for higher-cognition work (Chief of Staff, Research Assistant).

**Ship target:** Q1 2027 SaaS launch. Not before. If the corpus isn't ready by end of December 2026, Level 7 slips to Q2. Do not force it.

### What this section unlocks

Every roster addition, every skill, every cartridge is measurable against these ladder rungs. When Chief of Staff runs the retrospective ritual, one question in the review is: **"Did this week's work move TOJcampaign closer to Level 6 or Level 7?"** If not, either the work was Level 5 maintenance (fine, name it as such) or the work was misdirected (fix at the source).

---

## Cross-links

- Product ladder + income ranges → `docs/toj-distribution-runbook.md` (funnel spec)
- Culmination artifact + roadmap to Level 7 → `docs/toj-media-roadmap.md` (long-term trajectory)
- Level-of-learning + client tier mapping → `docs/six-week-foundational-playbook.md` (Principles-level companion)
- Operator self-audit against essence → `agents/skills/operator-self-audit.md`
- 12-level ladder as trigger check → `docs/ai-notes-implementation-plan.md` (v3 § Weekly Retrospective Ritual)

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial · levels operationalized as verbs; 4 values mapped to tier ladder; 3 levels of learning mapped to client journey; 7 levels of AI mastery with honest current-state read | Claude |
