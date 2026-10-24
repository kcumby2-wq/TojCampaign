// Migration 024 in a real Postgres: the rules the database enforces for
// Pylon events, so no route bug can break them.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_db_test), which it DROPS and recreates. Never
// point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "gfs_db_test";

if (!URL_) {
  test("gfs database rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool;
const q = (sql, params) => pool.query(sql, params);
async function refused(sql, params, code) {
  try {
    await q(sql, params);
  } catch (e) {
    if (code) assert.match(e.message, new RegExp(code), `expected ${code}, got: ${e.message}`);
    return true;
  }
  assert.fail(`expected a refusal${code ? " (" + code + ")" : ""}: ${sql}`);
}
const one = async (sql, params) => (await q(sql, params)).rows[0];

let geneva, chicago, adult, adult2, youth, unscreened;

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${S} cascade; create schema ${S};`);
  // Supabase's API roles, so the grants mean something on a bare Postgres.
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${S}` });
  // The two team tables 024 adds regions to (migration 019 makes them).
  await q(`create table ${S}.team_members (email text primary key, role text, tools text[]);
           create table ${S}.team_invites (id uuid primary key default gen_random_uuid(), email text);`);
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "024_gfs_events.sql"), "utf8").replace(/public\./g, `${S}.`);
  await q(sql);
  await q(sql); // safe to run twice

  geneva = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, wraps_at, ends_at, created_by)
                      values ('Geneva2026', 'Girls Flag · Geneva, OH', 'one_day', 'midwest', 'Geneva', 'OH', 'America/New_York', '2026-10-24', '2026-10-24', '18:00', now(), 'kyron@example.com') returning *`);
  chicago = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                       values ('Chicago2027', 'Legacy Tour · Chicago', 'premier', 'midwest', 'Chicago', 'IL', 'America/Chicago', '2027-01-02', '2027-01-03', now(), 'kyron@example.com') returning *`);
  const creator = (code, extra) => one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, created_by)
      values ($1, $2, 'midwest', $3, $4, $5, $6, 'kyron@example.com') returning *`, [code, ...extra]);
  adult = await creator("ADLT1", ["Creator A", "adult", "2026-09-01", "2026-09-01", "2026-09-01"]);
  adult2 = await creator("ADLT2", ["Creator B", "adult", "2026-09-01", "2026-09-01", "2026-09-01"]);
  youth = await creator("YOUTH", ["Creator Y", "youth", "2026-09-01", "2026-09-01", "2026-09-01"]);
  unscreened = await creator("NOPE1", ["Creator N", "adult", null, "2026-09-01", "2025-01-01"]);
});
after(async () => {
  if (pool) await pool.end();
});

test("deadlines run from the event's own wrap time and zone; an unknown zone is refused", async () => {
  assert.equal(new Date(geneva.ends_at).toISOString(), "2026-10-24T22:00:00.000Z", "6 p.m. in Ohio");
  assert.equal(new Date(chicago.ends_at).toISOString(), "2027-01-04T00:00:00.000Z", "6 p.m. Central on the last day");
  await refused(`update gfs_events set tz = 'Mars/Olympus' where id = $1`, [geneva.id]);
  await refused(`update gfs_events set ends_on = '2026-11-24' where id = $1`, [geneva.id]);
});

test("crews: screened adults only, a youth creator never leads and never without an adult", async () => {
  const crew = (creator, role, status = "invited") => q(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, $3, $4, 'x') returning id`, [geneva.id, creator.id, role, status]);
  await refused(`insert into gfs_crew (event_id, creator_id, role, assigned_by) values ($1, $2, 'shooter', 'x')`, [geneva.id, unscreened.id], "crew_no_contract");
  await q(`update gfs_creators set contract_signed_on = '2026-09-01' where id = $1`, [unscreened.id]);
  await refused(`insert into gfs_crew (event_id, creator_id, role, assigned_by) values ($1, $2, 'shooter', 'x')`, [geneva.id, unscreened.id], "crew_safety_training");
  await refused(`insert into gfs_crew (event_id, creator_id, role, assigned_by) values ($1, $2, 'lead', 'x')`, [geneva.id, youth.id], "crew_youth_role");
  const y = (await crew(youth, "shooter")).rows[0].id;
  await refused(`update gfs_crew set status = 'confirmed' where id = $1`, [y], "crew_youth_needs_adult");
  const a = (await crew(adult, "lead", "confirmed")).rows[0].id;
  await q(`update gfs_crew set status = 'confirmed' where id = $1`, [y]);
  await refused(`update gfs_crew set status = 'removed' where id = $1`, [a], "crew_youth_left_alone");
  await refused(`insert into gfs_crew (event_id, creator_id, role, assigned_by) values ($1, $2, 'shooter', 'x')`, [geneva.id, adult.id], "duplicate key");
  const b = (await crew(adult2, "shooter", "confirmed")).rows[0].id;
  await q(`update gfs_crew set status = 'removed' where id = $1`, [a]);
  assert.ok(b);
});

let ann, cat, dee, otherAnn;
test("holds come from the athlete's record, and clips move one step at a time", async () => {
  const row = (event, rid, team, division, jersey, flags) =>
    one(`insert into gfs_roster (event_id, roster_id, team, division, jersey, position, under_13, consent_capture, consent_marketing, consent_sale, public_display, do_not_publish)
         values ($1, $2, $3, $4, $5, 'WR', $6, $7, $8, $9, $10, $11) returning *`, [event.id, rid, team, division, jersey, ...flags]);
  ann = await row(geneva, "ST-1001", "Ohio Heat 14U", "14U", "7", [false, true, true, true, true, false]);
  cat = await row(geneva, "ST-1003", "Ohio Heat 14U", "14U", "13", [false, true, true, true, true, true]);
  dee = await row(geneva, "ST-2001", "Buckeye Flag 12U", "12U", "21", [false, true, true, true, true, false]);
  otherAnn = await row(chicago, "ST-1001", "Ohio Heat 14U", "14U", "7", [false, true, true, true, true, false]);
  const clip = (r, file) => one(`insert into gfs_clips (event_id, log_key, file, angle, jersey, roster_row, match, label, held, logged_by)
      values ($1, $2, $3, 'Sideline', $4, $5, 'matched', 'Geneva2026-WR-7-Sideline-001', false, 'x') returning *`, [geneva.id, geneva.id + "|" + file, file, r.jersey, r.id]);
  const held = await clip(cat, "13-Sideline-001.mp4");
  assert.equal(held.held, true, "the client said false; the record says do-not-publish");
  assert.equal(held.hold_reason, "do_not_publish");
  await q(`update gfs_clips set held = false, hold_reason = null where id = $1`, [held.id]);
  assert.equal((await one(`select held from gfs_clips where id = $1`, [held.id])).held, true, "a hold can't be switched off from outside");

  const c = await clip(ann, "7-Sideline-001.mp4");
  await refused(`insert into gfs_clips (event_id, log_key, file, roster_row, match, stage, logged_by) values ($1, 'k-skip', 'x.mp4', $2, 'matched', 'approved', 'x')`, [geneva.id, ann.id], "gfs_clip_stage");
  await refused(`update gfs_clips set stage = 'edited' where id = $1`, [c.id], "gfs_clip_stage");
  await q(`update gfs_clips set stage = 'tagged' where id = $1`, [c.id]);
  await q(`update gfs_clips set stage = 'edited' where id = $1`, [c.id]);
  await refused(`update gfs_clips set stage = 'approved' where id = $1`, [c.id]);
  await q(`update gfs_clips set stage = 'approved', approved_by = 'josh@example.com', approved_at = now() where id = $1`, [c.id]);

  await q(`update gfs_clips set stage = 'tagged' where id = $1`, [held.id]);
  await q(`update gfs_clips set stage = 'edited' where id = $1`, [held.id]);
  await refused(`update gfs_clips set stage = 'approved', approved_by = 'j', approved_at = now() where id = $1`, [held.id], "gfs_clip_held");
});

test("SportsClippers Schedule A: sale consent to list; public only with public display and 13 or older", async () => {
  const approved = async (r, file, consentSale = true) => {
    await q(`update gfs_roster set consent_sale = $2 where id = $1`, [r.id, consentSale]);
    const c = await one(`insert into gfs_clips (event_id, log_key, file, roster_row, match, logged_by) values ($1, $2, $3, $4, 'matched', 'x') returning id`, [geneva.id, geneva.id + "|" + file, file, r.id]);
    for (const s of ["tagged", "edited"]) await q(`update gfs_clips set stage = $2 where id = $1`, [c.id, s]);
    await q(`update gfs_clips set stage = 'approved', approved_by = 'j', approved_at = now() where id = $1`, [c.id]);
    return c.id;
  };
  const deeClip = await approved(dee, "21-EndZone-002.mp4");
  await refused(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [deeClip], "gfs_clip_not_public");
  await q(`update gfs_clips set listed_at = now(), visibility = 'family' where id = $1`, [deeClip]);
  await refused(`update gfs_clips set visibility = 'public' where id = $1`, [deeClip], "gfs_clip_not_public");

  const annClip = (await one(`select id from gfs_clips where file = '7-Sideline-001.mp4'`)).id;
  await q(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [annClip]);
  await refused(`update gfs_clips set roster_row = $2 where id = $1`, [annClip, dee.id], "gfs_clip_already_out");
  await refused(`update gfs_clips set stage = 'shot' where id = $1`, [annClip], "gfs_clip_already_out");

  const noSale = await approved(dee, "21-EndZone-003.mp4", false);
  await refused(`update gfs_clips set listed_at = now(), visibility = 'family' where id = $1`, [noSale], "gfs_clip_no_sale_consent");
  await refused(`update gfs_clips set listed_at = now() where id = $1`, [noSale]);
  const unapproved = await one(`insert into gfs_clips (event_id, log_key, file, roster_row, match, logged_by) values ($1, 'k-unapproved', 'u.mp4', $2, 'matched', 'x') returning id`, [geneva.id, ann.id]);
  await refused(`update gfs_clips set delivered_at = now() where id = $1`, [unapproved.id], "gfs_clip_not_approved");
});

test("a takedown sets its own clock and holds the athlete at every event, for good", async () => {
  const t = await one(`insert into gfs_takedowns (event_id, region, roster_id, team, reason, received_at, pylon_due_at, other_due_at, offsite_due_at, logged_by)
                       values ($1, 'midwest', 'ST-1001', 'Ohio Heat 14U', 'safety_request', '2026-10-20 15:00Z', '2030-01-01', '2030-01-01', '2030-01-01', 'mw@example.com') returning *`, [geneva.id]);
  assert.equal(new Date(t.pylon_due_at).toISOString(), "2026-10-20T17:00:00.000Z", "2 hours, whatever the client sent");
  assert.equal(new Date(t.other_due_at).toISOString(), "2026-10-21T15:00:00.000Z");
  assert.equal(new Date(t.offsite_due_at).toISOString(), "2026-10-21T15:00:00.000Z");
  const w = await one(`insert into gfs_takedowns (region, roster_id, reason, received_at, pylon_due_at, other_due_at, offsite_due_at, logged_by)
                       values ('midwest', 'ST-9999', 'consent_withdrawn', '2026-10-20 15:00Z', now(), now(), now(), 'x') returning *`);
  assert.equal(new Date(w.pylon_due_at).toISOString(), "2026-10-21T15:00:00.000Z", "24 hours");
  assert.equal(new Date(w.other_due_at).toISOString(), "2026-10-23T15:00:00.000Z", "72 hours");
  await refused(`insert into gfs_takedowns (region, roster_id, reason, received_at, pylon_due_at, other_due_at, offsite_due_at, logged_by)
                 values ('midwest', 'ST-1', 'consent_withdrawn', now() + interval '1 day', now(), now(), now(), 'x')`, [], "gfs_takedown_future");

  const both = (await q(`select do_not_publish, takedown_at from gfs_roster where roster_id = 'ST-1001'`)).rows;
  assert.equal(both.length, 2);
  assert.ok(both.every((r) => r.do_not_publish && r.takedown_at), "both events, the same moment");
  const clip = await one(`select held, hold_reason, listed_at from gfs_clips where file = '7-Sideline-001.mp4'`);
  assert.deepEqual([clip.held, clip.hold_reason], [true, "takedown"]);
  const counts = await one(`select * from gfs_event_counts(array[$1]::uuid[])`, [geneva.id]);
  assert.equal(counts.needs_removal, 1, "listed and now held: it has to come down");

  await q(`update gfs_roster set do_not_publish = false, takedown_at = null where id = $1`, [ann.id]);
  const kept = await one(`select do_not_publish, takedown_at from gfs_roster where id = $1`, [ann.id]);
  assert.ok(kept.do_not_publish && kept.takedown_at, "a roster file can't undo a takedown");

  await q(`update gfs_takedowns set reason = 'consent_withdrawn', received_at = now(), roster_id = 'ST-2', pylon_done_at = now() where id = $1`, [t.id]);
  const after1 = await one(`select reason, roster_id, received_at, status, pylon_done_at from gfs_takedowns where id = $1`, [t.id]);
  assert.equal(after1.reason, "safety_request");
  assert.equal(after1.roster_id, "ST-1001");
  assert.equal(new Date(after1.received_at).toISOString(), "2026-10-20T15:00:00.000Z");
  assert.equal(after1.status, "open");
  await q(`update gfs_takedowns set pylon_done_at = null where id = $1`, [t.id]);
  assert.ok((await one(`select pylon_done_at from gfs_takedowns where id = $1`, [t.id])).pylon_done_at, "a done step stays done");
  await q(`update gfs_takedowns set other_done_at = now(), offsite_requested_at = now() where id = $1`, [t.id]);
  assert.equal((await one(`select status from gfs_takedowns where id = $1`, [t.id])).status, "done");
});

test("deliverables: approval needs an approver recorded and consent for every featured athlete", async () => {
  const d = await one(`insert into gfs_deliverables (event_id, kind, required, due_at, publishes) values ($1, 'who_is', 2, now(), true) returning *`, [geneva.id]);
  await refused(`insert into gfs_deliverables (event_id, kind, day, required, due_at, publishes, status) values ($1, 'recap', 0, 1, now(), true, 'approved')`, [geneva.id], "gfs_deliverable_starts_open");
  await refused(`update gfs_deliverables set status = 'submitted' where id = $1`, [d.id], "gfs_deliverable_nothing_new");
  await q(`update gfs_deliverables set delivered = 2, featured = array[$2::uuid] where id = $1`, [d.id, dee.id]);
  await refused(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now() where id = $1`, [d.id], "gfs_deliverable_status");
  await q(`update gfs_deliverables set status = 'submitted', submitted_by = 'mw', submitted_at = now() where id = $1`, [d.id]);
  await refused(`update gfs_deliverables set status = 'approved' where id = $1`, [d.id]);
  await q(`update gfs_roster set consent_marketing = false where id = $1`, [dee.id]);
  await refused(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now() where id = $1`, [d.id], "gfs_featured_consent");
  await q(`update gfs_roster set consent_marketing = true where id = $1`, [dee.id]);
  await q(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now(), approved_count = 99 where id = $1`, [d.id]);
  const ok = await one(`select status, approved_count, delivered_at from gfs_deliverables where id = $1`, [d.id]);
  assert.equal(ok.status, "approved");
  assert.equal(ok.approved_count, 2, "what was delivered and cleared, not what the client sent");
  assert.ok(ok.delivered_at);
  await q(`update gfs_deliverables set approved_count = 0 where id = $1`, [d.id]);
  assert.equal((await one(`select approved_count from gfs_deliverables where id = $1`, [d.id])).approved_count, 2);
  await refused(`update gfs_deliverables set delivered = 1 where id = $1`, [d.id], "gfs_deliverable_below_approved");

  const iv = await one(`insert into gfs_deliverables (event_id, kind, required, due_at) values ($1, 'interviews', 3, now()) returning id`, [geneva.id]);
  await refused(`update gfs_deliverables set status = 'done' where id = $1`, [iv.id], "gfs_deliverable_short");
  await refused(`update gfs_deliverables set delivered = 3, status = 'done' where id = $1`, [iv.id], "gfs_featured_required");
  await refused(`update gfs_deliverables set delivered = 3, status = 'submitted' where id = $1`, [iv.id], "gfs_deliverable_status|check");
  await q(`update gfs_deliverables set delivered = 3, featured = array[$2::uuid], status = 'done' where id = $1`, [iv.id, dee.id]);
});

test("everything is server-side only", async () => {
  const rls = (await q(`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and relname like 'gfs_%' and relkind = 'r'`, [S])).rows;
  assert.equal(rls.length, 8);
  assert.ok(rls.every((r) => r.relrowsecurity), JSON.stringify(rls));
  const can = async (role, fn) => (await one(`select has_function_privilege($1, $2, 'execute') as ok`, [role, `${S}.${fn}`])).ok;
  assert.equal(await can("anon", "gfs_event_counts(uuid[])"), false);
  assert.equal(await can("authenticated", "gfs_event_counts(uuid[])"), false);
  assert.equal(await can("service_role", "gfs_event_counts(uuid[])"), true);
  assert.equal(await can("anon", `gfs_under_13(${S}.gfs_roster)`), false);
});
