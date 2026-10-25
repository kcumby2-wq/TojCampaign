// Pylon events routes against a real Postgres with migrations 019, 020 and 024
// applied, so the routes and the database's own triggers run together (the
// in-memory fake has no triggers). These are the flows where the two layers
// have to agree. Made-up people and athletes only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_pg_routes_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_pg_routes_test";

if (!URL_) {
  test("gfs routes on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");
const P = require("../utils/push");
const G = require("../utils/gfs");

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => iso(Date.now() + n * DAY);
const ymd = (d) => d.replace(/-/g, "");
const LAST_MONTH = D(-30);

let pool, server, base;
let sent = [];
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

before(async () => {
  pool = await makeSchema(URL_, S);
  for (const m of [
    ["josh@example.com", "Josh", "approver", []],
    ["mw@example.com", "Midwest Director", "member", ["midwest"]],
    ["west@example.com", "West Director", "member", ["west"]],
    ["viewer@example.com", "Vi", "viewer", ["midwest"]],
  ]) await q(`insert into team_members (email, name, role, tools, regions) values ($1, $2, $3, array['gfs'], $4)`, m);
  setSupabase(pgSupabase(pool, S));
  P.setSender(async (s, payload) => sent.push({ to: s.email, ...payload }));
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs", require("../routes/gfs"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
}
async function as(email, role) {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const post = (c, p, body) => c(p, { method: "POST", body: body || {} });
const patch = (c, p, body) => c(p, { method: "PATCH", body });
const E = (e) => `/api/gfs/events/${e.id}`;
const clip = (e, file) => one(`select * from gfs_clips where event_id = $1 and file = $2`, [e.id, file]);
const athlete = (e, rid) => one(`select * from gfs_roster where event_id = $1 and roster_id = $2`, [e.id, rid]);

let kyron, josh, mw, west, view;
async function newEvent(who, body) {
  const r = await post(who, "/api/gfs/events", { size: "one_day", state: "OH", region: "midwest", starts_on: D(5), ...body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.event;
}
async function sendOut(e, dir, appr) {
  await post(dir, `${E(e)}/tags/approve`);
  await post(dir, `${E(e)}/clips/edited`);
  await post(appr, `${E(e)}/clips/approve`);
  await dir(`${E(e)}/families.csv`);
  return (await post(dir, `${E(e)}/clips/delivered`)).json;
}

test("an event start to finish, with the database's rules running under the routes", async () => {
  kyron = await as("kyron@example.com", "admin");
  josh = await as("josh@example.com");
  mw = await as("mw@example.com");
  west = await as("west@example.com");
  view = await as("viewer@example.com");
  const ev = await newEvent(mw, { name: "Girls Flag · Geneva, OH", city: "Geneva", starts_on: D(1) });
  assert.equal((await q(`select * from gfs_deliverables where event_id = $1`, [ev.id])).length, 13);
  const roster = "Athlete ID,First Name,Team,Division,Jersey,Position,Under 13,Capture,Marketing,Sale,Public,Do Not Publish\n" +
    "ST-1,Ann,Ohio Heat 14U,14U,7,WR,no,yes,yes,yes,yes,\nST-2,Bea,Ohio Heat 14U,14U,21,QB,no,yes,no,yes,no,\nST-3,Cat,Ohio Heat 14U,14U,13,DB,no,yes,yes,yes,yes,yes\nST-4,Dee,Buckeye Flag 12U,12U,21,R,no,yes,yes,yes,yes,\n";
  const r = await post(mw, `${E(ev)}/roster`, { csv: roster });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(!JSON.stringify(await q(`select * from gfs_roster where event_id = $1`, [ev.id])).includes("Ann"), "no names stored");
  const g = "Ohio-Heat-14U_vs_Buckeye-Flag-12U_" + ymd(D(1));
  const up = await post(mw, `${E(ev)}/uploads`, { csv: `path\n${g}/7/7-Sideline-001.mp4\n${g}/13/13-Sideline-002.mp4\n${g}/21/21-EndZone-003.mp4\n${g}/Buckeye-Flag-12U/21/21-EndZone-004.mp4\n` });
  assert.deepEqual([up.json.summary.clips.matched, up.json.summary.clips.held], [3, 1]);
  assert.equal((await clip(ev, "13-Sideline-002.mp4")).hold_reason, "do_not_publish", "the database computes the hold");
  const dee = await athlete(ev, "ST-4");
  assert.equal((await clip(ev, "21-EndZone-004.mp4")).roster_row, dee.id, "the team folder settles the two #21s");

  // Files first, then marks.
  await post(mw, `${E(ev)}/tags/approve`);
  await post(mw, `${E(ev)}/clips/edited`);
  assert.equal((await post(josh, `${E(ev)}/clips/approve`)).json.approved, 2);
  assert.deepEqual((await post(mw, `${E(ev)}/clips/delivered`)).json.delivered, 0, "nothing marked sent before the family file");
  await mw(`${E(ev)}/families.csv`);
  assert.equal((await post(mw, `${E(ev)}/clips/delivered`)).json.delivered, 2);
  assert.equal((await post(josh, `${E(ev)}/clips/listed`)).json.listed, 0, "nothing marked listed before the SportsClippers file");
  const csv = await josh(`${E(ev)}/listings.csv`);
  assert.ok(!csv.text.includes("Ann"));
  const listed = (await post(josh, `${E(ev)}/clips/listed`)).json;
  assert.deepEqual([listed.public, listed.family], [1, 1], "Ann public; Dee is 12U, so family-only");

  // A piece that posts clears only with the approver's word.
  const stills = await one(`select * from gfs_deliverables where event_id = $1 and kind = 'stills'`, [ev.id]);
  await patch(mw, `${E(ev)}/deliverables/${stills.id}`, { delivered: 40 });
  assert.equal((await post(mw, `${E(ev)}/deliverables/${stills.id}/submit`)).status, 200);
  assert.equal((await post(josh, `${E(ev)}/deliverables/${stills.id}/approve`)).json.error, "attest_required");
  const ok = await post(josh, `${E(ev)}/deliverables/${stills.id}/approve`, { attest: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const stored = await one(`select status, attested_by, decided_by from gfs_deliverables where id = $1`, [stills.id]);
  assert.deepEqual([stored.status, stored.attested_by, stored.decided_by], ["approved", "josh@example.com", "josh@example.com"]);
});

test("a roster correction on the real database: counts, re-matching, void exports, and clips out held until they come down", async () => {
  const ev = await newEvent(mw, { name: "Dayton Flag", city: "Dayton", starts_on: D(7) });
  const v1 = "Athlete ID,Team,Division,Jersey,Under 13,Capture,Marketing,Sale,Public\nDA-1,Dayton Dragons 14U,14U,31,no,yes,yes,yes,yes\nDA-2,Dayton Dragons 14U,14U,13,no,yes,yes,yes,yes\nKF-1,Kettering Flag 14U,14U,40,no,yes,yes,yes,yes\n";
  await post(mw, `${E(ev)}/roster`, { csv: v1 });
  const g = "Dayton-Dragons-14U_vs_Kettering-Flag-14U_" + ymd(D(7));
  await post(mw, `${E(ev)}/uploads`, { csv: `path\n${g}/40/40-EndZone-004.mp4\n` });
  assert.equal((await sendOut(ev, mw, josh)).delivered, 1);
  // Two more clips go into both files under the first roster, unmarked.
  await post(mw, `${E(ev)}/uploads`, { csv: `path\n${g}/31/31-Sideline-001.mp4\n${g}/13/13-Sideline-002.mp4\n` });
  await post(mw, `${E(ev)}/tags/approve`);
  await post(mw, `${E(ev)}/clips/edited`);
  await post(josh, `${E(ev)}/clips/approve`);
  await mw(`${E(ev)}/families.csv`);
  await josh(`${E(ev)}/listings.csv`);
  assert.deepEqual([(await mw(E(ev))).json.counts.to_send, (await mw(E(ev))).json.counts.to_list], [2, 3]);

  // Sports Thread swaps 31 and 13, and corrects Kettering's #40 to #41.
  const v2 = v1.replace("DA-1,Dayton Dragons 14U,14U,31", "DA-1,Dayton Dragons 14U,14U,13").replace("DA-2,Dayton Dragons 14U,14U,13", "DA-2,Dayton Dragons 14U,14U,31").replace(",40,", ",41,");
  const s = (await post(mw, `${E(ev)}/roster`, { csv: v2 })).json.summary;
  assert.deepEqual([s.renumbered, s.clips_back_to_review, s.clips_out_held, s.clips_matched_now], [3, 2, 1, 2], "the summary counts what moved, not what's left after the database moved it");
  const rid = async (f) => (await one(`select r.roster_id from gfs_clips c join gfs_roster r on r.id = c.roster_row where c.event_id = $1 and c.file = $2`, [ev.id, f])).roster_id;
  assert.equal(await rid("31-Sideline-001.mp4"), "DA-2");
  assert.equal(await rid("13-Sideline-002.mp4"), "DA-1");
  const c31 = await clip(ev, "31-Sideline-001.mp4");
  assert.deepEqual([c31.family_export_at, c31.exported_at, c31.stage], [null, null, "shot"], "a file made under the old tag doesn't count for the new one");
  const counts = (await mw(E(ev))).json.counts;
  assert.deepEqual([counts.to_send, counts.to_list], [0, 0]);
  assert.equal((await post(mw, `${E(ev)}/clips/delivered`)).json.delivered, 0);
  assert.equal((await post(josh, `${E(ev)}/clips/listed`)).json.listed, 0);

  const out = await clip(ev, "40-EndZone-004.mp4");
  assert.deepEqual([out.held, out.hold_reason, out.retag], [true, "roster_changed", true]);
  assert.equal(counts.needs_removal, 1);
  const rem = (await post(mw, `${E(ev)}/clips/removed`, { ids: [out.id] })).json;
  assert.deepEqual([rem.removed, rem.back_to_review], [1, 1], "once it's down, it goes back to tag review");
  const back = await clip(ev, "40-EndZone-004.mp4");
  assert.deepEqual([back.match, back.why, back.held, back.retag], ["unmatched", "not_on_roster", false, false], "matched again by its number where it can be: #40 isn't on the corrected roster");
  assert.ok((await mw(`${E(ev)}/clips?view=unmatched`)).json.clips.some((x) => x.id === out.id), "and tag review shows it");
  const kf = await athlete(ev, "KF-1");
  const tagged = await patch(mw, `${E(ev)}/clips/${out.id}`, { roster_row: kf.id });
  assert.equal(tagged.status, 200, JSON.stringify(tagged.json));
  const again = await clip(ev, "40-EndZone-004.mp4");
  assert.deepEqual([again.held, again.removed_at, again.delivered_at, again.stage], [false, null, null, "shot"], "tagged again, it starts over");
  assert.equal((await post(mw, `${E(ev)}/tags/approve`)).json.tagged, 3);
});

test("named athletes can't be swapped onto a piece that's already cleared", async () => {
  const ev = await newEvent(mw, { name: "Mentor Flag", city: "Mentor", starts_on: D(9) });
  await post(mw, `${E(ev)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture,Marketing,Do Not Publish\nME-1,Mentor Flag 14U,3,yes,yes,\nME-2,Mentor Flag 14U,4,yes,yes,yes\nME-3,Mentor Flag 14U,5,yes,no,\n" });
  const [ok, dnp, noMarketing] = [await athlete(ev, "ME-1"), await athlete(ev, "ME-2"), await athlete(ev, "ME-3")];
  const d = async (kind) => one(`select * from gfs_deliverables where event_id = $1 and kind = $2`, [ev.id, kind]);
  const stills = await d("stills");
  await patch(mw, `${E(ev)}/deliverables/${stills.id}`, { delivered: 40, featured: [ok.id] });
  await post(mw, `${E(ev)}/deliverables/${stills.id}/submit`);
  assert.equal((await post(josh, `${E(ev)}/deliverables/${stills.id}/approve`, { attest: true })).status, 200);
  let r = await patch(mw, `${E(ev)}/deliverables/${stills.id}`, { featured: [dnp.id, noMarketing.id] });
  assert.equal(r.json.error, "gfs_featured_consent");
  assert.deepEqual(r.json.blocks.map((b) => b.why).sort(), ["do_not_publish", "no_marketing_consent"]);
  assert.equal((await one(`select featured from gfs_deliverables where id = $1`, [stills.id])).featured.length, 1, "the cleared piece still names only who it named");
  await refusedSql(`update gfs_deliverables set featured = array[$2::uuid] where id = $1`, [stills.id, dnp.id], "gfs_featured_consent");

  const interviews = await d("interviews");
  await patch(mw, `${E(ev)}/deliverables/${interviews.id}`, { delivered: 3, featured: [ok.id] });
  assert.equal((await post(mw, `${E(ev)}/deliverables/${interviews.id}/done`)).status, 200);
  assert.equal((await patch(mw, `${E(ev)}/deliverables/${interviews.id}`, { featured: [dnp.id] })).json.error, "gfs_featured_consent");
  const report = await d("event_report");
  assert.equal((await patch(mw, `${E(ev)}/deliverables/${report.id}`, { featured: [dnp.id] })).json.error, "featured_not_used");
  await refusedSql(`update gfs_deliverables set delivered = 1, featured = array[$2::uuid], status = 'done' where id = $1`, [report.id, dnp.id], "gfs_featured_consent");

  // A new submission starts without the old attestation.
  await patch(mw, `${E(ev)}/deliverables/${stills.id}`, { delivered: 41 });
  await post(mw, `${E(ev)}/deliverables/${stills.id}/submit`);
  assert.equal((await one(`select attested_at from gfs_deliverables where id = $1`, [stills.id])).attested_at, null);
});

async function refusedSql(sql, params, code) {
  try {
    await pool.query(sql, params);
  } catch (e) {
    assert.match(e.message, new RegExp(code));
    return;
  }
  assert.fail("expected " + code);
}

test("crews on the real database: the youth rule holds, deletes too, and a rating lands for a paused creator", async () => {
  const ev = await newEvent(mw, { name: "Lima clinic", size: "clinic", city: "Lima", starts_on: D(8) });
  const screened = { contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH, age_checked_on: LAST_MONTH };
  const A = (await post(kyron, "/api/gfs/creators", { name: "Creator A", region: "midwest", tier: "adult", ...screened })).json.creator;
  const Y = (await post(kyron, "/api/gfs/creators", { name: "Creator Y", region: "midwest", tier: "youth", guardian_name: "Parent Y", guardian_email: "parent.y@example.com", ...screened })).json.creator;
  const a = (await post(mw, `${E(ev)}/crew`, { creator_id: A.id, role: "lead" })).json.crew;
  const y = (await post(mw, `${E(ev)}/crew`, { creator_id: Y.id, role: "shooter" })).json.crew;
  assert.equal((await patch(mw, `${E(ev)}/crew/${y.id}`, { status: "confirmed" })).json.error, "crew_youth_needs_adult");
  await patch(mw, `${E(ev)}/crew/${a.id}`, { status: "confirmed" });
  assert.equal((await patch(mw, `${E(ev)}/crew/${y.id}`, { status: "confirmed" })).status, 200);
  assert.equal((await patch(mw, `${E(ev)}/crew/${a.id}`, { role: "editor" })).json.error, "crew_youth_left_alone");
  await refusedSql(`delete from gfs_crew where id = $1`, [a.id], "crew_youth_left_alone");
  // Even with a new age check (so the flip itself is valid), the tier holds mid-crew.
  assert.equal((await patch(kyron, `/api/gfs/creators/${Y.id}`, { tier: "adult", age_checked_on: D(-7) })).json.error, "gfs_creator_on_crew");
  // The crew is ready; the adult is paused after the event; a rating still lands.
  assert.equal((await mw(E(ev))).json.checklist.find((c) => c.key === "crew").done, true);
  await patch(kyron, `/api/gfs/creators/${A.id}`, { status: "paused" });
  assert.equal((await mw(E(ev))).json.checklist.find((c) => c.key === "crew").done, false, "a paused creator stops counting");
  const rated = await patch(mw, `${E(ev)}/crew/${a.id}`, { family_rating: 4.8, rating_count: 3 });
  assert.equal(rated.status, 200, JSON.stringify(rated.json));
  // Deleting the event takes its crew with it.
  await pool.query(`delete from gfs_events where id = $1`, [ev.id]);
  assert.equal((await q(`select * from gfs_crew where event_id = $1`, [ev.id])).length, 0);
});

test("a takedown on the real database: later rosters start held, and each region takes down its own clips", async () => {
  const akron = await newEvent(mw, { name: "Girls Flag · Akron, OH", city: "Akron", starts_on: D(4) });
  const roster = "Athlete ID,Team,Jersey,Capture,Marketing,Sale,Public,Under 13\nST-70,Cali Stars 14U,4,yes,yes,yes,yes,no\nST-71,Akron Flag 14U,9,yes,yes,yes,yes,no\n";
  await post(mw, `${E(akron)}/roster`, { csv: roster });
  await post(mw, `${E(akron)}/uploads`, { csv: `path\nCali-Stars-14U_vs_Akron-Flag-14U_${ymd(D(4))}/4/4-EndZone-001.mp4\n` });
  assert.equal((await sendOut(akron, mw, josh)).delivered, 1);
  const ontario = await newEvent(west, { name: "Girls Flag · Ontario, CA", region: "west", city: "Ontario", state: "CA", starts_on: D(3) });
  await post(west, `${E(ontario)}/roster`, { csv: roster.replace("Akron Flag 14U", "Ontario Flag 14U") });
  await post(west, `${E(ontario)}/uploads`, { csv: `path\nCali-Stars-14U_vs_Ontario-Flag-14U_${ymd(D(3))}/4/4-Sideline-002.mp4\n` });
  assert.equal((await sendOut(ontario, west, josh)).delivered, 1);

  sent = [];
  const td = (await post(mw, "/api/gfs/takedowns", { event_id: akron.id, roster_row: (await athlete(akron, "ST-70")).id, reason: "safety_request" })).json.takedown;
  assert.deepEqual([td.regions, td.clips_out], [["midwest", "west"], 2]);
  // A stop whose roster loads afterwards starts with the athlete held.
  const later = await newEvent(mw, { name: "Legacy Tour · Chicago, IL", city: "Chicago", state: "IL", starts_on: D(40) });
  await post(mw, `${E(later)}/roster`, { csv: roster });
  const atLater = await athlete(later, "ST-70");
  assert.ok(atLater.takedown_at && atLater.do_not_publish);

  let t = await patch(mw, `/api/gfs/takedowns/${td.id}`, { other_done: true });
  assert.deepEqual([t.json.partial.removed, t.json.partial.still_out], [1, 1]);
  await refusedSql(`update gfs_takedowns set other_done_at = now() where id = $1`, [td.id], "gfs_takedown_clips_out");
  t = await patch(west, `/api/gfs/takedowns/${td.id}`, { other_done: true });
  assert.ok(t.json.takedown.steps[1].done_at);
  assert.equal((await q(`select * from gfs_clips c join gfs_roster r on r.id = c.roster_row where r.roster_id = 'ST-70' and (c.listed_at is not null or c.delivered_at is not null) and c.removed_at is null`)).length, 0);
});

test("a listing the roster stops allowing is pulled on the real database", async () => {
  const ev = await newEvent(mw, { name: "Euclid Flag", city: "Euclid", starts_on: D(10) });
  const v1 = "Athlete ID,Team,Division,Jersey,Capture,Marketing,Sale,Public,Under 13\nEU-1,Euclid 14U,14U,3,yes,yes,yes,yes,no\nEU-2,Mentor 14U,14U,6,yes,yes,yes,no,no\n";
  await post(mw, `${E(ev)}/roster`, { csv: v1 });
  await post(mw, `${E(ev)}/uploads`, { csv: `path,team\nEuclid-14U_vs_Mentor-14U_${ymd(D(10))}/3/3-Sideline-001.mp4,Emma Smith\nEuclid-14U_vs_Mentor-14U_${ymd(D(10))}/3/3-Sideline-002.mp4,\n` });
  const named = await clip(ev, "3-Sideline-001.mp4");
  assert.deepEqual([named.team_given, named.team, named.why], [G.UNKNOWN_TEAM, null, "team_not_on_roster"], "a team column naming no team on the roster isn't stored, and the clip waits for a person");
  await post(mw, `${E(ev)}/tags/approve`);
  await post(mw, `${E(ev)}/clips/edited`);
  await post(josh, `${E(ev)}/clips/approve`);
  await josh(`${E(ev)}/listings.csv`);
  assert.equal((await post(josh, `${E(ev)}/clips/listed`)).json.public, 1);
  await post(mw, `${E(ev)}/roster`, { csv: v1.replace("3,yes,yes,yes,yes,no", "3,yes,yes,yes,no,no") });
  assert.equal((await clip(ev, "3-Sideline-002.mp4")).pull_reason, "not_public");
  assert.equal((await josh(E(ev))).json.counts.to_family_only, 1);
  // A full re-export never tells SportsClippers more than the app records.
  const all = (await josh(`${E(ev)}/listings.csv?all=1`)).text;
  assert.ok(all.split(/\r\n/).some((l) => l.includes("3-Sideline-002.mp4") && l.includes(",family,")));
  assert.equal((await post(josh, `${E(ev)}/clips/family-only`)).json.family_only, 1);
  await post(mw, `${E(ev)}/roster`, { csv: v1.replace("3,yes,yes,yes,yes,no", "3,yes,yes,no,no,no") });
  const c = await clip(ev, "3-Sideline-002.mp4");
  assert.equal(c.pull_reason, "no_sale_consent");
  assert.equal((await josh(E(ev))).json.counts.needs_removal, 1);
});
