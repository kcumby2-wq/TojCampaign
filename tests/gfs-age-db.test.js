// Migration 028 in a real Postgres: a creator's age is checked before they
// work. A new creator is youth until Kyron records an age check, adult needs
// one, nobody is crewed without one, a youth creator also needs a guardian of
// record, and only a checked adult counts as the adult on site. The routes run
// against the same database, so both layers are tested together. Made-up
// people only.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schemas (gfs_age_db_test, gfs_age_pre028_test), which it
// DROPS and recreates. Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_age_db_test";

if (!URL_) {
  test("migration 028 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.GFS_PAGE_BASE = "https://pages.example.com";
const { makeSchema, pgSupabase } = require("./helpers/pg-supabase");
const { setSupabase } = require("../utils/supabase");

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const D = (n) => iso(Date.now() + n * DAY);

let pool, server, base, ev;
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
// A row saved before migration 028: an adult with no age check on file.
async function legacyAdult(code, name) {
  await q(`alter table gfs_creators disable trigger gfs_creators_age_check`);
  try {
    return await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, created_by)
                      values ($1, $2, 'midwest', 'adult', $3, $3, $3, 'kyron@example.com') returning *`, [code, name, D(-30)]);
  } finally {
    await q(`alter table gfs_creators enable trigger gfs_creators_age_check`);
  }
}
const screened = () => [D(-30), D(-30), D(-30)];

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
                  values ('Akron2027', 'Legacy Tour · Akron', 'Legacy Tour', 'premier', 'midwest', 'Akron', 'OH', 'America/New_York', $1, $2, now(), 'kyron@example.com') returning *`, [D(20), D(21)]);
  // A Regional Director for the Midwest, and a viewer there.
  for (const m of [["mw@example.com", "Midwest Director", "member", ["midwest"]], ["viewer@example.com", "Vi", "viewer", ["midwest"]]])
    await q(`insert into team_members (email, name, role, tools, regions) values ($1, $2, $3, array['gfs'], $4)`, m);
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

test("028 runs twice; a new creator is youth, and adult needs an age check with who recorded it", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "028_gfs_creator_age.sql"), "utf8").replace(/public\./g, `${S}.`);
  await pool.query(sql);
  const fresh = await one(`insert into gfs_creators (code, name, region, created_by) values ('NEWC1', 'New Creator', 'midwest', 'kyron@example.com') returning *`);
  assert.equal(fresh.tier, "youth", "youth until an age check says otherwise");
  await refused(`insert into gfs_creators (code, name, region, tier, created_by) values ('ADNO1', 'Adult No Check', 'midwest', 'adult', 'kyron@example.com')`, [], /gfs_adult_needs_age_check/);
  await refused(`insert into gfs_creators (code, name, region, tier, age_checked_on, created_by) values ('ADNO2', 'Adult Half', 'midwest', 'adult', $1, 'kyron@example.com')`, [D(-1)], /age_fields_chk/);
  const ok = await one(`insert into gfs_creators (code, name, region, tier, age_checked_on, age_checked_by, created_by) values ('ADOK1', 'Adult Checked', 'midwest', 'adult', $1, 'kyron@example.com', 'kyron@example.com') returning *`, [D(-1)]);
  assert.equal(ok.tier, "adult");
  await refused(`update gfs_creators set age_checked_on = null, age_checked_by = null where id = $1`, [ok.id], /gfs_adult_needs_age_check/);
  await refused(`update gfs_creators set tier = 'adult' where id = $1`, [fresh.id], /gfs_adult_needs_age_check/);
  await refused(`update gfs_creators set guardian_email = 'parent@example.com' where id = $1`, [ok.id], /gfs_adult_has_guardian/);
  await refused(`update gfs_creators set guardian_email = 'Parent@Example.com' where id = $1`, [fresh.id], /age_fields_chk/);
  await q(`update gfs_creators set guardian_name = 'Pat Parent', guardian_email = 'parent@example.com' where id = $1`, [fresh.id]);
});

test("an adult saved before 028 can still be paused or edited, but can't work or anchor until checked", async () => {
  const old = await legacyAdult("OLDA1", "Old Adult");
  await q(`update gfs_creators set status = 'paused', notes = 'Saturday only' where id = $1`, [old.id]);
  await q(`update gfs_creators set status = 'active' where id = $1`, [old.id]);
  await refused(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'lead', 'invited', 'kyron@example.com')`, [ev.id, old.id], /crew_age_not_checked/);
  // A crew row saved before 028 doesn't make them the adult on site.
  await q(`alter table gfs_crew disable trigger gfs_crew_age_check`);
  const oldRow = await one(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'lead', 'confirmed', 'kyron@example.com') returning *`, [ev.id, old.id]);
  await q(`alter table gfs_crew enable trigger gfs_crew_age_check`);
  const teen = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, age_checked_on, age_checked_by, guardian_name, guardian_email, created_by)
                          values ('TEEN2', 'Teen Two', 'midwest', 'youth', $1, $1, $1, $1, 'kyron@example.com', 'Pat Parent', 'pat@example.com', 'kyron@example.com') returning *`, [D(-30)]);
  const teenRow = await one(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'shooter', 'invited', 'kyron@example.com') returning *`, [ev.id, teen.id]);
  await refused(`update gfs_crew set status = 'confirmed' where id = $1`, [teenRow.id], /crew_youth_needs_adult/);
  // A note on the old row still saves: nothing to check.
  await q(`update gfs_crew set note = 'parking lot B' where id = $1`, [oldRow.id]);
  // Once checked, they work and anchor.
  await q(`update gfs_creators set age_checked_on = $1, age_checked_by = 'kyron@example.com' where id = $2`, [D(0), old.id]);
  await q(`update gfs_crew set status = 'confirmed' where id = $1`, [teenRow.id]);
  await q(`update gfs_crew set status = 'removed' where id = $1`, [teenRow.id]);
});

test("a youth creator is crewed only with an age check and a guardian of record", async () => {
  const [a, b, c] = screened();
  const kid = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, created_by)
                         values ('KIDS1', 'Kid One', 'midwest', 'youth', $1, $2, $3, 'kyron@example.com') returning *`, [a, b, c]);
  await refused(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'shooter', 'invited', 'kyron@example.com')`, [ev.id, kid.id], /crew_age_not_checked/);
  await q(`update gfs_creators set age_checked_on = $1, age_checked_by = 'kyron@example.com' where id = $2`, [D(-1), kid.id]);
  await refused(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'shooter', 'invited', 'kyron@example.com')`, [ev.id, kid.id], /crew_youth_no_guardian/);
  await q(`update gfs_creators set guardian_name = 'Sam Guardian', guardian_email = 'sam@example.com' where id = $1`, [kid.id]);
  const row = await one(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'shooter', 'invited', 'kyron@example.com') returning *`, [ev.id, kid.id]);
  assert.equal(row.status, "invited");
  await q(`update gfs_crew set status = 'removed' where id = $1`, [row.id]);
});

test("routes: a director adds a youth creator with a guardian; only Kyron records the age check and makes them an adult", async () => {
  const mw = await signedIn("mw@example.com", "creator");
  const kyron = await signedIn();
  const add = await mw("/api/gfs/creators", { method: "POST", body: { name: "Jo Shooter", email: "jo@example.com", region: "midwest", guardian_name: "Lee Shooter", guardian_email: "LEE@example.com" } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const jo = add.json.creator;
  assert.equal(jo.tier, "youth");
  assert.equal(jo.guardian_email, "lee@example.com");
  assert.ok(jo.badges.some((b) => b.key === "age" && !b.ok), "the age badge says it isn't checked");
  assert.equal((await mw(`/api/gfs/creators/${jo.id}`, { method: "PATCH", body: { age_checked_on: D(0) } })).json.error, "credentials_owner_only");
  const noCheck = await kyron(`/api/gfs/creators/${jo.id}`, { method: "PATCH", body: { tier: "adult" } });
  assert.equal(noCheck.status, 400);
  assert.ok(noCheck.json.fields.includes("adult_needs_age_check"));
  assert.ok((await kyron(`/api/gfs/creators/${jo.id}`, { method: "PATCH", body: { age_checked_on: D(3) } })).json.fields.includes("age_checked_on"), "not a future date");
  const adult = await kyron(`/api/gfs/creators/${jo.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(0), contract_signed_on: D(-5), background_check_on: D(-5), safety_training_on: D(-5) } });
  assert.equal(adult.status, 200, JSON.stringify(adult.json));
  assert.equal(adult.json.creator.tier, "adult");
  assert.equal(adult.json.creator.age_checked_by, "kyron@example.com");
  assert.equal(adult.json.creator.guardian_name, null, "an adult has no guardian on file");
  assert.equal(adult.json.creator.guardian_email, null);
  // The form sends the same date back: nothing changes, and who checked stays.
  const again = await kyron(`/api/gfs/creators/${jo.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(0), notes: "lead material" } });
  assert.equal(again.status, 200, JSON.stringify(again.json));
  // Screening on file: the guardian belongs to the person now.
  const teen = (await mw("/api/gfs/creators", { method: "POST", body: { name: "Ty Teen", region: "midwest", guardian_name: "Ty Parent", guardian_email: "typ@example.com" } })).json.creator;
  await kyron(`/api/gfs/creators/${teen.id}`, { method: "PATCH", body: { age_checked_on: D(0) } });
  assert.equal((await mw(`/api/gfs/creators/${teen.id}`, { method: "PATCH", body: { guardian_email: "someone@example.com" } })).json.error, "identity_owner_only");
  assert.equal((await mw(`/api/gfs/creators/${teen.id}`, { method: "PATCH", body: { guardian_name: "Ty Parent", guardian_email: "typ@example.com", home_city: "Kent" } })).status, 200, "sending it back unchanged is fine");
  // A viewer never sees the guardian or who checked the age.
  const seen = (await (await signedIn("viewer@example.com", "creator"))("/api/gfs/creators")).json.creators.find((c) => c.id === teen.id);
  assert.equal(seen.guardian_name, null);
  assert.equal(seen.guardian_email, null);
  assert.equal(seen.age_checked_by, null);
  assert.ok(seen.age_checked_on, "the date itself shows, as the screening dates do");
});

test("a youth creator becomes an adult only with a new, later age check", async () => {
  const kyron = await signedIn();
  const add = await kyron("/api/gfs/creators", { method: "POST", body: { name: "Mae Turning", region: "midwest", guardian_name: "Mae Parent", guardian_email: "maep@example.com", age_checked_on: D(-200), contract_signed_on: D(-5), background_check_on: D(-5), safety_training_on: D(-5) } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const mae = add.json.creator;
  assert.equal(mae.tier, "youth");
  // The form's Adult toggle used to send the youth check back unchanged.
  const same = await kyron(`/api/gfs/creators/${mae.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(-200) } });
  assert.equal(same.status, 400, JSON.stringify(same.json));
  assert.ok(same.json.fields.includes("adult_needs_new_age_check"));
  const earlier = await kyron(`/api/gfs/creators/${mae.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(-300) } });
  assert.ok(earlier.json.fields.includes("adult_needs_new_age_check"), "an earlier date can't show they've since turned 18");
  await refused(`update gfs_creators set tier = 'adult', guardian_name = null, guardian_email = null where id = $1`, [mae.id], /gfs_adult_needs_new_age_check/);
  const later = await kyron(`/api/gfs/creators/${mae.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(0) } });
  assert.equal(later.status, 200, JSON.stringify(later.json));
  assert.equal(later.json.creator.tier, "adult");
  assert.equal(later.json.creator.guardian_email, null);
  // Recorded as youth by mistake today: clear the date, then mark adult.
  const oops = (await kyron("/api/gfs/creators", { method: "POST", body: { name: "Oz Oops", region: "midwest", age_checked_on: D(0) } })).json.creator;
  assert.ok((await kyron(`/api/gfs/creators/${oops.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(0) } })).json.fields.includes("adult_needs_new_age_check"));
  assert.equal((await kyron(`/api/gfs/creators/${oops.id}`, { method: "PATCH", body: { age_checked_on: null } })).status, 200);
  const fixed = await kyron(`/api/gfs/creators/${oops.id}`, { method: "PATCH", body: { tier: "adult", age_checked_on: D(0) } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  assert.equal(fixed.json.creator.tier, "adult");
});

test("on an upcoming crew, the age check and a youth creator's guardian stay on file; a check can't be dated ahead", async () => {
  const kyron = await signedIn();
  const stop = await one(`insert into gfs_events (code, name, series, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                          values ('Kent2027', 'Legacy Tour · Kent', 'Legacy Tour', 'premier', 'midwest', 'Kent', 'OH', 'America/New_York', $1, $2, now(), 'kyron@example.com') returning *`, [D(30), D(31)]);
  const [a] = screened();
  const anchor = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, age_checked_on, age_checked_by, created_by)
                            values ('ANCH9', 'Ann Anchor', 'midwest', 'adult', $1, $1, $1, $1, 'kyron@example.com', 'kyron@example.com') returning *`, [a]);
  const kid = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, age_checked_on, age_checked_by, guardian_name, guardian_email, created_by)
                         values ('KIDC9', 'Kit Crewed', 'midwest', 'youth', $1, $1, $1, $1, 'kyron@example.com', 'Kit Parent', 'kitp@example.com', 'kyron@example.com') returning *`, [a]);
  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'photographer', 'confirmed', 'kyron@example.com')`, [stop.id, anchor.id]);
  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'shooter', 'confirmed', 'kyron@example.com')`, [stop.id, kid.id]);
  await refused(`update gfs_creators set age_checked_on = null, age_checked_by = null where id = $1`, [kid.id], /gfs_creator_on_crew/);
  await refused(`update gfs_creators set guardian_email = null where id = $1`, [kid.id], /gfs_creator_on_crew/);
  const clearAge = await kyron(`/api/gfs/creators/${kid.id}`, { method: "PATCH", body: { age_checked_on: null } });
  assert.equal(clearAge.status, 409, JSON.stringify(clearAge.json));
  assert.equal(clearAge.json.error, "gfs_creator_on_crew");
  assert.equal((await kyron(`/api/gfs/creators/${kid.id}`, { method: "PATCH", body: { guardian_email: "" } })).status, 409);
  assert.equal((await kyron(`/api/gfs/creators/${kid.id}`, { method: "PATCH", body: { guardian_email: "kit.parent@example.com" } })).status, 200, "a different guardian is fine");
  await refused(`update gfs_creators set age_checked_on = $1, age_checked_by = 'kyron@example.com' where id = $2`, [D(5), anchor.id], /gfs_age_check_in_future/);
  // Off the crew, it can change again.
  await q(`update gfs_crew set status = 'removed' where event_id = $1 and creator_id = $2`, [stop.id, kid.id]);
  assert.equal((await kyron(`/api/gfs/creators/${kid.id}`, { method: "PATCH", body: { guardian_email: "" } })).status, 200);
  await q(`update gfs_crew set status = 'removed' where event_id = $1`, [stop.id]);
});

test("routes: the crew screen blocks an unchecked creator and a youth creator with no guardian, and says why", async () => {
  const kyron = await signedIn();
  const add = await kyron("/api/gfs/creators", { method: "POST", body: { name: "Al Unchecked", region: "midwest", tier: "youth", contract_signed_on: D(-5), background_check_on: D(-5), safety_training_on: D(-5) } });
  assert.equal(add.status, 200, JSON.stringify(add.json));
  const al = add.json.creator;
  const r1 = await kyron(`/api/gfs/events/${ev.id}/crew`, { method: "POST", body: { creator_id: al.id, role: "shooter" } });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error, "credentials");
  assert.deepEqual(r1.json.problems.filter((p) => ["age_not_checked", "youth_no_guardian"].includes(p)).sort(), ["age_not_checked", "youth_no_guardian"]);
  await kyron(`/api/gfs/creators/${al.id}`, { method: "PATCH", body: { age_checked_on: D(0), guardian_name: "Al Parent", guardian_email: "alp@example.com" } });
  const r2 = await kyron(`/api/gfs/events/${ev.id}/crew`, { method: "POST", body: { creator_id: al.id, role: "shooter" } });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
});

test("routes: an unchecked adult from before 028 gets no QR code and never appears on the stop page", async () => {
  const kyron = await signedIn();
  const old = await legacyAdult("OLDB2", "Ola Before");
  await q(`update gfs_creators set sportsclippers_url = 'https://sportsclippers.com/ola' where id = $1`, [old.id]);
  await q(`alter table gfs_crew disable trigger gfs_crew_age_check`);
  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'photographer', 'confirmed', 'kyron@example.com')`, [ev.id, old.id]);
  await q(`alter table gfs_crew enable trigger gfs_crew_age_check`);
  // Kyron can still pause them without checking their age first.
  assert.equal((await kyron(`/api/gfs/creators/${old.id}`, { method: "PATCH", body: { status: "paused", tier: "adult" } })).status, 200);
  await kyron(`/api/gfs/creators/${old.id}`, { method: "PATCH", body: { status: "active" } });
  const qr = await kyron(`/api/gfs/events/${ev.id}/qr`);
  assert.equal(qr.status, 200, JSON.stringify(qr.json));
  assert.ok(!qr.json.codes.some((c) => c.kind === "creator" && c.creator.code === "OLDB2"), "no code for them");
  assert.ok(!qr.json.creators_without_link.some((c) => c.code === "OLDB2"), "not named on the list: unchecked counts as youth");
  assert.ok(qr.json.youth_on_crew >= 1, "counted with the youth creators instead");
  const page = await kyron(`/e/${ev.code}?c=OLDB2`);
  assert.equal(page.status, 200, "the stop page itself loads");
  assert.doesNotMatch(page.text, /Ola/, "the stop page doesn't show them");
  // The control: a checked adult on the same crew does appear, by first name.
  const nia = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, age_checked_on, age_checked_by, sportsclippers_url, created_by)
                         values ('NIAC1', 'Nia Checked', 'midwest', 'adult', $1, $1, $1, $1, 'kyron@example.com', 'https://sportsclippers.com/nia', 'kyron@example.com') returning *`, [D(-30)]);
  await q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, 'photographer', 'confirmed', 'kyron@example.com')`, [ev.id, nia.id]);
  const shown = await kyron(`/e/${ev.code}?c=NIAC1`);
  assert.equal(shown.status, 200);
  assert.match(shown.text, /Nia/, "a checked adult shows by first name");
  assert.doesNotMatch(shown.text, /Checked/, "first name only");
  assert.ok((await kyron(`/api/gfs/events/${ev.id}/qr`)).json.codes.some((c) => c.kind === "creator" && c.creator.code === "NIAC1"), "and gets a code");
});

test("before 028 runs: nobody can be crewed (it fails closed), and adding an adult says to apply the migration", async () => {
  const old = await makeSchema(URL_, "gfs_age_pre028_test", ["019_team.sql", "020_native_push.sql", "024_gfs_events.sql", "025_gfs_qr.sql"]);
  setSupabase(pgSupabase(old, "gfs_age_pre028_test"));
  try {
    const kyron = await signedIn();
    const youth = await kyron("/api/gfs/creators", { method: "POST", body: { name: "Pre Youth", region: "midwest", contract_signed_on: D(-5), background_check_on: D(-5), safety_training_on: D(-5) } });
    assert.equal(youth.status, 200, JSON.stringify(youth.json));
    const adult = await kyron("/api/gfs/creators", { method: "POST", body: { name: "Pre Adult", region: "midwest", tier: "adult", age_checked_on: D(0) } });
    assert.equal(adult.status, 503, JSON.stringify(adult.json));
    assert.equal(adult.json.error, "gfs_age_not_set_up");
    const e = await kyron("/api/gfs/events", { method: "POST", body: { name: "Pre Event", size: "one_day", region: "midwest", city: "Kent", state: "OH", starts_on: D(40) } });
    const crew = await kyron(`/api/gfs/events/${e.json.event.id}/crew`, { method: "POST", body: { creator_id: youth.json.creator.id, role: "shooter" } });
    assert.equal(crew.status, 409);
    assert.ok(crew.json.problems.includes("age_not_checked"));
    // Pausing a youth creator still works from the full form, which sends
    // the (empty) guardian fields along.
    const form = { name: "Pre Youth", email: "", region: "midwest", home_city: "", notes: "", status: "paused", guardian_name: null, guardian_email: null };
    const paused = await kyron(`/api/gfs/creators/${youth.json.creator.id}`, { method: "PATCH", body: { ...form, contract_signed_on: D(-5), background_check_on: D(-5), safety_training_on: D(-5), age_checked_on: null, tier: "youth", shadow_events: 0, lead_scout: false } });
    assert.equal(paused.status, 200, JSON.stringify(paused.json));
    await old.query(`insert into team_members (email, name, role, tools, regions) values ('mw@example.com', 'Midwest Director', 'member', array['gfs'], array['midwest'])`);
    const mw = await signedIn("mw@example.com", "creator");
    assert.equal((await mw(`/api/gfs/creators/${youth.json.creator.id}`, { method: "PATCH", body: { ...form, status: "paused" } })).status, 200, "a director can pause them too");
  } finally {
    setSupabase(pgSupabase(pool, S));
    await old.query("drop schema gfs_age_pre028_test cascade");
    await old.end();
  }
});
