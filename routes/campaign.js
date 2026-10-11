// Campaign deal graph API — staff only, and only within tenants you belong to.
//
// Mounted at /api/campaign behind requireStaff (server.js). On top of that,
// every campaign route checks the signed-in email's membership in the
// campaign's tenant (deal.members). The database enforces the rest:
// approvals, member changes, finding resolution (migration 015).
//
//   GET  /roles                              campaign agent roles
//   GET  /me                                 tenants you belong to
//   POST /bootstrap                          first tenant, you as owner
//   POST /tenants/:tid/members               add/change a member (owner)
//   GET  /campaigns                          campaigns you can see
//   POST /campaigns                          { tenant_id, name }
//   GET  /campaigns/:id                      overview: versions, documents, findings
//   GET  /campaigns/:id/graph?version=N      facts at a version
//   GET  /campaigns/:id/diff?from=&to=       what changed
//   POST /campaigns/:id/facts                propose changes { summary, set, remove }
//   POST /campaigns/:id/documents            { kind, title, audience, origin, body }
//   POST /documents/:docId/versions          { body, graph_version? }
//   POST /graph-versions/:vid/approve        owner/approver
//   POST /graph-versions/:vid/discard        drop the open proposal
//   POST /findings/:fid/resolve              { status: fixed|waived, note }
//   POST /campaigns/:id/agents/run           { role, version_id?, task? }
//   GET  /agent-runs/:id                     poll a run
//
// Logs carry ids, never identities or document text.

const express = require("express");
const { withActor } = require("../utils/campaign-db");
const data = require("../agents/campaign/data");

const router = express.Router();

const WRITERS = new Set(["owner", "approver", "editor"]);
const DOC_KINDS = new Set(["agreement", "schedule", "addendum", "letter", "model", "deck", "plan", "page", "email", "playbook"]);
const AUDIENCES = new Set(["internal", "partner", "counsel", "family", "public"]);
const MAX_BODY = 500000;

// The orchestrator is loaded lazily (and swappable in tests) so the API can
// boot without an Anthropic key.
let runAgentImpl = null;
function runAgent(args) {
  if (!runAgentImpl) runAgentImpl = require("../agents/campaign/orchestrator").runAgent;
  return runAgentImpl(args);
}
router._setRunAgent = (fn) => {
  runAgentImpl = fn;
};

function me(req) {
  return String(req.session.userEmail || "").trim().toLowerCase();
}

// Map errors to responses. Database gate refusals (raise exception → P0001)
// and check violations are the caller's problem (409/400), not ours (500).
function fail(res, e, where) {
  if (e && e.code === "campaign_db_not_configured")
    return res.status(503).json({ error: "campaign_db_not_configured" });
  if (e && e.code === "bad_input") return res.status(400).json({ error: "bad_input", reason: e.message });
  if (e && e.code === "P0001") return res.status(409).json({ error: "refused", reason: e.message });
  if (e && ["23514", "23502", "22P02", "23503", "23505"].includes(e.code))
    return res.status(400).json({ error: "invalid", reason: e.code === "23505" ? "already exists" : e.message });
  console.error(`[campaign] ${where} failed:`, e && e.message);
  return res.status(500).json({ error: "server_error" });
}

// Membership for a campaign: { tenant_id, campaign_id, role } or null.
async function campaignAccess(c, email, campaignId) {
  if (!data.isUuid(campaignId)) return null;
  const { rows } = await c.query(
    `select c.tenant_id, c.id as campaign_id, m.role
       from deal.campaigns c
       join deal.members m on m.tenant_id = c.tenant_id and m.email = $2
      where c.id = $1`,
    [campaignId, email]
  );
  return rows[0] || null;
}

function scopeOf(a) {
  return { tenant_id: a.tenant_id, campaign_id: a.campaign_id };
}

// Run fn with access to one campaign, or refuse with 404 (not found or not yours —
// the same answer, so ids can't be probed).
function withCampaign(req, res, campaignId, { write = false } = {}, fn) {
  const email = me(req);
  return withActor(email, async (c) => {
    const a = await campaignAccess(c, email, campaignId);
    if (!a) return { http: 404, body: { error: "not_found" } };
    if (write && !WRITERS.has(a.role)) return { http: 403, body: { error: "read_only_member" } };
    return fn(c, a);
  });
}

// Handlers return either data, or { http, body } for a refusal.
function send(res, out) {
  if (out && out.http) return res.status(out.http).json(out.body);
  return res.json(out);
}

// ---- Roles and tenants -------------------------------------------------------

router.get("/roles", (_req, res) => {
  try {
    res.json({ roles: require("../agents/campaign/orchestrator").listRoles() });
  } catch (e) {
    fail(res, e, "roles");
  }
});

router.get("/me", async (req, res) => {
  const email = me(req);
  try {
    const tenants = await withActor(email, async (c) =>
      (await c.query(
        `select t.id, t.slug, t.name, m.role from deal.members m join deal.tenants t on t.id = m.tenant_id
          where m.email = $1 order by t.created_at`,
        [email]
      )).rows
    );
    res.json({ email, tenants });
  } catch (e) {
    fail(res, e, "me");
  }
});

// First tenant only: whoever bootstraps it becomes its owner.
router.post("/bootstrap", async (req, res) => {
  const email = me(req);
  const slug = String(req.body?.slug || "toj").trim().toLowerCase();
  const name = String(req.body?.name || "Trail of Joy").trim();
  try {
    const out = await withActor(email, async (c) => {
      await c.query("lock table deal.tenants in exclusive mode");
      const n = (await c.query("select count(*)::int as n from deal.tenants")).rows[0].n;
      if (n > 0) return { http: 409, body: { error: "already_bootstrapped" } };
      const t = (await c.query(
        "insert into deal.tenants (slug, name) values ($1, $2) returning id, slug, name", [slug, name]
      )).rows[0];
      await c.query(
        "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, 'owner', $2)", [t.id, email]
      );
      await c.query(
        "insert into deal.packs (tenant_id, name, voice) values ($1, 'TOJ Pack', $2)",
        [t.id, JSON.stringify({ banned_words: data.BANNED_WORDS, numbers_over_adjectives: true })]
      );
      return { tenant: t, role: "owner" };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "bootstrap");
  }
});

router.post("/tenants/:tid/members", async (req, res) => {
  const email = me(req);
  const target = String(req.body?.email || "").trim().toLowerCase();
  const role = String(req.body?.role || "");
  if (!data.isUuid(req.params.tid)) return res.status(404).json({ error: "not_found" });
  try {
    const out = await withActor(email, async (c) => {
      const mine = (await c.query(
        "select role from deal.members where tenant_id = $1 and email = $2", [req.params.tid, email]
      )).rows[0];
      if (!mine) return { http: 404, body: { error: "not_found" } };
      const { rows } = await c.query(
        `insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, $3, $4)
         on conflict (tenant_id, email) do update set role = excluded.role
         returning email, role`,
        [req.params.tid, target, role, email]
      );
      return { member: rows[0] };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "members");
  }
});

// ---- Campaigns ------------------------------------------------------------------

router.get("/campaigns", async (req, res) => {
  const email = me(req);
  try {
    const campaigns = await withActor(email, async (c) =>
      (await c.query(
        `select c.id, c.name, c.status, c.tenant_id, t.name as tenant_name, m.role,
                (select max(number) from deal.graph_versions g where g.campaign_id = c.id and g.approved_by is not null) as latest_approved,
                (select number from deal.graph_versions g where g.campaign_id = c.id and g.approved_by is null) as open_version,
                (select count(*)::int from deal.findings f where f.campaign_id = c.id and f.status = 'open') as open_findings
           from deal.campaigns c
           join deal.members m on m.tenant_id = c.tenant_id and m.email = $1
           join deal.tenants t on t.id = c.tenant_id
          order by c.created_at desc`,
        [email]
      )).rows
    );
    res.json({ campaigns });
  } catch (e) {
    fail(res, e, "list campaigns");
  }
});

router.post("/campaigns", async (req, res) => {
  const email = me(req);
  const tenantId = req.body?.tenant_id;
  const name = String(req.body?.name || "").trim();
  if (!data.isUuid(tenantId)) return res.status(400).json({ error: "tenant_id_required" });
  if (!name) return res.status(400).json({ error: "name_required" });
  try {
    const out = await withActor(email, async (c) => {
      const mine = (await c.query(
        "select role from deal.members where tenant_id = $1 and email = $2", [tenantId, email]
      )).rows[0];
      if (!mine) return { http: 404, body: { error: "not_found" } };
      if (!WRITERS.has(mine.role)) return { http: 403, body: { error: "read_only_member" } };
      const pack = (await c.query(
        "select id from deal.packs where tenant_id = $1 order by version desc limit 1", [tenantId]
      )).rows[0];
      const { rows } = await c.query(
        `insert into deal.campaigns (tenant_id, pack_id, name, created_by) values ($1, $2, $3, $4)
         returning id, name, status`,
        [tenantId, pack ? pack.id : null, name.slice(0, 200), email]
      );
      return { campaign: rows[0] };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "create campaign");
  }
});

router.get("/campaigns/:id", async (req, res) => {
  try {
    const out = await withCampaign(req, res, req.params.id, {}, async (c, a) => {
      const s = scopeOf(a);
      return {
        role: a.role,
        campaign: await data.campaignHeader(c, s),
        versions: await data.versions(c, s),
        documents: await data.listDocuments(c, s),
        findings: await data.findings(c, s, { status: "open" }),
      };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "campaign overview");
  }
});

router.get("/campaigns/:id/graph", async (req, res) => {
  try {
    const out = await withCampaign(req, res, req.params.id, {}, (c, a) =>
      data.graphAt(c, scopeOf(a), req.query.version ? Number(req.query.version) : undefined)
    );
    send(res, out);
  } catch (e) {
    fail(res, e, "graph");
  }
});

router.get("/campaigns/:id/diff", async (req, res) => {
  try {
    const out = await withCampaign(req, res, req.params.id, {}, async (c, a) => ({
      diff: await data.graphDiff(c, scopeOf(a), req.query.from, req.query.to),
    }));
    send(res, out);
  } catch (e) {
    fail(res, e, "diff");
  }
});

router.post("/campaigns/:id/facts", async (req, res) => {
  const { summary, set = [], remove = [] } = req.body || {};
  if (!Array.isArray(set) || !Array.isArray(remove)) return res.status(400).json({ error: "set_and_remove_are_lists" });
  try {
    const out = await withCampaign(req, res, req.params.id, { write: true }, async (c, a) => ({
      version: await data.proposeFacts(c, scopeOf(a), { summary, set, remove }, me(req)),
    }));
    send(res, out);
  } catch (e) {
    fail(res, e, "propose facts");
  }
});

// ---- Documents ---------------------------------------------------------------------

router.post("/campaigns/:id/documents", async (req, res) => {
  const { kind, title, audience, origin = "uploaded", body, graph_version = null } = req.body || {};
  if (!DOC_KINDS.has(kind)) return res.status(400).json({ error: "invalid_kind" });
  if (!AUDIENCES.has(audience)) return res.status(400).json({ error: "invalid_audience" });
  if (!title || typeof title !== "string") return res.status(400).json({ error: "title_required" });
  if (!body || typeof body !== "string") return res.status(400).json({ error: "body_required" });
  if (body.length > MAX_BODY) return res.status(413).json({ error: "body_too_large" });
  try {
    const out = await withCampaign(req, res, req.params.id, { write: true }, async (c, a) => {
      const d = (await c.query(
        `insert into deal.documents (tenant_id, campaign_id, kind, title, audience, origin)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [a.tenant_id, a.campaign_id, kind, title.slice(0, 300), audience, origin]
      )).rows[0];
      const v = (await c.query(
        `insert into deal.document_versions (tenant_id, campaign_id, document_id, number, graph_version, body, created_by)
         values ($1, $2, $3, 1, $4, $5, $6) returning id, number`,
        [a.tenant_id, a.campaign_id, d.id, graph_version, body, me(req)]
      )).rows[0];
      return { document_id: d.id, version_id: v.id, number: v.number };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "add document");
  }
});

router.post("/documents/:docId/versions", async (req, res) => {
  const { body, graph_version = null } = req.body || {};
  if (!data.isUuid(req.params.docId)) return res.status(404).json({ error: "not_found" });
  if (!body || typeof body !== "string") return res.status(400).json({ error: "body_required" });
  if (body.length > MAX_BODY) return res.status(413).json({ error: "body_too_large" });
  const email = me(req);
  try {
    const out = await withActor(email, async (c) => {
      const doc = (await c.query("select campaign_id from deal.documents where id = $1", [req.params.docId])).rows[0];
      const a = doc && (await campaignAccess(c, email, doc.campaign_id));
      if (!a) return { http: 404, body: { error: "not_found" } };
      if (!WRITERS.has(a.role)) return { http: 403, body: { error: "read_only_member" } };
      const v = (await c.query(
        `insert into deal.document_versions (tenant_id, campaign_id, document_id, number, graph_version, body, created_by)
         select $1, $2, $3, coalesce(max(number), 0) + 1, $4, $5, $6
           from deal.document_versions where document_id = $3
         returning id, number`,
        [a.tenant_id, a.campaign_id, req.params.docId, graph_version, body, email]
      )).rows[0];
      return { version_id: v.id, number: v.number };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "add document version");
  }
});

// ---- Decisions (the database checks who may make them) --------------------------

async function versionAccess(c, email, vid) {
  if (!data.isUuid(vid)) return null;
  const g = (await c.query("select campaign_id from deal.graph_versions where id = $1", [vid])).rows[0];
  return g ? campaignAccess(c, email, g.campaign_id) : null;
}

router.post("/graph-versions/:vid/approve", async (req, res) => {
  const email = me(req);
  try {
    const out = await withActor(email, async (c) => {
      if (!(await versionAccess(c, email, req.params.vid))) return { http: 404, body: { error: "not_found" } };
      const v = (await c.query("select * from deal.approve_graph_version($1)", [req.params.vid])).rows[0];
      return { approved: { number: v.number, approved_by: v.approved_by, approved_at: v.approved_at } };
    });
    if (out && out.approved) console.log(`[campaign] graph version ${req.params.vid} approved`);
    send(res, out);
  } catch (e) {
    fail(res, e, "approve");
  }
});

router.post("/graph-versions/:vid/discard", async (req, res) => {
  const email = me(req);
  try {
    const out = await withActor(email, async (c) => {
      if (!(await versionAccess(c, email, req.params.vid))) return { http: 404, body: { error: "not_found" } };
      await c.query("select deal.discard_graph_version($1)", [req.params.vid]);
      return { discarded: true };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "discard");
  }
});

router.post("/findings/:fid/resolve", async (req, res) => {
  const email = me(req);
  const status = req.body?.status;
  const note = req.body?.note ? String(req.body.note).slice(0, 2000) : null;
  if (!["fixed", "waived"].includes(status)) return res.status(400).json({ error: "status_is_fixed_or_waived" });
  if (!data.isUuid(req.params.fid)) return res.status(404).json({ error: "not_found" });
  try {
    const out = await withActor(email, async (c) => {
      const f = (await c.query("select campaign_id from deal.findings where id = $1", [req.params.fid])).rows[0];
      if (!f || !(await campaignAccess(c, email, f.campaign_id))) return { http: 404, body: { error: "not_found" } };
      const { rows } = await c.query(
        `update deal.findings set status = $2, resolved_by = $3, note = coalesce($4, note)
          where id = $1 returning id, status, resolved_by, resolved_at`,
        [req.params.fid, status, email, note]
      );
      return { finding: rows[0] };
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "resolve finding");
  }
});

// ---- Agent runs ----------------------------------------------------------------------

const DEFAULT_TASKS = {
  consistency: (v) => `Check document version ${v} against the latest approved deal graph. Record its claims and raise findings for every disagreement.`,
  intake: (v) => `Read document version ${v} and propose the deal terms it states as changes to the graph.`,
};

function eventsFromTrace(trace) {
  return (trace || [])
    .filter((t) => t.type === "tool_use")
    .map((t) => ({ tool: t.name, version_id: (t.input && t.input.version_id) || null }));
}

function stageSummary(stage) {
  if (!stage) return null;
  return {
    claims: Object.values(stage.claims || {}).reduce((n, l) => n + l.length, 0),
    findings: (stage.findings || []).length,
    facts_set: (stage.facts && stage.facts.set.length) || 0,
    facts_removed: (stage.facts && stage.facts.remove.length) || 0,
    detail: stage,
  };
}

router.post("/campaigns/:id/agents/run", async (req, res) => {
  const { role, version_id = null } = req.body || {};
  let task = req.body?.task;
  const roles = require("../agents/campaign/orchestrator").ROLES;
  if (!role || !roles[role]) return res.status(400).json({ error: "invalid_role" });
  if (version_id && !data.isUuid(version_id)) return res.status(400).json({ error: "invalid_version_id" });
  if (!task && !version_id) return res.status(400).json({ error: "task_or_version_required" });

  let run;
  let a;
  try {
    const out = await withCampaign(req, res, req.params.id, { write: true }, async (c, access) => {
      a = access;
      const h = await data.campaignHeader(c, scopeOf(a));
      let doc = null;
      if (version_id) {
        doc = await data.documentVersion(c, scopeOf(a), version_id);
        if (!doc) return { http: 400, body: { error: "unknown_version" } };
      }
      const base = task && typeof task === "string" ? task.slice(0, 4000) : DEFAULT_TASKS[role](version_id);
      task = [
        `Campaign: ${h.name} (${h.id}). Latest approved graph version: ${h.latest_approved || "none"}. Open proposal: ${h.open_version || "none"}.`,
        doc ? `Document in scope: "${doc.title}" (${doc.kind}, audience ${doc.audience}), version ${doc.number}, id ${doc.id}, built against graph version ${doc.graph_version || "unknown"}.` : null,
        "",
        base,
      ].filter((x) => x !== null).join("\n");
      run = (await c.query(
        `insert into deal.agent_runs (tenant_id, campaign_id, agent, requested_by, version_id, task)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [a.tenant_id, a.campaign_id, role, me(req), version_id, task]
      )).rows[0];
      return { ok: true, run_id: run.id };
    });
    if (out.http) return send(res, out);
    res.json(out);
  } catch (e) {
    return fail(res, e, "start run");
  }

  const actor = `agent:${role}`;
  const bound = scopeOf(a);
  setImmediate(async () => {
    const started = Date.now();
    let stage = null;
    try {
      const result = await runAgent({
        role,
        task,
        scope: { ...bound, onStage: (s) => (stage = s) },
      });
      const passed = ["passed", "passed_after_retry", "not_run"].includes(result.eval_status);
      let committed = null;
      if (passed && stage) committed = await withActor(actor, (c) => data.commitStage(c, bound, stage, actor));
      await withActor(actor, (c) =>
        c.query(
          `update deal.agent_runs set status = $2, output = $3, tool_calls = $4, eval_status = $5,
                  retry_count = $6, usage = $7, staged = $8, committed = $9, finished_at = now()
            where id = $1`,
          [run.id, passed ? "completed" : "waiting", result.output, JSON.stringify(eventsFromTrace(result.trace)),
           result.eval_status, result.retry_count || 0, JSON.stringify(result.usage || null),
           JSON.stringify(stageSummary(stage)), JSON.stringify(committed)]
        )
      );
      console.log(`[campaign] run ${run.id} ${passed ? "completed" : "waiting"} · ${role} · ${Date.now() - started}ms · eval=${result.eval_status}`);
    } catch (e) {
      console.error(`[campaign] run ${run.id} failed:`, e.message);
      try {
        await withActor(actor, (c) =>
          c.query(
            `update deal.agent_runs set status = 'failed', error = $2, staged = $3, finished_at = now() where id = $1`,
            [run.id, String(e.message).slice(0, 1000), JSON.stringify(stageSummary(stage))]
          )
        );
      } catch (e2) {
        console.error(`[campaign] run ${run.id} could not record failure:`, e2.message);
      }
    }
  });
});

router.get("/agent-runs/:id", async (req, res) => {
  const email = me(req);
  if (!data.isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  try {
    const out = await withActor(email, async (c) => {
      const r = (await c.query(
        `select id, campaign_id, agent, requested_by, version_id, status, output, tool_calls, eval_status,
                retry_count, error, staged, committed, started_at, finished_at
           from deal.agent_runs where id = $1`,
        [req.params.id]
      )).rows[0];
      if (!r || !(await campaignAccess(c, email, r.campaign_id))) return { http: 404, body: { error: "not_found" } };
      return r;
    });
    send(res, out);
  } catch (e) {
    fail(res, e, "poll run");
  }
});

module.exports = router;
