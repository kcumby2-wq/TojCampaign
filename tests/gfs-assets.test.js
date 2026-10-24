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
const fs = require("fs");
const path = require("path");
const vm = require("vm");
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
const pushes = [];
const today = new Date().toISOString().slice(0, 10);
const consents = { consent_capture: true, consent_recruiting: false, consent_marketing: true, consent_sale: false, consent_training: false, consent_3d: true, consent_nft: true, consent_feature: false, consent_commercial: false, public_display: false };

before(async () => {
  const mk = (code, name, region, state) => ({ id: crypto.randomUUID(), code, name, series: "Legacy Tour", size: "premier", region, city: name.split(" · ")[1], state, tz: "America/Chicago", starts_on: today, ends_on: today, status: "planning", created_by: "kyron@example.com" });
  ev.dallas = mk("Dallas2027", "Legacy Tour · Dallas", "south_central", "TX");
  ev.chicago = mk("Chicago2027", "Legacy Tour · Chicago", "midwest", "IL");
  ev.tulsa = mk("Tulsa2027", "Legacy Tour · Tulsa", "south_central", "OK");
  const row = (event, rid, team, jersey, extra) => ({ id: crypto.randomUUID(), event_id: event.id, roster_id: rid, team, division: "14U", jersey, position: "WR", under_13: false, do_not_publish: false, low_profile: false, priority: false, takedown_at: null, ...consents, ...extra });
  ro.ok = row(ev.dallas, "ST-100", "Bulldogs", "12", {});
  ro.kid = row(ev.dallas, "ST-101", "Bulldogs", "7", { under_13: null });
  ro.no3d = row(ev.dallas, "ST-102", "Hawks", "9", { consent_3d: false, consent_nft: false, consent_marketing: false });
  ro.listed = row(ev.dallas, "ST-103", "Hawks", "21", { consent_sale: true, public_display: true });
  ro.b1 = row(ev.dallas, "ST-104", "Rams", "3", {});
  ro.b2 = row(ev.dallas, "ST-105", "Rams", "4", {});
  ro.chi = row(ev.chicago, "ST-200", "Wolves", "4", {});
  // One athlete at two stops (one Sports Thread ID), in two regions.
  ro.twoDal = row(ev.dallas, "ST-300", "Comets", "8", {});
  ro.twoChi = row(ev.chicago, "ST-300", "Comets", "8", {});
  ro.tulsa = row(ev.tulsa, "ST-400", "Owls", "5", {});
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "wes@example.com", name: "Wes Director", role: "member", tools: ["gfs"], regions: ["south_central"], status: "active" },
        { email: "wendy@example.com", name: "Wendy West", role: "member", tools: ["gfs"], regions: ["west"], status: "active" },
        { email: "mia@example.com", name: "Mia Midwest", role: "member", tools: ["gfs"], regions: ["midwest"], status: "active" },
        { email: "abby@example.com", name: "Abby Approver", role: "approver", tools: ["gfs"], regions: [], status: "active" },
        { email: "gina@example.com", name: "Gina Gone", role: "approver", tools: ["gfs"], regions: [], status: "active" },
        { email: "vic@example.com", name: "Vic Viewer", role: "viewer", tools: ["gfs"], regions: ["south_central"], status: "active" },
      ],
      push_subscriptions: [{ id: crypto.randomUUID(), email: "mia@example.com", endpoint: "https://push.example.com/mia", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }],
      gfs_events: [ev.dallas, ev.chicago, ev.tulsa],
      gfs_roster: Object.values(ro),
      gfs_clips: [
        { id: crypto.randomUUID(), event_id: ev.dallas.id, match: "matched", stage: "approved", held: false, roster_row: ro.ok.id, delivered_at: new Date().toISOString(), listed_at: null, removed_at: null },
        { id: crypto.randomUUID(), event_id: ev.dallas.id, match: "unmatched", stage: "shot", held: false },
      ],
    },
    { unique: { gfs_events: ["code"] } }
  );
  setSupabase(db);
  P.setSender(async (sub, payload) => { pushes.push({ email: sub.email, payload }); return {}; });
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
  const call = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
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
let kyron, wes, wendy, mia, abby, gina, vic;
async function signIn() {
  if (kyron) return;
  kyron = await as("kyron@example.com", "admin");
  wes = await as("wes@example.com");
  wendy = await as("wendy@example.com");
  mia = await as("mia@example.com");
  abby = await as("abby@example.com");
  gina = await as("gina@example.com");
  vic = await as("vic@example.com");
}
const make = async (c, body) => {
  const r = await c("/api/gfs/assets", { method: "POST", body });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.asset;
};
const patch = (c, id, body) => c(`/api/gfs/assets/${id}`, { method: "PATCH", body });
const stage = (c, id, body) => c(`/api/gfs/assets/${id}/stage`, { method: "POST", body });
const check = (c, id, name, on = true) => c(`/api/gfs/assets/${id}/check`, { method: "POST", body: { check: name, on } });
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
  assert.equal((await patch(wes, national.id, { title: "x" })).json.error, "region_not_yours", "a director can read a national asset but not change it");
  // The library carries each stop's clips.
  const mine = await wes("/api/gfs/assets");
  const stop = mine.json.stops.find((s) => s.id === ev.dallas.id);
  assert.equal(stop.clips.shot, 2);
  assert.equal(stop.clips.delivered, 1);
});

test("titles and notes: no contact details and no links, footage links included", async () => {
  const e = await make(wes, { kind: "edit", title: "Recap · day two", event_id: ev.dallas.id });
  for (const title of ["https://drive.google.com/file/d/1AbC/view", "raw at www.dropbox.com/s/xyz", "dropbox.com/s/xyz/EndZone.mp4", "ｈｔｔｐｓ://drive.example.com/x"]) {
    assert.equal((await wes("/api/gfs/assets", { method: "POST", body: { kind: "edit", title, event_id: ev.dallas.id } })).json.error, "links", title);
    assert.equal((await patch(wes, e.id, { title })).json.error, "links", title);
  }
  assert.equal((await patch(wes, e.id, { note: "raw: https://www.dropbox.com/s/xyz/EndZone.mp4" })).json.error, "links");
  assert.equal((await patch(wes, e.id, { note: "wes＠example.com" })).json.error, "contact_details", "full-width @ counts");
  const ok = await patch(wes, e.id, { note: "Awww. Reshoot field 3 at 2:30", title: "Recap · day two, v2" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.asset.note, "Awww. Reshoot field 3 at 2:30");
});

test("a 3D/4D Moment: one athlete with 3D consent, the file before review, the approver's checks in review, the family's library", async () => {
  const m = await make(wes, { kind: "moment", format: "4d", title: "Catch on field 3", event_id: ev.dallas.id });
  assert.deepEqual(codes(m), ["deidentified", "one_athlete", "tier4"]);
  const add = (who) => patch(wes, m.id, { athletes: { add: [who] } });
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
  // An approver's checks wait for review; a director can't record them at all.
  assert.equal((await check(wes, m.id, "tier4")).status, 403);
  assert.equal((await check(abby, m.id, "mint_consent")).json.error, "check_not_for_this_asset");
  assert.equal((await check(abby, m.id, "tier4")).json.error, "gfs_asset_check_in_review");
  assert.equal((await abby(`/api/gfs/assets/${m.id}`)).json.asset.checks.tier4.can, false, "not in a draft");
  // Review needs the file where it goes live.
  assert.equal((await stage(wes, m.id, { to: "approved" })).status, 403);
  assert.equal((await stage(wes, m.id, { to: "review" })).json.error, "gfs_asset_file_required");
  await patch(wes, m.id, { location: "gfs_storage", ref: "Dallas2027-WR-12-EndZone-042" });
  assert.equal((await stage(wes, m.id, { to: "review" })).json.error, "gfs_asset_file_required", "GFS storage isn't where a Moment goes live");
  assert.equal((await patch(wes, m.id, { location: "family_library", ref: "family/123" })).json.error, "ref", "no slashes");
  await patch(wes, m.id, { location: "family_library", ref: "lib-88123" });
  assert.equal((await stage(wes, m.id, { to: "review" })).json.asset.stage, "review");
  // From review on, nothing changes: the details, the file, the athletes.
  assert.equal((await patch(wes, m.id, { title: "changed" })).json.error, "gfs_asset_locked");
  assert.equal((await patch(wes, m.id, { ref: "lib-other-2" })).json.error, "gfs_asset_locked");
  assert.equal((await patch(wes, m.id, { athletes: { remove: [ro.ok.id] } })).json.error, "gfs_asset_locked");
  assert.equal((await abby(`/api/gfs/assets/${m.id}`)).json.asset.checks.tier4.can, true, "in review");
  r = await check(abby, m.id, "tier4");
  r = await check(abby, m.id, "deidentified");
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal(r.json.asset.checks.tier4.by, "Abby Approver");
  const noConfirm = await stage(abby, m.id, { to: "approved" });
  assert.equal(noConfirm.json.error, "confirm_checklist");
  assert.match(noConfirm.json.checklist, /blurred or masked/);
  assert.equal((await stage(abby, m.id, { to: "approved", confirm: true })).json.asset.stage, "approved");
  assert.equal((await check(abby, m.id, "tier4", false)).json.error, "gfs_asset_locked", "checks hold once approved");
  // It goes out as it was reviewed: a different file at the last step is refused.
  assert.equal((await stage(abby, m.id, { to: "live", location: "family_library", ref: "lib-unmasked-2" })).json.error, "gfs_asset_locked");
  const live = await stage(abby, m.id, { to: "live" });
  assert.equal(live.json.asset.stage, "live");
  assert.equal(live.json.asset.stage_name, "Delivered");
  assert.equal(live.json.asset.ref, "lib-88123");
  // A viewer sees it's delivered: not the file's ID, the roster ID, why anything's held, or the checks.
  const seen = (await vic(`/api/gfs/assets/${m.id}`)).json.asset;
  assert.deepEqual([seen.ref, seen.blocks, seen.athletes[0].roster_id, seen.checks], [null, null, null, null]);
  ev.moment = m.id;
});

test("back to draft clears the review's checks, so a check never carries over to another athlete", async () => {
  // A Moment: Tier 4 and de-identification recorded in review, then a director sends it back.
  const m = await make(wes, { kind: "moment", format: "3d", title: "Run after the catch", event_id: ev.dallas.id });
  await patch(wes, m.id, { athletes: { add: [ro.b1.id] }, location: "family_library", ref: "lib-5001" });
  await stage(wes, m.id, { to: "review" });
  await check(abby, m.id, "tier4");
  await check(abby, m.id, "deidentified");
  let r = await stage(wes, m.id, { to: "draft" });
  assert.equal(r.json.asset.stage, "draft");
  assert.deepEqual([r.json.asset.checks.tier4.on, r.json.asset.checks.deidentified.on], [false, false]);
  r = await patch(wes, m.id, { athletes: { remove: [ro.b1.id], add: [ro.b2.id] } });
  assert.deepEqual([r.json.asset.checks.tier4.on, r.json.asset.checks.deidentified.on, r.json.asset.ready], [false, false, false]);
  // An NFT: the Consent to Mint can't be recorded in a draft, and an approved
  // NFT sent back to draft loses it with the approval.
  const n = await make(wes, { kind: "narrative_nft", title: "Interception · day one", event_id: ev.dallas.id });
  await patch(wes, n.id, { athletes: { add: [ro.b1.id] }, location: "ledger", ref: "2001" });
  assert.equal((await check(kyron, n.id, "mint_consent")).json.error, "gfs_asset_check_in_review");
  await stage(wes, n.id, { to: "review" });
  assert.equal((await check(kyron, n.id, "mint_consent")).status, 200);
  await stage(abby, n.id, { to: "approved", confirm: true });
  r = await stage(abby, n.id, { to: "draft" });
  assert.deepEqual([r.json.asset.stage, r.json.asset.checks.mint_consent.on, r.json.asset.approved], ["draft", false, null]);
  r = await patch(wes, n.id, { athletes: { remove: [ro.b1.id], add: [ro.b2.id] } });
  assert.deepEqual(codes(r.json.asset), ["mint_consent"], "athlete B needs their own Consent to Mint");
});

test("Moments that can't be made: under 13, no 3D permission, an Illinois stop", async () => {
  const kid = await make(wes, { kind: "moment", format: "3d", title: "Sideline catch", event_id: ev.dallas.id });
  let r = await patch(wes, kid.id, { athletes: { add: [ro.kid.id] } });
  assert.ok(codes(r.json.asset).includes("under_13:7"));
  const no3d = await make(wes, { kind: "moment", title: "Toe tap", event_id: ev.dallas.id });
  r = await patch(wes, no3d.id, { athletes: { add: [ro.no3d.id] } });
  assert.ok(codes(r.json.asset).includes("no_3d_consent:9"));
  const il = await make(mia, { kind: "moment", title: "Deep ball", event_id: ev.chicago.id });
  r = await patch(mia, il.id, { athletes: { add: [ro.chi.id] }, location: "family_library", ref: "lib-chi-1" });
  assert.ok(codes(r.json.asset).includes("illinois_hold"));
  await stage(mia, il.id, { to: "review" });
  for (const c of ["deidentified", "tier4"]) await check(abby, il.id, c);
  const refused = await stage(abby, il.id, { to: "approved", confirm: true });
  assert.equal(refused.json.error, "gfs_asset_blocked");
  assert.deepEqual(refused.json.blocks.map((b) => b.code), ["illinois_hold"]);
});

test("a Narrative NFT: NFT permission on the roster and the Consent to Mint, which only Kyron records; retiring it keeps nothing about the athlete", async () => {
  const n = await make(wes, { kind: "narrative_nft", title: "First touchdown · day one", event_id: ev.dallas.id });
  await patch(wes, n.id, { athletes: { add: [ro.ok.id] }, location: "ledger", ref: "1042", note: "Original file verified" });
  await stage(wes, n.id, { to: "review" });
  assert.equal((await check(abby, n.id, "mint_consent")).json.error, "check_owner_only");
  const r = await check(kyron, n.id, "mint_consent");
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal(r.json.asset.checks.mint_consent.by, "the owner");
  await stage(abby, n.id, { to: "approved", confirm: true });
  assert.equal((await stage(abby, n.id, { to: "live" })).json.asset.stage_name, "Minted");
  // Withdrawn: retiring it clears the file, the title, the note and the athlete.
  const ret = await wes(`/api/gfs/assets/${n.id}/retire`, { method: "POST", body: { reason: "withdrawn" } });
  assert.equal(ret.json.asset.stage, "retired");
  assert.deepEqual([ret.json.asset.ref, ret.json.asset.sha256, ret.json.asset.note, ret.json.asset.title, ret.json.asset.athletes.length], [null, null, null, "Retired Narrative NFT", 0]);
  assert.equal((await stage(wes, n.id, { to: "review" })).status, 409, "retired stays retired");
  assert.equal((await wes(`/api/gfs/assets/${n.id}/retire`, { method: "POST", body: { reason: "withdrawn" } })).json.error, "gfs_asset_retired");
  // An earlier retire that stopped short is finished by trying again.
  const m = await make(wes, { kind: "moment", title: "Leaping grab", event_id: ev.dallas.id });
  await patch(wes, m.id, { athletes: { add: [ro.ok.id] } });
  const row = db.tables.gfs_assets.find((x) => x.id === m.id);
  Object.assign(row, { stage: "retired", retired_at: new Date().toISOString(), retire_reason: "mistake", ref: "lib-left-1", title: "Retired 3D/4D Moment" });
  const again = await wes(`/api/gfs/assets/${m.id}/retire`, { method: "POST", body: { reason: "mistake" } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual([again.json.asset.ref, again.json.asset.athletes.length], [null, 0]);
  assert.equal(db.tables.gfs_asset_athletes.filter((x) => x.asset_id === m.id).length, 0);
});

test("a venue World and its World Pass: no people, venue permission, never a school venue, a fixed price, the same stop", async () => {
  const w = await make(wes, { kind: "venue_world", title: "Dallas 2027 · Stadium World", event_id: ev.dallas.id });
  assert.equal((await patch(wes, w.id, { athletes: { add: [ro.ok.id] } })).json.error, "gfs_asset_no_athletes");
  assert.deepEqual(codes(w), ["venue_permission"]);
  assert.equal((await check(wes, w.id, "venue_permission")).status, 200, "a director's check goes in a draft");
  const pass = await make(abby, { kind: "world_pass", title: "Dallas 2027 · Stadium World edition", event_id: ev.dallas.id });
  assert.deepEqual(codes(pass), ["price", "source_world"]);
  let r = await patch(abby, pass.id, { price_cents: 2500, source_asset_id: w.id });
  assert.deepEqual(codes(r.json.asset), ["source_world"], "the World isn't published yet");
  assert.equal((await patch(abby, pass.id, { price_cents: 5 })).json.error, "price");
  // Another stop's World can't be its source.
  const chiWorld = await make(mia, { kind: "venue_world", title: "Chicago 2027 · Stadium World", event_id: ev.chicago.id });
  assert.equal((await patch(abby, pass.id, { source_asset_id: chiWorld.id })).json.error, "source_world");
  // Publish the World.
  await patch(wes, w.id, { location: "gfs_storage", ref: "Dallas2027-world-01" });
  await stage(wes, w.id, { to: "review" });
  await stage(abby, w.id, { to: "approved", confirm: true });
  assert.equal((await stage(abby, w.id, { to: "live" })).json.asset.stage_name, "Published");
  r = await abby(`/api/gfs/assets/${pass.id}`);
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal((await wes(`/api/gfs/assets/${w.id}`, { method: "DELETE" })).json.error, "gfs_asset_keep");
  // A school venue World is never sold.
  const school = await make(wes, { kind: "venue_world", title: "Lincoln High · Stadium World", event_id: ev.dallas.id });
  r = await patch(wes, school.id, { school_venue: true });
  assert.equal(r.json.asset.school_venue, true);
  assert.equal((await patch(abby, pass.id, { source_asset_id: ev.moment })).json.error, "source_world", "an edition of a World only");
  assert.equal((await patch(wes, w.id, { school_venue: true })).json.error, "gfs_asset_locked");
  // On sale, as reviewed.
  await patch(abby, pass.id, { location: "gfs_store", ref: "Dallas2027-pass-01" });
  await stage(abby, pass.id, { to: "review" });
  await stage(abby, pass.id, { to: "approved", confirm: true });
  assert.equal((await stage(abby, pass.id, { to: "live" })).json.asset.stage_name, "On sale");
});

test("edits and brand assets: marketing consent; on SportsClippers, sale consent and public display; a sponsor's licence for its marks", async () => {
  const e = await make(wes, { kind: "edit", format: "feature", title: "Who is Bulldogs #12?", event_id: ev.dallas.id });
  let r = await patch(wes, e.id, { athletes: { add: [ro.ok.id, ro.no3d.id] }, sponsor_marks: true });
  assert.deepEqual(codes(r.json.asset), ["marks_licensed", "no_marketing_consent:9"]);
  assert.equal((await check(wes, e.id, "marks_licensed")).status, 403, "an approver records the licence");
  assert.equal((await check(abby, e.id, "marks_licensed")).json.error, "gfs_asset_check_in_review");
  r = await patch(wes, e.id, { athletes: { remove: [ro.no3d.id] } });
  assert.deepEqual(codes(r.json.asset), ["marks_licensed"]);
  // Where a file lives: labels and IDs, never a folder path; a link only for a brand asset.
  assert.equal((await patch(wes, e.id, { location: "gfs_storage", ref: "2027/03/Dallas/Some Name/clip.mp4" })).json.error, "ref");
  assert.equal((await patch(wes, e.id, { location: "link", ref: "https://www.canva.com/x" })).json.error, "link_brand_only");
  assert.equal((await patch(wes, e.id, { sha256: "abc" })).json.error, "sha256");
  // Listed on SportsClippers, an edit is a public listing (Schedule A).
  r = await patch(wes, e.id, { location: "sportsclippers", ref: "Dallas2027-WR-12-Feature-01" });
  assert.deepEqual(codes(r.json.asset), ["marks_licensed", "no_sale_consent:12", "not_public:12"]);
  const pick = (await wes(`/api/gfs/assets/${e.id}/roster`)).json.athletes;
  assert.deepEqual(pick.find((x) => x.jersey === "21").why, [], "sale consent and public display: can be listed");
  assert.deepEqual(pick.find((x) => x.jersey === "12").why, ["no_sale_consent", "not_public"]);
  r = await patch(wes, e.id, { location: "pylon_channels", ref: "Dallas2027-WR-12-Feature-01", sha256: "A".repeat(64) });
  assert.equal(r.json.asset.sha256, "a".repeat(64));
  assert.deepEqual(codes(r.json.asset), ["marks_licensed"]);
  await stage(wes, e.id, { to: "review" });
  r = await check(abby, e.id, "marks_licensed");
  assert.deepEqual(codes(r.json.asset), []);
  assert.equal((await stage(abby, e.id, { to: "approved", confirm: true })).json.asset.stage, "approved");
  // A brand link goes to a design tool, never a file host.
  const b = await make(abby, { kind: "brand", format: "lut", title: "Pylon Standard LUT" });
  r = await patch(abby, b.id, { location: "link", ref: "https://www.canva.com/design/abc" });
  assert.equal(r.json.asset.location, "link");
  assert.equal((await patch(abby, b.id, { location: "link", ref: "javascript:alert(1)" })).json.error, "link_brand_only");
  assert.equal((await patch(abby, b.id, { location: "link", ref: "https://drive.google.com/file/d/1AbC/view" })).json.error, "link_host");
  assert.equal((await patch(abby, b.id, { location: "link", ref: "https://canva.com.example.net/x" })).json.error, "link_host");
  // A draft can be deleted.
  assert.equal((await abby(`/api/gfs/assets/${b.id}`, { method: "DELETE" })).json.ok, true);
  // A sponsor asset always carries the sponsor's marks, so it needs the licence.
  const s = await make(abby, { kind: "brand", format: "sponsor", title: "Sponsor end card" });
  assert.equal(s.sponsor_marks, true);
  r = await patch(abby, s.id, { sponsor_marks: false, location: "gfs_storage", ref: "sponsor-endcard-01" });
  assert.equal(r.json.asset.sponsor_marks, true);
  await stage(abby, s.id, { to: "review" });
  const blocked = await stage(abby, s.id, { to: "approved", confirm: true });
  assert.equal(blocked.json.error, "gfs_asset_blocked");
  assert.deepEqual(blocked.json.blocks.map((x) => x.code), ["marks_licensed"]);
  const g = await make(abby, { kind: "brand", format: "graphic", title: "Sponsor graphic" });
  r = await patch(abby, g.id, { format: "sponsor" });
  assert.equal(r.json.asset.sponsor_marks, true, "switching to the sponsor format turns the marks on");
});

test("saving a draft checks everything first: a refusal changes nothing", async () => {
  const e = await make(wes, { kind: "edit", title: "Recap · day three", event_id: ev.dallas.id });
  const bad = await patch(wes, e.id, { title: "Recap · day three, final", athletes: { add: [ro.chi.id] } });
  assert.equal(bad.json.error, "gfs_asset_not_on_roster");
  assert.equal(db.tables.gfs_assets.find((x) => x.id === e.id).title, "Recap · day three", "the title wasn't saved");
  for (const athletes of [null, [], "x", { add: "x" }]) assert.equal((await patch(wes, e.id, { athletes })).json.error, "athlete", JSON.stringify(athletes));
  // Two adds at once can't leave two athletes on a Moment.
  const m = await make(wes, { kind: "moment", title: "Two at once", event_id: ev.dallas.id });
  await Promise.all([ro.b1, ro.b2].map((x) => patch(wes, m.id, { athletes: { add: [x.id] } })));
  assert.ok(db.tables.gfs_asset_athletes.filter((x) => x.asset_id === m.id).length <= 1);
});

test("a stop that moves region takes its assets: the old region's director loses them, the new one has them", async () => {
  const m = await make(wes, { kind: "moment", title: "Tulsa catch", event_id: ev.tulsa.id });
  await patch(wes, m.id, { athletes: { add: [ro.tulsa.id] } });
  const moved = await abby(`/api/gfs/events/${ev.tulsa.id}`, { method: "PATCH", body: { region: "west" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  assert.equal((await wes(`/api/gfs/assets/${m.id}`)).status, 404);
  assert.equal((await wes(`/api/gfs/assets/${m.id}/roster`)).status, 404);
  const w = await wendy(`/api/gfs/assets/${m.id}`);
  assert.equal(w.status, 200);
  assert.equal(w.json.asset.region, "west");
  assert.equal((await wendy(`/api/gfs/assets?event=${ev.tulsa.id}`)).json.assets.length, 1);
});

test("after the fact: a takedown puts a live Moment on the retire list and keeps the takedown open until it's retired", async () => {
  // Wes's live Moment shows Bulldogs #12. The family withdraws consent.
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: ev.dallas.id, roster_row: ro.ok.id, reason: "consent_withdrawn" } });
  assert.equal(td.status, 200, JSON.stringify(td.json));
  assert.equal(td.json.takedown.assets_live, 1);
  assert.deepEqual(td.json.takedown.assets_live_events, ["Dallas2027"]);
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
  assert.deepEqual([step.json.partial.asset_events, step.json.partial.asset_regions], [["Dallas2027"], ["south_central"]]);
  assert.equal(step.json.takedown.steps.find((s) => s.key === "other").done_at, null);
  const ret = await wes(`/api/gfs/assets/${ev.moment}/retire`, { method: "POST", body: { reason: "takedown" } });
  assert.equal(ret.json.asset.title, "Retired 3D/4D Moment", "the title kept the team and jersey; it doesn't now");
  step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.ok(step.json.takedown.steps.find((s) => s.key === "other").done_at, "done once the Moment is retired");
  assert.equal(step.json.takedown.assets_live, 0);
});

test("a takedown held up by a live asset in another region says where, and tells that region's directors", async () => {
  const e = await make(mia, { kind: "edit", title: "Chicago recap", event_id: ev.chicago.id });
  await patch(mia, e.id, { athletes: { add: [ro.twoChi.id] }, location: "pylon_channels", ref: "Chicago2027-recap-01" });
  await stage(mia, e.id, { to: "review" });
  await stage(abby, e.id, { to: "approved", confirm: true });
  assert.equal((await stage(abby, e.id, { to: "live" })).json.asset.stage, "live");
  pushes.length = 0;
  const td = await wes("/api/gfs/takedowns", { method: "POST", body: { event_id: ev.dallas.id, roster_row: ro.twoDal.id, reason: "safety_request" } });
  assert.equal(td.json.takedown.assets_live, 1);
  assert.equal(td.json.takedown.assets_live_yours, 0);
  assert.deepEqual([td.json.takedown.assets_live_events, td.json.takedown.assets_live_regions], [["Chicago2027"], ["midwest"]]);
  const step = await wes(`/api/gfs/takedowns/${td.json.takedown.id}`, { method: "PATCH", body: { other_done: true } });
  assert.deepEqual(step.json.partial, { removed: 0, still_out: 0, regions: [], events: [], assets_live: 1, asset_regions: ["midwest"], asset_events: ["Chicago2027"] });
  await new Promise((r) => setTimeout(r, 50));
  const told = pushes.filter((p) => p.email === "mia@example.com" && /assets still live/.test(p.payload.title));
  assert.equal(told.length, 1, JSON.stringify(pushes));
  assert.match(told[0].payload.body, /Chicago2027/);
  assert.ok(!/Comets|#8/.test(JSON.stringify(told[0].payload)), "no athlete in the notification");
});

test("who recorded it: a teammate's name, the owner, or a former teammate", async () => {
  const w = await make(wes, { kind: "venue_world", title: "Dallas 2027 · Practice field World", event_id: ev.dallas.id });
  await check(wes, w.id, "venue_permission");
  await patch(wes, w.id, { location: "gfs_storage", ref: "Dallas2027-world-02" });
  await stage(wes, w.id, { to: "review" });
  await stage(gina, w.id, { to: "approved", confirm: true });
  db.tables.team_members = db.tables.team_members.filter((x) => x.email !== "gina@example.com");
  const a = (await wes(`/api/gfs/assets/${w.id}`)).json.asset;
  assert.equal(a.approved.by, "a former teammate");
  assert.equal(a.checks.venue_permission.by, "Wes Director");
});

test("the activity log: what happened and where, never a title", async () => {
  const acts = db.tables.team_activity.filter((a) => /^gfs_asset_/.test(a.action));
  assert.ok(acts.some((a) => a.action === "gfs_asset_created" && a.subject === "Dallas2027" && a.detail.region === "south_central"));
  assert.ok(acts.some((a) => a.action === "gfs_asset_live"));
  assert.ok(acts.some((a) => a.subject === "the national brand kit" && a.detail.region === null));
  assert.ok(acts.some((a) => a.subject === "the South Central brand kit" && a.detail.region === "south_central"), "a region's brand asset is logged as that region's kit");
  assert.ok(!JSON.stringify(acts).includes("Bulldogs"), "no titles in the log");
});

test("the rules agree with the kinds: athletes, live places, checks", () => {
  assert.deepEqual(A.KIND_KEYS, ["edit", "venue_world", "moment", "world_pass", "narrative_nft", "brand"]);
  assert.deepEqual(A.checksFor({ kind: "edit", sponsor_marks: true }), ["marks_licensed"]);
  assert.deepEqual(A.checksFor({ kind: "moment" }), ["deidentified", "tier4"]);
  assert.deepEqual(A.checkStages("venue_permission"), ["draft", "review"]);
  assert.deepEqual(A.checkStages("mint_consent"), ["review"]);
  assert.equal(A.refProblem("brand", "link", "https://www.figma.com/file/a"), null);
  assert.equal(A.refProblem("brand", "link", "https://x.example.com/a"), "link_host");
  assert.equal(A.refProblem("edit", "gfs_storage", "Dallas2027-WR-11-EndZone-042"), null);
  assert.equal(A.refProblem("edit", "gfs_storage", "has space"), "ref");
  assert.equal(A.refProblem("edit", null, "x"), "location_required");
  assert.equal(A.liveLocationOk({ kind: "moment", location: "family_library", ref: "x" }), true);
  assert.equal(A.liveLocationOk({ kind: "moment", location: "gfs_storage", ref: "x" }), false);
});

test("the screen's Save details sends only what changed, and never clears what it hasn't loaded", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app", "gfs-assets.js"), "utf8");
  const window = { TOJScreens: {} };
  vm.runInContext(src, vm.createContext({ window, document: {}, String, Number, Math, Object, Array, JSON, isFinite, encodeURIComponent }));
  const dp = (a, form) => JSON.parse(JSON.stringify(window.TOJAssets.detailsPatch(a, form)));
  const pass = { title: "Edition", note: null, format: null, price_cents: 2500, source: { id: "w1" }, school_venue: false, sponsor_marks: false };
  assert.deepEqual(dp(pass, { title: "Edition", note: "", price: "25.00", source: "", sourceLoaded: false }), { body: {} }, "the World list hadn't loaded: the source stays");
  assert.deepEqual(dp(pass, { title: "Edition", note: "", price: "abc" }), { error: "price" }, "a price that isn't a number is an error, not a cleared price");
  assert.deepEqual(dp(pass, { title: "Edition", price: "$30", source: "w2", sourceLoaded: true }), { body: { price_cents: 3000, source_asset_id: "w2" } });
  assert.deepEqual(dp(pass, { title: "Edition", price: "" }), { body: { price_cents: null } }, "clearing the price on purpose");
  assert.deepEqual(dp(pass, { title: "New name", marks: false }), { body: { title: "New name" } });
});

test("its ID where it went live: review needs only GFS's label; the ID is recorded once on the way live", async () => {
  const n = await make(wes, { kind: "narrative_nft", title: "Interception · day two", event_id: ev.dallas.id });
  // GFS's own label for the file is enough for review: the ledger's token comes later.
  await patch(wes, n.id, { athletes: { add: [ro.b2.id] }, location: "ledger", ref: "Dallas2027-NFT-INT-2" });
  assert.equal((await patch(wes, n.id, { live_ref: "TOKEN-1" })).json.error, "gfs_asset_locked", "never through Save");
  const rv = await stage(wes, n.id, { to: "review" });
  assert.equal(rv.status, 200, JSON.stringify(rv.json));
  await check(kyron, n.id, "mint_consent");
  const ap = await stage(abby, n.id, { to: "approved", confirm: true });
  assert.equal(ap.status, 200, JSON.stringify(ap.json));
  assert.equal((await stage(abby, n.id, { to: "live", live_ref: "token 77" })).json.error, "live_ref", "an ID in the label form");
  const live = await stage(abby, n.id, { to: "live", live_ref: " TOKEN-0077 " });
  assert.equal(live.status, 200, JSON.stringify(live.json));
  assert.deepEqual([live.json.asset.stage, live.json.asset.live_ref, live.json.asset.ref], ["live", "TOKEN-0077", "Dallas2027-NFT-INT-2"]);
  assert.equal((await patch(abby, n.id, { live_ref: "TOKEN-0078" })).json.error, "gfs_asset_locked", "it can't change after");
  assert.equal((await vic(`/api/gfs/assets/${n.id}`)).json.asset.live_ref, null, "viewers never see it");
  const ret = await wes(`/api/gfs/assets/${n.id}/retire`, { method: "POST", body: { reason: "withdrawn" } });
  assert.deepEqual([ret.json.asset.live_ref, ret.json.asset.ref], [null, null], "retiring an NFT clears it with the rest");
  // A place that gives no ID of its own: going live without one is fine.
  const w = await make(wes, { kind: "venue_world", title: "Dallas 2027 · Stadium World, west end", event_id: ev.dallas.id });
  assert.equal(w.live_ref, null);
});

test("links without https: more domains count, and a slash then a space isn't a link", () => {
  for (const s of ["fb.watch/abc", "sportsclippers.store/x", "bbc.co.uk/x", "photos.app.goo.gl/x", "we.tl/t-abc", "Drive.Google.com/drive/x"]) assert.equal(A.textOk(s), false, s);
  for (const s of ["Team.tv/ intro", "St.Louis/KC swing", "v2.final/cut", "Recap w/ highlights", "3D/4D Moment", "drive.google.com"]) assert.equal(A.textOk(s), true, s);
  assert.equal(A.refProblem("brand", "link", "https://www.canva.com/design/DAF1/view?utm=x&a=1"), null);
  assert.equal(A.refProblem("brand", "link", "https://www.canva.com/design/DAF1 x/view"), "link_host", "no spaces of any kind in a link");
  assert.equal(A.liveRefProblem("TOKEN-0077"), null);
  assert.equal(A.liveRefProblem("a/b"), "live_ref");
});
