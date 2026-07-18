# Skill: Content Repurpose

Purpose: turn one organically-validated piece of content into a coordinated stack of assets across surfaces — long-form, medium, short, micro — that all carry the same idea in cartridge-passing form. This is the notes' HeyGen / NotebookLM / Pinterest / Cap Genius pattern, converted into a TOJ skill.

## When to load

- **Repurpose Producer** (`agents/roles/repurpose-producer.js`) — as its primary skill
- **Content Strategist** — when planning a week's content calendar around a source piece

## The tier-down stack

Every source piece (a validated original — see the "organic threshold" section of `docs/toj-distribution-runbook.md`) produces four downstream tiers:

| Tier | Format | Length | Owning surface |
|------|--------|--------|----------------|
| **T1 · Long-form** | Blog post, newsletter, YouTube long, podcast episode | 800–2,000 words / 8–15 min | tojcampaign.com blog + Substack + YouTube + podcast RSS |
| **T2 · Medium** | LinkedIn post, IG carousel, X thread | 200–400 words / 6–10 panels | Owned social |
| **T3 · Short** | Reels, TikTok, YouTube Short | 30–60 seconds | Owned social short-form |
| **T4 · Micro** | Single-image quote card, tweet, thread starter | < 30 words | Owned social micro |

**Rule:** all four tiers must ship for a validated source piece. If any tier is skipped, log the reason in `docs/repurpose-log.md` — skipping without a reason is a spec fail.

## The hook lock

Every tier uses the SAME hook for the first 3–5 seconds (or first line). Hook = the sentence that opens the source piece if it passed cartridges.

- Same hook creates recognition across surfaces
- Same hook lets Ad Teardown Producer swap in variant hooks per format from a known baseline
- Same hook makes A/B testing meaningful (you know the variable that changed)

## The 4-in-1 asset production sequence

For each source piece, produce assets in this order (each step gates the next):

### Step 1 — Extract the hook and the arc

Repurpose Producer reads the source piece. Extracts:

- **The hook** (1 sentence, ≤ 12 words)
- **The arc** (3–5 beats: setup → observation → turn → directive → close)
- **The evidence** (what specific example, stat, or quote anchors the piece)
- **The one-thing-to-do** (the directive the reader should walk away with)

### Step 2 — Long-form (T1)

If the source is already long-form, T1 is done — the source IS T1.

If the source is medium (like a LinkedIn post that outperformed), expand:
- 800–1,500 word blog post
- Adds a Foundation-Score angle (which pillar does this insight touch?)
- Adds a specific TOJ CTA at the end (audit, transcript, tier)

### Step 3 — Medium (T2)

For carousel / thread:
- Panel 1 = hook (exactly the hook, no adaptation)
- Panels 2–3 = observation + example
- Panels 4–5 = turn (the "here's what's underneath" pivot)
- Panels 6–7 = directive (the specific action)
- Panel 8 = CTA to T1

For LinkedIn post:
- Hook line 1
- Setup + observation lines 2–4
- Turn line 5
- Directive lines 6–7
- CTA line 8 → link to T1

### Step 4 — Short (T3)

30–60 second video script:
- 0–3s: hook (same words)
- 3–15s: observation with 1 concrete example
- 15–30s: turn
- 30–45s: directive
- 45–60s: CTA to T1

Repurpose Producer produces the script; a human (Kyron or contractor) records unless AI video pipeline is deployed (Q3 2027+).

### Step 5 — Micro (T4)

3 variants for A/B:

1. **Quote card** — the hook + attribution (© TOJ) as an image
2. **Tweet variant** — the hook + a 1-line consequence
3. **Thread starter** — the hook + "here's the one-thing-to-do" (1 tweet reveal, thread doesn't unroll further)

## Cartridge gating

Every tier runs the applicable cartridge before publish:

- T1 → Humanity + Marketing
- T2 → Humanity + Marketing
- T3 → Humanity (audio script) + Marketing
- T4 → Humanity + Marketing (short-form Marketing = hook strength)

Any tier failing at cartridge → returned to Repurpose Producer for revision. Ships when 27+/30 (per `docs/ai-notes-implementation-plan.md`).

## Scheduling

Repurpose Producer proposes a schedule. Default cadence for a single source piece:

- **T1** — day 0 (publish day)
- **T2 · LinkedIn + IG** — day 1
- **T2 · X thread** — day 2
- **T3 · IG Reel** — day 3
- **T3 · TikTok** — day 4
- **T3 · YouTube Short** — day 5
- **T4 · quote card + tweet** — day 6
- **T4 · thread starter** — day 7

7 days, 8 assets, one source piece. Chief of Staff wraps the weekly review of what shipped.

## Rules

- Never ship a tier that lost the hook. If the hook shifted, the tier is no longer part of this stack.
- Never invent evidence for a tier. Every tier uses the same evidence as the source.
- Never repurpose a source that failed cartridges. If T1 was under 27/30, don't build T2–T4 — fix T1 first.
- Never skip cartridge gating on shorter tiers because "it's just a tweet." Short-form is where voice slips.
- Never publish T4 before T1 has shipped (T4 assumes reader-recognition of T1's context).

## Anti-patterns

- Using AI to rewrite T2 in "a more social-media voice" — voice is voice; there is only `toj-voice.md`
- Producing 4 tiers of an unvalidated source piece — organic validation is the gate
- Missing the CTA in any tier — every tier lands somewhere in the funnel

## Fallback when data is missing

If a source piece's engagement data isn't reliable (was posted less than 5 days ago), delay tier-down production. Do not tier-down a piece before its own organic-validation window closes.

---

**References:** `docs/toj-distribution-runbook.md` § tier-down content pattern; `docs/toj-media-roadmap.md` § distribution rhythm; `agents/roles/content-strategist.js` (feeds source pieces); `agents/roles/ad-teardown-producer.js` (parallel workflow for paid).
