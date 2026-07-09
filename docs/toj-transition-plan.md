# TOJ Transition Plan — July → August 2026

**Author:** Kyron Cumby, Trail of Joy Management Group, LLC
**Status:** Living document — updated as decisions are made
**Audience:** The four incoming principals (Kyron + three)
**First revision:** July 8, 2026

---

## What's changing

Trail of Joy Management Group moves from a **consultancy that delivers a written Operational Transcript™** to a **platform that installs an operating system** as the deliverable — LMS, SOPs, and workflow software running under three verticals (Personal Brand, Non-profit, Authority) on one shared spine.

The Foundation Score™ + written 72-hour Operational Transcript™ remain the Entry offer. What used to be the Core/Premium engagement becomes a SaaS product installed for the client — a durable subscription instead of a one-time build.

## The four-principal structure

Each principal owns a functional area. The operator sits on top and holds the standard.

| Role | Owner | Commitment | Scope |
|------|-------|------------|-------|
| Operator / Founder | Kyron Cumby | Full-time | Standard, positioning, client-facing brand, top-level product direction |
| Chief Legal Officer | TBD | TBD | Structure, agreements, IP, MSAs, ToS/Privacy, trademark, compliance |
| Chief Revenue Officer | TBD | TBD | Sales motion, pipeline, enterprise accounts, MSA negotiation, comp |
| Chief Product Officer | TBD | Part-time | LMS backbone, SOPs library, SaaS product, engineering choices |

Kyron works full-time. CPO joins part-time (30 days of product spec before writing code). Legal and Revenue commitments TBD.

The structural decision — co-founder (equity + upside), executive (salary + option pool), or advisor (small equity, low commitment) — must be settled in Week 1 because it drives every legal agreement downstream.

## Concierge pricing: three tiers ($99 / $199 / $499)

Phase 1 pilots run August–October at three concierge-MVP price points:

| Tier | Price/mo | What the client gets |
|------|----------|----------------------|
| **Founding** | **$99** | Foundation Score™ + Operational Transcript™ delivered once, monthly check-in, access to the LMS/SOP library as it ships, waitlist priority for the SaaS. Loss-leader that puts real operators inside the tent. |
| **Core** | **$199** | Everything in Founding + weekly deliverable (CSV/campaign/pipeline drop), TOJ team runs one workflow module for them (chosen from CRM cadence, content calendar, or intake automation), quarterly pillar re-score. The sweet spot for the modern network marketer / solo operator ICP. |
| **Premium** | **$499** | Everything in Core + custom SOP build for one operation, monthly working session with Kyron, first-in-line for the full self-serve SaaS with lifetime founding-operator pricing when it ships Q1 2027. |

Price anchors the value story before self-serve SaaS. All three tiers are "concierge" — TOJ runs it manually while the platform gets built. Pilots who upgrade to the real SaaS in Q1 2027 keep their tier pricing for life.

## Launch sequence: Personal Brand + Authority in parallel, Non-profit October

- **August 1**: Personal Brand and Authority go live together as the two proving verticals. Both have committed pilots and existing partners (Sky's The Limit WR, XpandSports, Optimum Grading, CollegeFootballRecruiting.com for Authority; the modern-network-marketer ICP for Personal Brand).
- **October**: Non-profit vertical kicks off — pilots enrolled, engagement rhythm starts, funding-architecture SOPs go live.

Running two verticals from day one is aggressive but justified: the platform underneath is the same, so the marginal cost of the second vertical is copy + a few workflow variations, not a second product build. The risk to name: split attention on operator-facing communication. Kyron holds the standard across both; the CRO owns the pipeline motion of whichever vertical has enterprise-shaped buyers she's closest to.

## Ownership posture: we own the stack

**TOJ builds and owns the SaaS platform.** We are not reselling GoHighLevel, whitelabeling someone else's product, or wrapping a third party. The Chief Product Officer builds; the platform code, the data model, the customer relationship, and the IP all belong to Trail of Joy Management Group.

Rationale:

- Owned SaaS trades at 5–15× ARR at exit; whitelabel-reseller shops trade at 2–4× profit. The valuation delta is the difference between a lifestyle business and a company.
- "The operating system underneath your business" is only a defensible story if we actually built the OS.
- The e-commerce / self-serve motion (v0.1 by Q1 2027) requires a product we can iterate on our own timeline. Vendor platforms can't be shipped on our roadmap.
- Existing tools we already own (routes/csv.js, the Foundation Score intake system) are Module 01 of the platform. We're not starting from zero.

Standard modern owned-SaaS stack (CPO refines):

| Layer | Choice | Notes |
|-------|--------|-------|
| App | Next.js | Modern React framework, hireable, fast |
| Database | Supabase (Postgres) | Owned data, no vendor lock, generous free tier |
| Auth | Clerk or Supabase Auth | Replaceable |
| Payments | Stripe | Industry standard, replaceable |
| Email | Resend or Postmark | Simple owned integrations |
| AI | Anthropic + OpenAI | CPO already fluent |
| Hosting | Vercel + Render | Where we already are |

Existing GHL usage stays scoped to **internal ops** (managing our own funnel, comms, campaigns) — never rebranded to clients as "the platform."

## Runway to v0.1 SaaS: concierge → semi-auto → real

Pilots cannot wait until Q1 2027. Three-phase model that keeps revenue flowing while the platform gets built:

**Phase 1 — Concierge MVP (August–October 2026).** Deliver what the SaaS *will* deliver, but manually behind the scenes. Notion + Airtable + Zapier + the CSV builder + human labor. Charge like a subscription ($99–299/mo per pilot). Cash flows in, product hypotheses get validated, CPO gains a real spec. This is the Airbnb / DoorDash / Stripe pattern at same stage.

**Phase 2 — Semi-automated (October 2026 – January 2027).** CPO ships the first real modules, replacing the most painful manual work — CRM, campaign tracking, follow-up automation, the CSV builder extended into a proper pipeline tool. Existing clients migrate piece by piece. Waitlist emails invited into a private beta.

**Phase 3 — Real self-serve SaaS (Q1 2027).** Platform is real. Self-serve onboarding. E-commerce-style checkout. Freemium tier. New clients start on the platform, not manual. CRO's enterprise motion + self-serve motion both fire at once.

## Personal Brand ICP unlock: the modern network marketer

TOJ's founding thesis — replace door-to-door with modern social/network marketing — is a live positioning we haven't fully claimed yet. The addressable ICP if we do:

- MLM leaders (Amway, Herbalife, Primerica et al. — ~4M active reps in the U.S.)
- Insurance agents (~2M)
- Financial advisors and RIAs (~500K)
- Real estate agents (~1.5M solo/small-team)
- Coaches building downlines
- Fitness / wellness professionals selling programs and supplements

Roughly **8–12 million U.S. operators** running the modern personal-brand + network-marketing motion, whose tooling today is garbage (WhatsApp broadcast, Google Sheets pipelines, copy-pasted DM scripts, no follow-up automation, no analytics). Positioning TOJ Personal Brand as the operating system for this market:

- Doesn't exist elsewhere (no competitor with a real platform for this ICP)
- Matches the founding thesis exactly
- Fits self-serve SaaS pricing ($50–200/mo)
- Sells itself through their networks (this ICP *is* how word spreads)
- Public copy shift: "Network builders, insurance agents, financial advisors, real-estate teams — if your next customer comes through your own network, the Personal Brand operating system was built for you."

Ships on the site as an ICP expansion in the Personal Brand vertical page, not a new vertical. The vertical count stays at three.

## Three verticals, one spine

The product architecture stays exactly as the site describes it: **three doors, one operating system**. The SaaS is the operating system.

- **Personal Brand** — solo operators (trainers, creators, yoga instructors, realtors, barbers, consultants) whose revenue depends on personal reputation and 1-to-1 trust
- **Non-profit** — 501(c)(3) organizations with a program, campaign, or operational need TOJ fulfills as a paid vendor
- **Authority** — athletes, programs, and sport-adjacent creators whose growth depends on documented performance and public credibility

The shared spine — the platform every vertical runs on — is a course-plus-workflow product:

1. **Curriculum modules** — the LMS layer, teaching the operator how to run their vertical's version of the standard
2. **SOP library** — the templated documentation the operator's team follows day-to-day
3. **Workflow automations** — the layer that runs the operator's business in the background (intake, delivery, follow-up, reporting)

The vertical layer changes *which* modules and SOPs surface. The platform is one product.

## Six-week runway to August 1

Dependency-ordered, not calendar-ordered. Some things unlock others.

### Week 1 (July 8–14) — Structure and agreements

1. **Decide the ownership structure.** Co-founder / executive / advisor for each principal. This decision drives everything else.
2. **Have counsel draft** (either the incoming legal principal or an outside firm, depending on 1): amended Operating Agreement, IP Assignment agreements, vesting schedules (4-year with 1-year cliff is standard), confidentiality/NDA templates.
3. **File trademarks** — Operational Transcript™, Foundation Score™, TOJ Campaign, Trail of Joy Management Group. Public use has started; file before revenue materializes.
4. **Ship Terms of Service and Privacy Policy** on tojcampaign.com. Site currently collects email through "3 free ideas" and the Foundation Score intake with neither. Legal exposure.

### Week 2 (July 15–21) — Product definition

5. **Answer the one question**: what does the SaaS do that the 72-hour Transcript doesn't? The Transcript is a snapshot; the SaaS is the ongoing system the client runs their business through. Pick a v0.1 scope.
6. **Define the universal LMS spine** — the shared architecture across all three verticals. Curriculum modules, SOP libraries, workflow automations. Vertical layer changes surface; platform is one product.
7. **Wireframes and stack** — CPO's first deliverable. Data model, auth, hosting, AI features. A spec, not code.
8. **Pilot customers** — 2–3 per vertical, committed in writing before August 1, in exchange for lifetime discount or founder-status pricing.

### Week 3 (July 22–28) — Sales motion and external presentation

9. **CRO territory** — which vertical does she have the strongest existing relationships in right now? She owns that vertical solo. Time Warner Cable → enterprise B2B into captive procurement was her motion; map that to whichever vertical has enterprise-shaped buyers.
10. **Sales collateral** — MSA template, one-pager per vertical, enterprise pitch deck. CRO writes them; she knows what closes.
11. **Site changes** — /team.html for the four principals, /mission.html referencing the new structure, "SaaS launching August 2026 — join the waitlist" strip on each vertical page, consultancy-now / SaaS-August copy update.

### Week 4 (July 29 – August 4) — Rehearsal and go-live

12. **Pilot kickoff meetings** with the 6–9 pilot customers. Expectations set, feedback loops running.
13. **Founder cadence in place** — weekly all-hands, decision log, single source of truth (Notion recommended).
14. **Financial baseline** — payroll or founder distributions, basic accounting in Xero/QuickBooks, bank structure decided.

## Three risks worth naming

**1. The lawyer can't be both counsel-of-record and a beneficial owner** without an ongoing conflict. Either she's outside counsel (paid, no equity), OR she's a co-founder (equity, but her legal work has to be reviewed by outside counsel). Foundational decision — must happen before agreements are signed.

**2. Selling into hotels via Time Warner Cable was a very specific motion** — enterprise B2B into captive procurement pipelines. Selling SaaS to a solo yoga instructor is product-led, low-touch. Selling to a nonprofit board is relationship / RFP / budget-cycle. Selling to a youth athlete's family is parental trust and credential-based. Map the CRO's strengths to the right vertical; don't force her to invent a motion from scratch.

**3. Personal SaaS programs for companies under three verticals is a lot of surface area for v0.1.** Every startup that tried to ship three products in parallel failed. **Pick one vertical to prove the platform in** — probably Authority, since you have the deepest existing network and four Premium Partners already publicly named — then port the platform to the other two verticals once the shape is proven. This is the fastest path, not the slowest.

## Deliverables landing this week (Kyron)

- `docs/toj-transition-plan.md` — this document
- `/team.html` — 4-principal page, skeleton for bios to fill in
- `/terms.html` + `/privacy.html` — functional templates for legal review before publish
- SaaS waitlist strip on all three vertical pages — email capture for August launch
- Consistent ™ notation across the site — Foundation Score™ and Operational Transcript™

None of these commit the business to a particular SaaS scope. They set the stage so when the three principals walk in, the runway is paved.

## Open questions the principals will answer

- **Structure**: co-founder vs executive vs advisor for each of the three
- **Vesting**: standard 4-year, 1-year cliff — confirm
- **Compensation**: equity mix, salaries, sales commission structure
- **Product v0.1 scope**: what does the SaaS do on day one
- **Which vertical proves the platform**: Authority (recommended) or one of the others
- **Pilot customer identities**: 6–9 by name, committed in writing before August 1
- **Legal counsel**: internal principal or outside firm, and what's the ongoing arrangement
- **Trademark filing**: file this week or wait until the OA is signed
- **Fundraising posture**: bootstrapped, revenue-financed, or raise
- **Financial infrastructure**: bank structure, payroll provider, accounting stack

## Change log

- **2026-07-08** — Initial draft written. Structure, timeline, and risks laid out for four-principal review.
- **2026-07-08 (rev.)** — Ownership posture decided: TOJ builds and owns the SaaS platform; no GHL / whitelabel dependence. Concierge → semi-auto → real-SaaS runway added. Personal Brand ICP explicitly expanded to include the modern network-marketing operator (~8–12M U.S. addressable). Waitlist forms wired to owned Express backend at app.tojcampaign.com/api/waitlist.
- **2026-07-08 (rev. 2)** — Locked: **Supabase from day 1** as the SaaS DB (waitlist migrates from JSON to Postgres). **Three-tier concierge pricing** ($99 / $199 / $499). **Dual launch** August 1: Personal Brand + Authority in parallel; Non-profit October. **Kyron full-time; CPO part-time.** Kyron gets first 5 pilots in writing by end of week; 4 more by August 1 target. Personal Brand copy sharpened to name "network marketers building a downline" alongside insurance agents, financial advisors, real-estate teams. Admin dashboard for waitlist + pilots and concierge client portal skeleton shipped. Foundation Score Supabase migration spec written for the CPO.
