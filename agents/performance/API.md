# Performance Agents — External Integration API

The Performance agent pack is the runtime layer of `performance-os` (github.com/kcumby2-wq/performance-os) — the recruiting-fog-reducer product line. Same engine and REST surface as the TOJ, Hooks, and Diagnostic packs, scoped to the wearable-performance-data motion.

See `performance-os/README.md` and `performance-os/product/subscription-tiers.md` for the business context.

## Base URL

Production: `https://tojcampaign.com/api/performance-agents`
Dev: `http://localhost:3000/api/performance-agents`

## Authentication

Two modes:
- **Session auth** — browser use via the admin UI at `/admin/performance-agents.html`. Cookie-based session.
- **API key** — for external systems + automation (PlayerData webhooks, Pylon event ops software, headless post-event batch runs). Send `X-Performance-API-Key: <key>`. Set `PERFORMANCE_API_KEY` in the Render environment; treat it like the Supabase service role key — never expose it in client code.

## The roles (one per phase of the motion)

| Role id | Label | Phase |
|---|---|---|
| `session-report-generator` | The Session Report Generator | Post-session — one session's data → athlete-facing recap (6h SLA) |
| `coach-scout-reporter` | The Coach Scout Reporter | On-demand + monthly — session history → 90-second coach-facing one-pager |
| `progress-tracker` | The Progress Tracker | Monthly cadence — 30 + 90-day sessions → monthly scout report (subscription retention anchor) |
| `event-coordinator` | The Event Coordinator | Pre-event → day-of → 24h post-event distribution (Event Company tier) |
| `device-reliability` | The Device Reliability Steward | Zero-out triage · fit-check protocols · reliability rollups (internal ops) |

## Endpoints

### GET /roles
Public. Returns the role list.

### GET /skills
Public. Returns skill ids (performance-method, performance-voice, position-fluency).

### POST /run
Authenticated. Submits a task, returns a `run_id` immediately; the agent runs in the background. Poll `/runs/:id`.

**Request body:**
```json
{
  "role": "coach-scout-reporter",
  "task": "Athlete: [athlete name], WR, [grad year]. Trailing 90 days: <session list>. Benchmarks: <band data>.",
  "client_id": "optional-athlete-uuid"
}
```

Field notes:
- `role` (required) — one of the ids above.
- `task` (required, ≥5 chars) — the session data, the athlete profile, or the coordination context.
- `client_id` (optional) — the athlete uuid; when present, agents call `retrieve_client_context` to ground the output. Aliased as `athlete_id` for automation payloads.

**Response:**
```json
{ "ok": true, "run_id": "uuid", "namespace": "performance" }
```

### GET /runs/:id
Authenticated. Poll for status (`running` | `completed` | `waiting` | `failed`), `output`, `trace`, `usage`, and eval fields.

## Chaining the roles

The performance motion typically fires in this order per event:

1. `event-coordinator` (MODE 1 pre-event plan) ← event booking → **Pre-event coordination checklist**
2. `event-coordinator` (MODE 2 post-event distribution list) ← event end → **Ordered distribution timeline**
3. `session-report-generator` (× N athletes, parallel) ← individual session data → **Athlete-facing recaps**
4. `coach-scout-reporter` (× N opted-in athletes, parallel) ← athlete + session history → **Coach-facing one-pagers**
5. `event-coordinator` (MODE 3 event summary) ← aggregate cohort data → **Anonymized event summary for operator**
6. `device-reliability` (as needed) ← zero-out incidents → **Root-cause + parent follow-up plans**

For monthly cadence per subscriber:

1. `progress-tracker` ← athlete + trailing 30/90 day sessions → **Monthly scout report**
2. `coach-scout-reporter` (if athlete has ≥3 sessions) ← athlete + session history → **Refreshed coach-facing one-pager**

## Automation — running it hands-off

The `/run` endpoint IS the automation seam:
- **Post-event batch** — a script iterates over an event's covered athletes, fires session-report-generator + coach-scout-reporter for each, waits for all completions, then fires event-coordinator MODE 3. Full 25-athlete event = ~$5-8 in model cost, well inside the Event Company tier margin.
- **Monthly cron** — a Render cron job runs on the 1st of each month, iterates over active Individual-tier subscribers, fires progress-tracker for each.
- **PlayerData webhook** — when a session lands (if PD API exposes a completion event), fire session-report-generator automatically.
- **Zero-out escalation** — device-reliability triggers from a Supabase realtime subscription on `device_events` where `data_status = 'zero_out'`.

The eval loop (`evals/performance-principles.js`) runs on every output. A run that fails eval three times lands in `waiting` status — headless automation never silently ships a weak report. Always gate any auto-send behind `status === "completed"` and keep parent-facing sends (subscription CTAs, coach-facing distributions) as one-review-pass drafts.

## Cost (Opus 4.8, rough)

- Session Report Generator: ~$0.05-0.10 (one session in)
- Coach Scout Reporter: ~$0.10-0.20 (session history + benchmark lookup)
- Progress Tracker: ~$0.15-0.25 (30+90-day session history)
- Event Coordinator: ~$0.05-0.15 per mode
- Device Reliability: ~$0.03-0.05 per incident

Full 25-athlete post-event chain (session reports × 25 + coach one-pagers × 25 + event summary): approximately **$5-8 in model cost** against a per-event revenue potential of $1-5K + subscription conversions.

## Errors

| HTTP | Error | Meaning |
|---|---|---|
| 400 | `invalid_role` | Role id doesn't exist |
| 400 | `missing_task` | Task empty or < 5 chars |
| 401 | `not_authenticated` | No session AND no valid `X-Performance-API-Key` |
| 404 | `not_found` | run_id doesn't exist |
| 503 | `supabase_unavailable` | Supabase env vars not set |

## Adding a role or skill

Roles: drop a `.js` file in `agents/performance/roles/` with `{ id, label, tagline, skills, persona }`.
Skills: drop a `.md` file in `agents/performance/skills/`; reference by filename (minus `.md`) in a role's `skills[]`.
Both auto-load on boot. No other code changes needed.

## Data model handshake

Long-term, this pack reads from the Supabase schema documented in `performance-os/product/data-model.md`:
- `athletes` — subject
- `sessions` + `session_metrics` — captured data
- `events` — where sessions happen
- `benchmarks` — percentile bands per position × age tier
- `reports` + `report_shares` — generated artifacts + view analytics
- `devices` + `device_events` — chain-of-custody

Until that schema lands (pending first paid Individual-tier subscriber per `performance-os/infra/README.md`), the pack operates on task-payload inputs — the operator or automation caller passes the session data in the task body.
