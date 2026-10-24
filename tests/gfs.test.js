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
  for (const id of p_events) {
    const cs = (tables.gfs_clips || []).filter((c) => c.event_id === id);
    if (!cs.length) continue;
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
      needs_removal: cs.filter((c) => c.held && (c.listed_at || c.delivered_at) && !c.removed_at).length,
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
  creators.w = (await add(kyron, { name: "Creator W", region: "west", contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH })).json.creator;

  // Unscreened creators can't be crewed.
  let r = await post(mw, `/api/gfs/events/${evId}/crew`, { creator_id: creators.a.id, role: "lead" });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.problems.sort(), ["background_check", "no_contract", "safety_training"]);

  const screen = (id, extra = {}) => patch(kyron, `/api/gfs/creators/${id}`, { contract_signed_on: LAST_MONTH, background_check_on: LAST_MONTH, safety_training_on: LAST_MONTH, ...extra });
  assert.equal((await screen(creators.a.id)).status, 200);
  await screen(creators.b.id);
  await screen(creators.c.id, { safety_training_on: LONG_AGO });
  await screen(creators.y.id, { tier: "youth" });
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
  const csv = await josh(`/api/gfs/events/${evId}/listings.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  const lines = csv.text.trim().split(/\r\n/);
  assert.equal(lines[0], "label,file,event_code,event,team,jersey,position,roster_id,angle,visibility,consent_capture,consent_marketing,consent_sale,consent_commercial,public_display,under_13,price_cents");
  assert.equal(lines.length - 1, 4, "Eve (#11) has no sale consent, so her clip isn't listed");
  assert.ok(lines.some((l) => l.includes("ST-1001") && l.includes(",public,")));
  for (const leak of ["Ann", "Sample", "2012", "@example.com", "555-"]) assert.ok(!csv.text.includes(leak), leak);
  const listed = await post(josh, `/api/gfs/events/${evId}/clips/listed`);
  assert.deepEqual([listed.json.public, listed.json.family], [2, 2]);
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
  assert.equal((await post(mw, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/approve`)).status, 403);
  sent = [];
  r = await post(josh, `/api/gfs/events/${evId}/deliverables/${whoIs.id}/approve`);
  assert.equal(r.status, 200);
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
  const r = await josh("/api/gfs/scorecards");
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
  const log = JSON.stringify(db.tables.team_activity.filter((a) => a.action.startsWith("gfs_")));
  assert.ok(log.length > 100);
  for (const leak of ["ST-1001", "ST-2001", "Ann", "Sample", "555-", "2012-01-01"]) assert.ok(!log.includes(leak), leak);
});
