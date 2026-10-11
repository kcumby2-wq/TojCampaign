// Campaign deal graph (migration 015) — the database gates, the campaign-bound
// agent tools, and the /api/campaign routes.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// The test DROPS and rebuilds the "deal" schema of that database (it never
// touches "public"), so never point it at a real database.
//
// No Anthropic calls: agent runs use a stand-in that drives the real tools.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test("campaign deal graph (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

const express = require("express");
const campaignDb = require("../utils/campaign-db");
const data = require("../agents/campaign/data");
const { toolsFor } = require("../agents/campaign/tools");

const KYRON = "kyron@toj.test"; // owner
const APPROVER = "approver@toj.test";
const EDITOR = "editor@toj.test";
const VIEWER = "viewer@toj.test";
const OUTSIDER = "outsider@agency.test"; // staff, but not a member of TOJ
const AGENT = "agent:consistency";

let pool, server, base;
let toj, agx, camp, otherCamp;

// Run SQL as someone. Resolves the result, or the error (so a test can assert
// a refusal without try/catch noise).
async function as(actor, sql, params) {
  try {
    return await campaignDb.withActor(actor, (c) => c.query(sql, params));
  } catch (e) {
    return e;
  }
}
function refused(r) {
  return r instanceof Error;
}

before(async () => {
  pool = new Pool({ connectionString: URL_ });
  await pool.query("drop schema if exists deal cascade");
  // Supabase's API roles, so the grants test means something on a bare Postgres.
  for (const r of ["anon", "authenticated"])
    await pool.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "015_campaign_deal_graph.sql"), "utf8"));
  campaignDb.setPool(pool);

  // Two tenants: TOJ (four members) and an outside agency.
  toj = (await as(KYRON, "insert into deal.tenants (slug, name) values ('toj', 'Trail of Joy') returning id")).rows[0].id;
  await as(KYRON, "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, 'owner', $2)", [toj, KYRON]);
  for (const [e, r] of [[APPROVER, "approver"], [EDITOR, "editor"], [VIEWER, "viewer"]])
    await as(KYRON, "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, $3, $4)", [toj, e, r, KYRON]);
  agx = (await as(OUTSIDER, "insert into deal.tenants (slug, name) values ('agx', 'Agency X') returning id")).rows[0].id;
  await as(OUTSIDER, "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, 'owner', $2)", [agx, OUTSIDER]);

  camp = (await as(EDITOR, "insert into deal.campaigns (tenant_id, name, created_by) values ($1, 'Pylon x TOJ 2026-27', $2) returning id", [toj, EDITOR])).rows[0].id;
  otherCamp = (await as(OUTSIDER, "insert into deal.campaigns (tenant_id, name, created_by) values ($1, 'Agency campaign', $2) returning id", [agx, OUTSIDER])).rows[0].id;
});

after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

// ---- 1 · Database gates ------------------------------------------------------------

test("members: first member must be an owner adding themselves; only owners change members; one owner always remains", async () => {
  const t = (await as(EDITOR, "insert into deal.tenants (slug, name) values ('t3', 'T3') returning id")).rows[0].id;
  assert.ok(refused(await as(EDITOR, "insert into deal.members values ($1, $2, 'owner', $3)", [t, KYRON, EDITOR])), "can't seat someone else as first owner");
  assert.ok(refused(await as(EDITOR, "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, 'editor', $2)", [t, EDITOR])), "first member must be owner");
  assert.ok(refused(await as(AGENT, "insert into deal.members (tenant_id, email, role, added_by) values ($1, $2, 'viewer', $2)", [toj, AGENT])), "an agent can't join");
  assert.ok(refused(await as(EDITOR, "insert into deal.members (tenant_id, email, role, added_by) values ($1, 'x@toj.test', 'viewer', $2)", [toj, EDITOR])), "editor can't add members");
  assert.ok(refused(await as(APPROVER, "update deal.members set role = 'owner' where tenant_id = $1 and email = $2", [toj, APPROVER])), "approver can't promote themselves");
  assert.ok(refused(await as(KYRON, "delete from deal.members where tenant_id = $1 and email = $2", [toj, KYRON])), "last owner stays");
});

test("tenant consistency: a row can't point at another tenant's campaign", async () => {
  const r = await as(OUTSIDER, `insert into deal.documents (tenant_id, campaign_id, kind, title, audience, origin)
                                values ($1, $2, 'letter', 'x', 'internal', 'uploaded')`, [agx, camp]);
  assert.ok(refused(r) && r.code === "23503");
});

test("versions are numbered in order, one open at a time; facts only enter the open version", async () => {
  assert.ok(refused(await as(AGENT, "insert into deal.graph_versions (tenant_id, campaign_id, number, summary, proposed_by) values ($1, $2, 2, 'skip', $3)", [toj, camp, AGENT])));
  await as(AGENT, "insert into deal.graph_versions (tenant_id, campaign_id, number, summary, proposed_by) values ($1, $2, 1, 'v10 terms imported', $3)", [toj, camp, AGENT]);
  assert.ok(refused(await as(AGENT, "insert into deal.graph_versions (tenant_id, campaign_id, number, summary, proposed_by) values ($1, $2, 2, 'second open', $3)", [toj, camp, AGENT])), "only one open version");
  assert.ok(refused(await as(AGENT, "insert into deal.graph_versions (tenant_id, campaign_id, number, summary, proposed_by, approved_by) values ($1, $2, 2, 'x', $3, $3)", [toj, camp, AGENT])));
  const r = await as(AGENT, `insert into deal.facts (tenant_id, campaign_id, key, kind, value, status, source, from_version) values
      ($1, $2, 'split.pylon.event_sales', 'split', '{"model":"waterfall","rate":0.5}', 'proposed', 'Pylon v10 §8(d)', 1),
      ($1, $2, 'price.camp.standard', 'price', '{"usd":349}', 'posted', 'Schedule M-6', 1)`, [toj, camp]);
  assert.ok(!refused(r), String(r && r.message));
});

test("approving: not an agent, not an editor, not in someone else's name; an owner can; approved is final", async () => {
  const v1 = (await pool.query("select id from deal.graph_versions where campaign_id = $1 and number = 1", [camp])).rows[0].id;
  assert.ok(refused(await as(AGENT, "select deal.approve_graph_version($1)", [v1])), "agent");
  assert.ok(refused(await as(EDITOR, "select deal.approve_graph_version($1)", [v1])), "editor");
  assert.ok(refused(await as(KYRON, "update deal.graph_versions set approved_by = $2 where id = $1", [v1, APPROVER])), "in someone else's name");
  assert.ok(refused(await as(OUTSIDER, "select deal.approve_graph_version($1)", [v1])), "owner of another tenant");
  const ok = await as(KYRON, "select (deal.approve_graph_version($1)).approved_at", [v1]);
  assert.ok(!refused(ok) && ok.rows[0].approved_at);
  assert.ok(refused(await as(KYRON, "update deal.graph_versions set approved_by = null where id = $1", [v1])), "can't un-approve");
  assert.ok(refused(await as(KYRON, "delete from deal.graph_versions where id = $1", [v1])), "can't delete");
  assert.ok(refused(await as(KYRON, "update deal.facts set value = '{\"rate\":0.25}' where campaign_id = $1 and key = 'split.pylon.event_sales'", [camp])), "approved fact can't change");
  assert.ok(refused(await as(KYRON, "delete from deal.facts where campaign_id = $1 and key = 'price.camp.standard'", [camp])), "approved fact can't go");
  assert.ok(refused(await as(KYRON, `insert into deal.facts (tenant_id, campaign_id, key, kind, value, status, from_version)
                                     values ($1, $2, 'fee.x', 'fee', '{}', 'proposed', 1)`, [toj, camp])), "no facts into an approved version");
});

test("a later version supersedes; graph_at and graph_diff read it back", async () => {
  const n = await campaignDb.withActor(EDITOR, (c) =>
    data.proposeFacts(c, { tenant_id: toj, campaign_id: camp }, {
      summary: "Pylon share: v10 waterfall to 20% off the top",
      set: [{ key: "split.pylon.event_sales", kind: "split", value: { basis: "net_sale_price", rate: 0.2, order: "off_the_top" }, status: "agreed", source: "Pylon v11 §8(d)" }],
    }, EDITOR));
  assert.equal(n, 2);
  const s = { tenant_id: toj, campaign_id: camp };
  const g1 = await campaignDb.withActor(KYRON, (c) => data.graphAt(c, s, 1));
  const g2 = await campaignDb.withActor(KYRON, (c) => data.graphAt(c, s, 2));
  assert.equal(g1.facts.find((f) => f.key === "split.pylon.event_sales").value.model, "waterfall");
  assert.equal(g2.facts.find((f) => f.key === "split.pylon.event_sales").value.rate, 0.2);
  const diff = await campaignDb.withActor(KYRON, (c) => data.graphDiff(c, s, 1, 2));
  assert.deepEqual(diff.map((d) => [d.key, d.change, d.old_status, d.new_status]), [["split.pylon.event_sales", "changed", "proposed", "agreed"]]);
  // Another tenant reading with its own scope sees nothing of TOJ's graph.
  const leak = await campaignDb.withActor(OUTSIDER, (c) => data.graphAt(c, { tenant_id: agx, campaign_id: camp }, 2));
  assert.equal(leak.facts.length, 0);
});

test("an open blocker stops approval; an editor can't waive it; an approver can", async () => {
  const s = { tenant_id: toj, campaign_id: camp };
  const [fid] = await campaignDb.withActor(AGENT, (c) =>
    data.insertFindings(c, s, [{ kind: "value_mismatch", severity: "blocker", message: "Schedule M says 50%; graph v2 says 20%." }], AGENT));
  const v2 = (await pool.query("select id from deal.graph_versions where campaign_id = $1 and number = 2", [camp])).rows[0].id;
  assert.match((await as(KYRON, "select deal.approve_graph_version($1)", [v2])).message, /blocker/);
  assert.ok(refused(await as(AGENT, "update deal.findings set status = 'waived', resolved_by = $2 where id = $1", [fid, AGENT])), "agent can't resolve");
  assert.ok(refused(await as(EDITOR, "update deal.findings set status = 'waived', resolved_by = $2 where id = $1", [fid, EDITOR])), "editor can't waive a blocker");
  assert.ok(refused(await as(VIEWER, "update deal.findings set status = 'fixed', resolved_by = $2 where id = $1", [fid, VIEWER])), "viewer can't resolve");
  assert.ok(refused(await as(APPROVER, "update deal.findings set status = 'waived', resolved_by = $2 where id = $1", [fid, KYRON])), "not in someone else's name");
  assert.ok(refused(await as(APPROVER, "update deal.findings set message = 'softer' where id = $1", [fid])), "substance can't be edited");
  const w = await as(APPROVER, "update deal.findings set status = 'waived', resolved_by = $2, note = 'Schedule M being redone' where id = $1 returning resolved_at", [fid, APPROVER]);
  assert.ok(!refused(w) && w.rows[0].resolved_at);
  assert.ok(refused(await as(APPROVER, "update deal.findings set status = 'open', resolved_by = null where id = $1", [fid])), "resolved is final");
});

test("discarding the open version reopens what it closed", async () => {
  const s = { tenant_id: toj, campaign_id: camp };
  const v2 = (await pool.query("select id from deal.graph_versions where campaign_id = $1 and number = 2", [camp])).rows[0].id;
  assert.ok(refused(await as(VIEWER, "select deal.discard_graph_version($1)", [v2])), "viewer can't discard");
  assert.ok(!refused(await as(EDITOR, "select deal.discard_graph_version($1)", [v2])));
  const cur = await campaignDb.withActor(KYRON, (c) => data.graphAt(c, s));
  assert.equal(cur.version, 1);
  assert.equal(cur.facts.find((f) => f.key === "split.pylon.event_sales").value.model, "waterfall");
  // Propose v2 again (the rest of the tests build on it) and approve it.
  const n = await campaignDb.withActor(EDITOR, (c) =>
    data.proposeFacts(c, s, { summary: "Pylon share to 20% off the top", set: [{ key: "split.pylon.event_sales", kind: "split", value: { basis: "net_sale_price", rate: 0.2, order: "off_the_top" }, status: "agreed", source: "Pylon v11 §8(d)" }] }, EDITOR));
  assert.equal(n, 2);
  const id = (await pool.query("select id from deal.graph_versions where campaign_id = $1 and number = 2", [camp])).rows[0].id;
  assert.ok(!refused(await as(APPROVER, "select deal.approve_graph_version($1)", [id])));
});

test("approval requests: filed undecided, never decided by the asker or an agent, final once decided; outbound waits for one", async () => {
  const out = (await as(AGENT, `insert into deal.outbound (tenant_id, campaign_id, channel, subject, body, created_by)
                                values ($1, $2, 'email', 'v11 pack', 'draft', $3) returning id`, [toj, camp, AGENT])).rows[0].id;
  assert.ok(refused(await as(AGENT, "update deal.outbound set status = 'sent' where id = $1", [out])), "no approval, no send");
  assert.ok(refused(await as(AGENT, `insert into deal.approvals (tenant_id, campaign_id, subject, subject_id, requested_by, decision, decided_by)
                                     values ($1, $2, 'outbound', $3, $4, 'approved', $4)`, [toj, camp, out, AGENT])), "filed decided");
  const other = (await as(AGENT, `insert into deal.approvals (tenant_id, campaign_id, subject, subject_id, requested_by)
                                  values ($1, $2, 'outbound', gen_random_uuid(), $3) returning id`, [toj, camp, AGENT])).rows[0].id;
  await as(KYRON, "update deal.approvals set decision = 'approved', decided_by = $2 where id = $1", [other, KYRON]);
  assert.ok(refused(await as(AGENT, "update deal.outbound set status = 'sent', approval_id = $2 where id = $1", [out, other])), "borrowed approval");
  const ask = (await as(APPROVER, `insert into deal.approvals (tenant_id, campaign_id, subject, subject_id, requested_by)
                                   values ($1, $2, 'outbound', $3, $4) returning id`, [toj, camp, out, APPROVER])).rows[0].id;
  assert.ok(refused(await as(APPROVER, "update deal.approvals set decision = 'approved', decided_by = $2 where id = $1", [ask, APPROVER])), "asker can't decide");
  assert.ok(refused(await as(AGENT, "update deal.approvals set decision = 'approved', decided_by = $2 where id = $1", [ask, AGENT])), "agent can't decide");
  assert.ok(refused(await as(EDITOR, "update deal.approvals set decision = 'approved', decided_by = $2 where id = $1", [ask, EDITOR])), "editor can't decide");
  assert.ok(!refused(await as(KYRON, "update deal.approvals set decision = 'approved', decided_by = $2 where id = $1", [ask, KYRON])));
  assert.ok(refused(await as(KYRON, "update deal.approvals set decision = 'rejected', decided_by = $2 where id = $1", [ask, KYRON])), "final");
  assert.ok(!refused(await as(AGENT, "update deal.outbound set status = 'sent', approval_id = $2, sent_at = now() where id = $1", [out, ask])));
});

test("nothing in the deal schema is reachable by Supabase API roles", async () => {
  const { rows } = await pool.query(
    `select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'deal' and grantee in ('anon', 'authenticated', 'PUBLIC')`
  );
  assert.equal(rows[0].n, 0, "no table grants");
  for (const r of ["anon", "authenticated"]) {
    const p = (await pool.query(
      `select has_schema_privilege($1, 'deal', 'USAGE') as usage,
              has_function_privilege($1, 'deal.approve_graph_version(uuid)', 'EXECUTE') as approve`, [r]
    )).rows[0];
    assert.deepEqual(p, { usage: false, approve: false }, r);
  }
});

// ---- 2 · Campaign-bound tools -----------------------------------------------------------

let docV, otherDocV;

test("tools are bound to one campaign: another campaign's documents don't exist for them", async () => {
  const s = { tenant_id: toj, campaign_id: camp };
  docV = await campaignDb.withActor(EDITOR, async (c) => {
    const d = (await c.query(`insert into deal.documents (tenant_id, campaign_id, kind, title, audience, origin)
                              values ($1, $2, 'schedule', 'Schedule M', 'partner', 'compiled') returning id`, [toj, camp])).rows[0].id;
    return (await c.query(`insert into deal.document_versions (tenant_id, campaign_id, document_id, number, graph_version, body, created_by)
                           values ($1, $2, $3, 1, 1, $4, $5) returning id`,
      [toj, camp, d, "¶1 Camp price: $349 per athlete.\n¶2 Pylon receives 50% after the SportsClippers fee.\n¶3 An elite camp experience.", EDITOR])).rows[0].id;
  });
  otherDocV = await campaignDb.withActor(OUTSIDER, async (c) => {
    const d = (await c.query(`insert into deal.documents (tenant_id, campaign_id, kind, title, audience, origin)
                              values ($1, $2, 'letter', 'Agency secret', 'internal', 'uploaded') returning id`, [agx, otherCamp])).rows[0].id;
    return (await c.query(`insert into deal.document_versions (tenant_id, campaign_id, document_id, number, body, created_by)
                           values ($1, $2, $3, 1, 'agency terms', $4) returning id`, [agx, otherCamp, d, OUTSIDER])).rows[0].id;
  });

  const tools = Object.fromEntries(toolsFor({ role: "consistency", scope: s }).map((t) => [t.name, t]));
  assert.match(await tools.document_read.run({ version_id: otherDocV }), /Not found/);
  assert.match(await tools.claims_write.run({ version_id: otherDocV, claims: [{ locator: "x", quote: "y" }] }), /Refused/);
  const mine = JSON.parse(await tools.document_read.run({ version_id: docV }));
  assert.equal(mine.title, "Schedule M");
  const hits = JSON.parse(await tools.voice_check.run({ version_id: docV })).hits;
  assert.deepEqual(hits.map((h) => [h.word, h.line]), [["elite", 3]]);
  const overview = JSON.parse(await tools.campaign_overview.run({}));
  assert.equal(overview.campaign.id, camp);
  assert.ok(!JSON.stringify(overview).includes(otherCamp));
});

test("agent writes are staged, validated, and saved only on commit — as the agent", async () => {
  const s = { tenant_id: toj, campaign_id: camp };
  let stage = null;
  const tools = Object.fromEntries(toolsFor({ role: "intake", scope: { ...s, onStage: (x) => (stage = x) } }).map((t) => [t.name, t]));
  assert.match(await tools.facts_propose.run({ summary: "x", set: [{ key: "fee.monthly", kind: "fee", value: { usd: 3000 }, status: "agreed" }] }), /Refused/, "agents can't mark terms agreed");
  assert.match(await tools.facts_propose.run({ summary: "x", set: [{ key: "Bad Key", kind: "fee", value: {}, status: "proposed" }] }), /Refused/);
  await tools.claims_write.run({ version_id: docV, claims: [{ locator: "¶2", quote: "Pylon receives 50% after the SportsClippers fee.", fact_keys: ["split.pylon.event_sales"], stated: { rate: 0.5 } }] });
  await tools.facts_propose.run({ summary: "Monthly fee from redline", set: [{ key: "fee.pylon.monthly", kind: "fee", value: { usd: 3000, per: "month" }, status: "proposed", source: "redline §4" }] });
  const before = (await pool.query("select count(*)::int as n from deal.claims")).rows[0].n;
  assert.equal(before, 0, "nothing written before commit");

  const committed = await campaignDb.withActor("agent:intake", (c) => data.commitStage(c, s, stage, "agent:intake"));
  assert.deepEqual([committed.claims, committed.findings, committed.version], [1, 0, 3]);
  const v3 = (await pool.query("select proposed_by, approved_by from deal.graph_versions where campaign_id = $1 and number = 3", [camp])).rows[0];
  assert.deepEqual(v3, { proposed_by: "agent:intake", approved_by: null });
  const claim = (await pool.query("select created_by from deal.claims")).rows[0];
  assert.equal(claim.created_by, "agent:intake");
});

// ---- 3 · Routes ---------------------------------------------------------------------------

function client(email) {
  return async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...(email ? { "x-test-user": email } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
}

async function pollRun(call, id) {
  for (let i = 0; i < 50; i++) {
    const r = await call("GET", `/api/campaign/agent-runs/${id}`);
    if (r.body && r.body.status !== "running") return r.body;
    await new Promise((res) => setTimeout(res, 40));
  }
  throw new Error("run did not finish");
}

test("routes: membership decides what you see; roles decide what you change", async () => {
  process.env.ADMIN_EMAILS = [KYRON, APPROVER, EDITOR, VIEWER, OUTSIDER].join(",");
  const router = require("../routes/campaign");
  const app = express();
  app.use(express.json());
  // Test-only sign-in: a staff session for the email in x-test-user.
  app.use((req, _res, next) => {
    const e = req.headers["x-test-user"];
    req.session = e ? { userEmail: e, userRole: "staff" } : {};
    next();
  });
  app.use("/api/campaign", require("../utils/staff").requireStaff, router);
  await new Promise((r) => (server = app.listen(0, r)));
  base = "http://127.0.0.1:" + server.address().port;

  const kyron = client(KYRON), editor = client(EDITOR), viewer = client(VIEWER), outsider = client(OUTSIDER), anon = client(null);

  assert.equal((await anon("GET", "/api/campaign/campaigns")).status, 401);
  assert.equal((await outsider("GET", `/api/campaign/campaigns/${camp}`)).status, 404, "other tenant's campaign is not found");
  assert.ok(!(await outsider("GET", "/api/campaign/campaigns")).body.campaigns.some((c) => c.id === camp));
  assert.equal((await kyron("POST", "/api/campaign/bootstrap", {})).status, 409, "already bootstrapped");

  const ov = await viewer("GET", `/api/campaign/campaigns/${camp}`);
  assert.equal(ov.status, 200);
  assert.equal(ov.body.role, "viewer");
  assert.equal((await viewer("POST", `/api/campaign/campaigns/${camp}/documents`, { kind: "letter", title: "x", audience: "internal", body: "y" })).status, 403);
  assert.equal((await viewer("POST", `/api/campaign/campaigns/${camp}/agents/run`, { role: "consistency", version_id: docV })).status, 403);

  const doc = await editor("POST", `/api/campaign/campaigns/${camp}/documents`, { kind: "letter", title: "Cover Letter", audience: "partner", body: "Pylon receives 20% of the net sale price.", graph_version: 2 });
  assert.equal(doc.status, 200);
  const v2 = await editor("POST", `/api/campaign/documents/${doc.body.document_id}/versions`, { body: "Pylon receives 20% of the net sale price, off the top." });
  assert.equal(v2.body.number, 2);

  const g = await viewer("GET", `/api/campaign/campaigns/${camp}/graph?version=2`);
  assert.equal(g.body.facts.find((f) => f.key === "split.pylon.event_sales").value.rate, 0.2);
  const d = await viewer("GET", `/api/campaign/campaigns/${camp}/diff?from=1&to=2`);
  assert.equal(d.body.diff.length, 1);

  // v3 (the intake proposal) — editor can't approve, owner can.
  const v3id = (await pool.query("select id from deal.graph_versions where campaign_id = $1 and number = 3", [camp])).rows[0].id;
  const e1 = await editor("POST", `/api/campaign/graph-versions/${v3id}/approve`);
  assert.equal(e1.status, 409);
  assert.equal((await outsider("POST", `/api/campaign/graph-versions/${v3id}/approve`)).status, 404);
  const ok = await kyron("POST", `/api/campaign/graph-versions/${v3id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.approved.approved_by, KYRON);
  assert.equal((await kyron("POST", `/api/campaign/graph-versions/${v3id}/approve`)).status, 409, "final");
});

test("routes: an agent run saves only the accepted attempt's work; a failed eval saves nothing", async () => {
  const router = require("../routes/campaign");
  const editor = client(EDITOR), outsider = client(OUTSIDER);

  // Stand-in for the orchestrator: two attempts through the REAL bound tools.
  router._setRunAgent(async ({ role, scope }) => {
    let tools = Object.fromEntries(toolsFor({ role, scope }).map((t) => [t.name, t]));
    await tools.findings_write.run({ findings: [{ kind: "value_mismatch", severity: "major", message: "attempt 1 (rejected by eval)" }] });
    tools = Object.fromEntries(toolsFor({ role, scope }).map((t) => [t.name, t]));
    await tools.claims_write.run({ version_id: docV, claims: [{ locator: "¶2", quote: "Pylon receives 50% after the SportsClippers fee.", fact_keys: ["split.pylon.event_sales"] }] });
    await tools.findings_write.run({ findings: [{ kind: "value_mismatch", severity: "blocker", version_id: docV, fact_key: "split.pylon.event_sales", message: "Schedule M ¶2 says 50% after the SportsClippers fee; graph v3 says 20% of net sale price, off the top.", fix: "Replace ¶2." }] });
    return { output: "1 claim, 1 blocker.", trace: [{ type: "tool_use", name: "claims_write", input: { version_id: docV } }], eval_status: "passed_after_retry", retry_count: 1, usage: {} };
  });
  const start = await editor("POST", `/api/campaign/campaigns/${camp}/agents/run`, { role: "consistency", version_id: docV });
  assert.equal(start.status, 200);
  assert.equal((await outsider("GET", `/api/campaign/agent-runs/${start.body.run_id}`)).status, 404);
  const run = await pollRun(editor, start.body.run_id);
  assert.equal(run.status, "completed", JSON.stringify({ error: run.error, eval: run.eval_status }));
  assert.deepEqual([run.committed.claims, run.committed.findings], [1, 1]);
  const msgs = (await pool.query("select message, raised_by from deal.findings where campaign_id = $1 and status = 'open'", [camp])).rows;
  assert.ok(msgs.some((m) => m.message.startsWith("Schedule M ¶2") && m.raised_by === "agent:consistency"));
  assert.ok(!msgs.some((m) => m.message.includes("attempt 1")), "the rejected attempt left nothing behind");
  assert.deepEqual(run.tool_calls, [{ tool: "claims_write", version_id: docV }]);

  // The blocker now stops v4 from being approved until someone resolves it.
  router._setRunAgent(async ({ role, scope }) => {
    const tools = Object.fromEntries(toolsFor({ role, scope }).map((t) => [t.name, t]));
    await tools.findings_write.run({ findings: [{ kind: "stale", severity: "minor", message: "should never be saved" }] });
    return { output: "x", trace: [], eval_status: "failed_after_retries", retry_count: 3, usage: {} };
  });
  const s2 = await editor("POST", `/api/campaign/campaigns/${camp}/agents/run`, { role: "consistency", version_id: docV });
  const run2 = await pollRun(editor, s2.body.run_id);
  assert.equal(run2.status, "waiting");
  assert.equal(run2.committed, null);
  assert.equal(run2.staged.findings, 1, "what it would have saved is kept on the run for review");
  const n = (await pool.query("select count(*)::int as n from deal.findings where message = 'should never be saved'")).rows[0].n;
  assert.equal(n, 0);

  assert.equal((await editor("POST", `/api/campaign/campaigns/${camp}/agents/run`, { role: "approver-bot", version_id: docV })).status, 400);
  assert.equal((await editor("POST", `/api/campaign/campaigns/${camp}/agents/run`, { role: "consistency", version_id: otherDocV })).status, 400, "other campaign's document");
});

test("routes: findings are resolved by people, as themselves", async () => {
  const editor = client(EDITOR), kyron = client(KYRON);
  const f = (await pool.query("select id from deal.findings where campaign_id = $1 and status = 'open' and severity = 'blocker'", [camp])).rows[0].id;
  assert.equal((await editor("POST", `/api/campaign/findings/${f}/resolve`, { status: "waived" })).status, 409, "editor can't waive a blocker");
  const r = await kyron("POST", `/api/campaign/findings/${f}/resolve`, { status: "fixed", note: "Schedule M v2" });
  assert.equal(r.status, 200);
  assert.equal(r.body.finding.resolved_by, KYRON);
});

test("routes: 503 until CAMPAIGN_DATABASE_URL is set", async () => {
  campaignDb.setPool(null);
  const saved = process.env.CAMPAIGN_DATABASE_URL;
  delete process.env.CAMPAIGN_DATABASE_URL;
  try {
    const r = await client(KYRON)("GET", "/api/campaign/campaigns");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "campaign_db_not_configured");
  } finally {
    if (saved) process.env.CAMPAIGN_DATABASE_URL = saved;
    campaignDb.setPool(pool);
  }
});
