// Migration 025 in a real Postgres (the stop page's links and counts), and the
// QR routes and the public stop page against it, so the routes and the
// database's own checks run together. Made-up people only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_qr_db_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_qr_db_test";

if (!URL_) {
  test("migration 025 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.GFS_PAGE_BASE = "https://pages.example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => iso(Date.now() + n * DAY);

let pool, server, base, ev, adult, youth;
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
async function refused(sql, params, pattern) {
  try {
    await q(sql, params);
  } catch (e) {
    if (pattern) assert.match(e.message, pattern, `expected ${pattern}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal: ${sql} ${JSON.stringify(params || [])}`);
}

before(async () => {
  pool = await makeSchema(URL_, S);
  setSupabase(pgSupabase(pool, S));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs", require("../routes/gfs"));
  app.use("/e", require("../routes/gfs-page"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  ev = await one(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                  values ('Dallas2027', 'Legacy Tour · Dallas', 'Legacy Tour', 'premier', 'south_central', 'Dallas', 'TX', 'America/Chicago', $1, $2, now(), 'kyron@example.com') returning *`, [D(20), D(21)]);
  const creator = (code, name, tier) => one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, created_by)
      values ($1, $2, 'south_central', $3, $4, $4, $4, 'kyron@example.com') returning *`, [code, name, tier, D(-30)]);
  adult = await creator("MAYA1", "Maya Brooks", "adult");
  youth = await creator("TEEN1", "Teen Creator", "youth");
});
after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

// A request helper for the app above, signed in as Kyron.
async function signedIn() {
  let cookie = "";
  const c = async (p, { method = "GET", body, redirect = "follow" } = {}) => {
    const r = await fetch(base + p, { method, redirect, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "x-forwarded-for": "203.0.113.60" }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  await c("/test-login", { method: "POST", body: { email: "kyron@example.com", role: "admin" } });
  return c;
}

test("before 025 runs: creators and events keep working, and the new parts say so", async () => {
  const old = await makeSchema(URL_, "gfs_qr_pre025_test", ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql"]);
  setSupabase(pgSupabase(old, "gfs_qr_pre025_test"));
  try {
    const c = await signedIn();
    // The creator form's body, with the link left blank.
    const add = await c("/api/gfs/creators", { method: "POST", body: { name: "Pre Creator", email: "pre@example.com", region: "south_central", home_city: "", notes: "", sportsclippers_url: null, contract_signed_on: D(-10), background_check_on: D(-10), safety_training_on: D(-10), tier: "adult", shadow_events: 0, lead_scout: false } });
    assert.equal(add.status, 200, JSON.stringify(add.json));
    const edit = await c(`/api/gfs/creators/${add.json.creator.id}`, { method: "PATCH", body: { name: "Pre Creator", home_city: "Waco", sportsclippers_url: "" } });
    assert.equal(edit.status, 200, JSON.stringify(edit.json));
    const e = await c("/api/gfs/events", { method: "POST", body: { name: "Pre Event", size: "one_day", region: "south_central", city: "Waco", state: "TX", starts_on: D(40) } });
    assert.equal(e.status, 200, JSON.stringify(e.json));
    const link = await c(`/api/gfs/events/${e.json.event.id}`, { method: "PATCH", body: { sportsclippers_url: "https://sportsclippers.com/pylon/waco" } });
    assert.equal(link.status, 503);
    assert.equal(link.json.error, "gfs_qr_not_set_up");
    const qr = await c(`/api/gfs/events/${e.json.event.id}/qr`);
    assert.equal(qr.status, 200, JSON.stringify(qr.json));
    assert.equal(qr.json.counts_ready, false);
    assert.equal((await c(`/e/${e.json.event.code}`)).status, 404, "the page waits for the migration");
  } finally {
    setSupabase(pgSupabase(pool, S));
    await old.query("drop schema gfs_qr_pre025_test cascade");
    await old.end();
  }
});

test("025 runs twice, and the stop's links hold to its rules", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "025_gfs_qr.sql"), "utf8").replace(/public\./g, `${S}.`);
  await pool.query(sql);
  const set = (col, v) => q(`update gfs_events set ${col} = $1 where id = $2`, [v, ev.id]);
  for (const ok of ["https://sportsclippers.com/pylon/dallas-2027", "https://www.sportsclippers.com/p?id=7#top", null]) await set("sportsclippers_url", ok);
  for (const bad of ["http://sportsclippers.com/x", "https://sportsclippers.com.evil.example/x", "https://evil.example/sportsclippers.com", "https://sportsclippers.com/a b", 'https://sportsclippers.com/"x', "https://sportsclippers.com/" + "x".repeat(300)]) {
    await refused(`update gfs_events set sportsclippers_url = $1 where id = $2`, [bad, ev.id], /sportsclippers_url_chk/);
  }
  await set("help_phone", "+15552345678");
  for (const bad of ["5552345678", "+0123", "(555) 234-5678"]) await refused(`update gfs_events set help_phone = $1 where id = $2`, [bad, ev.id], /help_phone_chk/);
  await set("qr_sources", ["field-3-sign", "vip-tent"]);
  for (const bad of [["Field-3"], ["x"], [""], ["ok-one", null], ["ab,cd"], ["ok-1,"], ["ok-1", "bad key"], Array.from({ length: 21 }, (_, i) => "spot-" + i), ["a".repeat(25)]]) {
    await refused(`update gfs_events set qr_sources = $1 where id = $2`, [bad, ev.id], /qr_sources_chk/);
  }
});

test("a youth creator can't hold a public link, before or after a tier change", async () => {
  await refused(`update gfs_creators set sportsclippers_url = 'https://sportsclippers.com/teen' where id = $1`, [youth.id], /youth_link_chk/);
  await q(`update gfs_creators set sportsclippers_url = 'https://sportsclippers.com/maya' where id = $1`, [adult.id]);
  await refused(`update gfs_creators set tier = 'youth' where id = $1`, [adult.id], /youth_link_chk/);
  await refused(`update gfs_creators set sportsclippers_url = 'https://instagram.com/maya' where id = $1`, [adult.id], /sportsclippers_url_chk/);
});

test("counts: one row per code per day, server-only, gone with the event", async () => {
  for (let i = 0; i < 3; i++) await q(`select gfs_count_hit($1, 'stop', 'scan')`, [ev.id]);
  await q(`select gfs_count_hit($1, 's:booth', 'footage')`, [ev.id]);
  await q(`select gfs_count_hit($1, 'c:MAYA1', 'creator')`, [ev.id]);
  assert.deepEqual((await q(`select source, kind, hits from gfs_qr_hits where event_id = $1 order by source, kind`, [ev.id])).map((r) => [r.source, r.kind, r.hits]), [["c:MAYA1", "creator", 1], ["s:booth", "footage", 1], ["stop", "scan", 3]]);
  await refused(`select gfs_count_hit($1, 'Stop', 'scan')`, [ev.id], /check/);
  await refused(`select gfs_count_hit($1, 's:x', 'scan')`, [ev.id], /check/);
  await refused(`select gfs_count_hit($1, 'stop', 'view')`, [ev.id], /check/);
  const fn = `${S}.gfs_count_hit(uuid, text, text)`;
  const grants = await one(`select has_function_privilege('anon', '${fn}', 'execute') as anon, has_function_privilege('authenticated', '${fn}', 'execute') as auth, has_function_privilege('service_role', '${fn}', 'execute') as svc`);
  assert.deepEqual(grants, { anon: false, auth: false, svc: true });
  assert.equal((await one(`select relrowsecurity from pg_class where oid = '${S}.gfs_qr_hits'::regclass`)).relrowsecurity, true);
  const tmp = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                         values ('Gone2027', 'Gone', 'one_day', 'south_central', 'Waco', 'TX', 'America/Chicago', $1, $1, now(), 'x') returning id`, [D(30)]);
  await q(`select gfs_count_hit($1, 'stop', 'scan')`, [tmp.id]);
  await q(`delete from gfs_events where id = $1`, [tmp.id]);
  assert.equal((await one(`select count(*)::int as n from gfs_qr_hits where event_id = $1`, [tmp.id])).n, 0);
});

test("the routes on Postgres: links saved, the page counted, the counts read back", async () => {
  let cookie = "";
  const c = async (p, { method = "GET", body, redirect = "follow" } = {}) => {
    const r = await fetch(base + p, { method, redirect, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), "x-forwarded-for": "203.0.113.50" }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
  await c("/test-login", { method: "POST", body: { email: "kyron@example.com", role: "admin" } });
  const saved = await c(`/api/gfs/events/${ev.id}`, { method: "PATCH", body: { sportsclippers_url: "https://sportsclippers.com/pylon/dallas-2027", help_phone: "214-555-0199", qr_sources: ["Team tent"] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal((await one(`select help_phone from gfs_events where id = $1`, [ev.id])).help_phone, "+12145550199");
  assert.equal((await c(`/api/gfs/events/${ev.id}`, { method: "PATCH", body: { qr_sources: ["Bad!!", "x"] } })).status, 400);

  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'lead', 'confirmed', 'x')`, [ev.id, adult.id]);
  const page = await c(`/e/Dallas2027?c=MAYA1`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<h2>Maya is on the crew<\/h2>/);
  assert.ok(!page.text.includes("Brooks"));
  const go = await c(`/e/Dallas2027/go/footage?s=team-tent`, { redirect: "manual" });
  assert.equal(go.status, 302);
  assert.equal(new URL(go.headers.get("location")).searchParams.get("utm_content"), "s-team-tent");
  await new Promise((r) => setTimeout(r, 100));
  const d = await c(`/api/gfs/events/${ev.id}/qr`);
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.counts_ready, true);
  assert.deepEqual(d.json.codes.find((x) => x.key === "c-MAYA1").counts, { scan: 1, footage: 0, creator: 1 }, "this scan, plus the earlier direct call");
  assert.deepEqual(d.json.codes.find((x) => x.key === "s-team-tent").counts, { scan: 0, footage: 1, creator: 0 });
  assert.equal(d.json.totals.scan, 4);
});
