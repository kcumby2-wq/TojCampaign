// The season slate: the tour's stops and the films planned against each
// (routes/studio-films.js /slate), against a real Postgres.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL_ = process.env.TEST_DATABASE_URL;
const SCHEMA = "gfs_studio_slate_test";
if (!URL_) {
  test("studio season slate (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}
process.env.ADMIN_EMAILS = "kyron@toj.test";

const express = require("express");
const session = require("express-session");
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const T = require("../utils/team");

let pool, server, base;
const cookies = {};
const as = { kyron: "kyron@toj.test", dir: "dir@toj.test", out: "out@toj.test" };

before(async () => {
  pool = await makeSchema(URL_, SCHEMA, ["018_studio_kits.sql", "019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "039_studio_films.sql"]);
  setSupabase(pgSupabase(pool, SCHEMA));
  await pool.query("insert into team_members (email, role, tools) values ('dir@toj.test', 'member', array['studio']), ('out@toj.test', 'member', array['gfs'])");
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "slate", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.email === as.kyron ? "staff" : "user"; res.json({ ok: true }); });
  app.use("/api/studio-films", require("../routes/studio-films"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [k, email] of Object.entries(as)) {
    const r = await fetch(base + "/__test/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
    cookies[k] = r.headers.get("set-cookie").split(";")[0];
  }
});
after(async () => {
  server && server.close();
  setSupabase(null);
  if (pool) await pool.end();
});
beforeEach(() => T.forget());

async function call(method, path, body, who = "kyron") {
  const r = await fetch(base + "/api/studio-films" + path, { method, headers: { Cookie: cookies[who], ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function stop(code, name, from, to, status = "planning") {
  return (await pool.query("insert into gfs_events (code, name, series, size, region, city, state, starts_on, ends_on, status, created_by) values ($1, $2, 'Pylon 7v7', 'premier', 'south_central', 'Dallas', 'TX', $3, $4, $5, 'kyron@toj.test') returning id", [code, name, day(from), day(to), status])).rows[0].id;
}

test("the slate lists the tour's stops in order, each with its films, and the films planned for none", async () => {
  const dallas = await stop("DAL27", "Pylon Dallas", 10, 11);
  const houston = await stop("HOU27", "Pylon Houston", 40, 40);
  await stop("OLD26", "Pylon last spring", -60, -59);
  await stop("CAN27", "Pylon cancelled", 20, 20, "cancelled");
  await stop("FAR28", "Pylon next fall", 300, 301);
  // A member plans a film for a stop; one more in progress is planned for none.
  const a = ok(await call("POST", "/films", { kit_slug: "same-work", title: "S0101 hero", lane: "youth", format: "hero", athlete_id: "S0101", gfs_event_id: dallas }, "dir"), "planned film").film;
  const b = ok(await call("POST", "/films", { kit_slug: "same-work", title: "S0102 hero", lane: "youth", format: "hero", athlete_id: "S0102" }, "dir"), "unplanned film").film;
  const s = ok(await call("GET", "/slate", undefined, "dir"), "slate");
  assert.deepEqual(s.events.map((e) => e.code), ["DAL27", "HOU27"]);
  assert.deepEqual(s.events[0].films.map((f) => f.id), [a.id]);
  assert.equal(s.events[0].films[0].where.state, "active");
  assert.deepEqual(s.events[1].films, []);
  assert.deepEqual(s.unplaced.map((f) => f.id), [b.id]);
  // Linking a film to a stop, and unlinking it, is an ordinary edit of the film.
  ok(await call("PATCH", `/films/${b.id}`, { seen: b.updated_at, gfs_event_id: houston }, "dir"), "link");
  const s2 = ok(await call("GET", "/slate", undefined, "dir"), "slate again");
  assert.deepEqual(s2.events[1].films.map((f) => f.id), [b.id]);
  assert.deepEqual(s2.unplaced, []);
  const film = ok(await call("GET", `/films/${b.id}`, undefined, "dir"), "the room");
  assert.equal(film.stop.name, "Pylon Houston");
  ok(await call("PATCH", `/films/${b.id}`, { seen: s2.events[1].films[0].updated_at, gfs_event_id: null }, "dir"), "unlink");
  assert.deepEqual(ok(await call("GET", "/slate", undefined, "dir"), "slate").unplaced.map((f) => f.id), [b.id]);
});

test("a film is planned only against a stop that's on the calendar, and the slate is for Studio", async () => {
  const r = await call("POST", "/films", { kit_slug: "same-work", title: "S0201 hero", lane: "youth", format: "hero", athlete_id: "S0201", gfs_event_id: "00000000-0000-4000-8000-000000000000" }, "dir");
  assert.deepEqual([r.status, r.data.fields], [400, ["gfs_event_id"]]);
  assert.equal((await call("GET", "/slate", undefined, "out")).status, 403);
  const wide = ok(await call("GET", `/slate?from=${day(-90)}&to=${day(400)}`, undefined, "dir"), "a wider window");
  assert.ok(wide.events.some((e) => e.code === "OLD26") && wide.events.some((e) => e.code === "FAR28"));
});
