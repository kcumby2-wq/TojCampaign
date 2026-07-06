# /archive

Legacy avenue pages from the pre-v2 architecture. Not served by the site.
Preserved here so their content can be edited and eventually redirected
into the three-vertical hierarchy per Strategy Memo v1.1.

## Files and their target vertical

| Legacy page          | Redirect target when re-published        |
|----------------------|------------------------------------------|
| `sports.html`        | `/authority.html` (Youth Programs, Individual Athletes, sport-adjacent Creators) |
| `smallbusiness.html` | `/personal-brand.html` (Trainers, Creators, Solo Entrepreneurs) |
| `bigbusiness.html`   | Split between `/nonprofit.html` (multi-program orgs) and internal-only Advisory routing |
| `advisory.html`      | Split between `/personal-brand.html` (individuals building a brand) and `/authority.html` (NIL / athlete education) |

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
- **Advisory** — "Master the basics. Then become prime." (now on `/how-we-work.html`),
  the small-cohort quality signal, the ecosystem framing (SubjectSkillz / TOJ /
  SubjectMedia — kept internal per Memo §6 legal separation).

## When you're ready to re-publish

Move a file from `archive/` back into `public/` and add either:

1. A meta refresh in the `<head>`:
   `<meta http-equiv="refresh" content="0; url=/authority.html" />`

2. Or an Express route in `server.js`:
   `app.get('/sports.html', (req, res) => res.redirect(301, '/authority.html'));`

Option 2 is cleaner (301 for SEO) and doesn't require the file to exist in
`public/` at all.
