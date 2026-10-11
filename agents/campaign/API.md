# Campaign pack — deal graph + campaign agents

One versioned record of every deal term per campaign (parties, prices, splits, fees, dates, obligations, disclosures). Documents are checked against it. People approve every change.

Admin page: `/admin/campaign.html`. API: `/api/campaign/*`.

## Setup (once)

1. Apply `db/migrations/015_campaign_deal_graph.sql` to the database. It creates schema `deal` and touches nothing in `public`.
2. Set `CAMPAIGN_DATABASE_URL` on the server. This is the Postgres connection string from Supabase: Project Settings → Database. Until it is set, the routes answer `503 campaign_db_not_configured`.
3. Open `/admin/campaign.html` as staff and click **Create workspace**. You become the owner of the Trail of Joy workspace.
4. Add members with `POST /api/campaign/tenants/:tid/members {email, role}`. Roles:
   - `owner`: everything, including members
   - `approver`: approves versions, decides approvals, waives blockers
   - `editor`: proposes, adds documents, runs agents, marks findings fixed
   - `viewer`: reads

Who can reach `/api/campaign` at all is decided by the staff check (`utils/staff.js`). Which campaigns each person sees is decided by membership.

## How changes happen

- **Facts change only through versions.** Each campaign has at most one open version at a time. Proposals add to the open version, or start a new one if none is open.
- **Approval:** only an owner or approver can approve, and only as themselves. A version can't be approved while a blocker finding on it is open. Once approved, a version is final, and its facts can't be edited or deleted. A later version supersedes it.
- **Findings:**
  - Agents raise findings; only members resolve them, as themselves.
  - Waiving a blocker needs an owner or approver.
  - Once resolved, a finding is final.
- **Outbound messages** can't be marked approved or sent without an approved approval for that exact message. Whoever asked for the approval can't decide it.

The database enforces all of this with triggers in migration 015, not just the app. "Who is acting" comes from the `deal.actor` setting, which the server sets per transaction.

## Agents

| Role | Reads | Writes (staged) |
|---|---|---|
| `consistency` | overview, graph, diff, document, voice check, open findings | claims, findings |
| `intake` | overview, graph, document | claims, fact proposals (`proposed`/`hypothetical` only) |

- **Bound to one campaign:** tools are built per run and bound to the run's campaign. The model never names a tenant or campaign.
- **Writes are staged:** they're saved only from the attempt that passes the eval (`evals/campaign-principles.js`). A retried attempt leaves nothing behind. If the eval fails after 3 tries, the run lands in `waiting` and nothing is saved; what it would have saved stays on the run for review.
- **No approvals:** no agent tool approves anything, and the database refuses an `agent:*` actor.

Start a run with `POST /api/campaign/campaigns/:id/agents/run {role, version_id, task?}`, then poll `GET /api/campaign/agent-runs/:id`.

## What never goes in

No athlete or family records, and no minor's name. Contacts are partner staff only.
