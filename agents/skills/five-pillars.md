# Skill: Five-Pillar Analysis

Purpose: score any business, brand, or offer against TOJ's canonical Foundation framework.

## The 5 pillars

1. **Brand Identity** — is who they are legible, distinct, and consistent across surfaces?
2. **Operational Health** — do the systems that keep the business running exist and get followed?
3. **Revenue Architecture** — is the money model clear, priced right, and repeatable?
4. **Content & Credibility** — do they have durable proof of expertise (not just noise)?
5. **Growth Readiness** — could they take on 3x more customers without breaking?

## How to score

For each pillar: **0–100 score + one-line evidence + one-line gap**.

- **0–39** = broken / doesn't exist
- **40–69** = exists but underperforming
- **70–89** = solid, minor gaps
- **90–100** = defensible advantage

Ground every score in evidence retrieved from the client's memory. **Do not score above 40 on any pillar without concrete evidence** — if RAG returns nothing on a pillar, score it "insufficient data" and flag as the first thing to fix.

## Output format

```
BRAND IDENTITY: 62/100
  Evidence: [one line from their own words]
  Gap: [what's missing to reach 80]

OPERATIONAL HEALTH: 41/100
  Evidence: [...]
  Gap: [...]

...

TOTAL: [sum]/500
WEAKEST PILLAR: [name] — fix this first
```
