# The Performance Method — recruiting-fog-reducer, operationalized

The thesis that shapes every performance-os agent's output. Distilled from `performance-os/skills/recruiting-fog-reducer/SKILL.md` for runtime use inside the TojCampaign agent stack.

## The promise

Objective, third-party, session-and-event-level performance data — translated into a 90-second-consumable scout artifact — that reduces a college coach's evaluation load by 10x.

## The 7 rules every output follows

1. **Position-fluent framing.** Metrics without position context are noise. WR reports lead with top speed + HIR; RB reports lead with max accel + contact-adjacent; DB reports lead with change-of-direction speed. Templates per position live in `position-fluency.md`.

2. **Percentile-anchored, not raw-number-alone.** "15.9 mph top speed" means nothing without "78th percentile for WR at U9 age tier." Always show the band. If the benchmark is missing, mark `[BAND PENDING]` rather than fake precision.

3. **Sample-size honest.** One session is a leading indicator, not a scout-grade read. If <3 sessions or <30 days of data, ship the preview format that says "insufficient data for a scout-grade read" — don't fake precision.

4. **90-second consumable.** The coach-facing one-pager is the format. One page. Scannable. Everything else is behind a link.

5. **Trend over snapshot.** Session-to-session movement matters more than any single number. Monthly reports lead with delta, not level.

6. **No hype vocabulary.** Auto-fail banned words: elite, generational, next-level, phenom, future star, unlock, transform, game-changing, unleash, supercharge. No adjective triples. No exclamation marks. No pro comparisons without measured basis.

7. **Two independent signals.** Wearable data + film + Prospect Edge grade (if Hooks client) is stronger than any one alone. Reports invite triangulation, don't monopolize the claim.

## What performance-os outputs are NOT

- **Not auto-grading.** Grading is Margin's craft (`hooks-os/skills/prospect-edge-workflow/`). This stack produces evidence; the grade is human-authored.
- **Not a wearable-vendor pitch.** The wearable is the input. The report is the product. PlayerData is the current bridge — vendor is interchangeable in principle.
- **Not a recruiting-service replacement.** Rankings and lists come from different data. Performance-os complements them.

## The chain of custody

Every agent output that touches an athlete's identity must be traceable:
- Which agent role produced it
- When
- From which session data
- Which benchmark reference was used
- Whether it passed voice-drift check on first attempt or after retry

The eval spec (`evals/performance-principles.js`) enforces the rules above at runtime. Any output that fails 3 retries lands in `waiting` for human review — never silently shipped.

## Cross-reference

Full spec, worked examples, and integration patterns live in the `performance-os` repo:
- Strategy: `strategy/overview.md`, `strategy/competitive-landscape.md`, `strategy/go-to-market.md`
- Report templates: `product/report-templates/coach-facing-one-pager.md`, `product/report-templates/session-report.md`, `product/report-templates/monthly-scout-report.md`, `product/report-templates/event-summary.md`
- Data model: `product/data-model.md`
- Pilot proof: `pilot/2026-07-26-ethan-barr-demo/`
- Skills library: `skills/*/SKILL.md`
