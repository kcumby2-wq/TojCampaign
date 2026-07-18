# TOJ Vertical Theses

**Companion to:** `docs/ai-notes-implementation-plan.md` (v3)
**Last updated:** 2026-07-18
**Purpose:** the market bets buried in Kyron's July 2026 notes that the v2 plan didn't integrate. Each thesis below either becomes a sub-product, a delivery framework, or a positioning axiom — with file paths, decision gates, and next steps. No abstractions floating.

The theses cover: NIL/youth prep, mastery-based education, spatial intelligence, D2C future, tokens as infrastructure. Each is treated as either "build it" or "explicitly park it" — no half-decisions.

---

## Thesis 1 · NIL / Youth Prep — Authority sub-product

### The bet

The notes: *"Prepare kids for the NIL space both on and off the field."* This is a live wedge in the Authority vertical. Parents, coaches, and programs have a defined buyer profile and a defined pain (NIL is here, the guidance isn't). TOJcampaign has adjacent client relationships (Sky's The Limit WR, XpandSports, CollegeFootballRecruiting.com) that shape the offer without becoming the offer itself.

**The buyer:** parents of 8th–12th grade athletes, HS coaches building programs, small-market club programs, mid-major college programs supporting current athletes.

**The pain (unfiltered):** their athletes are either being ignored by the NIL market (because no one's built their profile) OR being exploited by the NIL market (because no one taught them to negotiate). Both are Foundation problems dressed as market problems.

### The product

**Name:** TOJ Foundation for NIL (working title — needs a name-check pass before public)

**Shape:** a vertical adaptation of the existing Foundation Score + Operational Transcript, scoped to a young athlete's personal-brand foundation.

- **Pillar 01 · Brand Identity** → What does this athlete stand for? What's their story a scout could describe in one sentence?
- **Pillar 02 · Operational Health** → What's their reliability signal? Grades, attendance, coach relationships, off-field presence.
- **Pillar 03 · Revenue Architecture** → What's their NIL-specific offer stack? Speaking, appearances, merch, coaching-of-younger-kids, media rights? Priced how?
- **Pillar 04 · Content & Credibility** → Their durable proof — tape, testimonials from coaches/teachers, results.
- **Pillar 05 · Growth Readiness** → Can they handle a $10k/mo NIL package without the wheels coming off school, family, or ball?

Same 5 pillars. Different vocabulary. Different evidence sources. Same TOJ voice.

### Pricing

- **Foundation for NIL Basic** — $199 (parent-scale price; higher than $99 because parent-buyer has different price ceilings than solo operator)
- **Foundation for NIL Program** — $999 setup + $299/mo per program (buyer: school or club program, covers up to 20 athletes on their roster)

### File paths

- `agents/roles/pillar-nil-brand.js` through `pillar-nil-growth.js` — vertical-specific pillar sub-agents, forking the existing Pillar Diagnostic ×5 pattern
- `agents/skills/nil-pillar-diagnostic.md` — the question tree tuned for a 14–18 year old athlete + parent
- `agents/skills/nil-guardrails.md` — hard rules: no minor's identifiable brand asset shipped without parent consent; no financial advice given to minors; no representation-adjacent language ("we can get you deals") — TOJ never becomes agent/representative
- `agents/skills/nil-vertical-positioner.md` — a vertical-specific extension of the base vertical-positioner skill
- `docs/nil-vertical-brief.md` — the market read + buyer profile + pricing + go-to-market

### Consent + compliance

Every NIL product includes:
- Parent/guardian consent for anyone under 18
- School-district notification for anyone with active NCAA eligibility (state-by-state variance — CLO researches once hired)
- Explicit language: TOJ scores foundations; TOJ does not negotiate deals or represent athletes
- No storage of a minor's likeness on TOJ infrastructure without explicit renewable consent

### Go/no-go gate

- **Go if:** by end of Q4 2026, TOJ has secured 3 pilot buyers at the Basic tier from the existing client-adjacent network (Kyron sourced, not cold-outreach)
- **No-go if:** by end of Q4 2026, no signed pilots — meaning either the buyer profile is wrong or Kyron's network doesn't carry that credential yet

**Owner of the go/no-go call:** Kyron + CFO agent. Chief of Staff surfaces the decision on Dec 15, 2026.

### Client relationships that inform (but don't become the product)

- **Sky's The Limit WR** — an existing Kyron-adjacent client running a wide-receiver methodology. Their pattern (evaluation → brand build → NIL enablement → advocacy) is the reference architecture for how a program-scale buyer uses TOJ. Do not white-label this offer under Sky's The Limit — TOJ delivers directly.
- **XpandSports · CollegeFootballRecruiting.com** — client relationships that give TOJ visibility into the college-side buyer. Useful for lead generation via existing partner channels; not part of the product itself.

---

## Thesis 2 · Mastery-Based Education — delivery framework, not a product

### The read

The notes describe a full spec for mastery-based education: assess first, mastery not seat-time, cognitive + creative + personal development, AI-scaffolded per module, ZPD-aware (Zone of Proximal Development). This is a comprehensive learning framework.

### The decision — framework, not product

TOJ does NOT launch a K–12 education product. Reasons:

1. K–12 is a different regulatory + buyer environment (institutions, procurement, state standards) that would fork TOJ's operating model
2. Adjacent-but-not-owned client relationships (Sky's The Limit WR runs youth programs; XpandSports runs athlete development) — going into K–12 as a competitor to those client-adjacent operators breaks the network trust
3. The mastery-based framework has more leverage as **the delivery mode for TOJ's OWN curriculum** — the Six-Week Foundational Playbook and the future SaaS onboarding

### What TOJ does instead

**Apply the mastery-based framework to `docs/six-week-foundational-playbook.md`:**

1. Assess first — the Foundation Score IS the assessment. Every pilot enters with a scored Foundation before touching any curriculum content.
2. Mastery not seat-time — the playbook's weeks are gated on pillar-move demonstrations, not on time elapsed. If a client hits the Week 1 mastery signal in 2 days, they advance. If they haven't hit it by day 14, they don't move on — Concierge Coach diagnoses the block.
3. Cognitive + creative + personal — every playbook week includes at least one artifact in each category (a decision made, a piece produced, a personal-development commitment).
4. AI-scaffolded per module — Concierge Coach agent runs the per-week check-in in the client's context. Personalized to their pillar state.
5. ZPD-aware — the playbook's next-week move is calibrated to be **one pillar tier above** where the client currently is on that dimension. Not two. Not stay-flat. Exactly one.

### File paths

- Amend `docs/six-week-foundational-playbook.md` — add a mastery-framework preamble explaining the delivery mode
- New skill: `agents/skills/mastery-progression.md` — the ZPD-aware next-move logic Concierge Coach loads
- New goal registry entry: `playbook_week_progression` — done-when a client demonstrates the mastery signal for their current week

### Ship target

Add the mastery-framework preamble by end of August 2026. Full mastery-progression skill by end of September 2026. First cohort using the framework: Q1 2027 alongside the SaaS launch.

---

## Thesis 3 · Spatial Intelligence / What AI WON'T Do Well Yet

### The read

The notes are watching what AI won't do well for the next 2–3 years — visual/spatial reasoning, embodied judgment, high-context human calibration. The interpretation: **positioning "AI leverage, not AI replacement"** — TOJ's roster is designed to keep the essence-level judgment layer human.

### The positioning axiom

**Verbatim for `agents/skills/toj-voice.md` and every client-facing surface:**

> "TOJ builds AI leverage, not AI replacement. The judgment layer stays yours. The pattern layer becomes ours."

### What the roster preserves as human labor for the next 24 months

1. **Every advocacy call.** No AI-generated coach-recommendation, ever. Margin's advocacy pattern (real relationship, real credential) is the ceiling defense.
2. **Every essence-level coaching decision.** Concierge Coach agent presents; Kyron decides. Especially at Premium tier where the client bought Communication + Essence.
3. **Every pillar re-score that changes a client's stated priority.** A pillar dropping 15+ points triggers a Retention Watcher flag AND a Kyron-only conversation, not an auto-produced recovery drop.
4. **Every guarantee refund decision.** Not auto-processed. Kyron reviews the specific case.
5. **Every case-study release.** Not auto-published even after client approval — Kyron reads the final version.

### What this thesis is NOT

- Not "TOJ builds slower than competitors on purpose" — TOJ ships faster on the pattern layer. The judgment layer is where it holds.
- Not "TOJ avoids visual/spatial AI" — TOJ uses visual/spatial AI in cartridges (image quality checks, layout audits) but never for authorship of client-facing artifacts.
- Not a permanent frame — this is a 24-month positioning. When Level 7 (Custom LLM) lands and Essence-level judgment can be embedded reliably in a tuned model, this axiom shifts. Not before.

### File paths

- `agents/skills/toj-voice.md` — add the axiom as a vocabulary lock
- `agents/skills/different-not-better.md` (new, see plan v3) — enforces the axiom in outbound copy

---

## Thesis 4 · D2C — the missing community/status layer

### The read

The notes describe a D2C (direct-to-consumer) future: subscriptions, digital products, private events, brand collaborations, a "grey market for loyal clients." TOJ is D2C-shaped through the concierge tiers — but the **community/status layer is missing**. That's what would keep pilots subscribed past the first year of value delivery.

### The missing surface

TOJ delivers value 1:1 (concierge). Value degrades over time as the client absorbs the framework and stops needing weekly drops. **Retention past year 1 requires belonging + status** — which is exactly what the notes' community-cohort spec addresses.

See `docs/toj-community-cohort-spec.md` for the full spec. This thesis authorizes it — the D2C future TOJ is building requires community + status as the retention floor.

### The 4 D2C surfaces to build (in order)

1. **Subscriptions** — already live (Founding/Core/Premium tiers)
2. **Digital products** — the SOP library, module templates, the podcast-to-book pipeline (Q4 2026+)
3. **Private events** — cohort alumni events, per-vertical retreats (Q2 2027+, gated by cohort program shipping)
4. **Brand collaborations** — Kyron's brand collaborates with adjacent-but-non-competitive brands (Q3 2027+, gated by TOJ having brand equity worth collaborating with)

### The grey market ("for loyal clients")

Not literally grey market. What the notes point at: preferential access for early pilots and Premium-tier alumni:

- Founding-price lock on the SaaS when it launches (already promised in the transition plan)
- First-access to new pillar tools, new agent capabilities
- Founder-price cohort seats
- Alumni-only Slack/community access post-Premium
- Private events invitation

Governance: the alumni-only benefits get named in every Premium contract. Client's benefits vest at 6 months of continuous subscription; forfeit if they churn.

### File paths

- `docs/toj-alumni-benefits.md` (to be written) — the vested-benefits schedule
- Amendments to Premium contract template (CLO owns once hired)

---

## Thesis 5 · Tokens / NFTs as Infrastructure

### The read

The notes reference tokens as **dynamic-permission data containers, not artwork**. The Michelle C prize model is cited: physical exhibition + web3 back-end abstracted from the user. Applied to TOJ: an existing "Certified Operator" pack in commit history could get a hybrid physical-credential + digital-verifiable-provenance layer.

### The position

TOJ does NOT ship an NFT product. TOJ MAY ship a token-backed verification layer for physical credentials at Premium+ tier — where the client benefits (verifiable, portable, non-forgeable) and the technology stays abstract to them.

### The candidate: Certified Operator credential

If revisited (Q3 2027+, low priority), the shape:

- **Physical:** a printed certificate, mailed to the operator, signed by Kyron, with a QR code linking to the digital verification page
- **Digital:** a soul-bound token (non-transferable) minted on a low-cost chain (Base or Polygon), tied to the operator's wallet (created for them via a custodial provider if they don't have one)
- **Verification:** the QR code goes to `tojcampaign.com/verify/{operator-id}` which reads the on-chain state
- **Value to operator:** portable, verifiable proof that a specific individual completed a specific TOJ credential — usable in their own bio, on their site, in outreach

**Explicit exclusions:**
- Not an NFT for sale, trade, or speculation
- Not a JPEG. The token is a data container, not artwork
- Not required for any TOJ tier. Every credential can also be verified through a traditional URL-based lookup
- Not built until the SaaS is post-launch and stable

### Ship gate

- Q3 2027 minimum
- Requires: SaaS stable, Q1 2027 launch behind us, a signed opinion from CLO about non-security, non-scam legal positioning, and Kyron actively wanting to ship it (not obligated to)

### If parked permanently

Fine. The alternative — a plain URL-based verification page + a printed certificate — delivers 80% of the credential's value without any web3 exposure. This thesis exists so it doesn't get forgotten if the model shifts.

---

## Cross-links

- Cohort + community + alumni + status → `docs/toj-community-cohort-spec.md`
- Positioning axiom (AI leverage, not replacement) → `agents/skills/different-not-better.md`
- Mastery-based delivery framework → `docs/six-week-foundational-playbook.md` (amended)
- Vertical adaptation logic → `agents/roles/vertical-positioner.js` (v2 plan) + `agents/skills/vertical-positioner.md`
- Curriculum-per-vertical → `docs/toj-curriculum.md`

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial · 5 theses with go/no-go gates, file paths, ship targets | Claude |
