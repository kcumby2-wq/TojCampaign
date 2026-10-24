// Migration 027 in a real Postgres (the asset library), and the asset routes
// against it, so the routes and the database's own rules run together.
// Made-up people and athletes only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schemas (gfs_assets_db_test, gfs_assets_pre_test), which it
// DROPS and recreates. Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_assets_db_test";
const PRE = "gfs_assets_pre_test";

if (!URL_) {
  test("migration 027 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
const { makeSchema, pgSupabase, ALL } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const A = require("../utils/gfs-assets");
const P = require("../utils/push");

let pool, prePool, server, base, dallas, chicago;
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
const event = (code, region, state) => one(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
  values ($1, $2, 'Legacy Tour', 'premier', $3, $4, $5, 'America/Chicago', current_date, current_date, now(), 'kyron@example.com') returning *`, [code, "Legacy Tour · " + code, region, code, state]);
let rid = 0;
const roster = (ev, extra = {}) => {
  const r = { team: "Bulldogs", division: "14U", jersey: String(10 + (rid % 80)), under_13: false, consent_capture: true, consent_3d: true, consent_nft: true, consent_marketing: true, do_not_publish: false, ...extra };
  rid++;
  return one(`insert into gfs_roster (event_id, roster_id, team, division, jersey, under_13, consent_capture, consent_3d, consent_nft, consent_marketing, do_not_publish)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *`, [ev.id, "ST-" + rid, r.team, r.division, r.jersey, r.under_13, r.consent_capture, r.consent_3d, r.consent_nft, r.consent_marketing, r.do_not_publish]);
};
const asset = (ev, kind, extra = {}) => one("insert into gfs_assets (event_id, kind, title, created_by, format) values ($1, $2, $3, 'wes@example.com', $4) returning *", [ev ? ev.id : null, kind, extra.title || kind, extra.format || null]);
const link = (a, r) => q("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'wes')", [a.id, r.id]);
const blocksOf = async (id) => (await one("select gfs_asset_blocks(a) as b from gfs_assets a where id = $1", [id])).b;

before(async () => {
  pool = await makeSchema(URL_, S, ALL);
  dallas = await event("Dallas", "south_central", "TX");
  chicago = await event("Chicago", "midwest", "IL");
  await q("insert into team_members (email, name, role, tools, regions) values ('wes@example.com', 'Wes Director', 'member', array['gfs'], array['south_central']), ('abby@example.com', 'Abby Approver', 'approver', array['gfs'], '{}')");
  setSupabase(pgSupabase(pool, S));
  P.setSender(async () => ({}));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs/assets", require("../routes/gfs-assets"));
  app.use("/api/gfs", require("../routes/gfs"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
  if (prePool) await prePool.end();
  P.setSender(null);
});
async function as(email, role) {
  let cookie = "";
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  await call("/test-login", { method: "POST", body: { email, role } });
  return call;
}

test("027: athletes only on a draft, from the stop's roster, none in a World or a brand asset, one in a Moment or an NFT", async () => {
  const w = await asset(dallas, "venue_world");
  const b = await asset(null, "brand");
  const m = await asset(dallas, "moment", { format: "4d" });
  const r1 = await roster(dallas), r2 = await roster(dallas), rc = await roster(chicago);
  assert.equal(m.region, "south_central", "the region comes from the stop");
  await refused("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [w.id, r1.id], /gfs_asset_no_athletes/);
  await refused("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [b.id, r1.id], /gfs_asset_no_athletes/);
  await refused("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [m.id, rc.id], /gfs_asset_not_on_roster/);
  await link(m, r1);
  await refused("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [m.id, r2.id], /gfs_asset_one_athlete/);
  const snap = await one("select team, jersey from gfs_asset_athletes where asset_id = $1", [m.id]);
  assert.deepEqual([snap.team, snap.jersey], [r1.team, r1.jersey], "team and jersey copied when added");
  await q("update gfs_assets set stage = 'review' where id = $1", [m.id]);
  await refused("delete from gfs_asset_athletes where asset_id = $1", [m.id], /gfs_asset_locked/);
  await refused("insert into gfs_assets (kind, title, created_by) values ('edit', 'x', 'w')", [], /check constraint/);
  await refused("insert into gfs_assets (event_id, kind, title, created_by, stage) values ($1, 'edit', 'x', 'w', 'review')", [dallas.id], /gfs_asset_starts_as_draft/);
  await refused("update gfs_assets set kind = 'edit' where id = $1", [m.id], /gfs_asset_fixed/);
});

test("027: approved and live need everything; live only where the kind lives; retired is final; reviewed records stay", async () => {
  const r = await roster(dallas);
  const m = await asset(dallas, "moment");
  await link(m, r);
  await q("update gfs_assets set stage = 'review' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [m.id], /gfs_asset_blocked/);
  await q("update gfs_assets set deidentified_at = now(), deidentified_by = 'abby', tier4_at = now(), tier4_by = 'abby' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'approved' where id = $1", [m.id], /check constraint/);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'live', location = 'gfs_storage', ref = 'Dallas-WR-1' where id = $1", [m.id], /gfs_asset_live_location/);
  await refused("update gfs_assets set location = 'gfs_storage', ref = 'a/b' where id = $1", [m.id], /check constraint/);
  await refused("update gfs_assets set location = 'link', ref = 'https://x.example.com' where id = $1", [m.id], /check constraint/);
  await q("update gfs_assets set stage = 'live', location = 'family_library', ref = 'lib-1' where id = $1", [m.id]);
  await refused("update gfs_assets set ref = 'lib-2' where id = $1", [m.id], /gfs_asset_locked/);
  await refused("update gfs_assets set title = 'x' where id = $1", [m.id], /gfs_asset_locked/);
  await refused("delete from gfs_assets where id = $1", [m.id], /gfs_asset_keep/);
  await q("update gfs_assets set stage = 'retired', retire_reason = 'withdrawn', retired_by = 'wes', ref = null where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'live' where id = $1", [m.id], /gfs_asset_retired/);
  await refused("update gfs_assets set ref = 'lib-9' where id = $1", [m.id], /gfs_asset_retired/);
  await q("delete from gfs_asset_athletes where asset_id = $1", [m.id]);
  // Stage order: no skipping review.
  const e = await asset(dallas, "edit");
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'a' where id = $1", [e.id], /gfs_asset_stage/);
});

test("027: the database's reasons match the app's, kind by kind", async () => {
  const rows = [
    await roster(dallas),
    await roster(dallas, { under_13: null }),
    await roster(dallas, { division: "12U" }),
    await roster(dallas, { consent_3d: false, consent_nft: false, consent_marketing: false }),
    await roster(dallas, { consent_capture: false }),
    await roster(dallas, { do_not_publish: true }),
  ];
  for (const kind of ["moment", "narrative_nft", "edit"]) {
    for (const r of rows) {
      const a = await asset(dallas, kind);
      await link(a, r);
      const row = await one("select * from gfs_assets where id = $1", [a.id]);
      const fresh = await one("select * from gfs_roster where id = $1", [r.id]);
      const app = A.assetBlocks(row, [{ roster: fresh, team: fresh.team, jersey: fresh.jersey }], dallas, null).sort();
      assert.deepEqual((await blocksOf(a.id)).sort(), app, `${kind} · ${r.roster_id}`);
    }
  }
  // A roster change after the athlete was added.
  const r = await roster(dallas);
  const a = await asset(dallas, "edit");
  await link(a, r);
  await q("update gfs_roster set jersey = '99' where id = $1", [r.id]);
  assert.ok((await blocksOf(a.id)).includes("roster_changed:" + r.id));
  // An Illinois Moment, a World Pass and its World, sponsor marks.
  const il = await asset(chicago, "moment");
  assert.ok((await blocksOf(il.id)).includes("illinois_hold"));
  const w = await asset(dallas, "venue_world");
  const wp = await one("insert into gfs_assets (event_id, kind, title, created_by, source_asset_id) values ($1, 'world_pass', 'Pass', 'w', $2) returning *", [dallas.id, w.id]);
  assert.deepEqual((await blocksOf(wp.id)).sort(), ["price", "source_world"]);
  const src = await one("select * from gfs_assets where id = $1", [w.id]);
  assert.deepEqual(A.assetBlocks(wp, [], dallas, src).sort(), ["price", "source_world"]);
  await q("update gfs_assets set school_venue = true where id = $1", [w.id]);
  const e = await asset(dallas, "edit");
  await q("update gfs_assets set sponsor_marks = true where id = $1", [e.id]);
  assert.deepEqual(await blocksOf(e.id), ["marks_licensed"]);
});

test("027: a takedown isn't off every surface while a live asset shows the athlete; the clips rule still holds", async () => {
  const r = await roster(dallas);
  const m = await asset(dallas, "moment");
  await link(m, r);
  await q("update gfs_assets set stage = 'review', deidentified_at = now(), deidentified_by = 'a', tier4_at = now(), tier4_by = 'a' where id = $1", [m.id]);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'a' where id = $1", [m.id]);
  await q("update gfs_assets set stage = 'live', location = 'family_library', ref = 'lib-7' where id = $1", [m.id]);
  const td = await one("insert into gfs_takedowns (event_id, region, roster_id, team, reason, logged_by) values ($1, 'south_central', $2, $3, 'safety_request', 'wes') returning *", [dallas.id, r.roster_id, r.team]);
  assert.ok(td.other_due_at && td.pylon_due_at, "the clock still runs");
  assert.ok((await blocksOf(m.id)).includes("takedown:" + r.id), "the athlete went do-not-publish");
  await refused("update gfs_takedowns set other_done_at = now(), other_done_by = 'wes' where id = $1", [td.id], /gfs_takedown_assets_out/);
  // A clip still out stops it too, as before.
  const r2 = await roster(dallas);
  const c = await one(`insert into gfs_clips (event_id, log_key, file, roster_row, match, logged_by) values ($1, 'k-1', '7-EndZone-001.mp4', $2, 'matched', 'w') returning id`, [dallas.id, r2.id]);
  for (const st of ["tagged", "edited"]) await q("update gfs_clips set stage = $2 where id = $1", [c.id, st]);
  await q("update gfs_clips set stage = 'approved', approved_by = 'a', approved_at = now() where id = $1", [c.id]);
  await q("update gfs_clips set family_export_at = now() where id = $1", [c.id]);
  await q("update gfs_clips set delivered_at = now() where id = $1", [c.id]);
  const td2 = await one("insert into gfs_takedowns (event_id, region, roster_id, team, reason, logged_by) values ($1, 'south_central', $2, $3, 'consent_withdrawn', 'wes') returning *", [dallas.id, r2.roster_id, r2.team]);
  await refused("update gfs_takedowns set other_done_at = now(), other_done_by = 'wes' where id = $1", [td2.id], /gfs_takedown_clips_out/);
  // Retired: done.
  await q("update gfs_assets set stage = 'retired', retire_reason = 'takedown', retired_by = 'wes' where id = $1", [m.id]);
  await q("update gfs_takedowns set other_done_at = now(), other_done_by = 'wes' where id = $1", [td.id]);
  assert.ok((await one("select other_done_at from gfs_takedowns where id = $1", [td.id])).other_done_at);
});

test("027: server only (RLS on, functions not callable by the API roles), and it runs twice", async () => {
  for (const t of ["gfs_assets", "gfs_asset_athletes"]) {
    const r = await one("select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2", [S, t]);
    assert.equal(r.relrowsecurity, true, t);
  }
  for (const sig of [`${S}.gfs_asset_text_ok(text)`, `${S}.gfs_asset_blocks(${S}.gfs_assets)`, `${S}.gfs_asset_live_location(text)`]) {
    assert.equal((await one("select has_function_privilege('anon', $1, 'execute') as ok", [sig])).ok, false, sig);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'execute') as ok", [sig])).ok, false, sig);
    assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') as ok", [sig])).ok, true, sig);
  }
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "027_gfs_assets.sql"), "utf8").replace(/public\./g, `${S}.`);
  await pool.query(sql);
});

test("the routes on Postgres: a Moment from draft to the family's library, then a takedown and retiring it", async () => {
  const wes = await as("wes@example.com");
  const abby = await as("abby@example.com");
  const r = await roster(dallas);
  const made = await wes("/api/gfs/assets", { method: "POST", body: { kind: "moment", format: "3d", title: "Bulldogs catch", event_id: dallas.id } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.asset.id;
  assert.equal((await wes(`/api/gfs/assets/${id}`, { method: "PATCH", body: { athletes: { add: [r.id] } } })).status, 200);
  for (const c of ["deidentified", "tier4"]) assert.equal((await abby(`/api/gfs/assets/${id}/check`, { method: "POST", body: { check: c, on: true } })).status, 200);
  assert.equal((await wes(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "review" } })).json.asset.stage, "review");
  assert.equal((await abby(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "approved", confirm: true } })).json.asset.stage, "approved");
  const live = await abby(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "live", location: "family_library", ref: "lib-4410" } });
  assert.equal(live.json.asset.stage, "live", JSON.stringify(live.json));
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: dallas.id, roster_row: r.id, reason: "consent_withdrawn" } });
  assert.equal(td.json.takedown.assets_live, 1);
  assert.equal((await wes(`/api/gfs/assets/${id}`)).json.asset.needs_retiring, true);
  const step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.equal(step.json.partial.assets_live, 1);
  assert.equal((await wes(`/api/gfs/assets/${id}/retire`, { method: "POST", body: { reason: "takedown" } })).json.asset.stage, "retired");
  assert.equal((await one("select count(*)::int as n from gfs_asset_athletes where asset_id = $1", [id])).n, 0);
  assert.equal((await one("select ref from gfs_assets where id = $1", [id])).ref, null);
  const done = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.ok(done.json.takedown.steps.find((s) => s.key === "other").done_at);
  // The database's own refusal reaches the app by name.
  const w = (await wes("/api/gfs/assets", { method: "POST", body: { kind: "venue_world", title: "Stadium", event_id: dallas.id } })).json.asset;
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "PATCH", body: { athletes: { add: [r.id] } } })).json.error, "gfs_asset_no_athletes");
});

test("before 027: the asset library says it isn't set up, and takedowns still work", async () => {
  prePool = await makeSchema(URL_, PRE, ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql", "026_team_chat.sql"]);
  await prePool.query("insert into team_members (email, name, role, tools, regions) values ('wes@example.com', 'Wes Director', 'member', array['gfs'], array['south_central'])");
  const ev = (await prePool.query(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
    values ('Pre', 'Legacy Tour · Pre', 'Legacy Tour', 'premier', 'south_central', 'Dallas', 'TX', 'America/Chicago', current_date, current_date, now(), 'k') returning *`)).rows[0];
  const r = (await prePool.query("insert into gfs_roster (event_id, roster_id, team, jersey, consent_capture) values ($1, 'PRE-1', 'Bulldogs', '3', true) returning *", [ev.id])).rows[0];
  setSupabase(pgSupabase(prePool, PRE));
  const wes = await as("wes@example.com");
  const list = await wes("/api/gfs/assets");
  assert.equal(list.status, 503);
  assert.equal(list.json.error, "gfs_assets_not_set_up");
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: ev.id, roster_row: r.id, reason: "consent_withdrawn" } });
  assert.equal(td.status, 200, JSON.stringify(td.json));
  assert.equal(td.json.takedown.assets_live, 0);
  const step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.ok(step.json.takedown.steps.find((s) => s.key === "other").done_at);
  assert.equal((await wes("/api/gfs/takedowns")).status, 200);
  setSupabase(pgSupabase(pool, S));
});
