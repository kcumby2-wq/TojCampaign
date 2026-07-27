# Skill: Hooks Methodology

Purpose: the operating framework for Margin Hooks's business. Load this into any Hooks agent that needs to reason about roster ops, funnel decisions, or how outputs feed each other.

## The three funnels (canonical order)

Hooks runs three concurrent revenue funnels. Every athlete or trainer in the system lives in one primary funnel and sometimes crosses into a second. Agents must know which funnel a person is in before speaking to them.

### Funnel 1 — Athlete Training
Individual coaching access. Athletes come for private and small-group training, positional development, and recruiting preparation. Typical age range: 12–19. Revenue: session packs and monthly memberships.

**Signals of health:** consistent session attendance, film-day completion, communication cadence with parents, measurable position grade improvement over time.

### Funnel 2 — Trainer Education (Blueprint)
Certification program for other football trainers. Modular curriculum, $3,500–$5,000 per seat. Certified trainers get to use the Hooks methodology in their own regions and refer athletes back into the Hooks network for elite-level evaluation.

**Signals of health:** cohort completion rate, certified trainer athlete referral counts, trainer-to-Blueprint upsell rate on athletes they can't handle.

### Funnel 3 — Athlete Brand / NIL
36+ signed athletes managed through Trail of Joy Management Group. Brand-building, deal flow, sponsor outreach, and content strategy for athletes with NIL earning potential.

**Signals of health:** number of active deals per athlete, deal quality (fit + comp), owned-media engagement, sponsor relationship warmth (Battle, Pylon, brand reps).

## The roster hierarchy

Every athlete falls into one of these buckets. Agents always identify which bucket an athlete is in before writing about them:

- **Prospect** — inquiring, hasn't started training yet
- **Active** — in regular training, not yet on college boards
- **On the board** — being tracked by at least one college program
- **Committed** — signed to a college
- **Signed athlete (NIL)** — managed through TOJ Management Group; has active brand/deal representation

An athlete's bucket determines what agents can appropriately say about them. Never talk about an *active* athlete like they're already *on the board*. Never talk about a *signed athlete* without checking their NIL context first.

## The advocacy ledger

Every coaching call from a college coach gets logged. Two reasons:
1. **Credibility** — proof of demand for later marketing and Blueprint sales
2. **Sales attribution** — knowing which athletes drove which conversations helps prioritize where Margin's time goes next

Agents that touch the advocacy ledger should always: record who called, about which athlete, what the call surfaced, and what the next action is. Never summarize a call without naming the specific college and the specific athlete.

## The weekly cadence (Roster Pulse)

Every Sunday night → Monday morning, Margin needs to see:
1. **Rising** — athletes whose film or performance is trending up (worth pushing to more coaches)
2. **Stalled** — athletes whose progress has plateaued (need a specific intervention)
3. **Attention needed** — athletes with pending communication (parent question, coach follow-up, missed session)
4. **Games this weekend** — the ones playing, so film can be captured
5. **Communication pending** — coaches / parents / sponsors waiting on a response

If an agent produces a roster-level output, this is the structure.

## The Blueprint cohort

Certified trainers pay $3,500–$5,000 and get:
- A 6–8 week curriculum on the Hooks operating model
- Live Q&A with Margin
- Access to templates (session plans, film breakdown format, parent comms)
- Rights to use "Certified by Coached by Hooks" in their local marketing
- A referral path back to Hooks for elite-level evaluations they can't handle

**The Blueprint cohort is a retention business, not a one-time transaction.** Every touchpoint after enrollment (weekly check-in, cohort call, template drop) reduces churn and increases the probability they'll (a) complete, (b) refer athletes, (c) upsell into a full Hooks partnership.

## The relationships Margin protects (never automate)

These are the parts of the business Margin does himself. Agents should never write final-form communication for these — draft only, and always flag "human review before send":
- **Parent 1-on-1s** (especially first-time parents, or parents of committed athletes)
- **Company relationships** — Battle, Pylon, and any brand rep with a personal history
- **College head-coach conversations** — position coaches are fine to draft to; head coach outreach is Margin himself
- **NIL negotiations** — deal terms are always Margin (or the TOJ Management team) in the loop

## What Hooks methodology is NOT

- **Not a highlight-reel factory.** Video work exists to support evaluation and outreach, not to build clout.
- **Not a college placement service.** Hooks develops athletes and communicates their case to programs. The athlete + family + Margin makes decisions.
- **Not a marketing agency for athletes.** The NIL work exists to compound their earning potential during a narrow window, not to make them influencers.
- **Not a soft-tone content brand.** Football culture. Direct. Earned.

## When you're not sure

If an agent has to make a call about what Hooks would do and this doc doesn't answer it, default to **what serves the athlete first**. Not the funnel. Not the deal. Not the metric. The kid.

---

## The canonical output preamble (mandatory · every Hooks role)

Every Hooks agent output opens with this exact header block so downstream systems (Optimum, CRM, email, admin queue) have one place to route, one place to check the review gate, and one place to grep for status. **No exceptions.**

```
===== [ROLE LABEL] — [ATHLETE OR TRAINER FIRST NAME] — [ISO DATE] =====
INPUT: [one-line summary of what was asked]
RETRIEVAL: [what was pulled via retrieve_client_context] · confidence [high|medium|low]
HUMAN REVIEW REQUIRED: [yes|no|conditional]
REVIEW REASON: [one line — only present when yes or conditional]
```

Field rules:
- **`ROLE LABEL`** — the role's `label` field, verbatim (e.g., `THE GRADER`, `THE RECRUITER LIAISON`).
- **`ATHLETE OR TRAINER FIRST NAME`** — first name only; use `[cohort]` if the output isn't about a single person (e.g., Roster Pulse).
- **`ISO DATE`** — YYYY-MM-DD.
- **`INPUT`** — the operator's ask compressed to one line. Not the whole task body.
- **`RETRIEVAL`** — comma-separated list of what got pulled ("film notes 2026-01", "advocacy log 2026-05"). Confidence reflects how well the pulled chunks actually cover the task; "low" means the retrieval was thin and the output leans harder on general reasoning.
- **`HUMAN REVIEW REQUIRED`** — three states only:
  - **`yes`** — a human must review before this ships (e.g., draft to a coordinator, first-time-parent update, any NIL deal that scores APPROVE or NEGOTIATE, any draft to Battle/Pylon/brand-rep, anything Margin does personally per the "relationships Margin protects" list above)
  - **`no`** — ready to send / act on with one operator glance
  - **`conditional`** — ready if a stated fact is verified first (e.g., "conditional on shuttle time being verified before sending to a P4 program")
- **`REVIEW REASON`** — one line, only present when `yes` or `conditional`. Point to the specific rule that triggered the gate.

The preamble comes BEFORE the role's fenced output template. Never inside it, never optional.

---

## The canonical missing-data exit (mandatory · every Hooks role)

When a role hits the "not enough info to fully complete" wall, it produces this exact structure and stops. **No prose bail-out, no partial guesses framed as fact.**

```
===== INSUFFICIENT DATA — [ROLE LABEL] — [ATHLETE OR TRAINER FIRST NAME] =====
MISSING: [specific fields that would unblock — comma-separated]
NEEDED FROM: [where the data lives OR who to ask — one line]
NEXT STEP: [what unblocks · verb-first, specific]
```

Rules:
- Ship this AS the entire output when the role cannot complete. Do not attempt the partial output with hedging language.
- `MISSING` is specific field names, not vague ("no film notes since March; no verified 40 time; no updated target-school list") — never "not enough context."
- `NEEDED FROM` names the source in a way an operator can act on ("Optimum film-notes queue," "advocacy ledger for [school]," "ask Margin," "capture at next session").
- `NEXT STEP` is a verb-first sentence pointing at one action ("Upload the 2026-11 game film to Optimum → re-run this task once ingested").

This exit format is what an operator grep's for when scanning the queue. Consistent surface means every "the agent couldn't complete" event routes to the same triage flow.

---

## The role-output shape contract (mandatory · every Hooks role)

Every role's persistent output is either:
1. **A full agent output** — the preamble above, followed by the role's fenced output template, followed by any body content the role produces
2. **A missing-data exit** — the exit format above, and nothing else

There is no third shape. Downstream parsers can rely on this.

