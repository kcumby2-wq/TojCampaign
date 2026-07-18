# TOJ Distribution Runbook

**Companion to:** `docs/ai-notes-implementation-plan.md` (v3)
**Last updated:** 2026-07-18
**Purpose:** the funnel spec — lead magnet through continuity offer — with the Meta ads runbook, pre-validation gate, guarantee scaffold, and baseline/ceiling/target KPI discipline the notes require. The v2 plan had Ad Teardown Producer and Content Strategist as roles; this doc spells out the distribution rhythm they run.

---

## The funnel, in file paths

```
[Lead Magnet]
  ↓ email capture
[Nurture (Waitlist Warmer)]
  ↓ 15–50 pre-validation buyers
[Founding $99]           ← Implementation value
  ↓ upgrade path
[Core $199]              ← Unification value
  ↓ upgrade path
[Premium $499]           ← Communication value
  ↓ upgrade path
[Q1 2027 SaaS]           ← Imagination value
  ↓ continuity
[Cohort + Community]     ← belonging + status
```

Every arrow is a step the funnel manages. Every arrow has KPI thresholds. Every arrow has a role that owns it.

---

## 1. The Lead Magnet — the missing Day 1 asset

The notes describe a 4-tier product ecosystem: **Lead Magnet (Day 1) → Core Product (30 days) → Premium Offers → Continuity Offers**. TOJcampaign's existing concierge tiers cover Core + Premium + Continuity. **The Lead Magnet slot is empty.** Design it.

### Candidates evaluated

| Candidate | Barrier to entry | Signal quality | Time to build | Recommendation |
|-----------|------------------|----------------|---------------|----------------|
| Public Foundation Score self-audit (free, email-gated) | Very low — 5 min form | High — matches TOJ's pillar rubric | 2 weeks (interactive tool + Supabase + result page) | **Ship this** |
| 3-minute pillar-diagnostic quiz (weakest pillar only) | Lowest — 3 min | Medium — one pillar, not five | 1 week | Backup / A/B variant |
| 5-part email teardown series (free course) | Low — 5 emails over 10 days | Medium — self-selection but delayed | 1 week to write, 2 hours to wire | Add as a nurture-only asset for pilots after conversion |

**Ship decision:** Public Foundation Score self-audit at `/foundation-score-audit` route. Free. Email-gated at result-reveal (not before form). Gives the operator a real pillar-tree, marked "based on your self-report — a coach-led score follows different rules." Includes ONE actionable next step per pillar (fix-first hint). Ends with a soft path into $99 Founding.

**File paths:**
- `routes/foundation-score-audit.js` — the interactive tool (Next.js page + Supabase submission)
- `agents/roles/foundation-audit-composer.js` — new role, Draft-tier, produces the result page from the form submission
- `agents/skills/foundation-audit-response.md` — the skill that governs the tone + shape of the result page (must NOT sound like the Operational Transcript — that's the paid deliverable)
- `db/foundationAudits.json` — pre-Supabase local storage
- `agents/goals/registry.js` — add `foundation-audit-result` artifact type

**Guardrails on the free asset:**
- Never scores above 60 on any pillar (self-report ceiling; keeps the paid version defensible)
- Never uses the phrase "Operational Transcript" (that phrase is trademarked and paid)
- Never publishes the score to the user; the result page contains a range ("Your Growth Readiness pillar looks under-scored — likely 30–50 based on what you told us") and an actionable one-step
- Always ends with the soft path to Founding: "For a coach-led score with retrieval-based evidence, start Founding at $99/mo."

### KPI discipline for the Lead Magnet

Baseline / ceiling / target format from the notes' Clairvo example — applied to every metric.

| Metric | Baseline (TOJ today) | Industry ceiling | Target (defensible) |
|--------|----------------------|------------------|---------------------|
| Landing page conversion (visit → form start) | Unknown | 8–15% for education tools | **10%** |
| Form completion (start → submit) | Unknown | 50–70% for 5-min forms | **60%** |
| Email verification (submit → confirmed) | Unknown | 60–80% for genuine leads | **70%** |
| Free-audit → Founding conversion (30 days) | Unknown | 3–7% for cold traffic; higher for referred | **5%** |
| Free-audit → Founding conversion (90 days, with nurture) | Unknown | 8–15% for warmed leads | **12%** |

**Read this table as a discipline:** every row where TOJ's baseline is "Unknown" gets measured for 30 days before optimization decisions. No decisions from vibes.

---

## 2. Meta Ads Runbook

The notes are specific: **$50–60 daily test budgets, 3–5 ads per day, contrarian hooks, high-relevancy content**, always tested organically first, retarget cold with Facebook pixel, pre-validate with 15–50 buyers before scaling.

### Daily cadence

```
Monday 08:00 — Content Strategist proposes 5 organic hooks for the week
Monday 12:00 — Kyron approves; Content Strategist drafts pieces
Tue–Thu       — Content Strategist ships 3–5 organic pieces
Fri  10:00    — Ad Teardown Producer scans for pieces that crossed organic threshold
Fri  14:00    — Ad Teardown Producer proposes 3–5 ad variants per validated piece
Fri  16:00    — Kyron approves ad spend (Q&A Approval Bot presents each)
Mon (next)    — Ads go live; $50–60/day/campaign; kill-criteria armed
```

### Organic threshold — when a piece earns paid amplification

A piece earns amplification when at least TWO of the following are true within 5 days of publish:

1. **Engagement rate > 2× the last-90-day baseline** for that surface (IG carousel, LinkedIn post, YouTube short, blog post)
2. **Reply/comment volume > 1.5× baseline** (comments carry more signal than reactions)
3. **Save/share > 3× baseline** (saves + shares are the strongest predictors of paid conversion)
4. **Time-on-page > 2× baseline** (for long-form)

Baselines update quarterly. Retention Watcher owns the baseline recalculation on the first Monday of each quarter.

### Ad variant discipline

Every paid ad = 3–5 variants of the same organic piece. Variants differ on:
- **Hook** (5 variants: contrarian, question, stat, story-opening, before/after)
- **Image or clip cut** (2 variants: original + tighter framing)
- **CTA** (2 variants: soft "read more" vs hard "start free audit")

3×2×2 = 12 combinations; Ad Teardown Producer picks the 3–5 most-distinct.

### Kill criteria

Every campaign has a kill trigger armed at launch:

- **CPM > 2× industry benchmark** after 500 impressions → kill
- **CTR < 0.5%** after 1,000 impressions → kill
- **Cost per email-capture > $8** on the Free Audit funnel → kill
- **Zero conversions from a 5-day $250 total spend** → kill

Kill decisions are auto-executed by Ad Teardown Producer (no Kyron approval for kills — approvals are for spend, not for stopping spend). Reported in Chief of Staff evening close-out.

### The 15–50 buyer pre-validation gate

**Rule:** paid ads never scale beyond the $50/day test budget until 15 concierge buyers have converted from ANY source (organic, referral, event, free audit). At 15, expand tests to $100–150/day per campaign. At 50, expand qualifying campaigns to $500–1,000/day.

**Why:** the notes are clear that paid amplification of a product with no validated buyer pool amplifies confusion, not revenue. Cash on paid before 15 buyers is confidence-theater, not distribution.

**Enforcement:** `agents/goals/registry.js` includes a `paid_ad_gate` that Chief of Staff checks nightly. If buyer count < 15 and paid daily spend > $60, CoS flags a violation to Kyron.

### KPI discipline — Meta ads

| Metric | Baseline (TOJ today) | Industry ceiling | Target (post-launch, 90 days) |
|--------|----------------------|------------------|-------------------------------|
| CTR (link click / impressions) | Unknown | 1.5–3% for education | **2%** |
| CPM | Unknown | $8–20 US audience | **$12** |
| Cost per email-captured | Unknown | $3–8 for education tools | **$5** |
| Cost per Founding sign-up | Unknown | $30–80 for $99 subs | **$50** |
| Cost per Core sign-up | Unknown | $80–200 for $199 subs | **$120** |
| ROAS (30 days) | Unknown | 1.2–2× for cold subscription | **1.5×** |

---

## 3. The Tier-Down Content Pattern

The notes describe **tier-down content**: webpage → post → clip. One idea produced in decreasing depth to reach decreasing-attention audiences.

For every organically-validated piece, Content Strategist produces:

1. **Long-form** (blog post / newsletter / YouTube long — 800–2,000 words / 8–15 min)
2. **Medium** (LinkedIn post / IG carousel — 200–400 words / 6–10 panels)
3. **Short** (Reels / TikTok / YouTube Short — 30–60 seconds)
4. **Micro** (single-image quote / tweet — < 30 words)

All four tiers use the **same hook** for the first 3–5 seconds. Everything else adapts. This is what the notes' 100-mechanisms brainstorm produces, applied to distribution: 1 idea × 4 formats × 3–5 hook variants = ~50 assets from one insight.

Repurpose Producer (`agents/roles/repurpose-producer.js` — see the plan v3) owns the tier-down expansion.

---

## 4. The Guarantee Scaffold

The notes give a specific guarantee shape: **30%-more-engagement, 5%-refund threshold, four metrics** — incoming engagement / outgoing outreach / lead quality / appointment completion.

TOJcampaign's version, per tier:

### Founding ($99/mo) — no financial guarantee

The Foundation Score deliverable is the guarantee: a scored pillar tree with evidence + gap + one-week action per pillar. If it doesn't deliver in 72 business hours, next month is free.

### Core ($199/mo) — engagement guarantee

**Guarantee:** within 90 days, the client's outgoing outreach metric moves 30%+ on their tracked baseline. If not, refund up to 5% of TOJ's earned fees during that period.

**Tracked metrics** (client picks 1–2 at intake):
- Incoming engagement (comments + saves on their content)
- Outgoing outreach (DMs sent, cold emails sent — quality-adjusted)
- Lead quality (form submissions with pillar-tier ICP fit)
- Appointment completion (booked calls that happened)

**Baseline:** the 30 days before Core kicks off. Client provides the raw numbers at intake; TOJ verifies via screen-share.

**Refund cap:** 5% of the full 3-month Core fee ($597 × 5% = ~$30) — small enough that the guarantee doesn't scare TOJ, big enough that it signals the promise is real. The notes' framing of "5% refund threshold" is exactly this — the guarantee amount is calibrated to prove commitment, not to underwrite failure.

### Premium ($499/mo) — SOP delivery guarantee

**Guarantee:** by month 3, the client has one working SOP for a specific operation in their business (chosen at Premium kickoff). SOP is tested by having someone other than the founder execute it; success = it produces the expected output. If not, next month is free + Kyron works 1:1 to close the gap.

**No engagement-metric guarantee at Premium** — Premium clients get Communication value (the notes' 3rd tier of AI value), which shows up as delegation + reduced founder attention, not as raw engagement bump. Wrong guarantee promises the wrong thing.

### SaaS (Q1 2027) — uptime + quality guarantee

**Guarantee:** 99.5% uptime + artifact cartridge pass-rate > 90% for all included agent runs. Below either, credit-based refund. Details in the SaaS ToS (drafted separately by CLO).

---

## 5. Outcome-Priced Offering — the notes' $30/booked-job pattern

The notes describe outcome pricing at $30/booked-job for high-conviction workflows. TOJcampaign adds this as a **fifth offer** — targeted at Authority-vertical partners with quantifiable metrics.

### Structure

**Name:** TOJ Placement Track (working title)

**Applies to:** Authority-vertical clients whose success has a countable unit — recruiting shops (placements), coaching agencies (contracts signed), evaluation services (reports shipped).

**Structure:**
- Setup fee: $1,500 (covers intake + Foundation Score + first two modules customized)
- Ongoing: $30 per unit-of-success shipped, verified monthly, no minimum

**Vs subscription tiers:** offered as an ALTERNATIVE to Core/Premium for clients whose unit economics support it. Not offered by default — requires a fit-check by CFO agent. Chief of Staff routes.

### Fit check (CFO owns)

**Green light** if all four hold:
- Client has ≥ 20 units/month baseline (below that, $30 × N is too small to fund delivery)
- Unit outcome is verifiable in a shared system (no honor-system billing)
- Client's LTV per unit is > $200 (otherwise TOJ is capturing too much of the margin)
- Client agrees to weekly attribution reporting

**Red light** if any of the above miss. Client stays on Core/Premium subscription instead.

### Skills that govern

- `agents/skills/paycheck-workflow.md` (see plan v3) — the 5-question scoring for whether a client workflow is worth outcome-pricing
- `agents/skills/pilot-scoping.md` — the outcome-priced variant of a pilot proposal

---

## 6. Distribution Guardrails

- **Never test paid before organic validates.** The organic threshold above is the gate.
- **Never scale paid before 15 buyers.** The pre-validation gate is the gate.
- **Never send a paid ad the Vertical Positioner hasn't tagged with a vertical.** Cross-vertical bleed kills conversion.
- **Never run a campaign without a kill criterion armed.** Every campaign at launch has its stop condition in the ad-copy metadata.
- **Never send an ad through a source piece that failed cartridges.** If the organic piece didn't pass 27/30, the ad won't either.
- **Never underprice the Free Audit.** Free is $0. The soft path to $99 must be visible on the result page.

---

## Cross-links

- Content cadence rules → `agents/skills/content-repurpose.md`
- Positioning axiom for ad copy → `agents/skills/different-not-better.md`
- Vertical-specific ad targeting → `agents/roles/vertical-positioner.js` (v2 plan)
- Community + status layer (post-conversion) → `docs/toj-community-cohort-spec.md`
- Culmination artifact (SaaS launch) → `docs/toj-media-roadmap.md`
- Weekly retrospective ritual → `docs/ai-notes-implementation-plan.md` (v3)

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial · funnel spec, lead magnet, Meta ads runbook, guarantee scaffold, outcome pricing, KPI baseline/ceiling/target discipline | Claude |
