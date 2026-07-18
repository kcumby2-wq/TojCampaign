# AI Notes → TOJcampaign.com Implementation Plan

**Author:** Kyron Cumby, Trail of Joy Management Group, LLC
**Focus:** TOJcampaign.com — the platform, the product, and the operator OS underneath
**Status:** Living working doc. Clients (Subject Report, Pylon7v7, Sky's The Limit WR, XpandSports, Optimum Grading, CollegeFootballRecruiting.com) are mentioned only where they change the design of a TOJcampaign agent, skill, or goal.
**Purpose:** Turn the July 2026 AI notes into concrete additions to `agents/roles/`, `agents/skills/`, and `agents/evals/` — every note maps to a file path, a persona, or a numeric threshold.
**North star:** TOJcampaign.com is a 9/10-quality, 10/10-consistency operator platform running three verticals on one agent spine.

---

## The one-paragraph synthesis, sharpened

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

### Skills that exist (`agents/skills/`)

- `toj-voice.md` — the 3-dial register/warmth/assertion voice DNA
- `voice-matching.md` — the retrieval protocol for client-voice mimicry
- `toj-methodology.md` — the TOJ core operating story every client-facing agent loads
- `five-pillars.md` — the Foundation Score scoring rubric (0–100 per pillar, evidence + gap)

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

1. **Chief of Staff** — foundation agent that routes everything, holds the daily brief, decides which role handles the task
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

### Missing skills (the markdown that defines HOW)

1. `verify-toj-artifact.md` — the analog of `verify-frontend-change`. Any client-facing artifact runs this end-to-end verify before shipping.
2. `pillar-diagnostic.md` — the structured question set per pillar for the intake conversation
3. `operational-transcript.md` — the 72-hour deliverable format (structure, section shape, evidence rules)
4. `foundation-score-intake.md` — the intake conversation flow, including insufficient-data behavior
5. `sales-call-brief.md` — the one-page sales-call brief spec: every objection has a scripted answer, follow-up quotes 3 things they actually said
6. `email-quality.md` — email done-when: <150 words, subject <45 chars, zero spam words, one clear ask
7. `webpage-quality.md` — TOJcampaign.com quality gate: every CTA works, mobile <2s, brand voice pass on visible copy blocks
8. `brand-voice-checklist.md` — the pass/fail checklist that "5 posts pass brand voice" resolves to
9. `pilot-scoping.md` — how a pilot conversation must be shaped: outcome named, metric named, timeline named, guarantee terms named
10. `concierge-weekly-drop.md` — the Friday-noon weekly deliverable spec per tier (Core = 1 module workflow, Premium = 1 module + working session prep)
11. `vertical-positioner.md` — how to translate copy across Personal Brand / Authority / Non-profit without breaking voice
12. `ad-teardown.md` — how to turn an organic piece into a paid-ad creative package

### Missing evals (the cartridges)

1. `humanity-cartridge.js` — voice (3-dial match) + variety + no-LLM-tells. 0–10.
2. `marketing-cartridge.js` — hook strength + specificity + one clear ask. 0–10.
3. `open-rate-cartridge.js` — subject-line quality + body length + spam-word scan + opener specificity. 0–10.
4. `pillar-evidence-cartridge.js` — every pillar claim grounded in retrieval, no ungrounded scores above 40. 0–10.
5. `cartridge-runner.js` — the orchestrator that sums applicable cartridges and enforces 27/30 (or 18/20, etc.) before delivery.
6. `pre-deliver.js` (hook) — the gate itself. No client-facing artifact ships without passing.

---

## Every missing agent, in the 7-question trusted-agent form

The notes reduce a trusted-agent spec to seven questions. Every new TOJcampaign agent below is written to that spec plus the same file shape as `architect.js` / `closer.js` — that's what makes them drop-in.

### 1. Chief of Staff — `agents/roles/chief-of-staff.js`

**Purpose:** own the operator's day. Route inputs to the right role. Produce the morning brief and the evening close-out.

- **Wakes up:** at 6:30am (time loop), on any new capture into Inbox, on any @toj-cos mention in Slack/DMs, on any Foundation Score movement > 5 points.
- **Context:** current day's calendar, Inbox contents, `listClients` output, active pilots + tier, weekly-drop shipping schedule, last 7 days of Kyron's captures, current OKR set.
- **Tools:** `listClients`, `getFoundationScore`, `retrieveClientContext`, ability to invoke any other role via the orchestrator, ability to push a Slack DM to Kyron, ability to write to `db/inbox.json`.
- **Allowed to do itself:** triage Inbox → (Next / Doing / Waiting / Done), pick the day's ONE metric-moving move per vertical, book time on Kyron's calendar for approvals, draft the morning brief and evening close-out, prompt other roles for their piece of the day.
- **Success looks like:** morning brief in Slack by 6:30am covering yesterday's Done, today's Doing, what's Waiting on Kyron specifically, one metric per vertical to move today; evening close-out by 7pm covering what moved, what didn't, tomorrow's top three.
- **Approval required for:** anything that would send a message to a real human outside TOJ (client, prospect, partner), any pricing statement, any pillar-score sent to a client.
- **Escalates when:** two consecutive daily briefs land with no metric moved on a vertical; a pilot's engagement drops below the retention threshold; any output fails cartridges 3 times in a row.
- **Loads skills:** `toj-voice`, `toj-methodology`, `verify-toj-artifact`.

### 2. Content Strategist — `agents/roles/content-strategist.js`

**Purpose:** own TOJcampaign.com's content surface — homepage, teardown posts, social, and any thought-leadership piece.

- **Wakes up:** on the weekly content-plan trigger (Monday 8am), on any request from CoS, when Retention Watcher flags a piece that outperformed and warrants an ad teardown.
- **Context:** current TOJcampaign.com content calendar, last 90 days of engagement metrics, the vertical positioning notes, cartridge-passing archive of prior posts, `toj-voice` and `voice-matching` skills.
- **Tools:** `retrieveClientContext` (for anonymized composite examples), site copy read/write, Slack post, ability to invoke `ad-teardown-producer`.
- **Allowed to do itself:** draft posts, propose a weekly calendar, produce hook variations (must generate 10 hooks under 8 words per piece), decline pieces that fail its own brief.
- **Success looks like:** every published piece scores 27+/30 across Humanity + Marketing cartridges before publish; 10 hook variants generated per piece; per-piece done-when includes "reads aloud under 60 seconds" for scripts and "brand-voice checklist passed" for written.
- **Approval required for:** anything with a specific client name or a hard financial claim.
- **Escalates when:** a piece fails cartridges 3 times, or the topic requires legal/compliance judgment.
- **Loads skills:** `toj-voice`, `toj-methodology`, `voice-matching`, `brand-voice-checklist`, `webpage-quality`, `ad-teardown`.

### 3. Research Assistant — `agents/roles/research-assistant.js`

**Purpose:** read the mess, return the signal. Any intake, any transcript, any public research task.

- **Wakes up:** on any new Foundation Score intake submission, on any pre-sales prospect prep request, on any post-call debrief request from CoS.
- **Context:** the intake payload / transcript / URL / uploaded file; `retrieveClientContext` for prior context if a returning client.
- **Tools:** `retrieveClientContext`, `getFoundationScore`, web read via the environment's fetch, PDF/notes read (once wired), the ability to write to a shared briefing store.
- **Allowed to do itself:** produce structured 5-bullet briefs (situation / evidence / gap / recommended move / owner), tag briefs by vertical + pillar, flag anything that requires ground truth from the client.
- **Success looks like:** brief on Kyron's phone in under 10 minutes for a routine ask, under 60 minutes for a full prospect prep; every claim carries a source (chunk id, URL, or "asked the client").
- **Approval required for:** none — briefs are internal.
- **Escalates when:** the source material contradicts itself, or the request needs personal-data access beyond consented scope.
- **Loads skills:** `toj-methodology`, `pillar-diagnostic`, `five-pillars`.

### 4. Pilot Intake Triage — `agents/roles/pilot-intake-triage.js`

**Purpose:** classify every inbound intent — from tojcampaign.com form, DM, referral, or event — by vertical and tier, and hand off cleanly.

- **Wakes up:** on webhook from the tojcampaign.com intake form, on any Waitlist-Warmer handoff, on any @toj-triage mention.
- **Context:** the intake payload, the tier definitions, the vertical positioning notes, current waitlist depth, current pilot capacity.
- **Tools:** `getFoundationScore` (if returning), Slack post to CoS with the classification, ability to schedule a discovery slot via calendar.
- **Allowed to do itself:** classify vertical (Personal Brand / Non-profit / Authority), classify tier fit ($99/$199/$499), enrich with public research from Research Assistant, add to CRM with proper tags, propose a discovery-slot bracket.
- **Success looks like:** every intake tagged and routed within 15 minutes of receipt; less than 5% mis-classification measured monthly; zero silent drops.
- **Approval required for:** anything sent to the prospect (Waitlist Warmer owns the send under approval; Triage stops at classify+route).
- **Escalates when:** the intake is ambiguous across two verticals, or the prospect fits nowhere.
- **Loads skills:** `toj-methodology`, `pilot-scoping`, `verify-toj-artifact`.

### 5. Operational Transcript Drafter — `agents/roles/operational-transcript-drafter.js`

**Purpose:** produce the 72-hour Operational Transcript™ deliverable at 9/10 concierge quality.

- **Wakes up:** on Foundation Score Intake completion, on a re-score request from Concierge Coach.
- **Context:** the client's intake, their pillar scores, their voice sample if provided, the operational-transcript skill spec, prior transcripts for pattern (anonymized).
- **Tools:** `retrieveClientContext`, `getFoundationScore`, the five pillar-diagnostic sub-agents (invoked in parallel).
- **Allowed to do itself:** draft the full transcript, run it through cartridges, revise up to 3 times based on cartridge feedback.
- **Success looks like:** transcript delivered within 72 hours of intake; 27+/30 cartridge score; all five pillars named with evidence and gap; the "weakest pillar — fix this first" section is unambiguous and actionable in 5 hours.
- **Approval required for:** every transcript — Kyron does the final read before send.
- **Escalates when:** intake evidence is too thin to score above 40 on 3+ pillars (that's a scoping problem, not an agent problem).
- **Loads skills:** `toj-voice`, `toj-methodology`, `five-pillars`, `operational-transcript`, `pillar-diagnostic`.

### 6. Foundation Score Intake — `agents/roles/foundation-score-intake.js`

**Purpose:** run the intake conversation (form-driven or 1:1) into a scored pillar tree.

- **Wakes up:** on intake form submission, on Kyron's request during a live discovery call.
- **Context:** the client's form data + any transcript, `pillar-diagnostic.md` questions, `five-pillars.md` scoring rubric.
- **Tools:** `retrieveClientContext` for returning clients, write to `db/foundationScores.json` (or the Supabase schema in `docs/foundation-score-supabase-spec.md` once live).
- **Allowed to do itself:** ask follow-up questions when a pillar's evidence is thin, score each pillar 0–100 with one-line evidence and one-line gap, produce the pillar-tree JSON.
- **Success looks like:** every pillar has a score + evidence + gap; no pillar scored above 40 without a retrievable evidence chunk; the intake takes under 20 minutes of client time.
- **Approval required for:** the client sees the score only after Kyron's review — Intake writes to storage but does not display.
- **Escalates when:** the client's stated goals contradict their pillar evidence at a level that a human should reconcile.
- **Loads skills:** `pillar-diagnostic`, `foundation-score-intake`, `five-pillars`, `toj-methodology`.

### 7. Concierge Weekly Producer — `agents/roles/concierge-weekly-producer.js`

**Purpose:** ship the Friday-noon weekly deliverable for every Core and Premium pilot.

- **Wakes up:** every Thursday 6am (time loop), on any Waiting-on-client input clearing early.
- **Context:** every active Core/Premium pilot's Foundation Score, their weekly-drop history, their stated priorities, the shared modules library (CRM cadence, content calendar, intake automation).
- **Tools:** all client-facing tools, the CSV builder (`routes/csv.js`), Slack DM to the client, calendar invite for Premium working sessions.
- **Allowed to do itself:** produce each pilot's weekly-drop artifact + one-page summary, queue them for Kyron's Friday-morning review, propose the following week's module target.
- **Success looks like:** every Core and Premium pilot receives a passing drop by Friday noon local time; 27+/30 cartridge score; the artifact is a decision, not homework, for the client.
- **Approval required for:** every drop before send.
- **Escalates when:** a pilot's engagement dropped below threshold (Retention Watcher raises it — Producer proposes a fix drop).
- **Loads skills:** `toj-voice`, `toj-methodology`, `concierge-weekly-drop`, `verify-toj-artifact`.

### 8. Pillar Diagnostic — `agents/roles/pillar-*.js` (×5)

Five focused sub-agents, one per pillar. Same 7-question shape, same skill loading, but each one owns one pillar's evidence + gap. The five files are `pillar-brand-identity.js`, `pillar-operational-health.js`, `pillar-revenue-architecture.js`, `pillar-content-credibility.js`, `pillar-growth-readiness.js`. Invoked in parallel by Operational Transcript Drafter and Foundation Score Intake. Success signal per pillar: score justified, evidence retrieved, gap actionable in one week. This is the "10 parallel subagents" pattern from the notes, applied to TOJ's core deliverable.

### 9. Retention Watcher — `agents/roles/retention-watcher.js`

**Purpose:** proactive loop — catch churn signals before churn.

- **Wakes up:** every Monday 7am (time loop), on any pilot's weekly-drop-open failing to register within 48 hours, on any pillar re-score dropping > 10 points.
- **Context:** every active pilot's engagement metrics (opens, replies, session attendance), pillar-score history.
- **Tools:** read engagement metrics, DM CoS with the alert, propose a fix action.
- **Allowed to do itself:** raise flags with severity, draft a "check-in" DM for Kyron to send.
- **Success looks like:** 100% of at-risk pilots surfaced to Kyron within 48 hours of the first signal; zero churn events that had no prior flag.
- **Approval required for:** every outbound message.
- **Escalates when:** two consecutive weeks of decline on the same pilot — CoS books a rescue call.
- **Loads skills:** `toj-methodology`.

### 10. Ad Teardown Producer — `agents/roles/ad-teardown-producer.js`

**Purpose:** turn organically-validated TOJcampaign.com content into a paid-ad creative package.

- **Wakes up:** when a piece crosses the organic threshold Content Strategist has set (e.g., X shares, N comments, engagement rate above baseline).
- **Context:** the source piece, the piece's engagement data, `ad-teardown.md`, the 3–5 ad daily test cadence from the notes.
- **Tools:** creative-asset generation (image/clip), hook variation generation, targeting-note drafting.
- **Allowed to do itself:** produce 3–5 ad variants per piece, each with hook, image/clip cut, targeting note, budget suggestion ($50–60 test as the notes describe).
- **Success looks like:** every paid-ad campaign traces back to a piece that already won organically; CTR and CPM metrics recorded before scale.
- **Approval required for:** every ad before spend.
- **Escalates when:** no piece meets the organic threshold in the review window.
- **Loads skills:** `ad-teardown`, `brand-voice-checklist`.

### 11. Vertical Positioner — `agents/roles/vertical-positioner.js`

**Purpose:** re-shape a piece of copy or an offer for the target vertical without breaking TOJ voice.

- **Wakes up:** on any Content Strategist or Closer request to adapt a piece for a specific vertical.
- **Context:** the source piece, the vertical's positioning brief, `vertical-positioner.md`.
- **Tools:** `retrieveClientContext`, cartridges.
- **Allowed to do itself:** produce a vertical-adapted version with a diff summary explaining what shifted and why.
- **Success looks like:** vertical adaptation lands in-voice per Humanity Cartridge; the diff summary is under 3 sentences.
- **Approval required for:** external send.
- **Escalates when:** the source piece contains a claim that only applies to one vertical and can't be neutralized.
- **Loads skills:** `toj-voice`, `voice-matching`, `vertical-positioner`, `toj-methodology`.

### 12. Q&A Approval Bot — `agents/roles/qa-approval-bot.js`

**Purpose:** sit at the approval gate. Every artifact needing Kyron's yes/no shows up here.

- **Wakes up:** on any role invoking the approval hook.
- **Context:** the artifact, the source request, the cartridge scores, the "why this deserves attention" one-liner.
- **Tools:** Slack DM with three buttons (Approve / Edit / Reject), route back to the origin role on Edit or Reject.
- **Allowed to do itself:** present, remind, timeout after N hours to Waiting.
- **Success looks like:** every awaiting-approval item is a yes-or-no decision, not a "read the whole thing" chore. Every approval takes under 30 seconds on phone.
- **Approval required for:** N/A — it IS the approval surface.
- **Escalates when:** a Kyron approval is missed for over 24 hours.
- **Loads skills:** `verify-toj-artifact`.

---

## The skills library, expanded

Every skill below is a markdown file under `agents/skills/`. Each follows the existing shape: **Purpose · How to use it · Rules · Anti-patterns · Fallback when data is missing.** Below is one-paragraph purpose per new skill so you can prioritize which to write first.

- **`verify-toj-artifact.md`** — Never report a client-facing artifact as complete based on a successful draft alone. Steps: (1) run the applicable cartridges, (2) read the piece aloud (script rule), (3) check every link/CTA works, (4) check length/subject constraints per artifact type, (5) confirm the artifact is a decision for the client, not homework. Fail any step and it goes back to the drafting role.
- **`pillar-diagnostic.md`** — For each of the 5 pillars, the structured question tree that turns a client's answers into scoreable evidence. Includes the "insufficient data" fallback: when a pillar's evidence returns thin, the diagnostic must ask one clarifying question before scoring; if evidence is still thin, the pillar scores "insufficient data — flag as first fix" per `five-pillars.md`.
- **`operational-transcript.md`** — The 72-hour deliverable format: cover page (client, date, weakest pillar, one recommendation), Pillar Detail section per pillar (score, evidence, gap, one-week action), Cross-Pillar Move (the one thing that lifts multiple pillars at once), Success Signals (what will be true in 30 / 60 / 90 days if this is executed), Governance (how the client should track it).
- **`foundation-score-intake.md`** — The intake conversation flow: opening prompt, per-pillar question set (from `pillar-diagnostic.md`), evidence-capture rules, edge-case behavior for founders who under-answer or over-answer. Includes the exit conversation — how the intake ends without setting the client's expectation about the score before Kyron has reviewed it.
- **`sales-call-brief.md`** — The one-page sales-call brief: prospect (name, role, vertical, source), stated pain (in their words), pillar hypothesis, offer fit (Founding/Core/Premium), objections + scripted answers (every objection from a prior call goes into a rolling registry — new brief must have all covered), follow-up shape (must quote 3 things the prospect said in their own words), success signal for the call.
- **`email-quality.md`** — Email done-when: under 150 words, one clear ask, subject under 45 chars with zero spam words, opens with either a name or a specific number, no LLM tells, one CTA per email. The Open-Rate Cartridge scores against this file.
- **`webpage-quality.md`** — TOJcampaign.com per-page done-when: every CTA fires and lands on the correct destination, mobile load under 2 seconds, all visible copy passes brand voice, no orphan states, canonical meta tags in place, page has one primary CTA (not three), Lighthouse audit >= 90 on performance and accessibility.
- **`brand-voice-checklist.md`** — The pass/fail list for brand voice: register/warmth/assertion match the 3 dials, no banned phrases ("unlock", "transform", "in today's fast-paced world", "delve", em-dash-as-connector, triple-adjective openers), specific over abstract, verbs before nouns, no hedging on load-bearing sentences. 8/8 required.
- **`pilot-scoping.md`** — How a pilot conversation must be shaped: outcome named in one sentence, primary metric named with baseline and target, timeline named, guarantee terms named (the 30%-more-engagement / 5%-refund pattern from the notes is the reference), budget owner named. Every pilot proposal must fill this shape or it doesn't go out.
- **`concierge-weekly-drop.md`** — Weekly drop by tier: Founding = one Slack DM summary + a check-in question; Core = one artifact (CSV, campaign, or pipeline drop) + one-page summary + next week's chosen module; Premium = Core + custom SOP progress + calendar-held working session with agenda. Every drop must be a decision, not homework.
- **`vertical-positioner.md`** — The translation rules: Personal Brand vertical uses X vocabulary and Y proof style; Authority uses institutional-partner vocabulary and case-study proof; Non-profit uses program-outcome vocabulary and funder-facing proof. Same underlying truth, three languages.
- **`ad-teardown.md`** — How to turn an organically-validated piece into a paid-ad package: 3–5 variants, hook first, image/clip cut second, targeting third, budget suggestion, kill criteria (when to stop the ad based on CPM/CTR after N impressions).

---

## The goal registry — done-when for every TOJcampaign artifact

Every artifact type produced by an agent (or by Kyron) has a numeric done-when. If the artifact does not hit its numbers, the loop re-runs. This is the "don't stop until…" pattern from the notes, converted into a table.

| Artifact | Done-when threshold | Cartridge(s) run | Owning role |
|----------|--------------------|--------------------|-------------|
| Website copy block (tojcampaign.com) | Brand voice pass 8/8; page mobile load < 2s; every CTA fires | Humanity + Marketing | Content Strategist |
| Homepage hero | ≤ 12 words in headline; ≤ 20 in subhead; one primary CTA | Humanity + Marketing | Content Strategist |
| Blog post / teardown | 10 hook variants under 8 words each; passes voice checklist; reads aloud in ≤ 60s per 200-word section | Humanity + Marketing | Content Strategist |
| Social post | Hook < 8 words; 27+/30 combined cartridge | Humanity + Marketing | Content Strategist |
| Marketing / nurture email | < 150 words, subject < 45 chars, one clear ask, no spam words | Humanity + Marketing + Open-Rate | Waitlist Warmer |
| Sales email (outbound) | < 120 words, subject < 45 chars, quotes prospect where possible | Humanity + Marketing + Open-Rate | Closer |
| Sales-call brief | Fits on one page; every objection has scripted answer; 3 prospect quotes in follow-up shape | — (skill check) | Research Assistant |
| Foundation Score intake | Every pillar scored 0–100 with evidence + gap; no pillar > 40 without evidence chunk | Pillar-evidence | Foundation Score Intake |
| Operational Transcript | ≤ 72 hours from intake; 27+/30 cartridges; weakest pillar unambiguous | Humanity + Pillar-evidence | Operational Transcript Drafter |
| Concierge weekly drop | Every Friday noon; 27+/30; decision-shaped for client | Humanity + Marketing | Concierge Weekly Producer |
| Pilot proposal | Fills `pilot-scoping.md` shape completely; guarantee terms specific | Humanity | Closer |
| Paid ad creative | Traces to organic-validated piece; 3–5 variants; targeting note included | Humanity + Marketing | Ad Teardown Producer |
| Vertical adaptation | Diff summary ≤ 3 sentences; Humanity Cartridge pass | Humanity | Vertical Positioner |
| Morning brief | Delivered by 6:30am; one metric-mover per vertical; ≤ 300 words | — | Chief of Staff |
| Evening close-out | Delivered by 7pm; what moved / what didn't / top 3 tomorrow; ≤ 200 words | — | Chief of Staff |
| Research brief | 5 bullets, situation/evidence/gap/move/owner; every claim sourced; ≤ 10 min routine, ≤ 60 min prospect prep | — | Research Assistant |
| Retention flag | Raised within 48h of first signal; includes proposed fix; severity 1–3 | — | Retention Watcher |

If the artifact type isn't in this table, it doesn't get produced yet. That's the segmentation discipline the notes require.

---

## The four loops, mapped to TOJcampaign

- **Turn loop.** Skill files exist and are tagged (`/verify-toj-artifact`). Every drafting role runs the applicable skill's verify at end-of-turn. This is already the pattern in `toj-principles.js` — extend it to the cartridge runner in Plan A.
- **Goal-based loop.** Every artifact type in the goal registry above has numeric thresholds. Retry up to 3 times, then Waiting. Same primitive already in prod.
- **Time-based loop.** Morning brief 6:30am. Evening close-out 7pm. Concierge weekly drops Thursday build → Friday noon send. Retention Watcher Monday 7am. Content Strategist weekly plan Monday 8am.
- **Proactive loop.** Retention Watcher (churn signals). Ad Teardown Producer (organic-threshold crossings). Chief of Staff daily-brief metric-mover flag. The trigger set is small on purpose — proactive loops are noisy if you add too many.

---

## The three plans (rewritten, TOJcampaign-first)

### Plan A — Cartridge OS: consistency layer for every TOJcampaign artifact

**The bet:** the difference between "we build good stuff sometimes" and "we build 9/10 stuff every time" is the cartridge/eval gate. Ship it once, on top of `agents/evals/toj-principles.js`, and every artifact TOJcampaign produces — website copy, Operational Transcripts, concierge drops, sales emails, ad creative — routes through it or doesn't ship. This is what the notes call the Humanity + Marketing + Open-Rate cartridge combining to 27/30.

**What ships (in file paths):**

- `agents/evals/humanity-cartridge.js`
- `agents/evals/marketing-cartridge.js`
- `agents/evals/open-rate-cartridge.js`
- `agents/evals/pillar-evidence-cartridge.js`
- `agents/evals/cartridge-runner.js` — sums the applicable cartridges per artifact type using the goal registry
- `agents/hooks/pre-deliver.js` — the gate; every role's output routes here before it leaves the system
- `agents/skills/verify-toj-artifact.md`
- `agents/skills/brand-voice-checklist.md`
- `docs/cartridges.md` — human-readable rubric so future team members (and Legal review) can reason about scores

**Time to ship:** 7 focused working days for v1. Two per cartridge, one for runner, one for gate + docs.

**Failure mode:** Building the rubric so tight nothing passes on first try, then softening it to move on. Better: publish v1 at "catches obvious misses," measure real fail patterns for two weeks, tighten in v1.1.

**Revenue impact:** Indirect but unbounded. Removes the operator-time ceiling on concierge tiers. Every $99/$199/$499 pilot becomes deliverable at scale without you personally editing each artifact.

**Notes it satisfies:** Cartridges (Humanity, Marketing, Open-Rate). Guardrails + evals. Goal-based loop 90%+ threshold. Turn loop skill files. Segmentation (only one job per cartridge).

### Plan B — Agent Roster Build-out: complete the platform's brain

**The bet:** the 6 existing roles cover the entry point and the delivery persona, but they do not cover the operator brain (Chief of Staff), the platform's daily production (Content Strategist, Research Assistant), the pilot lifecycle from intake through weekly drop (Pilot Intake Triage, Foundation Score Intake, Operational Transcript Drafter, Concierge Weekly Producer), or the proactive loop (Retention Watcher, Ad Teardown Producer, Vertical Positioner, Q&A Approval Bot). Ship the 12 new agents in Draft → Triage → Coordinate → Act order — never skip a tier for an artifact type.

**What ships:** the 12 role files listed above under "Every missing agent" — same shape as `architect.js` / `closer.js` — plus the pillar-diagnostic ×5 sub-agents that Operational Transcript Drafter and Foundation Score Intake invoke in parallel.

**Time to ship:** ship one role per working day. 12 roles + 5 sub-agents = 17 files. Cadence: 3 weeks with time for the Skeptic to red-team each before it lands. The Architect agent already exists to draft each one — use it. That IS the meta-pattern from the notes ("Claude prompts Claude").

**Failure mode:** shipping roles without their skills. Every role above lists the skills it loads — those skills must exist before the role lands, or it will free-form and break voice. Plan C ships the skills; do these in an interleave rather than sequence.

**Revenue impact:** Direct. The concierge tiers ($99/$199/$499) become sellable at 40+ pilots per vertical instead of 5, because the delivery labor moves into the roster instead of into Kyron's calendar. Also unlocks the Q1 2027 SaaS pivot — the roster is the product.

**Notes it satisfies:** Chief of Staff / Content Strategist / Research Assistant trio. Product ladder Draft → Triage → Coordinate → Act. The archetypes (Prototype/Builder/Sleeper/Grower/Maintainer map to roster maturity phases). Slack-channel one-Claude-per-channel pattern (Chief of Staff spawns sub-orchestrators per vertical).

### Plan C — Skills Library + Command Center: define done-when and orchestrate

**The bet:** every agent above is only as good as the skill markdown it loads. Ship the 12 new skill files, wire the goal registry into the orchestrator, and put a mobile capture surface between Kyron and the system so the whole platform can be operated from a phone.

**What ships:**

- The 12 skills markdown files listed under "Missing skills"
- `agents/goals/registry.js` — a machine-readable version of the goal-registry table above; cartridge-runner reads from it
- Mobile capture ingress (Raycast + Shortcuts on iPhone, or Left Click AI equivalent) that POSTs raw notes to an Inbox endpoint
- `routes/inbox.js` — the Inbox → Next → Doing → Waiting → Done pipeline
- Slack workspace + one channel per vertical/business surface (TOJ Personal Brand, TOJ Authority, TOJ Non-profit, TOJcampaign.com Growth) with Chief of Staff DMing the morning brief per channel
- `docs/operator-runbook.md` — how Kyron runs the platform on a Tuesday from an airport

**Time to ship:** 10 working days. Skills are 300–500 words each; write two per day for 6 days, then a full day on the goal registry + inbox routes, then two days on Slack + mobile capture wiring, then a day of end-to-end verify.

**Failure mode:** shipping the command center without shipping the roles that populate it (Plan B). The command center without the roster is theater. Do them in interleave.

**Revenue impact:** Multiplicative. Cuts Kyron's coordination time by 50%+ within a month. Unlocks selling the same command-center pattern to Authority-vertical clients as a productized offer once it works internally.

**Notes it satisfies:** Skill md files (the /verify pattern). Mobile execution / Left Click AI. Inbox → Next → Doing → Waiting → Done. Q&A approval gate. Chief of Staff daily brief. Slack channel pattern.

---

## Recommendation: sequencing

The three plans are not competing. They are three tracks of the same 30-day sprint, with interleave.

**Days 1–7:** Plan A cartridges + `verify-toj-artifact.md` + `brand-voice-checklist.md`. This is the fastest path to 10/10 consistency and it unlocks everything downstream. Every artifact produced from Day 8 onward is gated.

**Days 4–24:** Plan B roster, one role per working day. Start Chief of Staff on Day 4 in parallel with the last three days of Plan A — CoS needs less skill infrastructure than delivery roles. Then Content Strategist, Research Assistant, then the pilot-lifecycle roles (Intake Triage → Foundation Score Intake → Operational Transcript Drafter → Concierge Weekly Producer), then the proactive/support roles.

**Days 6–20:** Plan C skills interleaved with the roles that load them. Never ship a role whose skills aren't written yet — the Architect agent will refuse to design against absent skills, use that discipline. Ship the mobile capture and Slack wiring on Days 18–20 once there's real work to route.

**Day 25–30:** verify end-to-end. Run one full pilot lifecycle through the system as a dry-run on synthetic-but-plausible data. If anything fails cartridges, fix at the source (skill or persona), not at the cartridge.

**Anti-plan:** launching the Aug 1 Personal Brand + Authority verticals without any of the above in place. The transition plan's Aug 1 launch depends on quality that only the roster + cartridges can deliver at concierge scale.

---

## The next 72 hours (the six moves)

1. **Merge this doc.** Then delete or archive `docs/toj-transition-plan.md`'s implicit assumption that manual delivery scales — it doesn't, and this plan replaces the "how" while preserving the "what" and the "when."
2. **Ship `agents/evals/humanity-cartridge.js`** — 5 scored dimensions using `toj-voice.md` and `brand-voice-checklist.md` as the source of truth. Threshold 8/10.
3. **Write `agents/skills/verify-toj-artifact.md`** — the analog of the notes' `verify-frontend-change`, tailored to TOJcampaign artifacts. This is the turn-loop skill everything else loads.
4. **Use `architect.js` to draft `chief-of-staff.js`** — the notes' Chief of Staff, in TOJ's exact file shape. This is the meta-pattern working for you (Claude prompts Claude).
5. **Publish the goal registry as `agents/goals/registry.js`** — machine-readable done-when table for every artifact. Even a v1 with only 5 artifact types wired is enough to gate everything downstream.
6. **Pick the ONE metric per surface** that TOJcampaign is optimizing this month. Suggested: TOJcampaign.com organic pieces published passing cartridges (Content), Foundation Score intakes completed within 72h (Delivery), concierge pilots signed at any tier (Revenue), Kyron coordination hours spent per week (Operator). Refuse work that doesn't move one of the four.

---

## What this plan is not

- **Not a rebrand.** TOJ, Foundation Score™, Operational Transcript™, five pillars, three verticals, Aug 1 launch — all preserved from `docs/toj-transition-plan.md`.
- **Not a stack change.** Next.js / Supabase / Clerk / Stripe / Resend / Anthropic / Vercel / Render stands. All additions land in `agents/roles/`, `agents/skills/`, `agents/evals/`, `agents/hooks/`, `agents/goals/`, and `routes/`.
- **Not a client-work plan.** Subject Report, Pylon7v7, Sky's The Limit WR, XpandSports, Optimum Grading, and CollegeFootballRecruiting.com show up here only where their patterns change how a TOJcampaign agent is designed. Client-specific SOPs live in a separate document.
- **Not a promise on a slide.** Every element above is a file path, a numeric threshold, or a skill markdown. The proof is that after 30 days, `agents/roles/` has 12 more files, `agents/skills/` has 12 more files, `agents/evals/` has 4 more files, and `docs/cartridges.md` + `docs/operator-runbook.md` are readable by a new hire on day one.

---

## Levels-of-the-12, mapped to TOJcampaign this quarter

| Level | Manifestation on TOJcampaign this quarter |
|-------|-------------------------------------------|
| 1 Intention | Every artifact has a done-when in the goal registry; if it isn't in the registry, it isn't produced |
| 2 Inspiration | The Aug 1 launch is the forcing function — the calendar drives the roster |
| 3 Illumination | Every pilot's Foundation Score is a learning event — Retention Watcher captures what moves and what doesn't |
| 4 Identification | Every agent has a named label ("The Closer," "Chief of Staff") — no anonymous background jobs |
| 5 Segmentation | Never work all three plans on the same day; interleave per the sequence above |
| 6 Systemization | The roster + skills + cartridges IS the system — push a button, artifacts ship at 9/10 |
| 7 Delegation | Every artifact type has an owning role; nothing routed to "Kyron will do it" |
| 8 Automation | Time loops (morning brief, weekly drops) and proactive loops (Retention Watcher, Ad Teardown Producer) run without prompting |
| 9 Culmination | Q1 2027 self-serve SaaS launches on top of the roster — the platform Kyron shipped internally IS the product externally |
| 10 Relaxation | Chief of Staff owns coordination; Kyron owns Standard + Strategy + Relationships |

---

## The 90-day success line

- 12 new roles in `agents/roles/`, 12 new skills in `agents/skills/`, 4 new cartridges + runner in `agents/evals/`, 1 goal registry, 1 pre-deliver hook, 1 mobile capture ingress, 1 Slack workspace with per-vertical channels.
- Every artifact TOJcampaign.com produces gated by cartridges — zero deliverables below 27/30 shipped to a paying pilot.
- Concierge tier capacity at 40+ pilots per vertical without Kyron editing every artifact.
- Aug 1 Personal Brand + Authority launch happens on time, deliverable-ready, and the Sept/Oct capacity is 3x what manual delivery would have allowed.
- Kyron coordination hours per week down 50%+ month-over-month.
- One organic-validated TOJcampaign.com teardown per week driving one paid-ad campaign that has already been proven.

That is a 9/10 quality, 10/10 consistency operator platform in market. Not a promise on a slide — every element above is a file path.
