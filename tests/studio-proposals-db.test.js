// Proposed kits (agents/studio/proposals): listed for anyone on Studio, made a
// draft only by an approver, once per slug while a draft or an approved
// version is open, and then read and approved like any draft. Against a real
// Postgres (migrations 018–020, 039–042 and 044).
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_studio_proposals_test), which it DROPS and recreates.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_proposals_test";
if (!URL_) {
  test("studio proposed kits (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}
process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.STUDIO_API_KEY = "proposals-test-key-0123456789ab";

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const push = require("../utils/push");
const T = require("../utils/team");
const K = require("../agents/studio/kit");

let pool, sb, server, base;
const cookies = {};
const as = { kyron: "kyron@toj.test", lead: "lead@toj.test", dir: "dir@toj.test", look: "look@toj.test", out: "out@toj.test" };
const agentsRouter = require("../routes/studio-agents");

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "039_studio_films.sql", "040_studio_craft.sql", "041_studio_words.sql", "042_studio_learn.sql", "044_studio_proposals.sql"]);
  sb = pgSupabase(pool, SCHEMA);
  setSupabase(sb);
  agentsRouter._setDeps({ sb });
  await pool.query(`insert into team_members (email, role, tools) values
    ('lead@toj.test', 'approver', array['studio']), ('dir@toj.test', 'member', array['studio']),
    ('look@toj.test', 'viewer', array['studio']), ('out@toj.test', 'approver', array['gfs'])`);
  push.setSender(async () => ({}));
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "proposals", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-agents", agentsRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
});
after(async () => {
  server && server.close();
  push.setSender(null);
  setSupabase(null);
  agentsRouter._setDeps({ sb: null });
  if (pool) await pool.end();
});
beforeEach(() => T.forget());

async function call(method, path, body, who = "kyron", headers = {}) {
  const r = await fetch(base + "/api/studio-agents" + path, { method, headers: { ...(who ? { Cookie: cookies[who] } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const draft = (slug, who = "lead", body = {}, headers) => call("POST", `/proposals/${slug}/draft`, body, who, headers);
const listed = async (slug, who = "dir") => ok(await call("GET", "/proposals", undefined, who), "list").proposals.find((p) => p.slug === slug);

test("anyone on Studio sees the proposed kits with their checks; nobody else does", async () => {
  const d = ok(await call("GET", "/proposals", undefined, "look"), "a viewer lists them");
  assert.equal(d.storage, "ok");
  assert.deepEqual(d.proposals.map((p) => p.slug).sort(), K.proposedKits().map((p) => p.slug).sort());
  for (const p of d.proposals) {
    assert.equal(p.blockers, 0, p.slug);
    assert.equal(p.draft, null);
    assert.equal(p.approved, null);
    assert.ok(p.counts.cards > 0 && p.counts.locked > 0, p.slug);
  }
  assert.equal((await call("GET", "/proposals", undefined, null)).status, 401);
  assert.equal((await call("GET", "/proposals", undefined, "out")).status, 403, "on the team, but not on Studio");
  assert.equal((await call("GET", "/proposals", undefined, null, { "x-studio-api-key": process.env.STUDIO_API_KEY })).status, 200, "the Studio key reads them");
});

test("only an approver makes one a draft, as JSON from the app's own pages", async () => {
  assert.equal((await draft("sm-sessions", null)).status, 401);
  assert.equal((await draft("sm-sessions", "look")).data.error, "role_too_low");
  assert.equal((await draft("sm-sessions", "dir")).data.error, "role_too_low", "a member can't");
  assert.equal((await draft("sm-sessions", null, {}, { "x-studio-api-key": process.env.STUDIO_API_KEY })).status, 401, "the key never can");
  const form = await fetch(base + "/api/studio-agents/proposals/sm-sessions/draft", { method: "POST", headers: { Cookie: cookies.lead, "Content-Type": "application/x-www-form-urlencoded" }, body: "x=1" });
  assert.equal(form.status, 415);
  assert.equal((await form.json()).error, "json_only");
  assert.equal((await draft("sm-sessions", "lead", {}, { Origin: "https://evil.example" })).data.error, "wrong_origin");
  assert.equal((await draft("no-such-kit")).status, 404);
  assert.equal((await draft("same-work")).status, 404, "a built-in kit isn't a proposal");
  assert.equal((await draft("Bad_Slug!")).status, 404);
  const n = (await pool.query("select count(*)::int as n from studio_kits")).rows[0].n;
  assert.equal(n, 0, "nothing was written");
});

test("a draft is v1 of its slug, marked as proposed with no checks run, and read like any draft", async () => {
  const d = ok(await draft("pylon-stop"), "draft");
  assert.equal(d.version, 1);
  const row = (await pool.query("select * from studio_kits where id = $1", [d.id])).rows[0];
  assert.equal(row.slug, "pylon-stop");
  assert.equal(row.status, "draft");
  assert.equal(row.role, "proposal");
  assert.equal(row.eval_status, "not_run");
  assert.equal(row.created_by, "lead@toj.test");
  assert.equal(row.source_run_id, null);
  assert.equal(row.base_kit_id, null);
  assert.match(row.summary, /agents\/studio\/proposals\/pylon-stop\.v1\.json/);
  const file = K.proposedKits().find((p) => p.slug === "pylon-stop").kit;
  assert.deepEqual(row.kit.columns, file.columns, "the cards are the file's");
  const act = (await pool.query("select actor, action, subject from team_activity where action = 'drafted_proposed_kit'")).rows;
  assert.deepEqual(act, [{ actor: "lead@toj.test", action: "drafted_proposed_kit", subject: "pylon-stop v1" }]);

  const kit = ok(await call("GET", `/kits/${d.id}`, undefined, "dir"), "a member reads it");
  assert.equal(kit.check.ok, true);
  const page = await fetch(base + `/api/studio-agents/kits/${d.id}/page`, { headers: { Cookie: cookies.dir } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Draft v1/);

  const p = await listed("pylon-stop");
  assert.deepEqual(p.draft, { id: d.id, version: 1 });
  assert.equal(p.approved, null);
});

test("once a draft is open, a second ask points to it; approving it makes it the kit, and it's no longer a proposal to draft", async () => {
  const first = ok(await draft("fellowship"), "draft");
  const again = await draft("fellowship", "kyron");
  assert.equal(again.status, 409);
  assert.equal(again.data.error, "drafted_already");
  assert.equal(again.data.kit.id, first.id);
  assert.equal(again.data.kit.status, "draft");

  ok(await call("POST", `/kits/${first.id}/approve`, {}, "lead"), "approve");
  const p = await listed("fellowship");
  assert.deepEqual(p.approved, { id: first.id, version: 1 });
  assert.equal(p.draft, null);
  const after = await draft("fellowship");
  assert.equal(after.data.error, "drafted_already");
  assert.equal(after.data.kit.status, "approved", "changes to an approved kit go through a refresh");
  const kits = ok(await call("GET", "/kits", undefined, "dir"), "kits").kits;
  assert.ok(kits.some((k) => k.slug === "fellowship" && k.status === "approved" && k.version === 1), "it's listed with the kits");
});

test("a discarded draft can be drafted again, as the next version", async () => {
  const first = ok(await draft("sm-market-event"), "draft");
  ok(await call("POST", `/kits/${first.id}/discard`, {}, "lead"), "discard");
  assert.deepEqual((await listed("sm-market-event")).draft, null);
  const second = ok(await draft("sm-market-event"), "draft again");
  assert.equal(second.version, 2);
  assert.deepEqual((await listed("sm-market-event")).draft, { id: second.id, version: 2 });
});

test("approvers at once: one draft is made, the others are pointed to it", async () => {
  for (let round = 0; round < 10; round++) {
    const all = await Promise.all([draft("pylon-packages", "lead"), draft("pylon-packages", "kyron"), draft("pylon-packages", "lead"), draft("pylon-packages", "kyron")]);
    const made = all.filter((r) => r.status === 200);
    const told = all.filter((r) => r.status === 409);
    assert.equal(made.length, 1, JSON.stringify(all));
    assert.equal(told.length, 3);
    for (const t of told) {
      assert.equal(t.data.error, "drafted_already");
      assert.equal(t.data.kit.id, made[0].data.id);
    }
    const open = (await pool.query("select id from studio_kits where slug = 'pylon-packages' and status = 'draft'")).rows;
    assert.deepEqual(open, [{ id: made[0].data.id }]);
    ok(await call("POST", `/kits/${made[0].data.id}/discard`, {}, "lead"), "discard for the next round");
  }
});
