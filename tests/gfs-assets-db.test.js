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
const pushes = [];
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
  const r = { team: "Bulldogs", division: "14U", jersey: String(10 + (rid % 80)), under_13: false, consent_capture: true, consent_3d: true, consent_nft: true, consent_marketing: true, consent_sale: false, public_display: false, do_not_publish: false, roster_id: null, ...extra };
  rid++;
  return one(`insert into gfs_roster (event_id, roster_id, team, division, jersey, under_13, consent_capture, consent_3d, consent_nft, consent_marketing, consent_sale, public_display, do_not_publish)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`, [ev.id, r.roster_id || "ST-" + rid, r.team, r.division, r.jersey, r.under_13, r.consent_capture, r.consent_3d, r.consent_nft, r.consent_marketing, r.consent_sale, r.public_display, r.do_not_publish]);
};
const asset = (ev, kind, extra = {}) => one("insert into gfs_assets (event_id, kind, title, created_by, format) values ($1, $2, $3, 'wes@example.com', $4) returning *", [ev ? ev.id : null, kind, extra.title || kind, extra.format || null]);
const link = (a, r) => q("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'wes')", [a.id, r.id]);
const blocksOf = async (id) => (await one("select gfs_asset_blocks(a) as b from gfs_assets a where id = $1", [id])).b;
// Where each kind goes live, for moving records along in SQL.
const FILE = { moment: ["family_library", "lib-1"], narrative_nft: ["ledger", "1001"], edit: ["pylon_channels", "recap-1"], venue_world: ["gfs_storage", "world-1"], world_pass: ["gfs_store", "pass-1"], brand: ["gfs_storage", "brand-1"] };
const place = (a, n = "") => q("update gfs_assets set location = $2, ref = $3 where id = $1", [a.id, FILE[a.kind][0], FILE[a.kind][1] + n]);

before(async () => {
  pool = await makeSchema(URL_, S, ALL);
  dallas = await event("Dallas", "south_central", "TX");
  chicago = await event("Chicago", "midwest", "IL");
  await q(`insert into team_members (email, name, role, tools, regions) values
    ('wes@example.com', 'Wes Director', 'member', array['gfs'], array['south_central']),
    ('wendy@example.com', 'Wendy West', 'member', array['gfs'], array['west']),
    ('mia@example.com', 'Mia Midwest', 'member', array['gfs'], array['midwest']),
    ('vic@example.com', 'Vic Viewer', 'viewer', array['gfs'], array['south_central']),
    ('abby@example.com', 'Abby Approver', 'approver', array['gfs'], '{}'),
    ('gina@example.com', 'Gina Gone', 'approver', array['gfs'], '{}')`);
  await q("insert into push_subscriptions (email, endpoint, p256dh, auth) values ('mia@example.com', 'https://push.example.com/mia', 'k', 'a')");
  setSupabase(pgSupabase(pool, S));
  P.setSender(async (sub, payload) => { pushes.push({ email: sub.email, payload }); return {}; });
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
const post = (c, p, body, method = "POST") => c(p, { method, body });

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
  await place(m);
  await q("update gfs_assets set stage = 'review' where id = $1", [m.id]);
  await refused("delete from gfs_asset_athletes where asset_id = $1", [m.id], /gfs_asset_locked/);
  await refused("insert into gfs_assets (kind, title, created_by) values ('edit', 'x', 'w')", [], /check constraint/);
  await refused("insert into gfs_assets (event_id, kind, title, created_by, stage) values ($1, 'edit', 'x', 'w', 'review')", [dallas.id], /gfs_asset_starts_as_draft/);
  await refused("update gfs_assets set kind = 'edit' where id = $1", [m.id], /gfs_asset_fixed/);
});

test("027: the file is set before review and locks there; approved and live need everything; retired is final", async () => {
  const r = await roster(dallas);
  const m = await asset(dallas, "moment");
  await link(m, r);
  await refused("update gfs_assets set stage = 'review' where id = $1", [m.id], /gfs_asset_file_required/);
  await q("update gfs_assets set location = 'gfs_storage', ref = 'Dallas-WR-1' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'review' where id = $1", [m.id], /gfs_asset_file_required/);
  await refused("update gfs_assets set location = 'gfs_storage', ref = 'a/b' where id = $1", [m.id], /check constraint/);
  await refused("update gfs_assets set location = 'link', ref = 'https://www.canva.com/x' where id = $1", [m.id], /check constraint/);
  await q("update gfs_assets set location = 'family_library', ref = 'lib-1', sha256 = $2 where id = $1", [m.id, "c".repeat(64)]);
  await q("update gfs_assets set stage = 'review' where id = $1", [m.id]);
  for (const sql of ["update gfs_assets set ref = 'lib-2' where id = $1", "update gfs_assets set sha256 = null where id = $1", "update gfs_assets set location = 'gfs_storage', ref = 'x' where id = $1"]) await refused(sql, [m.id], /gfs_asset_locked/);
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [m.id], /gfs_asset_blocked/);
  await q("update gfs_assets set deidentified_at = now(), deidentified_by = 'abby', tier4_at = now(), tier4_by = 'abby' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'approved' where id = $1", [m.id], /check constraint/);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [m.id]);
  await refused("update gfs_assets set ref = 'lib-unmasked-2' where id = $1", [m.id], /gfs_asset_locked/);
  await refused("update gfs_assets set stage = 'live', ref = 'lib-unmasked-2' where id = $1", [m.id], /gfs_asset_locked/);
  await refused("update gfs_assets set tier4_at = null, tier4_by = null where id = $1", [m.id], /gfs_asset_locked/);
  await q("update gfs_assets set stage = 'live' where id = $1", [m.id]);
  assert.equal((await one("select ref from gfs_assets where id = $1", [m.id])).ref, "lib-1", "what was reviewed went out");
  await refused("update gfs_assets set title = 'x' where id = $1", [m.id], /gfs_asset_locked/);
  await refused("delete from gfs_assets where id = $1", [m.id], /gfs_asset_keep/);
  await q("update gfs_assets set stage = 'retired', retire_reason = 'withdrawn', retired_by = 'wes' where id = $1", [m.id]);
  await refused("update gfs_assets set stage = 'live' where id = $1", [m.id], /gfs_asset_retired/);
  await refused("update gfs_assets set ref = 'lib-9' where id = $1", [m.id], /gfs_asset_retired/);
  await refused("update gfs_assets set title = 'Bulldogs again' where id = $1", [m.id], /gfs_asset_retired/);
  // Stage order: no skipping review.
  const e = await asset(dallas, "edit");
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'a' where id = $1", [e.id], /gfs_asset_stage/);
  // No ID or label without its place.
  await refused("update gfs_assets set ref = 'Dallas2027-WR-1' where id = $1", [e.id], /check constraint/);
  await refused("update gfs_assets set location = null, ref = 'https://drive.google.com/drive/folders/x' where id = $1", [e.id], /check constraint/);
});

test("027: an approver's checks belong to one review: recorded in review only, cleared by going back to draft", async () => {
  const a1 = await roster(dallas), b1 = await roster(dallas);
  const n = await asset(dallas, "narrative_nft");
  await link(n, a1);
  await place(n);
  await refused("update gfs_assets set mint_consent_at = now(), mint_consent_by = 'kyron' where id = $1", [n.id], /gfs_asset_check_in_review/);
  await refused("insert into gfs_assets (event_id, kind, title, created_by, tier4_at, tier4_by) values ($1, 'moment', 'x', 'w', now(), 'abby')", [dallas.id], /gfs_asset_check_in_review/);
  await q("update gfs_assets set stage = 'review' where id = $1", [n.id]);
  await q("update gfs_assets set mint_consent_at = now(), mint_consent_by = 'kyron' where id = $1", [n.id]);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [n.id]);
  await q("update gfs_assets set stage = 'draft' where id = $1", [n.id]);
  let row = await one("select * from gfs_assets where id = $1", [n.id]);
  assert.deepEqual([row.mint_consent_at, row.mint_consent_by, row.approved_at, row.approved_by], [null, null, null, null]);
  // The swap the review found: athlete A out, athlete B in, then minted on A's consent. Not now.
  await q("delete from gfs_asset_athletes where asset_id = $1", [n.id]);
  await link(n, b1);
  await q("update gfs_assets set stage = 'review' where id = $1", [n.id]);
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [n.id], /gfs_asset_blocked/);
  assert.deepEqual(await blocksOf(n.id), ["mint_consent"]);
  // A Moment's Tier 4 and de-identification go the same way through review → draft.
  const m = await asset(dallas, "moment");
  await link(m, await roster(dallas));
  await place(m);
  await q("update gfs_assets set stage = 'review', deidentified_at = now(), deidentified_by = 'abby', tier4_at = now(), tier4_by = 'abby' where id = $1", [m.id]);
  await q("update gfs_assets set stage = 'draft' where id = $1", [m.id]);
  row = await one("select deidentified_at, tier4_at from gfs_assets where id = $1", [m.id]);
  assert.deepEqual([row.deidentified_at, row.tier4_at], [null, null]);
  // The venue's permission is a director's, in a draft or in review, and holds once approved.
  const w = await asset(dallas, "venue_world");
  await q("update gfs_assets set venue_permission_at = now(), venue_permission_by = 'wes' where id = $1", [w.id]);
  await place(w);
  await q("update gfs_assets set stage = 'review' where id = $1", [w.id]);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [w.id]);
  await refused("update gfs_assets set venue_permission_at = null where id = $1", [w.id], /gfs_asset_locked/);
});

test("027: retiring a Moment or an NFT clears its file, title, note and athlete in the same statement", async () => {
  const r = await roster(dallas);
  const m = await one("insert into gfs_assets (event_id, kind, title, created_by, note) values ($1, 'moment', 'Bulldogs #' || $2 || ' · catch', 'x', 'Shot on field 3') returning *", [dallas.id, r.jersey]);
  await link(m, r);
  await q("update gfs_assets set location = 'family_library', ref = 'lib-9', sha256 = $2 where id = $1", [m.id, "d".repeat(64)]);
  await q("update gfs_assets set stage = 'retired', retire_reason = 'withdrawn' where id = $1", [m.id]);
  const row = await one("select a.location, a.ref, a.sha256, a.title, a.note, (select count(*)::int from gfs_asset_athletes x where x.asset_id = a.id) as n from gfs_assets a where a.id = $1", [m.id]);
  assert.deepEqual([row.location, row.ref, row.sha256, row.title, row.note, row.n], ["family_library", null, null, "Retired 3D/4D Moment", null, 0]);
  await refused("update gfs_assets set title = 'Bulldogs #' || $2 where id = $1", [m.id, r.jersey], /gfs_asset_retired/);
  await refused("update gfs_assets set note = 'Bulldogs' where id = $1", [m.id], /gfs_asset_retired/);
  // An edit keeps its record: retiring it changes nothing else.
  const e = await asset(dallas, "edit", { title: "Recap · day one" });
  await place(e, "-retire");
  await q("update gfs_assets set stage = 'retired', retire_reason = 'replaced' where id = $1", [e.id]);
  const er = await one("select title, ref from gfs_assets where id = $1", [e.id]);
  assert.deepEqual([er.title, er.ref], ["Recap · day one", "recap-1-retire"]);
});

test("027: a World Pass's World is from its own stop; a sponsor asset carries the marks; a brand link goes to a design tool", async () => {
  const w = await asset(chicago, "venue_world", { title: "Chicago World" });
  await refused("insert into gfs_assets (event_id, kind, title, created_by, source_asset_id, price_cents) values ($1, 'world_pass', 'Dallas pass', 'x', $2, 2500)", [dallas.id, w.id], /gfs_asset_source_world/);
  const p = await one("insert into gfs_assets (event_id, kind, title, created_by, price_cents) values ($1, 'world_pass', 'Dallas pass', 'x', 2500) returning *", [dallas.id]);
  await refused("update gfs_assets set source_asset_id = $2 where id = $1", [p.id, w.id], /gfs_asset_source_world/);
  await refused("insert into gfs_assets (kind, title, created_by, format) values ('brand', 'Sponsor end card', 'x', 'sponsor')", [], /check constraint/);
  const s = await one("insert into gfs_assets (kind, title, created_by, format, sponsor_marks) values ('brand', 'Sponsor end card', 'x', 'sponsor', true) returning *");
  assert.deepEqual(await blocksOf(s.id), ["marks_licensed"]);
  await refused("update gfs_assets set location = 'link', ref = 'https://drive.google.com/file/d/1/view' where id = $1", [s.id], /check constraint/);
  await q("update gfs_assets set location = 'link', ref = 'https://www.canva.com/design/abc/view' where id = $1", [s.id]);
  // Titles and notes: no links.
  await refused("update gfs_assets set title = 'https://drive.google.com/file/d/1AbC/view' where id = $1", [s.id], /check constraint/);
  await refused("update gfs_assets set note = 'raw at www.dropbox.com/s/xyz' where id = $1", [s.id], /check constraint/);
});

test("027: titles and notes get the same text check in the app and the database", async () => {
  const ch = (...codes) => String.fromCharCode(...codes);
  const texts = [
    "Recap · day one", "Bulldogs #12 · catch on field 3", "Field 3 at 2:30", "1080p · 60fps · 4K", "Awww. Great catch", "Order 2025-10-24",
    "FaceTime: 3pm", "Tel: 4 cameras", "Recap w/ highlights", "St.Louis/KC swing", "v2.final/cut", "drive.google.com",
    "Call 214-555-0199", "Call ２１４－５５５－０１９９", "214" + ch(0x2011) + "555" + ch(0x2011) + "0199", "+44 20 7946 0958",
    "wes@example.com", "wes＠example.com", "w" + ch(0x200b) + "es@example.com",
    "tel:+12145550199", "facetime:2145550199", "wa.me/12145550199",
    "https://drive.google.com/file/d/1AbC/view", "http://x.example.com", "www.dropbox.com/s/xyz", "raw at WWW.DROPBOX.COM", "dropbox.com/s/xyz/clip.mp4",
    "ｈｔｔｐｓ://x.example.com", "youtu.be/abc", "w" + ch(0x200b) + "ww.example.com", "drive.google.com/drive/folders/x",
  ];
  const got = [];
  for (const s of texts) {
    const db = (await one("select gfs_asset_text_ok($1) as ok", [s])).ok;
    assert.equal(db, A.textOk(s), `app and database disagree on ${JSON.stringify(s)}`);
    got.push(db);
  }
  assert.deepEqual(got, [true, true, true, true, true, true, true, true, true, true, true, true, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false, false]);
});

test("027: the database's reasons match the app's, kind by kind", async () => {
  const rows = [
    await roster(dallas),
    await roster(dallas, { under_13: null }),
    await roster(dallas, { division: "12U" }),
    await roster(dallas, { consent_3d: false, consent_nft: false, consent_marketing: false }),
    await roster(dallas, { consent_capture: false }),
    await roster(dallas, { do_not_publish: true }),
    await roster(dallas, { consent_sale: true, public_display: true }),
    await roster(dallas, { consent_sale: true, public_display: true, division: "U-12" }),
  ];
  for (const kind of ["moment", "narrative_nft", "edit", "edit_listed"]) {
    for (const r of rows) {
      const a = await asset(dallas, kind === "edit_listed" ? "edit" : kind);
      await link(a, r);
      if (kind === "edit_listed") await q("update gfs_assets set location = 'sportsclippers', ref = 'Dallas-listing-1' where id = $1", [a.id]);
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
  await place(m, "-7");
  await q("update gfs_assets set stage = 'review', deidentified_at = now(), deidentified_by = 'a', tier4_at = now(), tier4_by = 'a' where id = $1", [m.id]);
  await q("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'a' where id = $1", [m.id]);
  await q("update gfs_assets set stage = 'live' where id = $1", [m.id]);
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

test("027: two athletes added to a Moment at once: the second waits for the first, then is refused", async () => {
  const m = await asset(dallas, "moment");
  const r1 = await roster(dallas), r2 = await roster(dallas);
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query("begin");
    await c1.query("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [m.id, r1.id]);
    let settled = false;
    const second = c2.query("insert into gfs_asset_athletes (asset_id, roster_row, added_by) values ($1, $2, 'x')", [m.id, r2.id]).then(
      () => { settled = true; return null; },
      (e) => { settled = true; return e; }
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(settled, false, "the second add waits on the asset's lock");
    await c1.query("commit");
    const err = await second;
    assert.ok(err && /gfs_asset_one_athlete/.test(err.message), String(err && err.message));
  } finally {
    c1.release();
    c2.release();
  }
  assert.equal((await one("select count(*)::int as n from gfs_asset_athletes where asset_id = $1", [m.id])).n, 1);
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
  const vic = await as("vic@example.com");
  const r = await roster(dallas);
  const made = await wes("/api/gfs/assets", { method: "POST", body: { kind: "moment", format: "3d", title: "Catch on field 3", event_id: dallas.id } });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.asset.id;
  assert.equal((await wes(`/api/gfs/assets/${id}`, { method: "PATCH", body: { athletes: { add: [r.id] }, location: "family_library", ref: "lib-4410" } })).status, 200);
  assert.equal((await abby(`/api/gfs/assets/${id}/check`, { method: "POST", body: { check: "tier4", on: true } })).json.error, "gfs_asset_check_in_review");
  assert.equal((await wes(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "review" } })).json.asset.stage, "review");
  for (const c of ["deidentified", "tier4"]) assert.equal((await abby(`/api/gfs/assets/${id}/check`, { method: "POST", body: { check: c, on: true } })).status, 200);
  assert.equal((await vic(`/api/gfs/assets/${id}`)).json.asset.checks, null, "a viewer doesn't see the checks");
  assert.equal((await abby(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "approved", confirm: true } })).json.asset.stage, "approved");
  // The file can't be swapped after approval.
  assert.equal((await wes(`/api/gfs/assets/${id}`, { method: "PATCH", body: { location: "family_library", ref: "lib-unmasked-2", sha256: "b".repeat(64) } })).json.error, "gfs_asset_locked");
  const live = await abby(`/api/gfs/assets/${id}/stage`, { method: "POST", body: { to: "live" } });
  assert.equal(live.json.asset.stage, "live", JSON.stringify(live.json));
  assert.equal(live.json.asset.ref, "lib-4410");
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: dallas.id, roster_row: r.id, reason: "consent_withdrawn" } });
  assert.equal(td.json.takedown.assets_live, 1);
  assert.equal((await wes(`/api/gfs/assets/${id}`)).json.asset.needs_retiring, true);
  const step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.equal(step.json.partial.assets_live, 1);
  assert.equal((await wes(`/api/gfs/assets/${id}/retire`, { method: "POST", body: { reason: "takedown" } })).json.asset.stage, "retired");
  assert.equal((await one("select count(*)::int as n from gfs_asset_athletes where asset_id = $1", [id])).n, 0);
  const row = await one("select ref, title from gfs_assets where id = $1", [id]);
  assert.deepEqual([row.ref, row.title], [null, "Retired 3D/4D Moment"]);
  const done = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.ok(done.json.takedown.steps.find((s) => s.key === "other").done_at);
  // The database's own refusal reaches the app by name.
  const w = (await wes("/api/gfs/assets", { method: "POST", body: { kind: "venue_world", title: "Stadium", event_id: dallas.id } })).json.asset;
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "PATCH", body: { athletes: { add: [r.id] } } })).json.error, "gfs_asset_no_athletes");
});

test("the routes on Postgres: the Consent to Mint recorded for one athlete never mints another", async () => {
  const wes = await as("wes@example.com"), abby = await as("abby@example.com"), kyron = await as("kyron@example.com", "admin");
  const a1 = await roster(dallas), b1 = await roster(dallas);
  const n = (await post(wes, "/api/gfs/assets", { kind: "narrative_nft", title: "First touchdown", event_id: dallas.id })).json.asset;
  await post(wes, `/api/gfs/assets/${n.id}`, { athletes: { add: [a1.id] }, location: "ledger", ref: "2001" }, "PATCH");
  assert.equal((await post(kyron, `/api/gfs/assets/${n.id}/check`, { check: "mint_consent", on: true })).json.error, "gfs_asset_check_in_review");
  await post(wes, `/api/gfs/assets/${n.id}/stage`, { to: "review" });
  assert.equal((await post(kyron, `/api/gfs/assets/${n.id}/check`, { check: "mint_consent", on: true })).status, 200);
  assert.equal((await post(wes, `/api/gfs/assets/${n.id}`, { athletes: { remove: [a1.id], add: [b1.id] } }, "PATCH")).json.error, "gfs_asset_locked");
  assert.equal((await post(wes, `/api/gfs/assets/${n.id}/stage`, { to: "draft" })).json.asset.checks.mint_consent.on, false);
  const swap = await post(wes, `/api/gfs/assets/${n.id}`, { athletes: { remove: [a1.id], add: [b1.id] } }, "PATCH");
  assert.equal(swap.status, 200, JSON.stringify(swap.json));
  assert.equal(swap.json.asset.checks.mint_consent.on, false);
  await post(wes, `/api/gfs/assets/${n.id}/stage`, { to: "review" });
  const blocked = await post(abby, `/api/gfs/assets/${n.id}/stage`, { to: "approved", confirm: true });
  assert.equal(blocked.json.error, "gfs_asset_blocked");
  assert.deepEqual(blocked.json.blocks.map((b) => b.code), ["mint_consent"]);
  // Two adds at once leave one athlete.
  const m = (await post(wes, "/api/gfs/assets", { kind: "moment", title: "Two at once", event_id: dallas.id })).json.asset;
  const r1 = await roster(dallas), r2 = await roster(dallas);
  const both = await Promise.all([r1, r2].map((r) => post(wes, `/api/gfs/assets/${m.id}`, { athletes: { add: [r.id] } }, "PATCH")));
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await one("select count(*)::int as n from gfs_asset_athletes where asset_id = $1", [m.id])).n, 1);
  // A refused change saves nothing; a malformed one is a 400, not a 500.
  const e = (await post(wes, "/api/gfs/assets", { kind: "edit", title: "Recap · day four", event_id: dallas.id })).json.asset;
  const rc = await roster(chicago);
  assert.equal((await post(wes, `/api/gfs/assets/${e.id}`, { title: "Recap · final", athletes: { add: [rc.id] } }, "PATCH")).json.error, "gfs_asset_not_on_roster");
  assert.equal((await one("select title from gfs_assets where id = $1", [e.id])).title, "Recap · day four");
  assert.equal((await post(wes, `/api/gfs/assets/${e.id}`, { athletes: null }, "PATCH")).status, 400);
  assert.equal((await post(wes, `/api/gfs/assets/${e.id}`, { title: "Raw: https://drive.google.com/file/d/1AbC/view" }, "PATCH")).json.error, "links");
});

test("the routes on Postgres: a stop that moves region takes its assets", async () => {
  const wes = await as("wes@example.com"), wendy = await as("wendy@example.com"), abby = await as("abby@example.com");
  const ev = await event("Moved", "south_central", "TX");
  const r = await roster(ev);
  const m = (await post(wes, "/api/gfs/assets", { kind: "moment", format: "3d", title: "Moved catch", event_id: ev.id })).json.asset;
  await post(wes, `/api/gfs/assets/${m.id}`, { athletes: { add: [r.id] } }, "PATCH");
  const moved = await post(abby, `/api/gfs/events/${ev.id}`, { region: "west" }, "PATCH");
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((await one("select region from gfs_assets where id = $1", [m.id])).region, "west");
  assert.equal((await wes(`/api/gfs/assets/${m.id}`)).status, 404);
  assert.equal((await wes(`/api/gfs/assets/${m.id}/roster`)).status, 404);
  assert.equal((await wendy(`/api/gfs/assets/${m.id}`)).status, 200);
  assert.equal((await wendy(`/api/gfs/assets?event=${ev.id}`)).json.assets.length, 1);
  // And in the database alone.
  await q("update gfs_events set region = 'southeast' where id = $1", [ev.id]);
  assert.equal((await one("select region from gfs_assets where id = $1", [m.id])).region, "southeast");
});

test("the routes on Postgres: an edit on SportsClippers needs sale consent and public display; a takedown held up in another region says where", async () => {
  const wes = await as("wes@example.com"), mia = await as("mia@example.com"), abby = await as("abby@example.com");
  const kid = await roster(dallas, { consent_sale: true, public_display: true, division: "12U" });
  const e = (await post(wes, "/api/gfs/assets", { kind: "edit", format: "reel", title: "Dallas reel", event_id: dallas.id })).json.asset;
  const r = await post(wes, `/api/gfs/assets/${e.id}`, { athletes: { add: [kid.id] }, location: "sportsclippers", ref: "Dallas-reel-1" }, "PATCH");
  assert.deepEqual(r.json.asset.blocks.map((b) => b.code), ["not_public"]);
  await post(wes, `/api/gfs/assets/${e.id}/stage`, { to: "review" });
  assert.equal((await post(abby, `/api/gfs/assets/${e.id}/stage`, { to: "approved", confirm: true })).json.error, "gfs_asset_blocked");
  await refused("update gfs_assets set stage = 'approved', approved_at = now(), approved_by = 'abby' where id = $1", [e.id], /gfs_asset_blocked/);
  // The same athlete at a Chicago stop, in a live Chicago edit.
  const rDal = await roster(dallas, { roster_id: "XREG-1" });
  const rChi = await roster(chicago, { roster_id: "XREG-1" });
  const ce = (await post(mia, "/api/gfs/assets", { kind: "edit", title: "Chicago recap", event_id: chicago.id })).json.asset;
  await post(mia, `/api/gfs/assets/${ce.id}`, { athletes: { add: [rChi.id] }, location: "pylon_channels", ref: "chi-recap" }, "PATCH");
  await post(mia, `/api/gfs/assets/${ce.id}/stage`, { to: "review" });
  await post(abby, `/api/gfs/assets/${ce.id}/stage`, { to: "approved", confirm: true });
  assert.equal((await post(abby, `/api/gfs/assets/${ce.id}/stage`, { to: "live" })).json.asset.stage, "live");
  pushes.length = 0;
  const td = await post(wes, "/api/gfs/takedowns", { event_id: dallas.id, roster_row: rDal.id, reason: "safety_request" });
  assert.deepEqual([td.json.takedown.assets_live, td.json.takedown.assets_live_yours, td.json.takedown.assets_live_events], [1, 0, ["Chicago"]]);
  const step = await post(wes, `/api/gfs/takedowns/${td.json.takedown.id}`, { other_done: true }, "PATCH");
  assert.deepEqual(step.json.partial, { removed: 0, still_out: 0, regions: [], events: [], assets_live: 1, asset_regions: ["midwest"], asset_events: ["Chicago"] });
  assert.equal((await wes(`/api/gfs/assets/${ce.id}`)).status, 404, "Wes still can't open it");
  await new Promise((r) => setTimeout(r, 100));
  const told = pushes.filter((p) => p.email === "mia@example.com" && /assets still live/.test(p.payload.title));
  assert.equal(told.length, 1, JSON.stringify(pushes));
  assert.match(told[0].payload.body, /Chicago/);
});

test("the routes on Postgres: who approved it, after they've left the team", async () => {
  const wes = await as("wes@example.com"), gina = await as("gina@example.com");
  const w = (await post(wes, "/api/gfs/assets", { kind: "venue_world", title: "Practice field World", event_id: dallas.id })).json.asset;
  await post(wes, `/api/gfs/assets/${w.id}/check`, { check: "venue_permission", on: true });
  await post(wes, `/api/gfs/assets/${w.id}`, { location: "gfs_storage", ref: "world-practice-1" }, "PATCH");
  await post(wes, `/api/gfs/assets/${w.id}/stage`, { to: "review" });
  assert.equal((await post(gina, `/api/gfs/assets/${w.id}/stage`, { to: "approved", confirm: true })).json.asset.approved.by, "Gina Gone");
  await q("delete from team_members where email = 'gina@example.com'");
  assert.equal((await wes(`/api/gfs/assets/${w.id}`)).json.asset.approved.by, "a former teammate");
});

test("before 027: the asset library says it isn't set up, and takedowns and event changes still work", async () => {
  prePool = await makeSchema(URL_, PRE, ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql", "026_team_chat.sql"]);
  await prePool.query("insert into team_members (email, name, role, tools, regions) values ('wes@example.com', 'Wes Director', 'member', array['gfs'], array['south_central']), ('abby@example.com', 'Abby Approver', 'approver', array['gfs'], '{}')");
  const ev = (await prePool.query(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
    values ('Pre', 'Legacy Tour · Pre', 'Legacy Tour', 'premier', 'south_central', 'Dallas', 'TX', 'America/Chicago', current_date, current_date, now(), 'k') returning *`)).rows[0];
  const r = (await prePool.query("insert into gfs_roster (event_id, roster_id, team, jersey, consent_capture) values ($1, 'PRE-1', 'Bulldogs', '3', true) returning *", [ev.id])).rows[0];
  setSupabase(pgSupabase(prePool, PRE));
  try {
    const wes = await as("wes@example.com");
    const abby = await as("abby@example.com");
    const list = await wes("/api/gfs/assets");
    assert.equal(list.status, 503);
    assert.equal(list.json.error, "gfs_assets_not_set_up");
    const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: ev.id, roster_row: r.id, reason: "consent_withdrawn" } });
    assert.equal(td.status, 200, JSON.stringify(td.json));
    assert.equal(td.json.takedown.assets_live, 0);
    const step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
    assert.ok(step.json.takedown.steps.find((s) => s.key === "other").done_at);
    assert.equal((await wes("/api/gfs/takedowns")).status, 200);
    const moved = await abby(`/api/gfs/events/${ev.id}`, { method: "PATCH", body: { region: "west" } });
    assert.equal(moved.status, 200, JSON.stringify(moved.json));
  } finally {
    setSupabase(pgSupabase(pool, S));
  }
});
