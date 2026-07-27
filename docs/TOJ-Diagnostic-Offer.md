# The TOJ Diagnostic Offer — Playbook

**What this is:** the productized version of the "$999 Model" AI-tools assessment, reframed so TOJ can sell it at a high level starting now. Hooks is the proof; the same motion runs across all three TOJ verticals.

**Status:** v1 · 2026-07-27 · owner: Kyron
**Runs on:** the `diagnostic` agent pack (`agents/diagnostic/`) + admin console at `/admin/diagnostic-agents.html`.

---

## 0. The one-paragraph pitch

A 45-minute discovery call, an AI notetaker, and a Claude analysis produce a report that names 3-7 tools to reclaim 5-10 hours a week. Worst case the owner gets a free-feeling interview that names their bottlenecks. Best case they buy the build. The diagnostic is $999 (waived if they move to implementation within 7 days). It's the top of a ladder that climbs to a full operating brain — and TOJ already built one for itself, so the proof isn't a promise.

---

## 1. Why now — the reframe

The $999 assessment, as originally sketched, is a **bottom-of-market entry product**. What changed: TOJ built its own operating brain first — the `hooks-os` skills library, the Supabase/GHL automation infrastructure, the master operating agreement, and the live agent stack running at `tojcampaign.com/admin`. That is the difference between selling a report and selling a destination.

**The move:** keep the $999 diagnostic as the top-of-funnel offer, but anchor every call against a much higher tier — the full Operating Brain build — with Hooks as the case study that makes it real. Every diagnostic ends with two doors: "start small (T1)" or "get what Hooks got (T2)."

**The moat nobody else can show:** a versioned skills repo and a live agent console. When a prospect asks "does this actually work," you don't answer — you screen-share.

---

## 2. The offer ladder

| Tier | Product | Price | Maps to |
|---|---|---|---|
| **T0 · Diagnostic** | Operating Brain Diagnostic (the AI-tools assessment) | **$999** (waived if they sign within 7 days) | the 45-min → report → review-call motion |
| **T1 · Foundation** | Process Redesign / Automation Build — 3-5 tools or flows shipped | **$1-5K** | quick wins from the report, built |
| **T2 · Operating Brain** | Full skills library + infra scaffolding + commercial-terms doc | **$15-30K** | the Hooks pattern (skills + infra + contract) |
| **T3 · Concierge** | Ongoing AI operator | **$1,200-3,000/mo** | two calls/mo + Voxer + 12-bh response |

The implementation sub-tiers inside T1/T2 (from the original model): Automation Build ($1-3K), Process Redesign ($3-5K), Custom Workflows ($3-5K), Knowledge Systems ($3K+). Detail lives in `agents/diagnostic/skills/offer-ladder.md`.

**The anchor mechanic:** the diagnostic is priced so it's a no-brainer, but the review call always frames T2 as the destination. Even the 40% who don't buy implementation now have seen what the top of the ladder looks like.

---

## 3. Hooks first — the case study that sells everything else

Before selling this to anyone, the pitch is: *"Here's what a full operating-brain engagement produced."*

What Hooks (Margin Hooks / STL / CBH) got, and what to show:
- **A skills library** — `hooks-os/skills/` — the WHAT: segmentation, recap agent, account-health, renewal, referral, revenue-share, and more.
- **Automation infrastructure** — `hooks-os/infra/` — the HOW: Supabase schema, Edge Functions, GHL workflow specs, the runtime map.
- **A commercial instrument** — the master operating agreement — the WHO-OWNS-WHAT.
- **A live agent console** — `tojcampaign.com/admin/hooks-agents.html` — six operator agents (Grader, Roster Pulse, Recruiter Liaison, NIL Strategist, Parent Communicator, Trainer Blueprint Coach) callable by hand or by API.

**How to use it on a call:** don't share the private repo. Show screenshots of the skills tree and the live agent console. Say: *"This is a full operating brain for one business. Your diagnostic tells us which pieces of this you need first."* The diagnostic becomes the on-ramp to the thing they just saw work.

**Recursive proof for the Authority vertical:** TOJ built its own operating brain before selling one. That's the strongest possible credential — "we run on this."

---

## 4. Per-vertical adaptation

The motion is identical; the pain language and pricing change.

### Football-Trainer vertical (fbtrainer / hooks-os / STL)
- **Target:** independent trainers, $100K-$500K coaching revenue, hitting the solo-operator scaling wall.
- **Discovery hits:** recap cadence, referral-tag discipline, roster health, session capacity, no-show recovery, parent comms.
- **Case study:** Margin Hooks (in-flight). Show the repo + console screenshots.
- **Pricing:** Diagnostic **$999** · Retainer **~$2,500/mo** (high LTV via athlete referrals).

### Small-Business vertical (smallbusiness)
- **Target:** owner-operators $500K-$5M, 3-20 employees, non-technical.
- **Discovery hits:** money-in-the-door visibility, invoice chase, month-end close effort, customer pulse, lead follow-up speed.
- **Case study needed:** pick one smallbusiness pipeline client, offer T1 at half-price in exchange for a written case study. Manufacture the first proof.
- **Pricing:** Diagnostic **$999** · Retainer **~$1,200/mo** (broader, price-sensitive market).

### Authority-Creator vertical (Subject Media / Subject Report)
- **Target:** creators and subject-matter experts, personal-brand businesses $50K-$500K.
- **Discovery hits:** content cadence, brand-voice drift, case-study production, repeated-question load, personal-LLM appetite.
- **Case study:** the TOJ ecosystem itself ("we built our own first").
- **Pricing:** Diagnostic **~$2,500** (creators pay more for premium framing) · Retainer **~$3,000/mo**.

---

## 5. The discovery-call question library (Phase 1)

Probe, don't prescribe. Capture frequency × duration for every pain.

- Walk me through your day yesterday — what do you typically do during a business day?
- What are the tasks in your business that you dread doing?
- Where does your work pile up?
- What have you tried to automate in the past that failed — and why do you think it didn't stick?
- If you could wave a magic wand and delete any one process, what would it be?

Follow-ups that unlock the financial-impact math:
- How often does that happen? How long does it take each time?
- Who does it today? What does an hour of your time (or theirs) cost?
- What breaks when it doesn't get done?

Feed the transcript to the **Discovery Analyst** agent → get a structured pain inventory back.

---

## 6. The report (Phase 3) — what the client pays for

Six parts, built in a Claude Design template (the **Report Architect** agent assembles it):
1. Executive summary — top 3 pains → outcome if implemented.
2. Priority matrix — effort vs impact; quick wins first.
3. Tool recommendations — in-depth, each pointed at a named pain, each `[VERIFY]` priced.
4. Four-day quick-start plan — concrete day-by-day actions.
5. Financial impact — "$X/mo for Y hrs/week," math shown.
6. What comes after quick wins — the high-effort projects, framed as the next engagement.

Review call: screen-share, walk each rec, close with the three questions (most urgent? · DIY or help? · timeline?). Email the report after regardless. The **Offer Strategist** agent turns the three answers into the tier + follow-up email + proposal.

---

## 7. Three scaling moves (approved — build order)

### Move 1 — Package the discovery→report pipeline as an agent pack ✅ (this build)
The `diagnostic` agent namespace does exactly this: transcript in, report out, offer drafted. Delivery time drops from ~3 hours to minutes; the model cost of a full chain is under $1 against a $999 sale. This is the margin engine.

### Move 2 — Re-prioritize acquisition around proof
With Hooks as proof, drop door-knocking to the bottom. Lead with:
- **LinkedIn DMs** to owners of 10-50 employee businesses — a one-line pain question + a link to a Hooks case-study one-pager.
- **AI Meetup / Office Hours** — you have the credibility now.
- **Agency partners** — Nicole first, then accountants/coaches; follow up every 2 weeks.
- **Post your win** — the 3-move Hooks sequence is a 6-post series.
The **Pipeline Hunter** agent drafts all of these.

### Move 3 — Bundle the diagnostic into the retainer sale
"$999 for the diagnostic, OR waived if you sign the retainer within 7 days." Drops friction, pushes conversion past 60%, and retainer LTV dwarfs the one-time fee.

---

## 8. The seven acquisition methods (reprioritized for TOJ)

1. **LinkedIn DMs** — durable flow. Ask about pain, don't pitch.
2. **Post Your Win** — 3-5x/week for 90 days. Document every result.
3. **Agency Partners** — go-to AI referral for coaches/agencies/accountants. Follow up every 2 weeks (start with Nicole).
4. **Free Audits** — from your network; manufactures the first proof + testimonial.
5. **AI Meetup** — host locally; be the expert in the room. (long game)
6. **Office Hours** — free weekly AI office hours at a coworking space.
7. **Door Knock** — the "need a client today" lever; keep it, but it's the floor, not the strategy.

---

## 9. The retainer offer (T3 detail)

**$1,200/mo** (per vertical; see §4 for football/authority pricing):
- Two 45-min calls per month.
- Voxer access between calls.
- 12 business-hour response time.
- Value: $500+/hour of your time.

In-session: set up Claude cowork, build Claude projects per business function, build skills for their existing workflows, ongoing AI concierge.

Premium feel:
- Google Forms onboarding before Call 1 (skip the cold-start interview).
- Named Drive folder with full call recordings.
- One-pager per call: top 3 action items before the next session.

---

## 10. How the agent pack productizes the whole motion

| Phase | Agent role | Input → Output |
|---|---|---|
| 1 · Discovery | `discovery-analyst` | transcript → structured pain inventory (probes, never prescribes) |
| 2 · Analysis | `opportunity-mapper` | inventory → 5-7 opportunities, each on an ROI lever + candidate tool |
| 3 · Report | `report-architect` | opportunities → six-part client report |
| Close | `offer-strategist` | report + 3 answers → tier + follow-up email + proposal |
| Funnel | `pipeline-hunter` | target + vertical → outreach that books diagnostics |

Run them by hand at `/admin/diagnostic-agents.html`, or headless via `/api/diagnostic-agents/run` with `X-Diagnostic-API-Key`. A notetaker webhook can kick off the chain automatically; the eval loop gates every output so a weak report never auto-ships. Full reference: `agents/diagnostic/API.md`.

**Automation path (your Cursor/Devin/scheduler question):** the `/run` endpoint is the seam. Any scheduler (Render cron, GitHub Actions), workflow tool (n8n/Make), or autonomous coding/ops agent (Cursor background agent, Devin, Anthropic Agent SDK) that holds the API key can drive the motion end-to-end without a human clicking a button — because the admin UI and the automation use the exact same endpoints. Keep client-facing sends (emails, proposals) as one-review-pass drafts.

---

## 11. Setup checklist (to go live)

- [ ] Set `DIAGNOSTIC_API_KEY` in the Render environment (treat like the service-role key).
- [ ] Confirm the `agent_runs` + `eval_runs` Supabase tables exist (shared with TOJ/Hooks packs — already live).
- [ ] Build the Claude Design report template so Report Architect output drops straight in.
- [ ] Pick the first smallbusiness client for a half-price T1 → written case study.
- [ ] Draft the Hooks case-study one-pager for LinkedIn outreach (Pipeline Hunter can draft it).
- [ ] Link `/admin/diagnostic-agents.html` from the TOJ Control Tower (fbtrainer repo).

---

*The diagnostic is the door. Hooks is the proof. The agent pack is the margin. The ladder is the business.*
