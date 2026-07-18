# TOJ Media Roadmap

**Companion to:** `docs/ai-notes-implementation-plan.md` (v3)
**Last updated:** 2026-07-18
**Purpose:** the notes' "be the whole media empire" thesis, converted into a 12–24 month sequence of file paths, agents, and shipped surfaces. TOJcampaign today is static site + concierge delivery. This doc names where it goes and in what order.

---

## The read of where TOJ media is today (July 2026)

- **Owned surfaces:** tojcampaign.com (static + intake), waitlist-warmer email flow (owned via Resend), an early Slack workspace (internal ops)
- **Rented surfaces:** whatever social platforms Kyron is posting on personally — these are distribution, not media assets
- **Missing entirely:** a hosted podcast, a video channel with editorial control, a cohort community platform, an interactive Foundation-Score self-audit tool, any AI-generated video/audio pipeline

**Honest read:** TOJ has a website + an email list + intermittent social presence. It is not a media empire. It is a service business that markets. The gap between where it is and where the notes name is 12–18 months of intentional building, not one sprint.

---

## The media empire — 4 surfaces to build, in order

Each surface answers a question. Each question is one the SaaS-tier client will ask before subscribing. Answer the question, and the sale becomes obvious.

### Surface 01 · Interactive Foundation Score self-audit (Q3 2026)

**Question answered:** "What are the five pillars, and where do I stand?"

**What ships:**
- `routes/foundation-score-audit.js` — the interactive tool (see `docs/toj-distribution-runbook.md` § Lead Magnet)
- `agents/roles/foundation-audit-composer.js` — Draft-tier role that generates result pages
- Public URL: `tojcampaign.com/foundation-audit`

**Time to ship:** 2 weeks (target: end of August 2026, immediately post-launch)

**Why first:** it's the lead magnet AND the media surface AND the demo of the platform's competence. One asset, three jobs.

### Surface 02 · Podcast + YouTube channel — "The Operator's Foundation" (Q4 2026)

**Question answered:** "How do people I respect actually run their businesses?"

**What ships:**
- Podcast: weekly, 30–45 min, interview format with real operators (mix of Personal Brand + Authority + Non-profit ICPs)
- YouTube channel: podcast video cuts + solo short-form + Foundation Score deep-dives per vertical
- Owned RSS + owned upload pipeline (Buzzsprout or Transistor for audio hosting; YouTube for video)
- Show notes on `tojcampaign.com/podcast/{episode-slug}` — SEO surface
- Every episode ends with a specific action ("score your Foundation," "read the transcript spec")

**Time to ship:** 4 weeks setup + first 8 episodes (target: late Oct 2026 launch)

**Editorial standard:** the podcast is under the same voice guardrails as everything else — `agents/skills/toj-voice.md`. No hype opens. No "in today's fast-paced world." Every guest gets a pre-brief from Research Assistant that includes their specific pillar profile.

**Distribution rhythm:** clip the podcast into 4–6 short-form pieces per episode. Content Strategist owns the calendar; Repurpose Producer produces the cuts.

### Surface 03 · Cohort community platform (Q1 2027)

**Question answered:** "Where are the other people building this way?"

See `docs/toj-community-cohort-spec.md` for the full spec. Media-wise:

- Owned community platform (Skool, Circle, or custom on the Next.js stack — CPO decides)
- Per-cohort private space + all-alumni space
- Weekly live sessions (Zoom initially, YouTube Live once the audience justifies)
- Digital products for cohort alumni (SOPs library, module templates, private teardowns)

**Ship target:** Q1 2027, alongside the SaaS launch. Cohort + SaaS launch together — cohort is where SaaS gets sold.

### Surface 04 · Interactive media — games + video (Q3 2027 — speculative)

**Question answered:** "How do I actually feel what a well-Foundation-scored business feels like?"

The notes point at interactive-media futures (games + video in one experience). Speculative for TOJ. Candidate: a browser-based "Run Your Business For a Week" simulator where the operator makes choices per pillar and sees consequences. Educational, not gamified for engagement.

**Not on the 12-month roadmap.** Named here so it doesn't get forgotten. If Q1 2027 SaaS launches successfully and Level 6 → Level 7 (Custom LLM) work advances, this becomes a Q3 2027 build candidate. Otherwise, park.

---

## The 12–24 month timeline

| Month | Milestone | Owning role |
|-------|-----------|-------------|
| Aug 2026 | Static site + audit lead magnet live | Content Strategist |
| Sep 2026 | Content Strategist producing 3–5 organic pieces/week + Repurpose Producer expanding | Content Strategist + Repurpose Producer |
| Oct 2026 | Podcast launch (8-episode drop) + first ad campaigns live post-validation gate | Content Strategist + Ad Teardown Producer |
| Nov 2026 | Podcast weekly cadence + YouTube monetization eligibility (1k subs, 4k watch hours) | Content Strategist |
| Dec 2026 | Cohort community platform stood up (private beta, existing Premium clients) | Concierge Weekly Producer + CPO |
| Q1 2027 | Cohort program public launch + SaaS launch + owned community + first cohort alumni event | Chief of Staff (coordination) |
| Q2 2027 | 2nd cohort program + Cohort Alumni Board convenes + digital products (SOP library) | Cohort program owner (new role, TBD) |
| Q3 2027 | Live event #1 (single-city, 30–50 alumni) + interactive-media pilot (speculative) | Kyron + CPO |

---

## The distribution rhythm — one week

**Monday** — Content Strategist proposes 5 organic hooks (`toj-voice.md` + `content-repurpose.md` loaded)
**Tuesday** — Content Strategist ships 2 pieces (long-form + medium)
**Wednesday** — Podcast recording day (biweekly)
**Thursday** — Content Strategist ships 2 pieces (short-form + micro from Tue's pieces) + Concierge Weekly Producer builds the week's drops
**Friday** — Weekly drops send + Ad Teardown Producer scans for organic winners + Kyron approves ad spend for next week
**Saturday** — Podcast edit + published Sunday 6am
**Sunday** — Podcast + weekly teardown newsletter (long-form recap)

Chief of Staff owns the rhythm. If a day slips, CoS raises it in the evening close-out and Content Strategist rebalances.

---

## Editorial guardrails

- **No LLM-generated content ships unedited.** Every AI-drafted piece runs Humanity Cartridge (≥ 8/10) before Kyron sees it and before it goes public.
- **No content published in a voice that isn't `toj-voice.md`.** Guest posts on TOJ surfaces are exceptions but require a voice-shift note in the byline.
- **No hype opens.** "In today's fast-paced world" · "The future of X" · "Everyone is talking about" — all banned in `toj-voice.md`. Enforced by cartridge.
- **No content that names a client without approval.** Case studies land only after the client has signed the case-study release.
- **No claims that don't trace to retrieval.** Every stat, every result, every quote has a source note in the draft even if it doesn't appear in the published piece.

---

## The AI-generated content thesis

The notes say "90% of ads are going to be AI-generated." TOJ's stance:

- **AI generates variants; humans generate the source idea.** Every organic piece originates from a human observation (Kyron, Content Strategist as a human, a guest, a Premium client). Variants (hooks, cuts, tier-downs) are AI-produced. This preserves editorial credibility while capturing the scale gain.
- **AI never generates the podcast content.** Podcast interviews are 100% human. The AI helps prep (Research Assistant briefs), edit (transcript cleanup), and repurpose (Repurpose Producer clips). AI does not host, guest, or script.
- **AI-generated video/audio (post Q1 2027)** is on the roadmap as a supplementary channel — likely visual explainers of Foundation Score concepts, not client-facing storytelling. Rules TBD when we get there.

---

## Cross-links

- Lead magnet spec → `docs/toj-distribution-runbook.md` § Lead Magnet
- Repurpose Producer role → `agents/roles/repurpose-producer.js` (added in v3 plan)
- Content repurpose method → `agents/skills/content-repurpose.md`
- Positioning axiom → `agents/skills/different-not-better.md`
- Cohort program design → `docs/toj-community-cohort-spec.md`
- Reading list for content producers → `docs/toj-curriculum.md`

---

## Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-18 | Initial · 4 media surfaces, 12–24 month timeline, weekly distribution rhythm, editorial guardrails, AI-content thesis | Claude |
