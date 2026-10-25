// Ground Floor Sports · Pylon events (routes/gfs.js) against an in-memory
// Supabase. Made-up people and athletes only. The same rules are enforced in
// Postgres by migration 024; tests/gfs-db.test.js checks those.
//
//   node --test tests/gfs.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const P = require("../utils/push");
const G = require("../utils/gfs");

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const TODAY = iso(Date.now());
const TOMORROW = iso(Date.now() + DAY);
const LAST_MONTH = iso(Date.now() - 30 * DAY);
const LONG_AGO = iso(Date.now() - 400 * DAY);

let db, server, base;
let sent = [];

// The SQL counts function, in JS, over the fake tables.
function countsRpc(tables, { p_events }) {
  const out = [];
  const isOut = (c) => !!(c.listed_at || c.delivered_at) && !c.removed_at;
  for (const id of p_events) {
    const cs = (tables.gfs_clips || []).filter((c) => c.event_id === id);
    if (!cs.length) continue;
    const ready = (c) => c.stage === "approved" && !c.held && !c.removed_at;
    out.push({
      event_id: id,
      shot: cs.length,
      matched: cs.filter((c) => c.match === "matched").length,
      unmatched: cs.filter((c) => c.match === "unmatched").length,
      not_a_player: cs.filter((c) => c.match === "not_a_player").length,
      tagged: cs.filter((c) => ["tagged", "edited", "approved"].includes(c.stage)).length,
      edited: cs.filter((c) => ["edited", "approved"].includes(c.stage)).length,
      approved: cs.filter((c) => c.stage === "approved").length,
      delivered: cs.filter((c) => c.delivered_at).length,
      listed: cs.filter((c) => c.listed_at && !c.removed_at).length,
      held: cs.filter((c) => c.held).length,
      needs_removal: cs.filter((c) => (c.held || c.pull_reason === "no_sale_consent") && isOut(c)).length,
      to_family_only: cs.filter((c) => c.pull_reason === "not_public" && !c.held).length,
      to_send: cs.filter((c) => ready(c) && c.family_export_at && !c.delivered_at).length,
      to_list: cs.filter((c) => ready(c) && c.exported_at && !c.listed_at).length,
    });
  }
  return { data: out, error: null };
}

before(async () => {
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "josh@example.com", name: "Josh", role: "approver", tools: ["gfs"], regions: [], status: "active" },
        { email: "mw@example.com", name: "Midwest Director", role: "member", tools: ["gfs"], regions: ["midwest"], status: "active" },
        { email: "west@example.com", name: "West Director", role: "member", tools: ["gfs"], regions: ["west"], status: "active" },
        { email: "viewer@example.com", name: "Vi", role: "viewer", tools: ["gfs"], regions: ["midwest"], status: "active" },
        { email: "studio@example.com", name: "St", role: "member", tools: ["studio"], status: "active" },
      ],
    },
    { unique: { gfs_events: ["code"], gfs_creators: ["code"], gfs_clips: ["log_key"], gfs_uploads: ["log_key"] }, rpc: { gfs_event_counts: countsRpc } }
  );
  setSupabase(db);
  P.setSender(async (s, payload) => sent.push({ to: s.email, ...payload }));
  db.tables.push_subscriptions = ["kyron", "josh", "mw", "west", "viewer"].map((n, i) => ({ id: "p" + i, email: `${n}@example.com`, endpoint: `https://push.example.com/${n}`, p256dh: "p", auth: "a", fail_count: 0, kind: "web" }));

  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs", require("../routes/gfs"));
  app.use("/api/team", require("../routes/team"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); });

function client() {
  let cookie = "";
  return async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
}
async function as(email, role) {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (c, path, body) => c(path, { method: "POST", body: body || {} });
const patch = (c, path, body) => c(path, { method: "PATCH", body });

let kyron, josh, mw, west, view, ev, evId;
const creators = {};
const ROSTER = [
  "Athlete ID,First Name,Last Name,Date of Birth,Parent Email,Parent Phone,Team,Division,Jersey #,Position,Under 13,Capture,Marketing and Social,Sale of Media,Commercial,Public Display,Do Not Publish,Low Profile,Player Package",
  "ST-1001,Ann,Sample,2012-01-01,a@example.com,555-0101,Ohio Heat 14U,14U,7,Wide Receiver,no,yes,yes,yes,no,yes,,,yes",
  "ST-1002,Bea,Sample,2012-01-01,b@example.com,555-0102,Ohio Heat 14U,14U,21,QB,no,yes,no,yes,no,no,,,",
  "ST-1003,Cat,Sample,2012-01-01,c@example.com,555-0103,Ohio Heat 14U,14U,13,DB,no,yes,yes,yes,no,yes,yes,,",
  "ST-2001,Dee,Sample,2015-01-01,d@example.com,555-0201,Buckeye Flag 12U,12U,21,R,no,yes,yes,yes,no,yes,,yes,",
  "ST-2002,Eve,Sample,2015-01-01,e@example.com,555-0202,Buckeye Flag 12U,12U,11,C,,yes,yes,no,no,no,,,",
  "ST-2003,Fay,Sample,2015-01-01,f@example.com,555-0203,Buckeye Flag 12U,12U,5,WR,no,no,no,no,no,no,,,",
].join("\n");
const GAME = "Ohio-Heat-14U_vs_Buckeye-Flag-12U_" + TOMORROW.replace(/-/g, "");

test("only people with the Pylon events tool get in; a viewer reads, never writes", async () => {
  kyron = await as("kyron@example.com", "admin");
  josh = await as("josh@example.com");
  mw = await as("mw@example.com");
  west = await as("west@example.com");
  view = await as("viewer@example.com");
  const studio = await as("studio@example.com");
  assert.equal((await client()("/api/gfs/events")).status, 401);
  assert.equal((await studio("/api/gfs/events")).status, 403, "Studio access isn't Pylon events access");
  assert.equal((await view("/api/gfs/events")).status, 200);
  const meta = await mw("/api/gfs/meta");
  assert.deepEqual(meta.json.you.regions, ["midwest"]);
  assert.equal(meta.json.you.all_regions, false);
  assert.equal((await josh("/api/gfs/meta")).json.you.all_regions, true, "approvers see every region");
  assert.equal((await post(view, "/api/gfs/events", { name: "Nope" })).status, 403);
});

test("a Regional Director plans events in their own region; Schedule C rows come with it", async () => {
  assert.equal((await post(mw, "/api/gfs/events", { name: "Girls Flag · Out of region", size: "one_day", region: "west", city: "Ontario", state: "CA", starts_on: TOMORROW })).status, 403);
  const bad = await post(mw, "/api/gfs/events", { name: "Bad", size: "one_day", region: "midwest", city: "Geneva", state: "OH", starts_on: TOMORROW, ends_on: TODAY, tz: "Mars/Olympus", clip_price_cents: 100 });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.includes("tz") && bad.json.fields.includes("ends_on") && bad.json.fields.includes("clip_price_needs_approver"), JSON.stringify(bad.json));

  const r = await post(mw, "/api/gfs/events", { name: "Girls Flag · Geneva, OH", series: "Girls Flag", size: "one_day", region: "midwest", city: "Geneva", state: "OH", starts_on: TOMORROW });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  ev = r.json.event;
  evId = ev.id;
  assert.equal(ev.code, "Geneva" + TOMORROW.slice(0, 4));
  assert.equal(ev.tz, "America/New_York");
  assert.equal(ev.crew_target, 2, "one-day: two named, screened operators (C-2)");
  assert.equal(ev.director.you, true);
  const rows = db.tables.gfs_deliverables.filter((d) => d.event_id === evId);
  assert.equal(rows.length, 13);
  assert.equal(rows.find((d) => d.kind === "stills").required, 40);
  assert.equal(rows.find((d) => d.kind === "cutdowns").required, 3);
  assert.equal(rows.find((d) => d.kind === "recap").due_at, G.hoursAfter(G.endsAt({ ...ev, wraps_at: "18:00" }), 72));

  const second = await post(mw, "/api/gfs/events", { name: "Girls Flag · Geneva again", size: "clinic", region: "midwest", city: "Geneva", state: "OH", starts_on: TOMORROW });
  assert.equal(second.json.event.code, "Geneva" + TOMORROW.slice(0, 4) + "A", "codes stay unique");
  assert.ok(!db.tables.gfs_deliverables.some((d) => d.event_id === second.json.event.id && d.kind === "winner_montage"), "a clinic crowns no champion");

  assert.equal((await west(`/api/gfs/events/${evId}`)).status, 404, "another region's event doesn't exist for them");
  assert.ok(!(await west("/api/gfs/events")).json.events.some((e) => e.id === evId));
  assert.equal((await west("/api/gfs/events?region=midwest")).status, 404);
  assert.equal((await josh(`/api/gfs/events/${evId}`)).status, 200);
  assert.equal((await view(`/api/gfs/events/${evId}`)).status, 200);
  const created = db.tables.team_activity.find((a) => a.action === "gfs_event_created");
  assert.equal(created.subject, ev.code);
});

test("the plan: checklist marks, and deadlines follow the dates", async () => {
  const r = await patch(mw, `/api/gfs/events/${evId}`, { brief_sent: true, storefront_url: "https://sportsclippers.example/pylon/geneva", storefront_ready: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const plan = await mw(`/api/gfs/events/${evId}`);
  const marks = Object.fromEntries(plan.json.checklist.map((c) => [c.key, c.done]));
  assert.deepEqual(marks, { storefront: true, roster: false, brief: true, crew: false });

  const before = db.tables.gfs_deliverables.find((d) => d.event_id === evId && d.kind === "recap").due_at;
  await patch(mw, `/api/gfs/events/${evId}`, { wraps_at: "20:00" });
  const afterWrap = db.tables.gfs_deliverables.find((d) => d.event_id === evId && d.kind === "recap").due_at;
  assert.equal(new Date(afterWrap) - new Date(before), 2 * 3600000);

  await patch(mw, `/api/gfs/events/${evId}`, { ends_on: iso(Date.parse(TOMORROW) + DAY) });
  assert.equal(db.tables.gfs_deliverables.filter((d) => d.event_id === evId && d.kind === "cutdowns").length, 2, "a second day owes its own cut-downs");
  await patch(mw, `/api/gfs/events/${evId}`, { ends_on: TOMORROW, wraps_at: "18:00" });
  assert.equal(db.tables.gfs_deliverables.filter((d) => d.event_id === evId && d.kind === "cutdowns").length, 1);
  assert.equal((await patch(mw, `/api/gfs/events/${evId}`, { size: "premier" })).status, 400);
});

test("creators: directors add them, only the owner records screening, and crews follow the rules", async () => {
  const add = async (who, body) => post(who, "/api/gfs/creators", body);
  assert.equal((await add(mw, { name: "Creator A", region: "midwest", background_check_on: TODAY })).status, 403, "screening is GFS ops'");
  assert.equal((await add(mw, { name: "Creator W", region: "west" })).status, 400, "not their region");
  for (const [key, body] of Object.entries({
    a: { name: "Creator A", region: "midwest", home_city: "Cleveland" },
    b: { name: "Creator B", region: "midwest", home_city: "Columbus" },
    c: { name: "Creator C", region: "midwest", home_city: "Pittsburgh" },
    y: { name: "Creator Y", region: "midwest", home_city: "Akron" },
  })) {
    const r = await add(mw, body);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    creators[key] = r.json.creator;
  }
  creators.w = (await add(kyron, { name: "Creator W", region: "west", tier: "adult", age_checked_on: LAST_MONTH, contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH })).json.creator;

  // Unscreened creators can't be crewed: a new creator is youth with no age
  // check and no guardian until someone records them (migration 028).
  let r = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.a.id, role: "lead" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.problems.sort(), ["age_not_checked", "background_check", "no_contract", "safety_training", "youth_no_guardian", "youth_role"]);

  const screen = (id, extra = {}) => patch(kyron, `/api/gfs/creators/${id}`, { contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH, tier: "adult", age_checked_on: LAST_MONTH, ...extra });
  assert.equal((await screen(creators.a.id)).status, 200);
  await screen(creators.b.id);
  await screen(creators.c.id, { safety_training_on: LONG_AGO });
  await screen(creators.y.id, { tier: "youth", guardian_name: "Parent Y", guardian_email: "parent.y@example.com" });
  assert.equal((await patch(mw, `/api/gfs/creators/${creators.b.id}`, { safety_training_on: TODAY })).status, 403);
  assert.equal((await patch(kyron, `/api/gfs/creators/${creators.b.id}`, { background_check_on: "2999-01-01" })).status, 400, "a check can't be dated in the future");

  r = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.c.id, role: "shooter" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.problems, ["safety_training"], "training older than a year blocks");
  r = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.w.id, role: "shooter" });
  assert.equal(r.status, 404, "a director crews from their own regions");
  r = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.y.id, role: "lead" });
  assert.deepEqual(r.json.problems, ["youth_role"], "a youth creator never leads");

  const lead = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.a.id, role: "lead", note: "On site 8 a.m." });
  assert.equal(lead.status, 200, JSON.stringify(lead.json));
  assert.equal((await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.a.id, role: "shooter" })).json.error, "already_on_crew");
  const youth = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.y.id, role: "shooter" });
  assert.equal(youth.status, 200);
  r = await patch(mw, `/api/gfs/events/${evId}/crew/${youth.json.crew.id}`, { status: "confirmed" });
  assert.equal(r.json.error, "crew_youth_needs_adult", "never without a confirmed adult");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/crew/${lead.json.crew.id}`, { status: "confirmed" })).status, 200);
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/crew/${youth.json.crew.id}`, { status: "confirmed" })).status, 200);
  r = await patch(mw, `/api/gfs/events/${evId}/crew/${lead.json.crew.id}`, { status: "removed" });
  assert.equal(r.json.error, "crew_youth_left_alone");
  const shooter = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.b.id, role: "shooter" });
  await patch(mw, `/api/gfs/events/${evId}/crew/${shooter.json.crew.id}`, { status: "confirmed" });

  const crew = await mw(`/api/gfs/events/${evId}/crew`);
  assert.equal(crew.json.checklist.find((c) => c.key === "crew").done, true, "two on site and a lead");
  const cand = crew.json.candidates.find((c) => c.id === creators.c.id);
  assert.deepEqual(cand.blocks, ["safety_training"]);
  assert.ok(cand.badges.some((b) => b.key === "training" && !b.ok && /expired/i.test(b.label)));
  const asViewer = await view(`/api/gfs/events/${evId}/crew`);
  assert.ok(asViewer.json.crew.every((c) => c.creator.email === null && c.creator.notes === null));
});

test("the roster keeps IDs, jerseys and permissions, and drops names, birth dates and contacts", async () => {
  assert.equal((await post(view, `/api/gfs/events/${evId}/roster`, { csv: ROSTER })).status, 403);
  const r = await post(mw, `/api/gfs/events/${evId}/roster`, { csv: ROSTER });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.summary;
  assert.equal(s.added, 6);
  for (const col of ["First Name", "Last Name", "Date of Birth", "Parent Email", "Parent Phone"]) assert.ok(s.dropped_columns.includes(col), col);
  assert.equal(s.do_not_publish, 1);
  assert.equal(s.no_capture, 1);
  assert.equal(s.priority, 1);
  assert.equal(s.low_profile, 1);
  assert.equal(s.under_13, 3, "12U counts as under 13, verified age or not (L-5)");
  const stored = JSON.stringify(db.tables.gfs_roster);
  for (const leak of ["Ann", "Sample", "2012-01-01", "a@example.com", "555-0101"]) assert.ok(!stored.includes(leak), `stored ${leak}`);
  const again = await post(mw, `/api/gfs/events/${evId}/roster`, { csv: ROSTER });
  assert.equal(again.json.summary.added, 0);
  assert.equal(again.json.summary.unchanged, 6);
  assert.equal(db.tables.gfs_roster.filter((x) => x.event_id === evId).length, 6);
  assert.equal((await view(`/api/gfs/events/${evId}/roster`)).status, 403, "viewers don't see athletes' permissions");
  const list = await mw(`/api/gfs/events/${evId}/roster`);
  const dee = list.json.athletes.find((a) => a.roster_id === "ST-2001");
  assert.equal(dee.under_13, true);
  assert.equal(dee.visibility, "family", "under 13 is never public, whatever the guardian picked");
  assert.equal(list.json.athletes.find((a) => a.roster_id === "ST-1001").visibility, "public");
  assert.equal((await mw(`/api/gfs/events/${evId}`)).json.checklist.find((c) => c.key === "roster").done, true);
  const missing = await post(mw, `/api/gfs/events/${evId}/roster`, { csv: "Name,Jersey\nAnn,7\n" });
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json.problems, ["no_roster_id_column", "no_team_column"]);
});

let clipsByFile = {};
test("the upload log: clips tag by jersey number, holds come from the roster, and re-loading is safe", async () => {
  const csv = [
    "path,uploaded_at,creator,final_whistle",
    `${GAME}/Sideline/${GAME}_Sideline.mp4,${TOMORROW} 19:00,${creators.a.code},${TOMORROW} 12:00`,
    `${GAME}/EndZone/${GAME}_EndZone.mp4,${TOMORROW} 19:30,${creators.b.code},${TOMORROW} 12:00`,
    `${GAME}/7/7-Sideline-003.mp4,${TOMORROW} 19:00,${creators.a.code},`,
    `${GAME}/7/7-EndZone-004.mp4,${TOMORROW} 19:00,${creators.a.code},`,
    `${GAME}/13/13-Sideline-005.mp4,${TOMORROW} 19:00,${creators.a.code},`,
    `${GAME}/31/31-Sideline-006.mp4,${TOMORROW} 19:00,${creators.a.code},`,
    `${GAME}/21/21-EndZone-007.mp4,${TOMORROW} 19:00,${creators.b.code},`,
    `${GAME}/00-unassigned/EagleEye-008.mp4,${TOMORROW} 19:00,${creators.b.code},`,
    `${GAME}/11/11-Sideline-009.mp4,${TOMORROW} 19:00,${creators.b.code},`,
    `${GAME}/5/5-Sideline-010.mp4,${TOMORROW} 19:00,${creators.b.code},`,
    `${GAME}/Ohio-Heat-14U/21/21-Sideline-011.mp4,${TOMORROW} 19:00,${creators.b.code},`,
    "Ann_Sample_highlight.mp4,,,",
  ].join("\n");
  const r = await post(mw, `/api/gfs/events/${evId}/uploads`, { csv });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s = r.json.summary;
  assert.deepEqual(s.games, { added: 2, updated: 0 });
  assert.equal(s.clips.added, 9);
  assert.equal(s.clips.matched, 6, "7 (×2), 13, 11, 5, and the #21 filed under its team folder");
  assert.equal(s.clips.held, 2, "#13 is do-not-publish; #5 has no capture consent");
  assert.deepEqual(s.clips.why, { not_on_roster: 1, two_teams: 1, no_number: 1 });
  assert.equal(s.skipped, 1, "a file named for a person isn't a label");
  for (const c of db.tables.gfs_clips) clipsByFile[c.file] = c;
  assert.equal(clipsByFile["7-Sideline-003.mp4"].label, `${ev.code}-WR-7-Sideline-003`);
  assert.equal(clipsByFile["13-Sideline-005.mp4"].hold_reason, "do_not_publish");
  assert.equal(clipsByFile["5-Sideline-010.mp4"].hold_reason, "no_capture_consent");
  assert.equal(clipsByFile["21-Sideline-011.mp4"].label, `${ev.code}-QB-21-Sideline-011`, "a team folder tells the two #21s apart");
  assert.equal(clipsByFile["21-EndZone-007.mp4"].why, "two_teams", "without one, the jersey folder can't");
  const again = await post(mw, `/api/gfs/events/${evId}/uploads`, { csv });
  assert.equal(again.json.summary.clips.added, 0);
  assert.equal(again.json.summary.clips.already, 9);
  assert.equal(again.json.summary.games.updated, 2);
  assert.equal(db.tables.gfs_clips.length, 9);
});

test("tag review: suggestions for directors, then the game's tags are approved", async () => {
  const asViewer = await view(`/api/gfs/events/${evId}/clips?view=unmatched`);
  assert.equal(asViewer.status, 200);
  assert.ok(asViewer.json.clips.every((c) => c.suggestions === undefined));
  assert.deepEqual(asViewer.json.teams, []);
  const list = await mw(`/api/gfs/events/${evId}/clips?view=unmatched`);
  const miss31 = list.json.clips.find((c) => c.file === "31-Sideline-006.mp4");
  assert.equal(miss31.why, "not_on_roster");
  assert.ok(miss31.suggestions.some((x) => x.jersey === "13"), "digits swapped come first");
  const twoTeams = list.json.clips.find((c) => c.file === "21-EndZone-007.mp4");
  assert.equal(twoTeams.why, "two_teams");
  const bea = db.tables.gfs_roster.find((x) => x.roster_id === "ST-1002");
  assert.equal((await patch(view, `/api/gfs/events/${evId}/clips/${twoTeams.id}`, { roster_row: bea.id })).status, 403);
  const tagged = await patch(mw, `/api/gfs/events/${evId}/clips/${twoTeams.id}`, { roster_row: bea.id });
  assert.equal(tagged.status, 200, JSON.stringify(tagged.json));
  assert.equal(tagged.json.clip.label, `${ev.code}-QB-21-EndZone-007`);
  const unassigned = list.json.clips.find((c) => c.file === "EagleEye-008.mp4");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/clips/${unassigned.id}`, { not_a_player: true })).json.clip.match, "not_a_player");
  const other = await post(mw, "/api/gfs/events", { name: "Other stop", size: "clinic", region: "midwest", city: "Toledo", state: "OH", starts_on: TOMORROW });
  await post(mw, `/api/gfs/events/${other.json.event.id}/roster`, { csv: "Roster ID,Team,Jersey\nZZ-1,Other Team,9\n" });
  const zz = db.tables.gfs_roster.find((x) => x.roster_id === "ZZ-1");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/clips/${miss31.id}`, { roster_row: zz.id })).json.error, "not_on_this_roster");

  const ok = await post(mw, `/api/gfs/events/${evId}/tags/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.tagged, 5, "7 (×2), 21 (×2) and 11; held clips wait");
  assert.equal(db.tables.gfs_deliverables.find((d) => d.event_id === evId && d.kind === "tagging").status, "done");
});

test("clips: edited by the crew, approved by an approver, then families and SportsClippers", async () => {
  assert.equal((await post(mw, `/api/gfs/events/${evId}/clips/edited`)).json.edited, 5);
  assert.equal((await post(mw, `/api/gfs/events/${evId}/clips/approve`)).status, 403, "directors don't approve");
  assert.equal((await post(josh, `/api/gfs/events/${evId}/clips/approve`)).json.approved, 5);
  assert.equal((await mw(`/api/gfs/events/${evId}/listings.csv`)).status, 403);
  const early = await post(josh, `/api/gfs/events/${evId}/clips/listed`);
  assert.deepEqual([early.json.listed, early.json.not_exported], [0, 4], "nothing is marked listed before it's in a SportsClippers file");
  const csv = await josh(`/api/gfs/events/${evId}/listings.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split(/\r\n/);
  assert.equal(lines[0], "label,file,event_code,event,team,jersey,position,roster_id,angle,visibility,consent_capture,consent_marketing,consent_sale,consent_commercial,public_display,under_13,price_cents");
  assert.equal(lines.length - 1, 4, "Eve (#11) has no sale consent, so her clip isn't listed");
  assert.ok(lines.some((l) => l.includes("ST-1001") && l.includes(",public,")));
  for (const leak of ["Ann", "Sample", "2012-01-01", "@example.com", "555-0101", "555-0202"]) assert.ok(!csv.text.includes(leak), leak);
  const listed = await post(josh, `/api/gfs/events/${evId}/clips/listed`);
  assert.deepEqual([listed.json.public, listed.json.family], [2, 2]);
  const unsent = await post(mw, `/api/gfs/events/${evId}/clips/delivered`);
  assert.deepEqual([unsent.json.delivered, unsent.json.not_exported], [0, 5], "nothing is marked sent before it's in a family-links file");
  const fam = await mw(`/api/gfs/events/${evId}/families.csv`);
  assert.equal(fam.status, 200);
  assert.ok(fam.text.includes("ST-2002"), "family links don't need sale consent");
  assert.equal((await post(mw, `/api/gfs/events/${evId}/clips/delivered`)).json.delivered, 5);
  const listedClip = Object.values(db.tables.gfs_clips).find((c) => c.file === "7-Sideline-003.mp4");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/clips/${listedClip.id}`, { not_a_player: true })).json.error, "gfs_clip_already_out");
});

test("deliverables: consent is checked for featured athletes, and only approvers clear what posts", async () => {
  const dl = (await mw(`/api/gfs/events/${evId}`)).json.deliverables;
  const whoIs = dl.find((d) => d.kind === "who_is");
  const report = dl.find((d) => d.kind === "event_report");
  const interviews = dl.find((d) => d.kind === "interviews");
  const ann = db.tables.gfs_roster.find((x) => x.roster_id === "ST-1001");
  const bea = db.tables.gfs_roster.find((x) => x.roster_id === "ST-1002");

  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`)).json.error, "gfs_deliverable_nothing_new");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { delivered: 2 });
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`)).json.error, "featured_required");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { featured: [ann.id, bea.id] });
  let r = await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`);
  assert.equal(r.json.error, "gfs_featured_consent");
  assert.deepEqual(r.json.blocks.map((b) => [b.jersey, b.why]), [["21", "no_marketing_consent"]]);
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { required: 1 })).status, 403, "the count Pylon is owed isn't a director's call");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { featured: [ann.id] });
  sent = [];
  r = await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { delivered: 3 })).json.error, "in_review");
  await wait(50);
  assert.deepEqual([...new Set(sent.map((s) => s.to))].sort(), ["josh@example.com", "kyron@example.com"], "approvers hear about it, not directors or viewers");
  assert.ok(sent.every((s) => !/ST-\d|Ann|Sample/.test(JSON.stringify(s))));
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/approve`, { attest: true })).status, 403);
  assert.equal((await post(josh, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/approve`)).json.error, "attest_required", "the approver checks the keep-out list and says so");
  sent = [];
  r = await post(josh, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/approve`, { attest: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.deliverable.attested, true);
  assert.equal(r.json.deliverable.approved_count, 2);
  assert.equal(r.json.deliverable.cleared, true);
  await wait(50);
  assert.deepEqual(sent.map((s) => s.to), ["mw@example.com"], "the director hears back");

  await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { delivered: 3 });
  await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`);
  assert.equal((await post(josh, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/changes`, {})).json.error, "note_required");
  r = await post(josh, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/changes`, { note: "Recut the third without the sideline crowd." });
  assert.equal(r.json.deliverable.status, "changes");
  assert.equal(r.json.deliverable.note_from_approver, "Recut the third without the sideline crowd.");
  assert.equal(r.json.deliverable.approved_count, 2, "what was cleared stays cleared");

  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${report.id}/submit`)).json.error, "not_for_approval");
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${report.id}/done`)).json.error, "gfs_deliverable_short");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${report.id}`, { delivered: 1 });
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${report.id}/done`)).json.deliverable.status, "done");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${interviews.id}`, { delivered: 3, featured: [bea.id] });
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${interviews.id}/done`)).json.error, "gfs_featured_consent", "an interview needs marketing consent too");
});

let takedown;
test("a takedown starts its clock, holds the athlete everywhere, and tracks each surface", async () => {
  const ann = db.tables.gfs_roster.find((x) => x.roster_id === "ST-1001" && x.event_id === evId);
  // The same athlete at another event.
  const other = await post(mw, "/api/gfs/events", { name: "Legacy Tour · Chicago", series: "Legacy Tour", size: "premier", region: "midwest", city: "Chicago", state: "IL", starts_on: iso(Date.now() + 40 * DAY), ends_on: iso(Date.now() + 41 * DAY) });
  await post(mw, `/api/gfs/events/${other.json.event.id}/roster`, { csv: "Roster ID,Team,Jersey,Capture\nST-1001,Ohio Heat 14U,7,yes\n" });
  assert.equal((await post(view, "/api/gfs/takedowns", { event_id: evId, roster_row: ann.id, reason: "safety_request" })).status, 403);
  assert.equal((await post(west, "/api/gfs/takedowns", { event_id: evId, roster_row: ann.id, reason: "safety_request" })).status, 404);
  sent = [];
  const r = await post(mw, "/api/gfs/takedowns", { event_id: evId, roster_row: ann.id, reason: "safety_request", note: "Family called the site lead." });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  takedown = r.json.takedown;
  const recv = Date.parse(takedown.received_at);
  assert.equal(Date.parse(takedown.steps[0].due_at) - recv, 2 * 3600000);
  assert.equal(Date.parse(takedown.steps[1].due_at) - recv, 24 * 3600000);
  assert.equal(Date.parse(takedown.steps[2].due_at) - recv, 24 * 3600000);
  assert.equal(takedown.clips_out, 2, "two of her clips are out on SportsClippers and family links");
  assert.ok(db.tables.gfs_roster.filter((x) => x.roster_id === "ST-1001").every((x) => x.do_not_publish && x.takedown_at), "do-not-publish at every event");
  assert.ok(db.tables.gfs_clips.filter((c) => c.roster_row === ann.id).every((c) => c.held && c.hold_reason === "takedown"));
  await wait(50);
  assert.deepEqual([...new Set(sent.map((s) => s.to))].sort(), ["josh@example.com", "kyron@example.com", "mw@example.com"]);
  assert.ok(sent.every((s) => !/ST-1001|Ann/.test(JSON.stringify(s))), "notifications carry no athlete identity");

  const desk = await josh("/api/gfs/desk");
  assert.equal(desk.status, 200);
  assert.equal(desk.json.totals.takedowns_open, 1);
  assert.equal(desk.json.rows.find((x) => x.event.id === evId).needs_removal, 2);

  const again = await post(mw, `/api/gfs/events/${evId}/roster`, { csv: ROSTER });
  assert.equal(again.status, 200);
  assert.ok(db.tables.gfs_roster.find((x) => x.roster_id === "ST-1001" && x.event_id === evId).do_not_publish, "a new roster file doesn't undo a takedown");

  assert.equal((await patch(west, `/api/gfs/takedowns/${takedown.id}`, { pylon_done: true })).status, 404);
  let t = await patch(mw, `/api/gfs/takedowns/${takedown.id}`, { pylon_done: true });
  assert.equal(t.json.takedown.status, "open");
  t = await patch(mw, `/api/gfs/takedowns/${takedown.id}`, { other_done: true });
  assert.equal(t.json.takedown.clips_out, 0, "SportsClippers and family links are marked removed");
  t = await patch(mw, `/api/gfs/takedowns/${takedown.id}`, { offsite_requested: true });
  assert.equal(t.json.takedown.status, "done");
  assert.equal((await josh("/api/gfs/takedowns")).json.takedowns.length, 0);
  assert.equal((await josh("/api/gfs/takedowns?status=done")).json.takedowns.length, 1);
});

test("scorecards: the four measures from game uploads and family ratings", async () => {
  // Creator A uploaded the Sideline 7 hours after the final whistle; with B's
  // End Zone the game has two wide angles. Creator B's End Zone came in 7.5h.
  const lead = db.tables.gfs_crew.find((c) => c.creator_id === creators.a.id && c.event_id === evId);
  await patch(mw, `/api/gfs/events/${evId}/crew/${lead.id}`, { family_rating: 4.6, rating_count: 5 });
  const r = await josh(`/api/gfs/scorecards?on=${TOMORROW}`);
  assert.equal(r.status, 200);
  const a = r.json.creators.find((c) => c.id === creators.a.id).scorecard;
  assert.equal(a.games, 1);
  assert.equal(a.on_time, 1);
  assert.equal(a.angles_hit, 1);
  assert.equal(a.usable, null, "no file reviewed yet");
  assert.equal(a.rating, 4.6);
  assert.equal(a.on_standard, true);
  const mwRoll = r.json.regions.find((x) => x.region === "midwest");
  assert.ok(mwRoll.creators >= 4);
  assert.equal((await west("/api/gfs/scorecards?region=midwest")).status, 404);
  const desk = await josh("/api/gfs/desk");
  assert.ok(desk.json.creators.attention.some((c) => c.id === creators.c.id), "expired training shows on the desk");
});

test("today: what needs a director, and what needs an approver", async () => {
  const mine = await mw("/api/gfs/today");
  assert.equal(mine.status, 200);
  assert.ok(mine.json.next, "the next event");
  assert.ok(mine.json.needs.some((n) => n.kind === "changes"), "the approver's note is waiting for the director");
  const theirs = await josh("/api/gfs/today");
  assert.ok(Array.isArray(theirs.json.needs));
  const westToday = await west("/api/gfs/today");
  assert.equal(westToday.json.next, null, "nothing in the West yet");
});

test("approvers load Pylon's calendar; a second load skips what's already in", async () => {
  const csv = require("fs").readFileSync(require("path").join(__dirname, "..", "docs", "gfs-calendar-2026-27.csv"), "utf8");
  assert.equal((await post(mw, "/api/gfs/events/import", { csv })).status, 403, "directors add their own events, one at a time");
  const rows = G.parseTable(csv).rows;
  const there = rows.filter((x) => db.tables.gfs_events.some((e) => e.city === x[4] && e.state === x[5] && e.starts_on === x[8])).length;
  const r = await post(josh, "/api/gfs/events/import", { csv });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created, 20 - there);
  const nj = db.tables.gfs_events.find((e) => e.city === "New Jersey");
  assert.equal(G.eventDays(nj), 4, "New Jersey runs four days");
  assert.equal(db.tables.gfs_deliverables.filter((d) => d.event_id === nj.id && d.kind === "cutdowns").length, 4);
  assert.equal(db.tables.gfs_events.find((e) => e.city === "Panama City").tz, "America/Chicago", "the panhandle is on Central time");
  assert.equal(db.tables.gfs_events.filter((e) => e.city === "Chicago" && e.series === "Legacy Tour" && e.starts_on.startsWith("2027")).map((e) => e.code).sort().join(","), "Chicago2027,Chicago2027A");
  const again = await post(josh, "/api/gfs/events/import", { csv });
  assert.equal(again.json.created, 0);
  assert.equal(again.json.skipped.filter((x) => x.why === "already_in").length, 20);
  const bad = await post(josh, "/api/gfs/events/import", { csv: "city,state,starts_on,region\nSomewhere,ZZZ,2027-13-01,nowhere\n" });
  assert.equal(bad.json.created, 0);
  assert.match(bad.json.skipped[0].why, /state/);
});

test("team: Pylon events invites carry regions, and joining keeps them", async () => {
  const noRegion = await post(kyron, "/api/team/invites", { email: "dir@example.com", role: "member", tools: ["gfs"] });
  assert.equal(noRegion.status, 400);
  assert.equal(noRegion.json.error, "regions_required");
  const inv = await post(kyron, "/api/team/invites", { email: "dir@example.com", name: "Southeast Director", role: "member", tools: ["gfs"], regions: ["southeast", "nowhere"] });
  assert.equal(inv.status, 200, JSON.stringify(inv.json));
  assert.deepEqual(db.tables.team_invites.find((i) => i.email === "dir@example.com").regions, ["southeast"]);
  const approverInv = await post(kyron, "/api/team/invites", { email: "lead@example.com", role: "approver", tools: ["gfs"], regions: ["west"] });
  assert.deepEqual(db.tables.team_invites.find((i) => i.email === "lead@example.com").regions, [], "approvers see every region");
  assert.equal(approverInv.status, 200);
  const studioInv = await post(kyron, "/api/team/invites", { email: "plain@example.com", role: "member", tools: ["studio"] });
  assert.equal(studioInv.status, 200);
  assert.ok(!("regions" in db.tables.team_invites.find((i) => i.email === "plain@example.com")), "other invites don't touch the new column");
  const joiner = client();
  const info = await joiner(`/api/team/join/${inv.json.token}`);
  assert.deepEqual(info.json.regions, ["southeast"]);
  const j = await post(joiner, "/api/team/join", { token: inv.json.token, password: "a-long-password" });
  assert.equal(j.status, 200, JSON.stringify(j.json));
  assert.deepEqual(db.tables.team_members.find((m) => m.email === "dir@example.com").regions, ["southeast"]);
  const meta = await joiner("/api/gfs/meta");
  assert.deepEqual(meta.json.you.regions, ["southeast"]);
  await patch(kyron, "/api/team/members/dir%40example.com", { regions: ["southeast", "northeast"] });
  assert.deepEqual(db.tables.team_members.find((m) => m.email === "dir@example.com").regions, ["southeast", "northeast"]);
});

test("the activity log carries event codes and counts, never an athlete's identity", async () => {
  const entries = db.tables.team_activity.filter((a) => a.action.startsWith("gfs_"));
  const log = JSON.stringify(entries.map((a) => [a.action, a.subject, a.detail]));
  assert.ok(log.length > 100);
  for (const leak of ["ST-1001", "ST-2001", "Ann", "Sample", "555-0101", "2012-01-01", "a@example.com"]) assert.ok(!log.includes(leak), leak);
  assert.ok(entries.every((a) => a.detail && a.detail.region), "every entry says which region it belongs to");
});

// ── The review's findings, one test each ─────────────────────────────────
const D = (n) => iso(Date.now() + n * DAY);
const ymd = (d) => d.replace(/-/g, "");
const E = (e) => `/api/gfs/events/${e.id}`;
const clipOf = (e, file) => db.tables.gfs_clips.find((c) => c.event_id === e.id && c.file === file);
const rosterOf = (e, rid) => db.tables.gfs_roster.find((x) => x.event_id === e.id && x.roster_id === rid);
async function newEvent(who, body) {
  const r = await post(who, "/api/gfs/events", { size: "one_day", state: "OH", starts_on: TOMORROW, ...body });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.event;
}
// Tags, the edit, approval, the family-links file, then marked sent.
async function sendOut(e, dir, appr) {
  await post(dir, `${E(e)}/tags/approve`);
  await post(dir, `${E(e)}/clips/edited`);
  await post(appr, `${E(e)}/clips/approve`);
  await dir(`${E(e)}/families.csv`);
  return (await post(dir, `${E(e)}/clips/delivered`)).json;
}

test("B1, S6, S12: a takedown reaches rosters loaded later, in any region, and each region takes down its own clips", async () => {
  // Ann's takedown was logged at Geneva; her roster at a West stop loads now.
  const ontario = await newEvent(west, { name: "Girls Flag · Ontario, CA", region: "west", city: "Ontario", state: "CA", starts_on: D(3) });
  const r = await post(west, `${E(ontario)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture,Marketing,Sale,Public,Under 13\nST-1001,Ohio Heat 14U,7,yes,yes,yes,yes,no\nST-7001,Cali Stars 14U,4,yes,yes,yes,yes,no\n" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(rosterOf(ontario, "ST-1001").takedown_at && rosterOf(ontario, "ST-1001").do_not_publish, "a takedown follows the athlete to a roster loaded later");
  assert.equal(r.json.summary.do_not_publish, 1);
  const OG = "Ohio-Heat-14U_vs_Cali-Stars-14U_" + ymd(D(3));
  await post(west, `${E(ontario)}/uploads`, { csv: `path\n${OG}/7/7-Sideline-001.mp4\n${OG}/4/4-Sideline-002.mp4\n` });
  assert.equal(clipOf(ontario, "7-Sideline-001.mp4").hold_reason, "takedown");

  // A new athlete on rosters in two regions, with a clip out in each.
  const akron = await newEvent(mw, { name: "Girls Flag · Akron, OH", region: "midwest", city: "Akron", starts_on: D(4) });
  await post(mw, `${E(akron)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture,Marketing,Sale,Public,Under 13\nST-7001,Cali Stars 14U,4,yes,yes,yes,yes,no\nST-7002,Akron Flag 14U,9,yes,yes,yes,yes,no\n" });
  await post(mw, `${E(akron)}/uploads`, { csv: `path\nCali-Stars-14U_vs_Akron-Flag-14U_${ymd(D(4))}/4/4-EndZone-003.mp4\n` });
  assert.equal((await sendOut(akron, mw, josh)).delivered, 1);
  assert.equal((await sendOut(ontario, west, josh)).delivered, 1, "Cali Stars #4 is out in the West too; Ann's clip stays held");

  sent = [];
  const td = (await post(mw, "/api/gfs/takedowns", { event_id: akron.id, roster_row: rosterOf(akron, "ST-7001").id, reason: "consent_withdrawn" })).json.takedown;
  assert.deepEqual(td.regions, ["midwest", "west"]);
  assert.equal(td.clips_out, 2);
  await wait(50);
  assert.ok(sent.some((x) => x.to === "west@example.com"), "the West director runs an event the athlete is on, so they hear about it");
  assert.ok((await west("/api/gfs/takedowns")).json.takedowns.some((t) => t.id === td.id), "and they see it");

  let t = await patch(mw, `/api/gfs/takedowns/${td.id}`, { other_done: true });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  assert.deepEqual([t.json.partial.removed, t.json.partial.still_out, t.json.partial.regions], [1, 1, ["west"]]);
  assert.equal(t.json.takedown.steps[1].done_at, null, "not done while a clip is out anywhere");
  assert.ok(G.isOut(clipOf(ontario, "4-Sideline-002.mp4")), "the West clip is the West director's to take down");
  assert.ok(!G.isOut(clipOf(akron, "4-EndZone-003.mp4")));
  assert.equal((await west("/api/gfs/desk")).json.rows.find((x) => x.event.id === ontario.id).needs_removal, 1);
  t = await patch(west, `/api/gfs/takedowns/${td.id}`, { other_done: true });
  assert.ok(t.json.takedown.steps[1].done_at, "done once the last region takes theirs down");
  assert.equal(t.json.takedown.clips_out, 0);
});

test("B2, minor 17: a clip matches only when its team is certain; folders that aren't teams are dropped", async () => {
  const ev2 = await newEvent(mw, { name: "Toledo Flag Fest", region: "midwest", city: "Toledo", starts_on: D(5) });
  await post(mw, `${E(ev2)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture\nLE-7,Lake Erie 10U,7,yes\nTS-7,Toledo Storm 12U,7,yes\nTS-9,Toledo Storm 12U,9,yes\nCP-12,Cedar Point 14U,12,yes\n" });
  const g = "Lake-Erie-10U_vs_Toledo-Storm-12U_" + ymd(D(5));
  const csv = [
    "path,team",
    `${g}/7/7-Sideline-001.mp4,`,
    `Lake-Erie-10U_vs_Toledo-Storm_${ymd(D(5))}/7/7-Sideline-002.mp4,`,
    `12/12-EndZone-003.mp4,`,
    `${g}/9/9-EndZone-004.mp4,Toledo Storm 12U`,
    `${g}/Lake-Erie-10U/9/9-EndZone-005.mp4,Toledo Storm 12U`,
    `${g}/Sideline/9/9-Sideline-006.mp4,`,
    `${g}/Emma-Smith-highlights/EndZone-007.mp4,`,
  ].join("\n");
  const r = await post(mw, `${E(ev2)}/uploads`, { csv });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const why = (f) => clipOf(ev2, f).why;
  assert.equal(why("7-Sideline-001.mp4"), "two_teams");
  assert.equal(why("7-Sideline-002.mp4"), "team_not_on_roster", "a game folder naming a team the roster doesn't have can't hand its #7 to the other team");
  assert.equal(why("12-EndZone-003.mp4"), "no_team", "no game folder and no team: a person decides");
  assert.equal(clipOf(ev2, "9-EndZone-004.mp4").roster_row, rosterOf(ev2, "TS-9").id, "a team column settles it");
  assert.equal(why("9-EndZone-005.mp4"), "team_conflict", "the team folder and the team column disagree");
  const angleFolder = clipOf(ev2, "9-Sideline-006.mp4");
  assert.equal(angleFolder.match, "matched", "an angle folder isn't a team; the game folder decides");
  assert.equal(angleFolder.team_hint, null);
  assert.equal(clipOf(ev2, "EndZone-007.mp4").folder, null);
  assert.ok(!JSON.stringify(db.tables.gfs_clips.filter((c) => c.event_id === ev2.id)).includes("Emma"), "a folder named for a person isn't stored, keys included");
  const clinic = await newEvent(mw, { name: "Toledo clinic", size: "clinic", region: "midwest", city: "Toledo", starts_on: D(6) });
  await post(mw, `${E(clinic)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture\nCL-5,Clinic Group,5,yes\n" });
  await post(mw, `${E(clinic)}/uploads`, { csv: "path\n5/5-Sideline-001.mp4\n" });
  assert.equal(clipOf(clinic, "5-Sideline-001.mp4").match, "matched", "one team on the roster: no doubt whose #5 it is");
});

test("B2: a roster correction re-tags; number-matched clips follow it, a director's tags go back to review, clips already out are held", async () => {
  const ev3 = await newEvent(mw, { name: "Dayton Flag", region: "midwest", city: "Dayton", starts_on: D(7) });
  const v1 = "Athlete ID,Team,Jersey,Capture,Marketing,Sale\nDA-1,Dayton Dragons 14U,31,yes,yes,yes\nDA-2,Dayton Dragons 14U,13,yes,yes,yes\nDA-3,Dayton Dragons 14U,8,yes,yes,yes\nKF-1,Kettering Flag 14U,40,yes,yes,yes\n";
  await post(mw, `${E(ev3)}/roster`, { csv: v1 });
  const g = "Dayton-Dragons-14U_vs_Kettering-Flag-14U_" + ymd(D(7));
  await post(mw, `${E(ev3)}/uploads`, { csv: `path\n${g}/40/40-EndZone-004.mp4\n` });
  assert.equal((await sendOut(ev3, mw, josh)).delivered, 1);
  await post(mw, `${E(ev3)}/uploads`, { csv: `path\n${g}/31/31-Sideline-001.mp4\n${g}/13/13-Sideline-002.mp4\n${g}/88/88-Sideline-003.mp4\n` });
  const rid = (f) => (db.tables.gfs_roster.find((x) => x.id === clipOf(ev3, f).roster_row) || {}).roster_id;
  assert.equal(rid("31-Sideline-001.mp4"), "DA-1");
  const c88 = clipOf(ev3, "88-Sideline-003.mp4");
  assert.equal(c88.why, "not_on_roster");
  assert.equal((await patch(mw, `${E(ev3)}/clips/${c88.id}`, { roster_row: rosterOf(ev3, "DA-3").id })).status, 200, "the director says file 88 is #8");
  assert.equal(clipOf(ev3, "88-Sideline-003.mp4").jersey, "88", "the file's own number stays as filed");

  // Sports Thread corrects the file: 31 and 13 were swapped, #8 is #18, Kettering's #40 is #41.
  const v2 = v1.replace("DA-1,Dayton Dragons 14U,31", "DA-1,Dayton Dragons 14U,13").replace("DA-2,Dayton Dragons 14U,13", "DA-2,Dayton Dragons 14U,31").replace(",8,", ",18,").replace(",40,", ",41,");
  const s = (await post(mw, `${E(ev3)}/roster`, { csv: v2 })).json.summary;
  assert.deepEqual([s.renumbered, s.clips_back_to_review, s.clips_out_held], [4, 3, 1]);
  assert.equal(rid("31-Sideline-001.mp4"), "DA-2", "matched again to whoever wears 31 now");
  assert.equal(rid("13-Sideline-002.mp4"), "DA-1");
  assert.equal(clipOf(ev3, "31-Sideline-001.mp4").label, `${ev3.code}-NA-31-Sideline-001`);
  const back = clipOf(ev3, "88-Sideline-003.mp4");
  assert.deepEqual([back.match, back.why, back.tag_source], ["unmatched", "roster_changed", "manual"], "a director's tag waits for the director");
  const out = clipOf(ev3, "40-EndZone-004.mp4");
  assert.deepEqual([out.held, out.hold_reason, out.retag], [true, "roster_changed", true], "out, maybe showing the wrong child: held until it comes down");
  assert.equal((await josh(`${E(ev3)}/clips?view=out`)).json.clips.length, 1);
  assert.equal((await mw(E(ev3))).json.counts.needs_removal, 1);
  assert.equal((await patch(mw, `${E(ev3)}/clips/${out.id}`, { roster_row: rosterOf(ev3, "KF-1").id })).json.error, "gfs_clip_already_out");
  const rem = (await post(mw, `${E(ev3)}/clips/removed`, { ids: [out.id] })).json;
  assert.deepEqual([rem.removed, rem.back_to_review], [1, 1]);
  assert.deepEqual([clipOf(ev3, "40-EndZone-004.mp4").match, clipOf(ev3, "40-EndZone-004.mp4").retag], ["unmatched", false], "once it's down it goes back to tag review");
  assert.ok((await mw(`${E(ev3)}/clips?view=unmatched`)).json.clips.some((x) => x.id === out.id));
  const fixed = await patch(mw, `${E(ev3)}/clips/${out.id}`, { roster_row: rosterOf(ev3, "KF-1").id });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.deepEqual([fixed.json.clip.held, fixed.json.clip.removed, fixed.json.clip.stage], [false, false, "shot"], "taken down and tagged again, it starts over");

  const c31 = clipOf(ev3, "31-Sideline-001.mp4");
  assert.equal((await patch(mw, `${E(ev3)}/clips/${c31.id}`, { untag: true })).json.clip.why, "untagged");
  await post(mw, `${E(ev3)}/roster`, { csv: v2 });
  assert.equal(clipOf(ev3, "31-Sideline-001.mp4").match, "unmatched", "a director's untag survives the next roster load");
});

test("B3, S11, minor 13: a youth creator always works beside a screened adult", async () => {
  const ev4 = await newEvent(mw, { name: "Lima clinic", size: "clinic", region: "midwest", city: "Lima", starts_on: D(8) });
  const screened = { contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH, age_checked_on: LAST_MONTH };
  const P = (await post(kyron, "/api/gfs/creators", { name: "Creator P", region: "midwest", tier: "adult", ...screened })).json.creator;
  const Q = (await post(kyron, "/api/gfs/creators", { name: "Creator Q", region: "midwest", tier: "youth", guardian_name: "Parent Q", guardian_email: "parent.q@example.com", ...screened })).json.creator;
  const p = (await post(mw, `${E(ev4)}/crew`, { creator_id: P.id, role: "lead" })).json.crew;
  const q = (await post(mw, `${E(ev4)}/crew`, { creator_id: Q.id, role: "shooter" })).json.crew;
  await patch(mw, `${E(ev4)}/crew/${p.id}`, { status: "confirmed" });
  assert.equal((await patch(mw, `${E(ev4)}/crew/${q.id}`, { status: "confirmed" })).status, 200);
  assert.equal((await patch(mw, `${E(ev4)}/crew/${p.id}`, { status: "invited" })).json.error, "crew_youth_left_alone", "un-confirming the only adult");
  assert.equal((await patch(mw, `${E(ev4)}/crew/${p.id}`, { role: "editor" })).json.error, "crew_youth_left_alone", "moving the only adult off site");
  assert.equal((await patch(mw, `${E(ev4)}/crew/${p.id}`, { role: "shooter" })).status, 200, "still on site");
  // Even with a new age check (so the flip itself is valid), the tier holds mid-crew.
  assert.equal((await patch(kyron, `/api/gfs/creators/${Q.id}`, { tier: "adult", age_checked_on: D(-7) })).json.error, "gfs_creator_on_crew");

  // The adult's background check lapses (cleared here): they stop counting.
  await patch(kyron, `/api/gfs/creators/${P.id}`, { background_check_on: null });
  const plan = await mw(E(ev4));
  const crewCheck = plan.json.checklist.find((c) => c.key === "crew");
  assert.equal(crewCheck.done, false);
  assert.match(crewCheck.label, /not screened for this event.*youth creator needs a screened adult/);
  assert.deepEqual(plan.json.crew.find((c) => c.id === p.id).problems, ["background_check"]);

  // A family rating after the event goes in, even with the creator paused since.
  await patch(kyron, `/api/gfs/creators/${P.id}`, { status: "paused" });
  const rated = await patch(mw, `${E(ev4)}/crew/${p.id}`, { family_rating: 4.8, rating_count: 3 });
  assert.equal(rated.status, 200, JSON.stringify(rated.json));
});

test("B4: once screening is on file, a creator's name, email and return to work are Kyron's", async () => {
  const S = (await post(kyron, "/api/gfs/creators", { name: "Creator S", email: "s@example.com", region: "midwest", contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH })).json.creator;
  assert.equal((await patch(mw, `/api/gfs/creators/${S.id}`, { name: "Someone Else" })).json.error, "identity_owner_only");
  assert.equal((await patch(mw, `/api/gfs/creators/${S.id}`, { email: "other@example.com" })).json.error, "identity_owner_only");
  assert.equal((await patch(mw, `/api/gfs/creators/${S.id}`, { name: "Creator S", email: "s@example.com", home_city: "Lorain" })).status, 200, "the form sends the name back unchanged");
  assert.equal((await patch(mw, `/api/gfs/creators/${S.id}`, { status: "paused" })).status, 200, "a director can pause");
  assert.equal((await patch(mw, `/api/gfs/creators/${S.id}`, { status: "active" })).json.error, "reactivate_owner_only");
  assert.equal((await patch(kyron, `/api/gfs/creators/${S.id}`, { status: "active", name: "Creator S2" })).status, 200);
  const U = (await post(mw, "/api/gfs/creators", { name: "Creator U", region: "midwest" })).json.creator;
  assert.equal((await patch(mw, `/api/gfs/creators/${U.id}`, { name: "Creator U2" })).status, 200, "before screening, a director fixes a typo");
  assert.equal((await mw("/api/gfs/creators")).json.creators.find((c) => c.id === S.id).identity_locked, true);
});

test("B5: anything that posts clears only against the event's keep-out list", async () => {
  assert.equal((await view(`/api/gfs/events/${evId}/keep-out`)).status, 403);
  const ko = (await mw(`/api/gfs/events/${evId}/keep-out`)).json;
  const flat = ko.teams.flatMap((t) => t.athletes.map((a) => `${t.team} #${a.jersey} ${a.why}`)).sort();
  assert.deepEqual(flat, ["Buckeye Flag 12U #5 no_capture_consent", "Ohio Heat 14U #13 do_not_publish", "Ohio Heat 14U #21 no_marketing_consent", "Ohio Heat 14U #7 takedown"]);
  assert.ok(!JSON.stringify(ko).includes("ST-"), "team and jersey, no roster IDs");
  const stills = (await mw(`/api/gfs/events/${evId}`)).json.deliverables.find((d) => d.kind === "stills");
  assert.equal(stills.featured_allowed, true);
  const cat = rosterOf({ id: evId }, "ST-1003");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${stills.id}`, { delivered: 40, featured: [cat.id] });
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${stills.id}/submit`)).json.error, "gfs_featured_consent", "a still that names a do-not-publish athlete doesn't go");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${stills.id}`, { featured: [] });
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${stills.id}/submit`)).status, 200);
  assert.equal((await post(josh, `/api/gfs/events/${evId}/deliverables/${stills.id}/approve`)).json.error, "attest_required");
  const ok = await post(josh, `/api/gfs/events/${evId}/deliverables/${stills.id}/approve`, { attest: true });
  assert.deepEqual([ok.json.deliverable.status, ok.json.deliverable.attested], ["approved", true]);
  assert.equal(db.tables.gfs_deliverables.find((d) => d.id === stills.id).attested_by, "josh@example.com");
});

test("S8: a listing the roster stops allowing is pulled, to family-only or down", async () => {
  const ev5 = await newEvent(mw, { name: "Mentor Flag", region: "midwest", city: "Mentor", starts_on: D(9) });
  const v1 = "Athlete ID,Team,Division,Jersey,Capture,Marketing,Sale,Public,Under 13\nME-1,Mentor Flag 14U,14U,3,yes,yes,yes,yes,no\nME-2,Euclid 14U,14U,6,yes,yes,yes,no,no\n";
  await post(mw, `${E(ev5)}/roster`, { csv: v1 });
  await post(mw, `${E(ev5)}/uploads`, { csv: `path\nMentor-Flag-14U_vs_Euclid-14U_${ymd(D(9))}/3/3-Sideline-001.mp4\n` });
  await post(mw, `${E(ev5)}/tags/approve`);
  await post(mw, `${E(ev5)}/clips/edited`);
  await post(josh, `${E(ev5)}/clips/approve`);
  await josh(`${E(ev5)}/listings.csv`);
  assert.equal((await post(josh, `${E(ev5)}/clips/listed`)).json.public, 1);

  await post(mw, `${E(ev5)}/roster`, { csv: v1.replace("3,yes,yes,yes,yes,no", "3,yes,yes,yes,no,no") });
  assert.equal(clipOf(ev5, "3-Sideline-001.mp4").pull_reason, "not_public", "the guardian turned public display off");
  let counts = (await josh(E(ev5))).json.counts;
  assert.deepEqual([counts.to_family_only, counts.needs_removal], [1, 0]);
  assert.equal((await post(mw, `${E(ev5)}/clips/family-only`)).status, 403, "approvers change listings");
  assert.equal((await post(josh, `${E(ev5)}/clips/family-only`)).json.family_only, 1);
  assert.deepEqual([clipOf(ev5, "3-Sideline-001.mp4").visibility, clipOf(ev5, "3-Sideline-001.mp4").pull_reason], ["family", null]);

  await post(mw, `${E(ev5)}/roster`, { csv: v1.replace("3,yes,yes,yes,yes,no", "3,yes,yes,no,no,no") });
  assert.equal(clipOf(ev5, "3-Sideline-001.mp4").pull_reason, "no_sale_consent", "sale consent came off: it has to come down");
  counts = (await josh(E(ev5))).json.counts;
  assert.equal(counts.needs_removal, 1);
  const outList = (await mw(`${E(ev5)}/clips?view=out`)).json.clips;
  assert.deepEqual(outList.map((x) => x.pull_reason), ["no_sale_consent"]);
  await post(mw, `${E(ev5)}/clips/removed`, { ids: outList.map((x) => x.id) });
  assert.equal((await josh(E(ev5))).json.counts.needs_removal, 0);
});

test("S9: under 13, however the division is written", () => {
  for (const d of ["12U", "U12", "U-12", "12-U", "2026 U12", "Under 12", "12 & Under", "10U Girls", "Girls U-10", "U14/U12"]) assert.equal(G.under13({ under_13: false, division: d }), true, d);
  for (const d of ["14U", "U14", "HS Varsity", "2026", "18U", null]) assert.equal(G.under13({ under_13: false, division: d }), false, String(d));
  assert.equal(G.under13({ under_13: null, division: "14U" }), true, "no verified age counts as under 13");
});

test("S7: the activity feed shows each person only the Pylon regions they work", async () => {
  const studio = await as("studio@example.com");
  const feed = async (c) => (await c("/api/team/activity?limit=100")).json.activity;
  assert.ok((await feed(studio)).every((a) => !a.action.startsWith("gfs_")), "no Pylon events tool, no Pylon events entries");
  const westFeed = (await feed(west)).filter((a) => a.action.startsWith("gfs_"));
  assert.ok(westFeed.length > 0);
  assert.ok(westFeed.every((a) => a.detail.region === "west"), JSON.stringify(westFeed.map((a) => a.detail.region)));
  assert.ok((await feed(josh)).some((a) => a.action.startsWith("gfs_") && a.detail.region === "midwest"));
});

test("minors 14, 15: the athlete ID wins over a registration ID, and athletes missing from a later file are reported", async () => {
  const ev6 = await newEvent(mw, { name: "Sandusky", region: "midwest", city: "Sandusky", starts_on: D(10) });
  await post(mw, `${E(ev6)}/roster`, { csv: "Registration ID,Athlete ID,Team,Jersey,Capture\nREG-88812,ST-5501,Sandusky 14U,7,yes\nREG-88813,ST-5502,Sandusky 14U,8,yes\n" });
  assert.deepEqual(db.tables.gfs_roster.filter((x) => x.event_id === ev6.id).map((x) => x.roster_id).sort(), ["ST-5501", "ST-5502"]);
  const s = (await post(mw, `${E(ev6)}/roster`, { csv: "Athlete ID,Team,Jersey,Capture\nST-5501,Sandusky 14U,7,yes\n" })).json.summary;
  assert.equal(s.missing_from_file, 1);
});

test("minor 16: viewers see that a clip is held, never why, and no takedown reasons", async () => {
  const held = (await view(`/api/gfs/events/${evId}/clips?view=held`)).json.clips;
  assert.ok(held.length > 0);
  assert.ok(held.every((c) => c.held && c.hold_reason === null && c.athlete.roster_id === null));
  const tds = (await view("/api/gfs/takedowns")).json.takedowns;
  assert.ok(tds.length > 0);
  assert.ok(tds.every((t) => t.reason === null && t.reason_name === null && t.note === null));
  assert.ok((await mw("/api/gfs/takedowns")).json.takedowns.every((t) => t.reason_name));
});

test("second review: a file made under one tag doesn't count for another", async () => {
  const ev7 = await newEvent(mw, { name: "Kettering Flag", region: "midwest", city: "Kettering", starts_on: D(11) });
  const v1 = "Athlete ID,Team,Division,Jersey,Under 13,Capture,Marketing,Sale,Public\nA-1,Kettering 14U,14U,31,no,yes,yes,yes,yes\nB-1,Kettering 14U,14U,13,no,yes,yes,yes,yes\n";
  await post(mw, `${E(ev7)}/roster`, { csv: v1 });
  await post(mw, `${E(ev7)}/uploads`, { csv: `path,team\nKettering-14U_vs_Oakwood-14U_${ymd(D(11))}/31/31-Sideline-001.mp4,Kettering 14U\n` });
  await post(mw, `${E(ev7)}/tags/approve`);
  await post(mw, `${E(ev7)}/clips/edited`);
  await post(josh, `${E(ev7)}/clips/approve`);
  await mw(`${E(ev7)}/families.csv`);
  await josh(`${E(ev7)}/listings.csv`);
  // The director re-tags it to B before anything is marked.
  const c = clipOf(ev7, "31-Sideline-001.mp4");
  await patch(mw, `${E(ev7)}/clips/${c.id}`, { roster_row: rosterOf(ev7, "B-1").id });
  const after = clipOf(ev7, "31-Sideline-001.mp4");
  assert.deepEqual([after.family_export_at, after.exported_at], [null, null]);
  await post(mw, `${E(ev7)}/tags/approve`);
  await post(mw, `${E(ev7)}/clips/edited`);
  await post(josh, `${E(ev7)}/clips/approve`);
  assert.equal((await post(mw, `${E(ev7)}/clips/delivered`)).json.delivered, 0, "the family file carried it as A's");
  assert.equal((await post(josh, `${E(ev7)}/clips/listed`)).json.listed, 0);
});

test("second review: named athletes on a cleared piece are checked as they change, and only pieces that name athletes take names", async () => {
  const report = (await mw(`/api/gfs/events/${evId}`)).json.deliverables.find((d) => d.kind === "event_report");
  const cat = rosterOf({ id: evId }, "ST-1003");
  assert.equal((await patch(mw, `/api/gfs/events/${evId}/deliverables/${report.id}`, { featured: [cat.id] })).json.error, "featured_not_used");
  const stills = (await mw(`/api/gfs/events/${evId}`)).json.deliverables.find((d) => d.kind === "stills");
  assert.equal(stills.status, "approved");
  const r = await patch(mw, `/api/gfs/events/${evId}/deliverables/${stills.id}`, { featured: [cat.id] });
  assert.equal(r.json.error, "gfs_featured_consent", "a do-not-publish athlete can't be named on a cleared piece");
  const whoIs = (await mw(`/api/gfs/events/${evId}`)).json.deliverables.find((d) => d.kind === "who_is");
  await patch(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}`, { delivered: 3 });
  await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/submit`);
  assert.equal(db.tables.gfs_deliverables.find((d) => d.id === whoIs.id).attested_at, null, "a new submission starts without the old attestation");
});

test("second review: a team column naming no known team isn't stored, a re-export never upgrades a listing, and a folder and file that disagree on the number go to review", async () => {
  const ev8 = await newEvent(mw, { name: "Oakwood Flag", region: "midwest", city: "Oakwood", starts_on: D(12) });
  await post(mw, `${E(ev8)}/roster`, { csv: "Athlete ID,Team,Division,Jersey,Capture,Marketing,Sale,Public,Under 13\nOK-7,Oakwood 14U,14U,7,yes,yes,yes,no,no\nOK-11,Oakwood 14U,14U,11,yes,yes,yes,yes,no\nCV-1,Centerville 14U,14U,2,yes,yes,yes,yes,no\n" });
  const g = `Oakwood-14U_vs_Centerville-14U_${ymd(D(12))}`;
  await post(mw, `${E(ev8)}/uploads`, { csv: `path,team\n${g}/7/7-Sideline-001.mp4,Emma Smith\n${g}/7/11-Sideline-002.mp4,\n${g}/7/7-EndZone-003.mp4,\n` });
  const named = clipOf(ev8, "7-Sideline-001.mp4");
  assert.deepEqual([named.team_given, named.team, named.why], [G.UNKNOWN_TEAM, null, "team_not_on_roster"]);
  assert.ok(!JSON.stringify(db.tables.gfs_clips.filter((c) => c.event_id === ev8.id)).includes("Emma"));
  assert.equal(clipOf(ev8, "11-Sideline-002.mp4").why, "number_conflict", "filed under 7, named 11");
  // Listed family-only; the guardian then allows public; a full re-export stays family.
  await post(mw, `${E(ev8)}/tags/approve`);
  await post(mw, `${E(ev8)}/clips/edited`);
  await post(josh, `${E(ev8)}/clips/approve`);
  await josh(`${E(ev8)}/listings.csv`);
  assert.equal((await post(josh, `${E(ev8)}/clips/listed`)).json.family, 1);
  await post(mw, `${E(ev8)}/roster`, { csv: "Athlete ID,Team,Division,Jersey,Capture,Marketing,Sale,Public,Under 13\nOK-7,Oakwood 14U,14U,7,yes,yes,yes,yes,no\nOK-11,Oakwood 14U,14U,11,yes,yes,yes,yes,no\nCV-1,Centerville 14U,14U,2,yes,yes,yes,yes,no\n" });
  const all = (await josh(`${E(ev8)}/listings.csv?all=1`)).text.split(/\r\n/).find((l) => l.includes("7-EndZone-003.mp4"));
  assert.match(all, /,family,/, "the file says what the app recorded");
});
