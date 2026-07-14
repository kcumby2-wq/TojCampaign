# Hooks Agents — External Integration API

The Hooks Agents subsystem exposes a clean REST surface for external systems (Optimum grading platform, CRM, email automation, webhook consumers) to invoke Margin's agent stack programmatically.

## Base URL

Production: `https://tojcampaign.com/api/hooks-agents`
Dev: `http://localhost:3000/api/hooks-agents`

## Authentication

Two modes:
- **Session auth** — for browser-based use (admin UI at `/admin/hooks-agents.html`). Standard cookie-based session.
- **API key** — for external system integration. Send `X-Hooks-API-Key: <key>` header. Set `HOOKS_API_KEY` in the Render environment; treat it like the Supabase service role key — never expose in client code.

## Endpoints

### GET /roles
Public. Returns the list of available Hooks roles.

**Response:**
```json
{
  "roles": [
    { "id": "grader", "label": "The Grader", "tagline": "...", "skills": ["hooks-voice", "hooks-methodology", "athlete-grading-rubric"] },
    { "id": "recruiter-liaison", "label": "The Recruiter Liaison", ... },
    { "id": "roster-pulse", "label": "The Roster Pulse", ... },
    { "id": "nil-strategist", "label": "The NIL Strategist", ... },
    { "id": "parent-communicator", "label": "The Parent Communicator", ... },
    { "id": "trainer-blueprint-coach", "label": "The Trainer Blueprint Coach", ... }
  ]
}
```

### GET /skills
Public. Returns the list of available Hooks skills (voice, methodology, rubrics).

### POST /run
Authenticated. Submits an agent task and returns a `run_id` immediately. The agent runs in the background; poll `/runs/:id` for the result.

**Request body:**
```json
{
  "role": "grader",
  "task": "Grade the athlete based on their latest film upload.",
  "athlete_id": "38ef8efe-47c0-4c67-bfb7-97113d4eeaf0"
}
```

Field notes:
- `role` (required) — one of the ids from GET /roles
- `task` (required) — plain-language instruction. Minimum 5 chars.
- `athlete_id` (optional) — the athlete or trainer id (== client id in the clients table). Aliased as `client_id` for backward compat.

**Response:**
```json
{ "ok": true, "run_id": "b18a...uuid", "namespace": "hooks" }
```

### GET /runs/:id
Authenticated. Poll for run status.

**Response (running):**
```json
{
  "id": "...",
  "role": "grader",
  "client_id": "...",
  "task": "...",
  "status": "running",
  "created_at": "2026-07-14T00:00:00Z",
  "completed_at": null,
  "output": null,
  "trace": null,
  "usage": null,
  "error": null
}
```

**Response (completed):**
```json
{
  "id": "...",
  "role": "grader",
  "status": "completed",
  "output": "ATHLETE: Marcus Jones\nPOSITION: WR / KR\n...",
  "trace": [
    { "type": "tool_use", "name": "get_athlete", "input": { "athlete_id": "..." } },
    { "type": "tool_use", "name": "retrieve_client_context", "input": { ... } },
    { "type": "text", "text": "..." }
  ],
  "usage": { "input_tokens": 5479, "output_tokens": 2803 },
  "created_at": "...",
  "completed_at": "..."
}
```

**Response (failed):**
```json
{ "status": "failed", "error": "descriptive error message", ... }
```

## Poll rhythm

Recommended: poll every 2 seconds. Typical wall time per run:
- Roster Pulse (many tool calls): 60–90s
- Grader / Recruiter Liaison (2–3 tool calls): 30–60s
- Parent Communicator (2 tool calls): 20–45s

Bail out after 3 min if status is still `running` — surface the run_id to a human for review.

## Integration patterns

### Optimum grading platform
On new film upload event → POST /run with role=`grader`, athlete_id=<optimum athlete id> → poll → parse output → PATCH grade back into Optimum. The Grader output is designed for direct field extraction (see `agents/hooks/skills/athlete-grading-rubric.md` for the canonical output format).

### CRM (HubSpot, Zoho, etc.)
On weekly cron → POST /run with role=`roster-pulse` → poll → parse RISING/STALLED/ATTENTION buckets → create tasks in CRM for each. Also, on college coach reply event → POST /run with role=`recruiter-liaison`, task="draft follow-up to [coach name] about athlete [name]" → attach output as draft in CRM.

### Email automation (Mailchimp, Postmark, custom)
On parent-update cron (weekly) → for each active athlete → POST /run with role=`parent-communicator`, athlete_id=<id> → poll → send output as draft to Margin's inbox for review before send. HUMAN REVIEW REQUIRED items (first-time parents, committed athletes) are always draft-only.

### Webhook flow (recommended for external systems)
1. External system POSTs to /run and gets run_id
2. External system polls /runs/:id until status != "running"
3. On completed, external system parses `output` and takes downstream action
4. Optional: log the full trace + usage back to your analytics for cost tracking

## Data model — how athletes / trainers are stored

Hooks uses the shared `clients` table with `vertical` = `"athlete"` or `"trainer"`. This means:

- Insert an athlete → `INSERT INTO clients (email, operator_name, business_name, vertical, tier, metadata) VALUES (...)`
- Athlete's file uploads / notes / evals → `client_documents` (linked by client_id) → auto-embedded into `client_embeddings`
- Retrieval by athlete_id works via the same `match_client_chunks(client_id, query_embedding, k)` RPC as TOJ

Bucketing (prospect / active / on_the_board / committed / signed / trainer) can be stored in `clients.status` or `clients.metadata` — see the Hooks methodology skill for canonical bucket names.

## Rate limits + cost tracking

Every completed run's `usage.input_tokens` and `usage.output_tokens` are stored in `agent_runs`. To bill or cap by consumer, query the table by `created_at` + role + client_id.

Typical cost (Opus 4.8):
- Grader: ~$0.10–0.20
- Recruiter Liaison: ~$0.05–0.10
- Roster Pulse (multi-athlete): ~$0.15–0.30
- Parent Communicator: ~$0.05
- NIL Strategist: ~$0.10
- Trainer Blueprint Coach: ~$0.05

Margin's full weekly ops cadence (Roster Pulse + 5 parent updates + 3 recruiter drafts + 1 NIL eval + 1 grader) runs approximately $0.80–$1.20 per week per athlete cohort. At 30 athletes, that's ~$4-6/week in agent costs to run 90%+ of the operational surface.

## Errors

| HTTP | Error string | Meaning |
|---|---|---|
| 400 | `invalid_role` | The role id doesn't exist |
| 400 | `missing_task` | Task is empty or under 5 chars |
| 401 | `not_authenticated` | No session cookie AND no valid X-Hooks-API-Key header |
| 404 | `not_found` | run_id doesn't exist |
| 500 | `<error message>` | Look at the response error string; check Render logs |
| 503 | `supabase_unavailable` | SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var not set |

## Adding a new role or skill

Roles: drop a `.js` file in `agents/hooks/roles/` with `{ id, label, tagline, skills, persona }`.
Skills: drop a `.md` file in `agents/hooks/skills/`. Reference it by filename (minus `.md`) in any role's `skills[]`.

Both are auto-loaded on server boot. No code changes elsewhere.
