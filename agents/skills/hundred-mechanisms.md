# Skill: Hundred Mechanisms

Purpose: when TOJ hits a metric plateau on any goal-registry item, invoke the "10 parallel subagents × 10 mechanisms each" brainstorm pattern from the notes to generate 100 distinct mechanisms to move the metric — then deduplicate to a working shortlist. This is how the platform breaks out of local maxima.

## When to load

- Chief of Staff triggers this skill when a KPI in the goal registry has been flat (< ±5% variance) for 4+ consecutive weeks
- Content Strategist triggers when a content piece keeps landing at similar engagement despite variant attempts
- CFO triggers when a pricing tier isn't converting at target for 30+ days
- Kyron manually triggers when he senses a plateau but the KPIs haven't officially flagged it yet

## The pattern

10 parallel subagent runs, each producing 10 distinct mechanisms across a spread of 7 lenses:

1. **Algorithmic** — a rule / an algorithm / a system-level change
2. **Behavioral** — a change in what a user, client, or operator does
3. **Infrastructural** — a change in the underlying platform or tool
4. **Regulatory / policy** — a change in the rules the game is played under
5. **Psychological** — a change in how the situation is perceived
6. **Time-based** — a change in when the thing happens
7. **Identity-based** — a change in who is doing / receiving the thing

Each subagent must span at least 4 of the 7 lenses across its 10 mechanisms.

**Total raw output:** 100 mechanisms. **Deduplication target:** ~50 distinct. **Working shortlist:** 5–7.

## The subagent invocation

Chief of Staff invokes 10 parallel Claude runs via the orchestrator. Each run gets:

- **The metric** to be moved (with baseline, current, target)
- **The context** — 30-day snapshot of what's been tried, what worked, what didn't
- **The 7 lenses** as a checklist
- **Constraint:** no mechanism may repeat a mechanism from the 30-day tried list

Each run outputs 10 mechanisms in this shape:

```
1. [Lens] — [Mechanism]: [1-sentence why it might work]
2. [Lens] — [Mechanism]: [1-sentence why it might work]
...
10. [Lens] — [Mechanism]: [1-sentence why it might work]
```

## Deduplication

After 100 mechanisms land, a single Claude run (not parallel) deduplicates:

- Group by mechanism family (same idea, different framing → same entry)
- Score each group by (a) breadth of lenses that hit it, (b) novelty vs. tried, (c) apparent ease-of-test
- Output top 20, ranked

## Selecting the working shortlist

Kyron picks 5–7 from the top-20. Selection criteria (all four required):

1. Testable in ≤ 2 weeks
2. Falsifiable — you'll know if it worked
3. Reversible — you can un-do it if it doesn't
4. Not violating an existing TOJ hard rule (no minor's brand assets shipped without consent; no automated post-to-client; etc.)

## Running the tests

Each selected mechanism gets a mini-test:

- **Test duration:** 2 weeks
- **Success signal:** metric moves ≥ 20% of the gap between current and target
- **Failure signal:** no movement OR reverse movement
- **Kill criterion:** if 2 out of 5 tests fail in Week 1, abort those and add 2 from the top-20 backup list

## Governance

- **Hundred Mechanisms is NOT the default response to a bad week.** It's the response to a **plateau** — the discipline is to try normal iteration first.
- **Chief of Staff logs every invocation.** File: `docs/hundred-mechanisms-log.md`. Kyron reads quarterly to see whether the platform is drifting into over-brainstorming vs. under-brainstorming.
- **The output is stored.** Even mechanisms not selected get archived — they become the search space for the next invocation.

## Rules

- Never invoke on a KPI that has been tracked for < 30 days (not enough baseline)
- Never invoke without naming a specific metric with a specific target
- Never accept mechanisms that don't cite a lens
- Never let the shortlist grow past 7 (10 becomes theater; 5 is real)

## Anti-patterns

- "Let's brainstorm 100 ideas about growth" — no. The trigger is a specific plateau on a specific metric.
- Running multiple hundred-mechanisms in parallel on different KPIs — no. One at a time. The operator can't hold five active mechanism-tests in attention.
- Skipping the deduplication step — no. The signal is in what patterns emerge across independent runs, not in raw volume.

## Fallback when data is missing

If the current metric baseline is too noisy to trigger cleanly, run a diagnostic first (Research Assistant produces a 5-bullet brief on why the metric is noisy) BEFORE invoking Hundred Mechanisms. Never invoke against noise — you'll produce noise-shaped mechanisms.

---

**References:** the notes' 100-mechanisms pattern; `docs/ai-notes-implementation-plan.md` v3 § Weekly Retrospective Ritual (which surfaces plateaus).
