// Sessions on Supabase — a sign-in survives a server restart (a new store on
// the same table), expired sessions are refused, and touches are throttled.
// In-memory fake of the Supabase client; no network.
//
//   node --test tests/session-store.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const { SupabaseSessionStore, toPg } = require("../utils/supabase-session-store");

function fakeSupabase() {
  const rows = new Map();
  const calls = { select: 0, upsert: 0, update: 0, delete: 0 };
  function q() {
    const st = { op: "select", filters: [] };
    const api = {
      select() { st.op = st.op === "select" ? "select" : st.op; return api; },
      eq(c, v) { st.filters.push((r) => r[c] === v); return api; },
      lt(c, v) { st.filters.push((r) => r[c] < v); return api; },
      maybeSingle() { st.single = true; return api; },
      upsert(row) { st.op = "upsert"; st.row = row; return api; },
      update(patch) { st.op = "update"; st.patch = patch; return api; },
      delete() { st.op = "delete"; return api; },
      then(res, rej) {
        return Promise.resolve().then(() => {
          calls[st.op]++;
          const match = [...rows.values()].filter((r) => st.filters.every((f) => f(r)));
          if (st.op === "upsert") { rows.set(st.row.sid, JSON.parse(JSON.stringify(st.row))); return { error: null }; }
          if (st.op === "update") { match.forEach((r) => Object.assign(r, st.patch)); return { error: null }; }
          if (st.op === "delete") { match.forEach((r) => rows.delete(r.sid)); return { error: null }; }
          return { data: st.single ? match[0] || null : match, error: null };
        }).then(res, rej);
      },
    };
    return api;
  }
  return { rows, calls, from: () => q() };
}

function appWith(store) {
  const app = express();
  app.use(session({ secret: "test-secret", resave: false, saveUninitialized: false, store, cookie: { maxAge: 7 * 24 * 3600 * 1000 } }));
  app.post("/login", (req, res) => { req.session.userEmail = "kyron@example.com"; req.session.save(() => res.json({ ok: true })); });
  app.get("/me", (req, res) => res.json({ email: (req.session && req.session.userEmail) || null }));
  app.post("/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
  return app;
}

async function listen(app) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("a sign-in survives a restart: a new store on the same table still knows the cookie", async () => {
  const db = fakeSupabase();
  const a = await listen(appWith(new SupabaseSessionStore({ client: db, prune: false })));
  const login = await fetch(`${a.base}/login`, { method: "POST" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(db.rows.size, 1);
  a.server.close();

  // "Deploy": a fresh process, fresh store, same database.
  const b = await listen(appWith(new SupabaseSessionStore({ client: db, prune: false })));
  const me = await (await fetch(`${b.base}/me`, { headers: { cookie } })).json();
  assert.equal(me.email, "kyron@example.com");

  await fetch(`${b.base}/logout`, { method: "POST", headers: { cookie } });
  assert.equal(db.rows.size, 0);
  const after = await (await fetch(`${b.base}/me`, { headers: { cookie } })).json();
  assert.equal(after.email, null);
  b.server.close();
});

test("expired sessions are refused and pruned", async () => {
  const db = fakeSupabase();
  const store = new SupabaseSessionStore({ client: db, prune: false });
  db.rows.set("old", { sid: "old", sess: { cookie: {}, userEmail: "x@example.com" }, expire: toPg(new Date(Date.now() - 1000)) });
  const got = await new Promise((r) => store.get("old", (e, s) => r(s)));
  assert.equal(got, null);
  await store.prune();
  assert.equal(db.rows.has("old"), false);
});

test("reads are cached briefly and expiry is pushed forward at most hourly", async () => {
  const db = fakeSupabase();
  const store = new SupabaseSessionStore({ client: db, prune: false });
  const sess = { cookie: { maxAge: 3600 * 1000 }, userEmail: "k@example.com" };
  await new Promise((r) => store.set("s1", sess, r));
  for (let i = 0; i < 5; i++) await new Promise((r) => store.get("s1", r));
  assert.equal(db.calls.select, 0, "served from cache after set");
  for (let i = 0; i < 5; i++) await new Promise((r) => store.touch("s1", sess, r));
  assert.equal(db.calls.update, 0, "touch throttled");
});
