// Pylon events · the asset library (routes/gfs-assets.js,
// utils/gfs-assets.js) against an in-memory Supabase: roles and regions,
// each kind's rules, checks, moving an asset along, holds after the fact,
// takedowns, and what viewers see. Made-up people and athletes only.
// Migration 027's own checks run in Postgres in tests/gfs-assets-db.test.js.
//
//   node --test tests/gfs-assets.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const A = require("../utils/gfs-assets");
const P = require("../utils/push");

let db, server, base;
const ev = {};
const ro = {};
const today = new Date().toISOString().slice(0, 10);
const consents = { consent_capture: true, consent_recruiting: false, consent_marketing: true, consent_sale: false, consent_training: false, consent_3d: true, consent_nft: true, consent_feature: false, consent_commercial: false, public_display: false };

before(async () => {
  const mk = (code, name, region, state) => ({ id: crypto.randomUUID(), code, name, series: "Legacy Tour", size: "premier", region, city: name.split(" · ")[1], state, tz: "America/Chicago", starts_on: today, ends_on: today, status: "planning", created_by: "kyron@example.com" });
  ev.dallas = mk("Dallas2027", "Legacy Tour · Dallas", "south_central", "TX");
  ev.chicago = mk("Chicago2027", "Legacy Tour · Chicago", "midwest", "IL");
  const row = (event, rid, team, jersey, extra) => ({ id: crypto.randomUUID(), event_id: event.id, roster_id: rid, team, division: "14U", jersey, position: "WR", under_13: false, do_not_publish: false, low_profile: false, priority: false, takedown_at: null, ...consents, ...extra });
  ro.ok = row(ev.dallas, "ST-100", "Bulldogs", "12", {});
  ro.kid = row(ev.dallas, "ST-101", "Bulldogs", "7", { under_13: null });
  ro.no3d = row(ev.dallas, "ST-102", "Hawks", "9", { consent_3d: false, consent_nft: false, consent_marketing: false });
  ro.chi = row(ev.chicago, "ST-200", "Wolves", "4", {});
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "wes@example.com", name: "Wes Director", role: "member", tools: ["gfs"], regions: ["south_central"], status: "active" },
        { email: "mia@example.com", name: "Mia Midwest", role: "member", tools: ["gfs"], regions: ["midwest"], status: "active" },
        { email: "abby@example.com", name: "Abby Approver", role: "approver", tools: ["gfs"], regions: [], status: "active" },
        { email: "vic@example.com", name: "Vic Viewer", role: "viewer", tools: ["gfs"], regions: ["south_central"], status: "active" },
      ],
      gfs_events: [ev.dallas, ev.chicago],
      gfs_roster: Object.values(ro),
      gfs_clips: [
        { id: crypto.randomUUID(), event_id: ev.dallas.id, match: "matched", stage: "approved", held: false, roster_row: ro.ok.id, delivered_at: new Date().toISOString(), listed_at: null, removed_at: null },
        { id: crypto.randomUUID(), event_id: ev.dallas.id, match: "unmatched", stage: "shot", held: false },
      ],
    },
    { unique: { gfs_events: ["code"] } }
  );
  setSupabase(db);
  P.setSender(async () => ({}));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs/assets", require("../routes/gfs-assets"));
  app.use("/api/gfs", require("../routes/gfs"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  await signIn();
});
after(() => { server && server.close(); P.setSender(null); });

async function as(email, role) {
  let cookie = "";
  const call = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  await call("/test-login", { method: "POST", body: { email, role } });
  return call;
}
let kyron, wes, mia, abby, vic;
async function signIn() {
  if (kyron) return;
  kyron = await as("kyron@example.com", "admin");
  wes = await as("wes@example.com");
  mia = await as("mia@example.com");
  abby = await as("abby@example.com");
  vic = await as("vic@example.com");
}
const make = async (c, body) => {
  const r = await c("/api/gfs/assets", { method: "POST", body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.asset;
};
const codes = (a) => (a.blocks || []).map((b) => b.code + (b.athlete ? ":" + b.athlete.jersey : "")).sort();

test("roles and regions: directors make drafts in their regions; viewers read; national brand assets are an approver's", async () => {
  assert.equal((await vic("/api/gfs/assets", { method: "POST", body: { kind: "edit", title: "Recap", event_id: ev.dallas.id } })).status, 403);
  assert.equal((await mia("/api/gfs/assets", { method: "POST", body: { kind: "edit", title: "Recap", event_id: ev.dallas.id } })).status, 404, "not her region");
  assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "edit", title: "Recap" } })).json.error, "event_required");
  assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "brand", title: "End card" } })).json.error, "national_needs_approver");
  assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "brand", title: "End card", region: "midwest" } })).json.error, "region_not_yours");
  assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "edit", title: "Call 214-555-0199", event_id: ev.dallas.id } })).json.error, "contact_details");
  assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "edit", title: "Recap", format: "3d", event_id: ev.dallas.id } })).json.error, "format");
  const recap = await make(wes, { kind: "edit", title: "Recap · day one", format: "recap", event_id: ev.dallas.id });
  assert.equal(recap.region, "south_central");
  assert.equal(recap.stage, "draft");
  const brand = await make(wes, { kind: "brand", title: "South Central end card", format: "template", region: "south_central" });
  const national = await make(abby, { kind: "brand", title: "Pylon end card", format: "template" });
  assert.equal(national.region, null);
  const lib = await mia("/api/gfs/assets");
  assert.ok(lib.json.assets.some((a) => a.id === national.id), "a national brand asset is everyone's to see");
  assert.ok(!lib.json.assets.some((a) => a.id === recap.id || a.id === brand.id), "another region's assets aren't");
  assert.equal((await mia(`/api/gfs/assets/${recap.id}`)).status, 404);
  assert.equal((await wes(`/api/gfs/assets/${national.id}`, { method: "PATCH", body: { title: "x" } })).json.error, "region_not_yours", "a director can read a national asset but not change it");
  // The library carries each stop's clips.
  const mine = await wes("/api/gfs/assets");
  const stop = mine.json.stops.find((s) => s.id === ev.dallas.id);
  assert.equal(stop.clips.shot, 2);
  assert.equal(stop.clips.delivered, 1);
});

test("a 3D/4D Moment: one athlete with 3D consent, the checks, an approver's approval, the family's library", async () => {
  const m = await make(wes, { kind: "moment", format: "4d", title: "Bulldogs #12 · catch on field 3", event_id: ev.dallas.id });
  assert.deepEqual(codes(m), ["deidentified", "one_athlete", "tier4"]);
  const add = (who) => wes(`/api/gfs/assets/${m.id}`, { method: "PATCH", body: { athletes: { add: [who] } } });
  assert.equal((await add(ro.chi.id)).json.error, "gfs_asset_not_on_roster");
  let r = await add(ro.ok.id);
  assert.deepEqual(r.json.asset.athletes.map((a) => [a.team, a.jersey]), [["Bulldogs", "12"]]);
  assert.equal((await add(ro.no3d.id)).json.error, "gfs_asset_one_athlete");
  // The roster picker says who can be in it.
  const pick = (await wes(`/api/gfs/assets/${m.id}/roster`)).json.athletes;
  assert.deepEqual(pick.find((x) => x.jersey === "7").why, ["under_13"]);
  assert.deepEqual(pick.find((x) => x.jersey === "9").why, ["no_3d_consent"]);
  assert.equal(pick.find((x) => x.jersey === "12").in_asset, true);
  assert.equal((await vic(`/api/gfs/assets/${m.id}/roster`)).status, 403);
  // Checks: approvers record de-identification and Tier 4; a director can't.
  assert.equal((await wes(`/api/gfs/assets/${m.id}/check`, { method: "POST", body: { check: "tier4", on: true } })).status, 403);
  assert.equal((await abby(`/api/gfs/assets/${m.id}/check`, { method: "POST", body: { check: "mint_consent", on: true } })).json.error, "check_not_for_this_asset");
  await abby(`/api/gfs/assets/${m.id}/check`, { method: "POST", body: { check: "tier4", on: true } });
  r = await abby(`/api/gfs/assets/${m.id}/check`, { method: "POST", body: { check: "deidentified", on: true } });
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal(r.json.asset.checks.tier4.by, "Abby Approver");
  // Review, then an approver approves with the checklist confirmed.
  assert.equal((await wes(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "approved" } })).status, 403);
  assert.equal((await wes(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "review" } })).json.asset.stage, "review");
  assert.equal((await wes(`/api/gfs/assets/${m.id}`, { method: "PATCH", body: { title: "changed" } })).json.error, "gfs_asset_locked");
  const noConfirm = await abby(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "approved" } });
  assert.equal(noConfirm.json.error, "confirm_checklist");
  assert.match(noConfirm.json.checklist, /blurred or masked/);
  assert.equal((await abby(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "approved", confirm: true } })).json.asset.stage, "approved");
  // Live only in the family's library.
  assert.equal((await abby(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "live", location: "gfs_storage", ref: "Dallas2027-WR-12-EndZone-042" } })).json.error, "gfs_asset_live_location");
  assert.equal((await abby(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "live", location: "family_library", ref: "family/123" } })).json.error, "ref", "no slashes");
  const live = await abby(`/api/gfs/assets/${m.id}/stage`, { method: "POST", body: { to: "live", location: "family_library", ref: "lib-88123" } });
  assert.equal(live.json.asset.stage, "live");
  assert.equal(live.json.asset.stage_name, "Delivered");
  // A viewer sees it's delivered, not the file's ID, the roster ID or why anything's held.
  const seen = (await vic(`/api/gfs/assets/${m.id}`)).json.asset;
  assert.deepEqual([seen.ref, seen.blocks, seen.athletes[0].roster_id], [null, null, null]);
  ev.moment = m.id;
});

test("Moments that can't be made: under 13, no 3D permission, an Illinois stop", async () => {
  const kid = await make(wes, { kind: "moment", format: "3d", title: "Bulldogs #7", event_id: ev.dallas.id });
  let r = await wes(`/api/gfs/assets/${kid.id}`, { method: "PATCH", body: { athletes: { add: [ro.kid.id] } } });
  assert.ok(codes(r.json.asset).includes("under_13:7"));
  const no3d = await make(wes, { kind: "moment", title: "Hawks #9", event_id: ev.dallas.id });
  r = await wes(`/api/gfs/assets/${no3d.id}`, { method: "PATCH", body: { athletes: { add: [ro.no3d.id] } } });
  assert.ok(codes(r.json.asset).includes("no_3d_consent:9"));
  const il = await make(mia, { kind: "moment", title: "Wolves #4", event_id: ev.chicago.id });
  r = await mia(`/api/gfs/assets/${il.id}`, { method: "PATCH", body: { athletes: { add: [ro.chi.id] } } });
  assert.ok(codes(r.json.asset).includes("illinois_hold"));
  await mia(`/api/gfs/assets/${il.id}/stage`, { method: "POST", body: { to: "review" } });
  for (const c of ["deidentified", "tier4"]) await abby(`/api/gfs/assets/${il.id}/check`, { method: "POST", body: { check: c, on: true } });
  const refused = await abby(`/api/gfs/assets/${il.id}/stage`, { method: "POST", body: { to: "approved", confirm: true } });
  assert.equal(refused.json.error, "gfs_asset_blocked");
  assert.deepEqual(refused.json.blocks.map((b) => b.code), ["illinois_hold"]);
});

test("a Narrative NFT: NFT permission on the roster and the Consent to Mint, which only Kyron records", async () => {
  const n = await make(wes, { kind: "narrative_nft", title: "Bulldogs #12 · first touchdown", event_id: ev.dallas.id });
  await wes(`/api/gfs/assets/${n.id}`, { method: "PATCH", body: { athletes: { add: [ro.ok.id] } } });
  assert.equal((await abby(`/api/gfs/assets/${n.id}/check`, { method: "POST", body: { check: "mint_consent", on: true } })).json.error, "check_owner_only");
  const r = await kyron(`/api/gfs/assets/${n.id}/check`, { method: "POST", body: { check: "mint_consent", on: true } });
  assert.deepEqual(codes(r.json.asset), []);
  await wes(`/api/gfs/assets/${n.id}/stage`, { method: "POST", body: { to: "review" } });
  await abby(`/api/gfs/assets/${n.id}/stage`, { method: "POST", body: { to: "approved", confirm: true } });
  assert.equal((await abby(`/api/gfs/assets/${n.id}/stage`, { method: "POST", body: { to: "live", location: "ledger", ref: "1042" } })).json.asset.stage_name, "Minted");
  // Withdrawn: retiring it clears the token's file reference and the athlete.
  const ret = await wes(`/api/gfs/assets/${n.id}/retire`, { method: "POST", body: { reason: "withdrawn" } });
  assert.equal(ret.json.asset.stage, "retired");
  assert.deepEqual([ret.json.asset.ref, ret.json.asset.sha256, ret.json.asset.athletes.length], [null, null, 0]);
  assert.equal((await wes(`/api/gfs/assets/${n.id}/stage`, { method: "POST", body: { to: "review" } })).status, 409, "retired stays retired");
  assert.equal((await wes(`/api/gfs/assets/${n.id}/retire`, { method: "POST", body: { reason: "withdrawn" } })).json.error, "gfs_asset_retired");
});

test("a venue World and its World Pass: no people, venue permission, never a school venue, a fixed price", async () => {
  const w = await make(wes, { kind: "venue_world", title: "Dallas 2027 · Stadium World", event_id: ev.dallas.id });
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "PATCH", body: { athletes: { add: [ro.ok.id] } } })).json.error, "gfs_asset_no_athletes");
  assert.deepEqual(codes(w), ["venue_permission"]);
  await wes(`/api/gfs/assets/${w.id}/check`, { method: "POST", body: { check: "venue_permission", on: true } });
  const pass = await make(abby, { kind: "world_pass", title: "Dallas 2027 · Stadium World edition", event_id: ev.dallas.id });
  assert.deepEqual(codes(pass), ["price", "source_world"]);
  let r = await abby(`/api/gfs/assets/${pass.id}`, { method: "PATCH", body: { price_cents: 2500, source_asset_id: w.id } });
  assert.deepEqual(codes(r.json.asset), ["source_world"], "the World isn't published yet");
  assert.equal((await abby(`/api/gfs/assets/${pass.id}`, { method: "PATCH", body: { price_cents: 5 } })).json.error, "price");
  // Publish the World.
  await wes(`/api/gfs/assets/${w.id}/stage`, { method: "POST", body: { to: "review" } });
  await abby(`/api/gfs/assets/${w.id}/stage`, { method: "POST", body: { to: "approved", confirm: true } });
  assert.equal((await abby(`/api/gfs/assets/${w.id}/stage`, { method: "POST", body: { to: "live", location: "gfs_storage", ref: "Dallas2027-world-01" } })).json.asset.stage_name, "Published");
  r = await abby(`/api/gfs/assets/${pass.id}`);
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "DELETE" })).json.error, "gfs_asset_keep");
  // A school venue World is never sold.
  const school = await make(wes, { kind: "venue_world", title: "Lincoln High · Stadium World", event_id: ev.dallas.id });
  r = await wes(`/api/gfs/assets/${school.id}`, { method: "PATCH", body: { school_venue: true } });
  assert.equal(r.json.asset.school_venue, true);
  assert.equal((await abby(`/api/gfs/assets/${pass.id}`, { method: "PATCH", body: { source_asset_id: ev.moment } })).json.error, "source_world", "an edition of a World only");
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "PATCH", body: { school_venue: true } })).json.error, "gfs_asset_locked");
});

test("edits and brand assets: marketing consent for featured athletes; a sponsor's licence for its marks", async () => {
  const e = await make(wes, { kind: "edit", format: "feature", title: "Who is Bulldogs #12?", event_id: ev.dallas.id });
  let r = await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { athletes: { add: [ro.ok.id, ro.no3d.id] }, sponsor_marks: true } });
  assert.deepEqual(codes(r.json.asset), ["marks_licensed", "no_marketing_consent:9"]);
  assert.equal((await wes(`/api/gfs/assets/${e.id}/check`, { method: "POST", body: { check: "marks_licensed", on: true } })).status, 403, "an approver records the licence");
  await abby(`/api/gfs/assets/${e.id}/check`, { method: "POST", body: { check: "marks_licensed", on: true } });
  r = await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { athletes: { remove: [ro.no3d.id] } } });
  assert.deepEqual(codes(r.json.asset), []);
  // Where a file lives: labels and IDs, never a folder path; a link only for a brand asset.
  assert.equal((await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { location: "gfs_storage", ref: "2027/03/Dallas/Some Name/clip.mp4" } })).json.error, "ref");
  assert.equal((await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { location: "link", ref: "https://drive.example.com/x" } })).json.error, "link_brand_only");
  assert.equal((await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { sha256: "abc" } })).json.error, "sha256");
  r = await wes(`/api/gfs/assets/${e.id}`, { method: "PATCH", body: { location: "gfs_storage", ref: "Dallas2027-WR-12-Feature-01", sha256: "A".repeat(64) } });
  assert.equal(r.json.asset.sha256, "a".repeat(64));
  const b = await make(abby, { kind: "brand", format: "lut", title: "Pylon Standard LUT" });
  r = await abby(`/api/gfs/assets/${b.id}`, { method: "PATCH", body: { location: "link", ref: "https://www.canva.com/design/abc" } });
  assert.equal(r.json.asset.location, "link");
  assert.equal((await abby(`/api/gfs/assets/${b.id}`, { method: "PATCH", body: { location: "link", ref: "javascript:alert(1)" } })).json.error, "link_brand_only");
  // A draft can be deleted.
  assert.equal((await abby(`/api/gfs/assets/${b.id}`, { method: "DELETE" })).json.ok, true);
});

test("after the fact: a takedown puts a live Moment on the retire list and keeps the takedown open until it's retired", async () => {
  // Wes's live Moment shows Bulldogs #12. The family withdraws consent.
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: ev.dallas.id, roster_row: ro.ok.id, reason: "consent_withdrawn" } });
  assert.equal(td.status, 200, JSON.stringify(td.json));
  assert.equal(td.json.takedown.assets_live, 1);
  const m = (await wes(`/api/gfs/assets/${ev.moment}`)).json.asset;
  assert.equal(m.needs_retiring, true);
  assert.deepEqual(codes(m), ["takedown:12"]);
  assert.equal((await vic(`/api/gfs/assets/${ev.moment}`)).json.asset.held, true, "a viewer sees it's held");
  const lib = await wes("/api/gfs/assets");
  assert.ok(lib.json.totals.needs_retiring >= 1);
  // Off every other surface: clips come down in Wes's region, but the step
  // stays open while the Moment is live.
  let step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.equal(step.status, 200, JSON.stringify(step.json));
  assert.equal(step.json.partial.assets_live, 1);
  assert.equal(step.json.takedown.steps.find((s) => s.key === "other").done_at, null);
  await wes(`/api/gfs/assets/${ev.moment}/retire`, { method: "POST", body: { reason: "takedown" } });
  step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.ok(step.json.takedown.steps.find((s) => s.key === "other").done_at, "done once the Moment is retired");
  assert.equal(step.json.takedown.assets_live, 0);
});

test("the activity log: what happened and where, never a title", async () => {
  const acts = db.tables.team_activity.filter((a) => /^gfs_asset_/.test(a.action));
  assert.ok(acts.some((a) => a.action === "gfs_asset_created" && a.subject === "Dallas2027" && a.detail.region === "south_central"));
  assert.ok(acts.some((a) => a.action === "gfs_asset_live"));
  assert.ok(acts.some((a) => a.subject === "the national brand kit" && a.detail.region === null));
  assert.ok(!JSON.stringify(acts).includes("Bulldogs"), "no titles in the log");
});

test("the rules agree with the kinds: athletes, live places, checks", () => {
  assert.deepEqual(A.KIND_KEYS, ["edit", "venue_world", "moment", "world_pass", "narrative_nft", "brand"]);
  assert.deepEqual(A.checksFor({ kind: "edit", sponsor_marks: true }), ["marks_licensed"]);
  assert.deepEqual(A.checksFor({ kind: "moment" }), ["deidentified", "tier4"]);
  assert.equal(A.refProblem("brand", "link", "https://x.example.com/a"), null);
  assert.equal(A.refProblem("edit", "gfs_storage", "Dallas2027-WR-11-EndZone-042"), null);
  assert.equal(A.refProblem("edit", "gfs_storage", "has space"), "ref");
  assert.equal(A.refProblem("edit", null, "x"), "location_required");
  assert.equal(A.liveLocationOk({ kind: "moment", location: "family_library", ref: "x" }), true);
  assert.equal(A.liveLocationOk({ kind: "moment", location: "gfs_storage", ref: "x" }), false);
});
