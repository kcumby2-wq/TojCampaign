// The run sheet, "Needs you", the crew brief, the stop review and the upload
// check, through the routes on a real Postgres (docs/gfs-workflow-sop.md).
// Made-up people only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schemas (gfs_run_sheet_test, gfs_run_sheet_pre029_test),
// which it DROPS and recreates. Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_run_sheet_test";

if (!URL_) {
  test("run sheet on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.GFS_PAGE_BASE = "https://pages.example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");

const DAY = 86400000;
const D = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let pool, server, base;
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const ev = {};

async function stop(code, startsIn, extra = {}) {
  const day = D(startsIn);
  return one(
    `insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, crew_target, director_email, created_by)
     values ($1, $2, 'Girls Flag', 'one_day', 'midwest', $3, 'OH', 'America/New_York', $4, $4, now(), 2, $5, 'kyron@example.com') returning *`,
    [code, `Girls Flag · ${extra.city || code}`, extra.city || code, day, extra.director || null]
  );
}

before(async () => {
  pool = await makeSchema(URL_, S);
  setSupabase(pgSupabase(pool, S));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/gfs", require("../routes/gfs"));
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const m of [["mw@example.com", "Mia Director", "member", ["midwest"]], ["joe@example.com", "Joe Director", "member", ["midwest"]], ["ap@example.com", "Ava Approver", "approver", []], ["viewer@example.com", "Vi", "viewer", ["midwest"]]])
    await q(`insert into team_members (email, name, role, tools, regions) values ($1, $2, $3, array['gfs'], $4)`, m);
  ev.far = await stop("Kent2026", 40, { city: "Kent" }); // staffing due 5 days ago
  ev.near = await stop("Akron2026", 10, { city: "Akron", director: "mw@example.com" }); // QR codes due in 3 days
  ev.joes = await stop("Dayton2026", 12, { city: "Dayton", director: "joe@example.com" });
  ev.done = await stop("Toledo2026", -3, { city: "Toledo", director: "mw@example.com" }); // wrapped 3 days ago
});
after(async () => {
  if (server) server.close();
  if (pool) await pool.end();
});

async function signedIn(email = "kyron@example.com", role = "admin") {
  let cookie = "";
  const c = async (p, { method = "GET", body } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const stagesFor = (needs, evId) => needs.filter((n) => n.kind === "stage" && n.event.id === evId).map((n) => n.stage.key);

test("the event plan carries the twelve-stage run sheet and the upload check", async () => {
  const mw = await signedIn("mw@example.com", "creator");
  const r = await mw(`/api/gfs/events/${ev.far.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.run_sheet.length, 12);
  const staff = r.json.run_sheet.find((s) => s.key === "staff");
  assert.equal(staff.status, "late");
  assert.equal(staff.note, "0 of 2 on site · no lead yet");
  assert.equal(r.json.run_sheet.find((s) => s.key === "uploads").status, "upcoming", "the stop hasn't happened");
  assert.deepEqual(r.json.upload_check.games, 0);
  assert.equal(r.json.checklist.find((c) => c.key === "crew").due_at, r.json.run_sheet.find((s) => s.key === "crew").due_at, "the crew check is due at T-14, as in the SOP");
});

test("Needs you shows each stop's late and due-this-week stages to whoever owns them, from T-45", async () => {
  const mw = await (await signedIn("mw@example.com", "creator"))("/api/gfs/today");
  assert.equal(mw.status, 200, JSON.stringify(mw.json));
  assert.ok(stagesFor(mw.json.needs, ev.far.id).includes("staff"), "a stop 40 days out with no crew is already late on staffing");
  assert.ok(stagesFor(mw.json.needs, ev.near.id).includes("storefront"), "QR codes due within the week");
  assert.ok(!stagesFor(mw.json.needs, ev.near.id).includes("screened"), "screening is Kyron's");
  assert.deepEqual(stagesFor(mw.json.needs, ev.joes.id), [], "another director's stop");
  assert.ok(stagesFor(mw.json.needs, ev.done.id).includes("uploads"), "wrapped three days ago with no upload log");
  const late = mw.json.needs.filter((n) => n.kind === "stage" && n.stage.status === "late");
  const soon = mw.json.needs.filter((n) => n.kind === "stage" && n.stage.status === "soon");
  assert.ok(mw.json.needs.indexOf(late.at(-1)) < mw.json.needs.indexOf(soon[0]), "late stages come before this week's");

  const kyron = await (await signedIn())("/api/gfs/today");
  assert.ok(stagesFor(kyron.json.needs, ev.near.id).includes("screened"), "Kyron sees screening");
  assert.ok(stagesFor(kyron.json.needs, ev.joes.id).length > 0, "and every stop");

  const ap = await (await signedIn("ap@example.com", "creator"))("/api/gfs/today");
  const apKeys = ap.json.needs.filter((n) => n.kind === "stage").map((n) => n.stage.key);
  assert.ok(apKeys.every((k) => k === "storefront" || k === "sale"), `an approver gets the storefront and getting clips out, nothing else: ${apKeys}`);
  assert.ok(stagesFor(ap.json.needs, ev.near.id).includes("storefront"));

  const vi = await (await signedIn("viewer@example.com", "creator"))("/api/gfs/today");
  assert.deepEqual(vi.json.needs.filter((n) => n.kind === "stage"), []);
});

test("the crew brief: built from the stop, team and jersey only, with the crew's emails for the director", async () => {
  const lead = await one(`insert into gfs_creators (code, name, email, region, tier, contract_signed_on, background_check_on, safety_training_on, age_checked_on, age_checked_by, created_by)
                          values ('LEAD1', 'Ana Ruiz', 'ana@example.com', 'midwest', 'adult', $1, $1, $1, $1, 'kyron@example.com', 'kyron@example.com') returning *`, [D(-30)]);
  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'lead', 'confirmed', 'kyron@example.com')`, [ev.near.id, lead.id]);
  for (const [rid, team, jersey, flags] of [["R1", "Kent Stars", "11", { priority: true }], ["R2", "Kent Stars", "7", { do_not_publish: true }], ["R3", "Akron Flash", "3", {}]])
    await q(`insert into gfs_roster (event_id, roster_id, team, jersey, consent_capture, priority, do_not_publish) values ($1, $2, $3, $4, true, $5, $6)`, [ev.near.id, rid, team, jersey, !!flags.priority, !!flags.do_not_publish]);
  const mw = await signedIn("mw@example.com", "creator");
  const r = await mw(`/api/gfs/events/${ev.near.id}/brief`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.text, /^CREW BRIEF · Girls Flag · Akron\n/);
  assert.match(r.json.text, /- Ana Ruiz · Lead\nDirector: Mia Director · mw@example\.com/);
  assert.match(r.json.text, /COVER FIRST[^\n]*\n- Kent Stars: #11\n/);
  assert.match(r.json.text, /NO CLIPS OF[^\n]*\n- Kent Stars: #7\n/);
  assert.match(r.json.text, /exactly: Akron Flash, Kent Stars\./);
  assert.match(r.json.text, /https:\/\/pages\.example\.com\/e\/Akron2026/);
  assert.doesNotMatch(r.json.text, /R1|R2|R3/, "no roster IDs");
  assert.deepEqual(r.json.emails, ["ana@example.com"]);
  assert.equal(r.json.sent_at, null);
  assert.equal((await (await signedIn("viewer@example.com", "creator"))(`/api/gfs/events/${ev.near.id}/brief`)).status, 403, "viewers can't open it");
  // Marked sent from the brief, the run sheet ticks it.
  await mw(`/api/gfs/events/${ev.near.id}`, { method: "PATCH", body: { brief_sent: true } });
  const plan = await mw(`/api/gfs/events/${ev.near.id}`);
  assert.equal(plan.json.run_sheet.find((s) => s.key === "brief").done, true);
});

test("the stop review is Kyron's: one line on the SOP, or none", async () => {
  const mw = await signedIn("mw@example.com", "creator");
  const kyron = await signedIn();
  const no = await mw(`/api/gfs/events/${ev.done.id}`, { method: "PATCH", body: { reviewed: true } });
  assert.equal(no.status, 403);
  assert.equal(no.json.error, "review_owner_only");
  const yes = await kyron(`/api/gfs/events/${ev.done.id}`, { method: "PATCH", body: { reviewed: true, review_note: "  Upload at lunch, not at the end of the day.  " } });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.ok(yes.json.event.reviewed_at);
  assert.equal(yes.json.event.review_note, "Upload at lunch, not at the end of the day.");
  const row = await one(`select reviewed_by from gfs_events where id = $1`, [ev.done.id]);
  assert.equal(row.reviewed_by, "kyron@example.com");
  assert.equal((await kyron(`/api/gfs/events/${ev.done.id}`)).json.run_sheet.find((s) => s.key === "review").done, true);
  const undo = await kyron(`/api/gfs/events/${ev.done.id}`, { method: "PATCH", body: { reviewed: false } });
  assert.equal(undo.json.event.reviewed_at, null);
  assert.equal(undo.json.event.review_note, null);
});

test("the upload check on arrival: a missing angle, a late file, a late clip", async () => {
  const mw = await signedIn("mw@example.com", "creator");
  const g = `Toledo-Stars_vs_Kent-Flash_${ev.done.starts_on.replace(/-/g, "")}`;
  const day = ev.done.starts_on;
  const csv = [
    "path,uploaded_at,final_whistle",
    `${g}/Sideline/${g}_Sideline.mp4,${day} 18:00,${day} 11:00`,
    `${g}/EagleEye/${g}_EagleEye.mp4,${day} 13:00,${day} 11:00`,
    `${g}/Toledo-Stars/11/11-Sideline-001.mp4,${day} 23:30,`,
    `${g}/Toledo-Stars/11/11-Sideline-002.mp4,${day} 12:00,`,
    "Amy Smith/IMG_0001.mov,,",
  ].join("\n");
  const r = await mw(`/api/gfs/events/${ev.done.id}/uploads`, { method: "POST", body: { csv } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const k = r.json.summary.check;
  assert.equal(k.games, 1);
  assert.equal(k.missing_angle, 0, "Sideline and Eagle Eye are two wide angles");
  assert.equal(k.late_files, 0);
  assert.equal(k.late_clips, 1, "one clip landed 12.5 hours after the final whistle");
  assert.equal(r.json.summary.skipped, 1, "a file named after a person is skipped");
  // A second game with one angle, uploaded late.
  const g2 = `Toledo-Stars_vs_Akron-Flash_${day.replace(/-/g, "")}`;
  const r2 = await mw(`/api/gfs/events/${ev.done.id}/uploads`, { method: "POST", body: { csv: ["path,uploaded_at,final_whistle", `${g2}/Sideline/${g2}_Sideline.mp4,${D(-2)} 09:00,${day} 15:00`].join("\n") } });
  const k2 = r2.json.summary.check;
  assert.equal(k2.games, 2);
  assert.equal(k2.missing_angle, 1);
  assert.equal(k2.late_files, 1);
  assert.deepEqual(k2.issues.find((x) => x.game === g2).missing, ["EndZone"]);
  const plan = await mw(`/api/gfs/events/${ev.done.id}`);
  assert.equal(plan.json.upload_check.missing_angle, 1);
  const sheet = Object.fromEntries(plan.json.run_sheet.map((s) => [s.key, s]));
  assert.equal(sheet.uploads.done, true);
  assert.match(sheet.uploads.note, /1 file over 12 hours/);
  assert.equal(sheet.capture.done, false);
  assert.match(sheet.capture.note, /1 missing an angle/);
});

test("before migration 029: the run sheet works without the review, and marking one says to apply it", async () => {
  const old = await makeSchema(URL_, "gfs_run_sheet_pre029_test", ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql", "028_gfs_creator_age.sql"]);
  setSupabase(pgSupabase(old, "gfs_run_sheet_pre029_test"));
  try {
    const e = (await old.query(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                                values ('Erie2026', 'Girls Flag · Erie', 'Girls Flag', 'one_day', 'midwest', 'Erie', 'OH', 'America/New_York', $1, $1, now(), 'kyron@example.com') returning *`, [D(-20)])).rows[0];
    const kyron = await signedIn();
    const plan = await kyron(`/api/gfs/events/${e.id}`);
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    const review = plan.json.run_sheet.find((s) => s.key === "review");
    assert.equal(review.actionable, false);
    assert.match(review.note, /migration 029/);
    const today = await kyron("/api/gfs/today");
    assert.ok(!today.json.needs.some((n) => n.kind === "stage" && n.stage.key === "review"), "an untracked review never nags");
    const mark = await kyron(`/api/gfs/events/${e.id}`, { method: "PATCH", body: { reviewed: true } });
    assert.equal(mark.status, 503, JSON.stringify(mark.json));
    assert.equal(mark.json.error, "gfs_review_not_set_up");
  } finally {
    setSupabase(pgSupabase(pool, S));
    await old.query("drop schema gfs_run_sheet_pre029_test cascade");
    await old.end();
  }
});
