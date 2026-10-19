// Notifications — keys made once and kept, subscriptions per device, dead
// devices dropped, and Studio telling the right people when a draft, a brief
// or an approval happens. No network: the sender is swapped for a recorder.
//
//   node --test tests/push.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const P = require("../utils/push");
const BASE = require("../agents/studio/kits/same-work.v1.json");

let db;
let sent = [];
let server;
let base;

const sub = (n) => ({ endpoint: `https://push.example.com/device-${n}`, keys: { p256dh: "BPk" + n, auth: "au" + n } });

before(async () => {
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "approver@example.com", name: "A", role: "approver", tools: ["studio"], status: "active" },
        { email: "member@example.com", name: "M", role: "member", tools: ["studio"], status: "active" },
        { email: "viewer@example.com", name: "V", role: "viewer", tools: ["studio"], status: "active" },
      ],
    },
    {
      unique: { app_config: ["key"] },
      rpc: {
        studio_kit_approve: (tables, { p_id, p_by }) => {
          const row = tables.studio_kits.find((r) => r.id === p_id);
          Object.assign(row, { status: "approved", approved_by: p_by });
          return { data: p_id, error: null };
        },
      },
    }
  );
  setSupabase(db);
  P.setSender(async (s, payload) => {
    if (s.endpoint.endsWith("gone")) {
      const e = new Error("gone");
      e.statusCode = 410;
      throw e;
    }
    sent.push({ to: s.email, ...payload });
  });

  const studio = require("../routes/studio-agents");
  const studioPack = require("../agents/studio/orchestrator");
  studio._setDeps({
    sb: db,
    run: async ({ role, scope }) => {
      const tools = Object.fromEntries(studioPack.toolsForRun(role, { scope }).filter((t) => t.run).map((t) => [t.name, (i) => t.run(i || {})]));
      const cams = BASE.columns[5].cards.find((k) => k.title === "Cameras");
      await tools.kit_put_card({ column: "Gear", card: { ...cams, body: cams.body + "<p>Checked Nov 1, 2026.</p>" }, reason: "re-check 2026-11-01" });
      return { output: "Changed Cameras.", eval_status: "passed", retry_count: 0, trace: [], usage: {} };
    },
  });

  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    req.session.save(() => res.json({ ok: true }));
  });
  app.use("/api/push", require("../routes/push"));
  app.use("/api/studio-agents", studio);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

function client() {
  let cookie = "";
  return async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
}
async function as(email, role = "creator") {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("the key pair is made once and kept; env keys win", async () => {
  const k1 = await P.vapidKeys();
  const k2 = await P.vapidKeys();
  assert.equal(k1.publicKey, k2.publicKey);
  assert.equal(db.tables.app_config.length, 1);
  const kyron = await as("kyron@example.com", "admin");
  assert.equal((await kyron("/api/push/key")).json.publicKey, k1.publicKey);
  assert.equal((await client()("/api/push/key")).status, 401);
});

test("subscribing stores the device under your own email; bad subscriptions are refused", async () => {
  const m = await as("member@example.com");
  assert.equal((await m("/api/push/subscribe", { method: "POST", body: { subscription: { endpoint: "http://insecure" } } })).status, 400);
  assert.equal((await m("/api/push/subscribe", { method: "POST", body: { subscription: sub(1) } })).status, 200);
  assert.equal((await m("/api/push/subscribe", { method: "POST", body: { subscription: sub(1) } })).status, 200, "same device again: one row");
  assert.equal(db.tables.push_subscriptions.length, 1);
  assert.equal(db.tables.push_subscriptions[0].email, "member@example.com");
  sent = [];
  await m("/api/push/test", { method: "POST" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "member@example.com");
});

test("a device that's gone is dropped", async () => {
  db.tables.push_subscriptions.push({ id: "x1", email: "viewer@example.com", endpoint: "https://push.example.com/gone", p256dh: "p", auth: "a", fail_count: 0 });
  await P.notify(["viewer@example.com"], { title: "t", body: "b", url: "/app/" });
  assert.equal(db.tables.push_subscriptions.some((s) => s.endpoint.endsWith("gone")), false);
});

test("a saved draft tells the approvers, the owner and whoever started it; not other members", async () => {
  for (const [i, email] of ["kyron@example.com", "approver@example.com", "viewer@example.com"].entries()) {
    db.tables.push_subscriptions.push({ id: "s" + i, email, endpoint: sub(10 + i).endpoint, p256dh: "p", auth: "a", fail_count: 0 });
  }
  sent = [];
  const m = await as("member@example.com");
  const start = await m("/api/studio-agents/run", { method: "POST", body: { role: "kit-refresher", slug: "same-work", brief: "Re-check the cameras card." } });
  assert.equal(start.status, 200);
  for (let i = 0; i < 50 && sent.length < 3; i++) await wait(20);
  const to = sent.map((s) => s.to).sort();
  assert.deepEqual(to, ["approver@example.com", "kyron@example.com", "member@example.com"]);
  assert.match(sent[0].title, /^Draft v2 of Same Work is ready$/);
  assert.match(sent[0].url, /^\/app\/#review\/[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(sent).includes("Cameras"), "no card text in the notification");

  // Approving tells everyone else on the team.
  const draftId = sent[0].url.split("/").pop();
  sent = [];
  const a = await as("approver@example.com");
  assert.equal((await a(`/api/studio-agents/kits/${draftId}/approve`, { method: "POST" })).status, 200);
  for (let i = 0; i < 50 && sent.length < 3; i++) await wait(20);
  assert.deepEqual(sent.map((s) => s.to).sort(), ["kyron@example.com", "member@example.com", "viewer@example.com"]);
  assert.equal(sent[0].title, "Same Work v2 is approved");
});

test("teamEmails: owners always, then members at or above the role", async () => {
  assert.deepEqual((await P.teamEmails("approver")).sort(), ["approver@example.com", "kyron@example.com"]);
  assert.equal((await P.teamEmails("viewer")).length, 4);
});
