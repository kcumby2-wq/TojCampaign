# /archive

Legacy pages from the pre-v2 architecture. Not served by the site.
Preserved here so their content can be edited and eventually redirected
into the three-vertical hierarchy per Strategy Memo v1.1.

## Files and their redirect target

| Legacy page          | Redirect target                          | Reason archived |
|----------------------|------------------------------------------|-----------------|
| `sports.html`        | `/authority.html`                        | Four-avenue architecture retired |
| `smallbusiness.html` | `/personal-brand.html`                   | Four-avenue architecture retired |
| `bigbusiness.html`   | `/nonprofit.html` (Advisory kept internal per §5) | TOJ Big Business department retired per Memo §5 |
| `advisory.html`      | `/personal-brand.html` (individuals) or `/authority.html` (NIL / athlete education) | TOJ Advisory as a public door retired; residual work sourced by referral per §5 |
| `intake.html`        | `/foundation-score.html`                 | Foundation Score is the Entry offer per Memo §3.2 |
| `instructors.html`   | `/how-we-work.html`                      | TOJ Advisory as a public door retired per §5 |

## Notes for the copy edit

Strongest ideas already carried forward into the v2 vertical pages:

- **Sports → Authority** — "Coaches don't act on hype", "The record is the resume",
  "One record. Four surfaces.", the Prospect / NIL Earner / Program / Creator archetypes.
- **Small Business → Personal Brand** — "Regulars leave when you go quiet", the
  four-part operating system (Presence Kit / Intake / Cadence / Retention Rhythm),
  the Month 01 shipping schedule.
- **Big Business → Nonprofit** — "Every new program was supposed to feel like the
  first one", "Mission preserved. At scale.", the phased rollout (Baseline →
  Standardize → Install → Extend).
- **Advisory → How We Work** — "Master the basics. Then become prime.", the
  small-cohort quality signal, the ecosystem framing (SubjectSkillz / TOJ /
  SubjectMedia — kept internal per Memo §6 legal separation).
- **Intake → Foundation Score** — the branching intake logic collapses into
  the vertical-picker + five-pillar rating flow on `/foundation-score.html`.

## How the redirects are wired

Express 301 routes in `server.js`. The files in `archive/` are not served —
they only exist so the copy can be mined for future v2 iterations.
