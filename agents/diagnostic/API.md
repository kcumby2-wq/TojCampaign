# Diagnostic Agents — External Integration API

The Diagnostic agent pack productizes the "$999 Model" — the repeatable AI-tools assessment that turns a 45-minute discovery call into a report and an implementation offer. Same engine and REST surface as the TOJ and Hooks packs, scoped to the diagnostic motion.

See `docs/TOJ-Diagnostic-Offer.md` for the business playbook.

## Base URL

Production: `https://tojcampaign.com/api/diagnostic-agents`
Dev: `http://localhost:3000/api/diagnostic-agents`

## Authentication

Two modes:
- **Session auth** — browser use via the admin UI at `/admin/diagnostic-agents.html`. Cookie-based session.
- **API key** — for external systems and automation. Send `X-Diagnostic-API-Key: <key>`. Set `DIAGNOSTIC_API_KEY` in the Render environment; treat it like the Supabase service role key — never expose it in client code.

## The roles (one per phase of the motion)

| Role id | Label | Phase |
|---|---|---|
| `discovery-analyst` | The Discovery Analyst | Phase 1 — transcript → structured pain inventory (probes, never prescribes) |
| `opportunity-mapper` | The Opportunity Mapper | Phase 2 — inventory → 5-7 opportunities, each on an ROI lever |
| `report-architect` | The Report Architect | Phase 3 — opportunities → six-part client report |
| `offer-strategist` | The Offer Strategist | Post-review — report + 3 answers → tier + email + proposal |
| `pipeline-hunter` | The Pipeline Hunter | Top-of-funnel — target + vertical → outreach that books diagnostics |

## Endpoints

### GET /roles
Public. Returns the role list.

### GET /skills
Public. Returns skill ids (diagnostic-method, roi-levers, tool-research, report-blueprint, offer-ladder, diagnostic-voice).

### POST /run
Authenticated. Submits a task, returns a `run_id` immediately; the agent runs in the background. Poll `/runs/:id`.

**Request body:**
```json
{
  "role": "discovery-analyst",
  "task": "Here is the full discovery-call transcript:\n\n<transcript>",
  "client_id": "optional-uuid-for-a-stored-client"
}
```

Field notes:
- `role` (required) — one of the ids above.
- `task` (required, ≥5 chars) — the transcript, the prior phase's output, or the instruction. The whole motion is chainable: feed the Discovery Analyst's output as the Opportunity Mapper's task, and so on.
- `client_id` (optional) — when present, agents call `retrieve_client_context` to ground the work in that client's stored memory. Aliased as `transcript_client_id` for clarity in automation payloads.

**Response:**
```json
{ "ok": true, "run_id": "uuid", "namespace": "diagnostic" }
```

### GET /runs/:id
Authenticated. Poll for status (`running` | `completed` | `waiting` | `failed`), `output`, `trace`, `usage`, and eval fields.

## Chaining the phases

The four core phases are designed to pipe into each other:

1. `discovery-analyst` ← raw transcript → **Discovery Inventory**
2. `opportunity-mapper` ← Discovery Inventory → **Opportunity Map**
3. `report-architect` ← Opportunity Map → **six-part report**
4. `offer-strategist` ← report + the client's 3 closing answers → **tier + email + proposal**

An orchestrating script (or an autonomous coding agent working on this repo) can run all four back-to-back, polling each to completion before submitting the next. Typical end-to-end wall time: 3-6 minutes for the full chain.

## Automation — running it hands-off

The `/run` endpoint IS the automation seam. Anything that can make an authenticated HTTPS POST can drive the motion without a human clicking the admin button:

- **Scheduled** — a Render cron job (or GitHub Actions on a schedule) fires `pipeline-hunter` weekly to refresh outreach, or runs the full report chain when a new transcript lands in a watched folder / table.
- **Triggered** — a webhook from the notetaker (Fathom, Otter, Fireflies, etc.) posting a finished transcript kicks off `discovery-analyst` → chain automatically; the finished report lands in `agent_runs` for review.
- **Agent-driven** — an autonomous coding/ops agent (Cursor background agent, Devin, an n8n/Make flow, or Anthropic's own agent SDK) holds the `DIAGNOSTIC_API_KEY` and calls the endpoints as tools. The admin UI and the API are the same endpoints, so anything the operator can do by hand, an automation can do headless.

Guardrail: the eval loop (`evals/diagnostic-principles.js`) runs on every output. A run that fails eval three times lands in `waiting` status instead of `completed` — so headless automation never silently ships a weak report. Always gate any auto-send behind `status === "completed"`, and keep client-facing sends (emails, proposals) as drafts for one human review pass.

## Cost (Opus 4.8, rough)

- Discovery Analyst: ~$0.05-0.15 (one transcript in)
- Opportunity Mapper: ~$0.10-0.20
- Report Architect: ~$0.10-0.20
- Offer Strategist: ~$0.05-0.10
- Pipeline Hunter: ~$0.05

Full assessment chain (discovery → report): well under $1 in model cost to produce a report you sell for $999.

## Errors

| HTTP | Error | Meaning |
|---|---|---|
| 400 | `invalid_role` | Role id doesn't exist |
| 400 | `missing_task` | Task empty or < 5 chars |
| 401 | `not_authenticated` | No session AND no valid `X-Diagnostic-API-Key` |
| 404 | `not_found` | run_id doesn't exist |
| 503 | `supabase_unavailable` | Supabase env vars not set |

## Adding a role or skill

Roles: drop a `.js` file in `agents/diagnostic/roles/` with `{ id, label, tagline, skills, persona }`.
Skills: drop a `.md` file in `agents/diagnostic/skills/`; reference it by filename (minus `.md`) in a role's `skills[]`.
Both auto-load on boot. No other code changes needed.
