# Foundation Score → Supabase migration spec

**Audience:** Chief Product Officer (incoming, part-time).
**Author:** Kyron Cumby (Founder). Assisted draft by Claude.
**Purpose:** Move the Foundation Score™ intake system from a client-side
sessionStorage + email-drop flow to a Supabase-backed pipeline that
seeds the Concierge tier client portal, the pilot tracker, and eventually
the real self-serve SaaS.
**Status:** Living spec. Refine as v0.1 crystallizes.

---

## What exists today

Three vertical-specific intake pages that all follow the same 4-step
scaffold with sessionStorage autosave:

- `public/foundation-score-personal-brand.html` — clay accent, ~8 minute intake
- `public/foundation-score-nonprofit.html` — pine accent, ~10 minute intake
- `public/foundation-score-authority.html` — navy/dark accent, ~12 minute intake

Each has:
- A four-step progress bar and per-step review
- `sessionStorage` autosave under a per-vertical `STORAGE_KEY`
- A success state on final submit (currently client-side only)
- No backend delivery — Kyron reads intake responses out-of-band today

The intake is the on-ramp. Everything downstream (the Transcript, the
tier proposal, the client portal, the pilots tracker) depends on this
intake actually landing in a database.

## What v0.1 has to do

1. **Persist every intake submission** into Supabase `public.foundation_scores`.
2. **Create or link a `clients` row** for the operator so downstream systems
   (portal, pilot tracker, deliverables log) can attach.
3. **Notify the TOJ team** so a Transcript can be authored inside 72 business hours.
4. **Preserve the existing UX** — no visual redesign, no additional friction.
   sessionStorage autosave stays as it is.

Everything past step 1 can ship on top later. Step 1 is the wedge.

## Data model (already in migrations/001_initial_schema.sql)

```
clients                foundation_scores           deliverables
--------               -----------------           ------------
id (uuid)      ◄────── client_id (fk)              client_id (fk)
auth_user_id           vertical                    kind
business_name          intake_payload (jsonb)      title
operator_name          intake_version              file_url
email                  submitted_at                delivered_at
vertical               pillar_scores (jsonb)       delivered_by
tier                   transcript_url
monthly_price_usd      transcript_delivered_at
status (pilot/active)  proposal_tier
onboarded_at           proposal_url
```

Row-Level Security is on. Clients only see rows where
`client.auth_user_id = auth.uid()`. The service_role key (used by the
Express backend) bypasses RLS for admin operations.

## Backend flow — Phase 1 (concierge, this month)

The Express backend on Render already collects intake responses via a
route in `routes/intake.js` (currently JSON-file-backed). Migrate that
to Supabase-first with JSON fallback, exactly the pattern
`routes/waitlist.js` now uses.

### Endpoint 1: submit intake

```
POST /api/intake/foundation-score
body:
  vertical: 'personal-brand' | 'nonprofit' | 'authority'
  intake_version: 'v1' (constant for now)
  payload: { ... whatever the intake collected ... }
  contact_email: string     (from step 4 of every intake)
  operator_name: string
  business_name: string
returns:
  { ok, foundation_score_id, client_id }
```

Server logic:
1. Validate email + vertical.
2. `upsert` into `clients` by email:
   ```
   insert into clients (business_name, operator_name, email, vertical,
                        tier, monthly_price_usd, status)
   values (..., ..., ..., ..., 'founding', 99, 'pilot')
   on conflict (email) do update set
     business_name = excluded.business_name,
     operator_name = excluded.operator_name,
     updated_at = now()
   returning id;
   ```
3. Insert the intake row:
   ```
   insert into foundation_scores (client_id, vertical, intake_payload,
                                  intake_version, submitted_at)
   values (:client_id, :vertical, :payload::jsonb, 'v1', now())
   returning id;
   ```
4. Fire a notification to TOJ (`hello@tojcampaign.com`) via the existing
   `nodemailer` config — a plain text summary + a link to the row in
   Supabase table editor.
5. Return `{ ok, foundation_score_id, client_id }` to the client.

### Endpoint 2: TOJ team uploads the finished Transcript

```
POST /api/intake/transcript
body:
  foundation_score_id: uuid
  transcript_url: string (link to PDF in Supabase Storage or Google Drive)
  pillar_scores: { brand_identity, operational_health, revenue_architecture,
                   content_credibility, growth_readiness } — each 0–100
  proposal_tier: 'founding' | 'core' | 'premium'
  proposal_url: string (link to signed proposal PDF)
returns:
  { ok }
```

Session-authed. Sets `transcript_delivered_at = now()`.

### Endpoint 3: client-side hydration

```
GET /api/client/me
returns:
  {
    email, operator_name, business_name, vertical, tier, status,
    transcript: { transcript_url, pillar_scores, ... } | null,
    deliverables: [ { kind, title, file_url, delivered_at }, ... ]
  }
```

Session-authed. Returns everything the `/client.html` portal needs to
hydrate. The portal already has the shape wired in (see the `boot()` fn
in `public/client.html`); wiring this endpoint completes the flow.

## Frontend flow — Phase 1

Only one file change per intake page:

```js
// existing: final submit → sessionStorage cleanup + success screen
// new: also POST to /api/intake/foundation-score before showing success

async function submitIntake() {
  const payload = collectAllSteps();     // already exists
  try {
    const r = await fetch(
      'https://app.tojcampaign.com/api/intake/foundation-score',
      { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vertical: 'personal-brand',   // per page
          intake_version: 'v1',
          payload,
          contact_email: payload.contact_email,
          operator_name: payload.brand_name,
          business_name: payload.business_name,
        })
      }
    );
    const out = await r.json();
    if (out.ok) {
      // store id for reference on the success screen
      sessionStorage.setItem('toj-fs-last-id', out.foundation_score_id);
      showSuccess();
      sessionStorage.removeItem(STORAGE_KEY);   // already exists
    } else {
      showError(out.error);
    }
  } catch (e) {
    // Network trouble — do not clear autosave; let them retry.
    showError('network');
  }
}
```

Everything else — the four-step scaffold, autosave, review step, success
screen — stays as it is.

## Backend flow — Phase 2 (semi-automated, Q4 2026)

- The service_role backend starts calling AI to draft the pillar scores +
  initial Transcript from the intake payload. Kyron reviews and finalizes,
  same 72-business-hour SLA.
- The `deliverables` table starts filling automatically as workflow
  modules ship (CSV drops, campaign launches, SOP releases).
- Supabase Realtime pushes a toast to the client portal when a new
  deliverable lands.

## Backend flow — Phase 3 (self-serve SaaS, Q1 2027)

- The intake becomes AI-guided (multi-turn conversation instead of a
  fixed 4-step form).
- Payment happens at intake completion via Stripe. Tier is chosen at
  checkout (Founding / Core / Premium).
- Portal auto-provisions after payment succeeds.
- Transcript is drafted in minutes, not 72 hours, with a human review
  step for the Premium tier only.

## Migration order (dependencies)

1. **Supabase creds live** (see `docs/supabase-setup.md`).
2. **Run migration 001** — schema exists.
3. **Refactor `routes/intake.js`** to the pattern in `routes/waitlist.js`
   (Supabase-first, JSON fallback).
4. **Wire the three intake pages** to POST to
   `/api/intake/foundation-score`. Keep sessionStorage autosave.
5. **Ship `POST /api/intake/transcript`** for the TOJ team to record
   completed Transcripts.
6. **Ship `GET /api/client/me`** to hydrate the portal.
7. **Onboard the first pilot** and walk the full loop end-to-end:
   intake → row appears in Supabase → notification → Kyron writes the
   Transcript → team uploads it → pilot logs into `/client.html` and sees
   the Transcript.

Steps 1–2: Kyron (15 min per `docs/supabase-setup.md`).
Steps 3–6: CPO. Estimate 20–30 hours of work, part-time over 2–3 weeks.
Step 7: Kyron + CPO together, one working session.

## Success criteria for v0.1

- Every intake submission lands in `foundation_scores` with a linked
  `clients` row, verifiable via the admin dashboard.
- The team can upload a Transcript + pillar scores via one endpoint.
- A pilot with `auth_user_id` set can log into `/client.html` and see
  their tier, Transcript link, pillar scores, and deliverables list.
- No visual regression on the three intake pages.
- The JSON fallback keeps working if Supabase creds are ever misconfigured
  (defense-in-depth).

## Non-goals for v0.1

- Not migrating the CSV builder, brand-pulse, analytics, or other Express
  routes to Supabase yet.
- Not building an AI-drafted Transcript pipeline yet (Phase 2).
- Not building payment / Stripe yet (Phase 3).
- Not building notifications past a single email to hello@ (Phase 2).

## Open questions for the CPO

- Should intake payloads be schemaless jsonb (current spec) or move to
  per-field columns in v1? Recommendation: keep jsonb until the intake
  shape stops changing. Migrate to columns when the schema is stable
  (Phase 2).
- Auth: reuse the existing Express session, or move clients to Supabase
  Auth (magic-link / OAuth) immediately? Recommendation: Supabase Auth
  from day one. The Express session stays for internal admin (Kyron).
  Clients get Supabase Auth via a passwordless magic-link flow.
- Should the `/client/me` endpoint sit on Render (Express) or on Vercel
  (serverless function)? Recommendation: Render for now, port to Vercel
  Edge Functions in Phase 2 for latency.

## Timeline anchor

Live on August 1 with **at least Steps 1–4 complete** (intake writes to
Supabase, sessionStorage still works, admin can see rows). Steps 5–6 land
by August 15 so the first pilot has a working portal. Everything else
follows the Phase 2/3 cadence in `docs/toj-transition-plan.md`.
