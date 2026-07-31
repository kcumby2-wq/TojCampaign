# Pillar Scoring — the 5-pillar diagnostic (runtime)

The runtime distillation of `performance-os/skills/pillar-scoring/SKILL.md` for the TojCampaign agent stack. The `pillar-scorer` role loads this. It turns an athlete's evidence into the universal 5-pillar diagnostic per `toj-platform/CLAUDE.md` §2.

## The five pillars (0-100 each · 0-500 total)

| # | Pillar | What it measures | Football evidence |
|---|---|---|---|
| 01 | **Brand Identity** | position + role distinction | position clarity · signature signal (burst/route-runner/volume/explosive) from session_metrics |
| 02 | **Operational Health** | capture + training cadence | sessions/month · zero-out rate · load balance · film-day completion |
| 03 | **Revenue Architecture** | NIL two-phase | pre-NIL scaffolding (ceiling ~60) OR NIL-active layer (full 0-100) |
| 04 | **Content & Credibility** | the receipts | verified sources joined (PlayerData/Optimum/Subject Media) · TOJ Composite + trend · one-pager views |
| 05 | **Growth Readiness** | trajectory | recruiting markers · trailing-90-day trend · offer/interest pipeline |

## The scoring bands

- **0–40** — thin/no evidence. No citation required (low score IS the signal).
- **41–60** — foundational, developing. **Citation required.**
- **61–80** — strong, above band. **Citation required.**
- **81–100** — exceptional, multi-source, trending up. **Citation required.**

**Hard rule:** every score above 40 cites retrievable evidence. If you can't cite it, it can't exceed 40. (CLAUDE.md §2 + §11.)

## Ceilings

- Revenue Architecture caps ~60 for pre-NIL athletes (scaffolding only, revenue hasn't started).
- Any pillar with < 2 evidence sources stays provisional and can't score above 60.

## After scoring all five

1. **Total** (0–500).
2. **Weakest pillar** — lowest, named unambiguously. Tie → lowest evidence density.
3. **Cross-pillar move** — the ONE move raising 2+ pillars. The engagement anchor.
4. **Tier-gate state** (computed, never a toggle):
   - Internal Mastery: total ≥ 350 AND no pillar < 50
   - External Validation: scholarship offer / all-district / state (from attestations)
   - Basic (neither) · Runway (external only) · Prime (mastery only) · Premium (both)

## Rules

- **Cannot lie.** No invented stats/names/outcomes/measurables. Missing evidence → low score + why.
- **Weakest pillar named unambiguously.** One pillar, no hedging.
- **One cross-pillar move.** Not a list.
- **No hype vocabulary** (CLAUDE.md §6 · enforced by performance-principles auto-fail regex).
- **Child-safety:** minors' diagnostics never surface identifying/contact info outside the family/mentor/coach circle.

## Output format

Follows the hooks-methodology canonical preamble (INPUT / RETRIEVAL / HUMAN REVIEW REQUIRED), then:

```
===== 5-PILLAR DIAGNOSTIC — [athlete first name] — [ISO date] =====
SPORT / POSITION / GRAD YEAR / AGE TIER

PILLAR SCORES
01 Brand Identity:        [XX] · [evidence anchor]
02 Operational Health:    [XX] · [evidence anchor]
03 Revenue Architecture:  [XX] · [pre-NIL ceiling ~60 | NIL-active] · [anchor]
04 Content & Credibility: [XX] · [N verified sources] · [anchor]
05 Growth Readiness:      [XX] · [evidence anchor]
TOTAL: [XXX] / 500

WEAKEST PILLAR: [name] at [XX] · [why]
CROSS-PILLAR MOVE: [verb-first] · raises [A] + [B] · [why now]
TIER-GATE STATE: [Basic|Runway|Prime|Premium] · [mastery met? external met?]
EVIDENCE GAPS: [what would sharpen it]
===== END =====
```

## When evidence is too thin

< 2 sessions AND no Optimum games AND no film → ship the INSUFFICIENT DATA exit; score only what's retrievable; label pillars 04/05 as source-dependent. Never fabricate.

## Cross-skill

- `performance-method` — the recruiting-fog-reducer thesis
- `position-fluency` — the signature-signal read for pillar 01
- `performance-voice` — the register
- Full doctrine: `performance-os/skills/pillar-scoring/SKILL.md`
