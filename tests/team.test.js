// The team — invites, joining, roles, and what each role may do in Studio.
// In-memory Supabase stand-in; real express-session. No network.
//
//   node --test tests/team.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

process.env.ADMIN_EMAILS = "kyron@example.com";
const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const T = require("../utils/team");

let db;
let server;
let base;

before(async () => {
  db = fakeSupabase(
    {
      users: [
        { email: "kyron@example.com", hash: bcrypt.hashSync("owner-password-1", 4), role: "admin" },
        { email: "max@example.com", hash: bcrypt.hashSync("max-existing-pw", 4), role: "creator" },
      ],
    },
    { unique: { users: ["email"], team_invites: ["token_hash"] } }
  );
  setSupabase(db);
  const studio = require("../routes/studio-agents");
  studio._setDeps({ sb: db, run: async () => ({ output: "x", eval_status: "passed", trace: [], usage: {} }) });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  // Test-only sign-in (the real one checks a password).
  app.post("/test-login", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    req.session.save(() => res.json({ ok: true }));
  });
  app.use("/api/team", require("../routes/team"));
  app.use("/api/studio-agents", studio);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

function client() {
  let cookie = "";
  return async function call(path, { method = "GET", body } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let json = null;
    try {
      json = await r.json();
    } catch {}
    return { status: r.status, json };
  };
}

const owner = client();
let memberToken;

test("only the owner can invite; the link is a one-time token shown once", async () => {
  await owner("/test-login", { method: "POST", body: { email: "kyron@example.com", role: "admin" } });
  const stranger = client();
  await stranger("/test-login", { method: "POST", body: { email: "someone@example.com", role: "creator" } });
  assert.equal((await stranger("/api/team/invites", { method: "POST", body: { email: "dir@example.com" } })).status, 403);
  assert.equal((await stranger("/api/team")).json.error, "not_on_team");

  const bad = await owner("/api/team/invites", { method: "POST", body: { email: "not-an-email", role: "member" } });
  assert.equal(bad.json.error, "invalid_email");
  const ownerRole = await owner("/api/team/invites", { method: "POST", body: { email: "dir@example.com", role: "owner" } });
  assert.equal(ownerRole.json.error, "invalid_role");

  const r = await owner("/api/team/invites", { method: "POST", body: { email: "Dir@Example.com", name: "The Director", role: "member", tools: ["studio", "crm"] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.invite.email, "dir@example.com");
  assert.deepEqual(r.json.invite.tools, ["studio"], "owner-only tools can't be granted");
  assert.match(r.json.path, /^\/app\/#join\/[A-Za-z0-9_-]{40,}$/);
  memberToken = r.json.token;
  const stored = db.tables.team_invites[0];
  assert.notEqual(stored.token_hash, memberToken, "only a hash is stored");
  assert.equal((await owner("/api/team/invites")).json.invites.length, 1);
});

test("joining: a short password is refused; joining signs you in as a member; the link then stops working", async () => {
  const dir = client();
  const peek = await dir(`/api/team/join/${memberToken}`);
  assert.equal(peek.json.role, "member");
  assert.equal(peek.json.account_exists, false);
  assert.equal((await dir("/api/team/join", { method: "POST", body: { token: memberToken, password: "short" } })).json.error, "password_too_short");
  const ok = await dir("/api/team/join", { method: "POST", body: { token: memberToken, password: "a-long-password", name: "Dee" } });
  assert.equal(ok.status, 200);
  const me = await dir("/api/team/me");
  assert.equal(me.json.on_team, true);
  assert.equal(me.json.role, "member");
  assert.deepEqual(me.json.tools, ["studio"]);
  assert.equal(db.tables.users.find((u) => u.email === "dir@example.com").role, "creator", "an account, not staff");
  assert.equal((await client()(`/api/team/join/${memberToken}`)).status, 404);
  assert.equal((await client()("/api/team/join", { method: "POST", body: { token: memberToken, password: "a-long-password" } })).status, 404);
});

test("an existing account joins with its own password", async () => {
  const inv = await owner("/api/team/invites", { method: "POST", body: { email: "max@example.com", role: "approver" } });
  const max = client();
  assert.equal((await max(`/api/team/join/${inv.json.token}`)).json.account_exists, true);
  assert.equal((await max("/api/team/join", { method: "POST", body: { token: inv.json.token, password: "wrong-password" } })).status, 401);
  const ok = await max("/api/team/join", { method: "POST", body: { token: inv.json.token, password: "max-existing-pw" } });
  assert.equal(ok.json.role, "approver");
});

test("the team list: everyone sees names and roles; only owners see other people's emails", async () => {
  const dir = client();
  await dir("/test-login", { method: "POST", body: { email: "dir@example.com", role: "creator" } });
  const seen = (await dir("/api/team")).json.people;
  assert.deepEqual(seen.map((p) => p.role), ["owner", "member", "approver"]);
  assert.equal(seen.find((p) => p.role === "owner").email, null);
  assert.equal(seen.find((p) => p.you).email, "dir@example.com");
  const all = (await owner("/api/team")).json.people;
  assert.equal(all.find((p) => p.role === "owner").email, "kyron@example.com");
});

test("Studio: members can't approve; approvers can; only the owner unlocks rule cards", async () => {
  const dir = client();
  await dir("/test-login", { method: "POST", body: { email: "dir@example.com", role: "creator" } });
  assert.equal((await dir("/api/studio-agents/kits")).status, 200, "members open kits");
  const denied = await dir("/api/studio-agents/kits/00000000-0000-4000-8000-000000000000/approve", { method: "POST" });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error, "role_too_low");

  const max = client();
  await max("/test-login", { method: "POST", body: { email: "max@example.com", role: "creator" } });
  const allowed = await max("/api/studio-agents/kits/00000000-0000-4000-8000-000000000000/approve", { method: "POST" });
  assert.equal(allowed.status, 404, "past the role check; no such draft");
  const unlock = await max("/api/studio-agents/run", { method: "POST", body: { role: "kit-refresher", slug: "same-work", brief: "Change a rule card.", allow_rule_changes: true } });
  assert.equal(unlock.json.error, "rule_changes_need_the_owner");
});

test("viewers can open kits but not start runs; the owner can change roles and remove people", async () => {
  const dir = client();
  await dir("/test-login", { method: "POST", body: { email: "dir@example.com", role: "creator" } });
  assert.equal((await owner("/api/team/members/dir@example.com", { method: "PATCH", body: { role: "viewer" } })).status, 200);
  assert.equal((await dir("/api/studio-agents/kits")).status, 200);
  const run = await dir("/api/studio-agents/run", { method: "POST", body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the gear please." } });
  assert.equal(run.status, 403);
  assert.equal((await dir("/api/team/members/max@example.com", { method: "DELETE" })).status, 403);
  assert.equal((await owner("/api/team/members/dir@example.com", { method: "DELETE" })).status, 200);
  assert.equal((await dir("/api/studio-agents/kits")).json.error, "not_on_team");
});

test("invites can be renewed (new link) and cancelled; activity records who did what", async () => {
  const inv = await owner("/api/team/invites", { method: "POST", body: { email: "ed@example.com", role: "member" } });
  const renewed = await owner(`/api/team/invites/${inv.json.invite.id}/renew`, { method: "POST" });
  assert.notEqual(renewed.json.token, inv.json.token);
  assert.equal((await client()(`/api/team/join/${inv.json.token}`)).status, 404, "the old link stops working");
  assert.equal((await client()(`/api/team/join/${renewed.json.token}`)).status, 200);
  assert.equal((await owner(`/api/team/invites/${inv.json.invite.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await client()(`/api/team/join/${renewed.json.token}`)).status, 404);

  const acts = (await owner("/api/team/activity")).json.activity.map((a) => a.action);
  for (const a of ["invited", "joined", "changed_member", "removed_member", "cancelled_invite"]) assert.ok(acts.includes(a), a);
});

test("an API key acts as a member: it can't approve", () => {
  assert.equal(T.can({ role: "member", tools: ["studio"], owner: false }, "studio", "approver"), false);
  assert.equal(T.can({ role: "approver", tools: ["studio"], owner: false }, "studio", "approver"), true);
  assert.equal(T.can({ role: "approver", tools: [], owner: false }, "studio", "viewer"), false, "needs the tool");
  assert.equal(T.can({ role: "owner", tools: [], owner: true }, "studio", "approver"), true);
});

test("you can delete your own account from the app; the owner's can't be", async () => {
  const inv = await owner("/api/team/invites", { method: "POST", body: { email: "leaving@example.com", name: "Leaving", role: "approver" } });
  const me = client();
  assert.equal((await me("/api/team/join", { method: "POST", body: { token: inv.json.token, password: "leaving-password-1", name: "Leaving" } })).status, 200);
  db.tables.agent_runs = db.tables.agent_runs || [];
  db.tables.agent_runs.push({ id: "r-leaving", role: "kit-refresher", status: "completed", created_by: "leaving@example.com" });
  db.tables.studio_kits = db.tables.studio_kits || [];
  db.tables.studio_kits.push({ id: "k-leaving", slug: "same-work", version: 9, status: "approved", created_by: "leaving@example.com", approved_by: "leaving@example.com" });
  db.tables.push_subscriptions = [{ id: "p1", email: "leaving@example.com", endpoint: "apns:" + "a".repeat(64), kind: "apns" }];

  assert.equal((await me("/api/team/me", { method: "DELETE", body: {} })).json.error, "confirm_required");
  assert.equal((await owner("/api/team/me", { method: "DELETE", body: { confirm: true } })).json.error, "owner_account");

  const del = await me("/api/team/me", { method: "DELETE", body: { confirm: true } });
  assert.equal(del.status, 200);
  assert.equal(db.tables.users.some((u) => u.email === "leaving@example.com"), false, "the sign-in is gone");
  assert.equal(db.tables.team_members.some((m) => m.email === "leaving@example.com"), false);
  assert.equal(db.tables.team_invites.some((i) => i.email === "leaving@example.com"), false);
  assert.equal(db.tables.push_subscriptions.length, 0);
  assert.equal(JSON.stringify(db.tables.team_activity).includes("leaving@example.com"), false, "the activity log no longer names them");
  assert.equal(db.tables.agent_runs.find((r) => r.id === "r-leaving").created_by, null);
  const kit = db.tables.studio_kits.find((k) => k.id === "k-leaving");
  assert.equal(kit.status, "approved", "what they approved stays approved");
  assert.equal(kit.approved_by, "former teammate");
  assert.equal((await me("/api/team/me")).status, 401, "signed out");
  const acts = (await owner("/api/team/activity")).json.activity;
  assert.ok(acts.some((a) => a.action === "deleted_account" && a.actor_name === "A former teammate"));
});
