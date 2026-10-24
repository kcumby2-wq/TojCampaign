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
  await refused(`update gfs_clips set listed_at = now(), visibility = 'family' where id = $1`, [deeClip], "gfs_clip_not_exported");
  await q(`update gfs_clips set exported_at = now(), export_visibility = 'public' where id = $1`, [deeClip]);
  await refused(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [deeClip], "gfs_clip_not_public");
  await q(`update gfs_clips set listed_at = now(), visibility = 'family' where id = $1`, [deeClip]);
  await refused(`update gfs_clips set visibility = 'public' where id = $1`, [deeClip], "gfs_clip_not_public");

  const annClip = (await one(`select id from gfs_clips where file = '7-Sideline-001.mp4'`)).id;
  await q(`update gfs_clips set exported_at = now(), export_visibility = 'family' where id = $1`, [annClip]);
  await refused(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [annClip], "gfs_clip_not_exported");
  await q(`update gfs_clips set export_visibility = 'public' where id = $1`, [annClip]);
  await q(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [annClip]);
  await refused(`update gfs_clips set roster_row = $2 where id = $1`, [annClip, dee.id], "gfs_clip_already_out");
  await refused(`update gfs_clips set stage = 'shot' where id = $1`, [annClip], "gfs_clip_already_out");

  const noSale = await approved(dee, "21-EndZone-003.mp4", false);
  await q(`update gfs_clips set exported_at = now(), export_visibility = 'family' where id = $1`, [noSale]);
  await refused(`update gfs_clips set listed_at = now(), visibility = 'family' where id = $1`, [noSale], "gfs_clip_no_sale_consent");
  await refused(`update gfs_clips set listed_at = now() where id = $1`, [noSale]);
  const unapproved = await one(`insert into gfs_clips (event_id, log_key, file, roster_row, match, logged_by) values ($1, 'k-unapproved', 'u.mp4', $2, 'matched', 'x') returning id`, [geneva.id, ann.id]);
  await refused(`update gfs_clips set delivered_at = now() where id = $1`, [unapproved.id], "gfs_clip_not_approved");
  const approvedAnn = await approved(ann, "7-EndZone-009.mp4");
  await refused(`update gfs_clips set delivered_at = now() where id = $1`, [approvedAnn], "gfs_clip_not_exported");
  await q(`update gfs_clips set family_export_at = now() where id = $1`, [approvedAnn]);
  await q(`update gfs_clips set delivered_at = now() where id = $1`, [approvedAnn]);
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
  assert.equal(counts.needs_removal, 3, "Ann's listing and family link (held now) and Dee's listing (her sale consent came off): all three come down");

  await q(`update gfs_roster set do_not_publish = false, takedown_at = null where id = $1`, [ann.id]);
  const kept = await one(`select do_not_publish, takedown_at from gfs_roster where id = $1`, [ann.id]);
  assert.ok(kept.do_not_publish && kept.takedown_at, "a roster file can't undo a takedown");
  // The way the app loads a roster file: an upsert on (event, roster ID).
  await q(`insert into gfs_roster (event_id, roster_id, team, jersey, consent_capture, do_not_publish) values ($1, 'ST-1001', 'Ohio Heat 14U', '7', true, false)
           on conflict (event_id, roster_id) do update set consent_capture = excluded.consent_capture, do_not_publish = excluded.do_not_publish`, [geneva.id]);
  const upserted = await one(`select do_not_publish, takedown_at from gfs_roster where id = $1`, [ann.id]);
  assert.ok(upserted.do_not_publish && upserted.takedown_at, "nor can a re-upload");

  await q(`update gfs_takedowns set reason = 'consent_withdrawn', received_at = now(), roster_id = 'ST-2', pylon_done_at = now() where id = $1`, [t.id]);
  const after1 = await one(`select reason, roster_id, received_at, status, pylon_done_at from gfs_takedowns where id = $1`, [t.id]);
  assert.equal(after1.reason, "safety_request");
  assert.equal(after1.roster_id, "ST-1001");
  assert.equal(new Date(after1.received_at).toISOString(), "2026-10-20T15:00:00.000Z");
  assert.equal(after1.status, "open");
  await q(`update gfs_takedowns set pylon_done_at = null where id = $1`, [t.id]);
  assert.ok((await one(`select pylon_done_at from gfs_takedowns where id = $1`, [t.id])).pylon_done_at, "a done step stays done");
  await refused(`update gfs_takedowns set other_done_at = now() where id = $1`, [t.id], "gfs_takedown_clips_out");
  await q(`update gfs_clips c set removed_at = now() from gfs_roster r where r.id = c.roster_row and r.roster_id = 'ST-1001' and (c.listed_at is not null or c.delivered_at is not null)`);
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
  await refused(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now() where id = $1`, [d.id], "gfs_deliverable_attest");
  await refused(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now(), attested_by = 'someone-else', attested_at = now() where id = $1`, [d.id], "gfs_deliverable_attest");
  await q(`update gfs_deliverables set status = 'approved', decided_by = 'j', decided_at = now(), attested_by = 'j', attested_at = now(), approved_count = 99 where id = $1`, [d.id]);
  const ok = await one(`select status, approved_count, delivered_at from gfs_deliverables where id = $1`, [d.id]);
  assert.equal(ok.status, "approved");
  assert.equal(ok.approved_count, 2, "what was delivered and cleared, not what the client sent");
  assert.ok(ok.delivered_at);
  await q(`update gfs_deliverables set approved_count = 0 where id = $1`, [d.id]);
  assert.equal((await one(`select approved_count from gfs_deliverables where id = $1`, [d.id])).approved_count, 2);
  await refused(`update gfs_deliverables set delivered = 1 where id = $1`, [d.id], "gfs_deliverable_below_approved");
  await q(`update gfs_deliverables set attested_by = null, attested_at = null where id = $1`, [d.id]);
  assert.ok((await one(`select attested_at from gfs_deliverables where id = $1`, [d.id])).attested_at, "an attestation stays with the approval it was given for");
  await q(`update gfs_deliverables set delivered = 3, status = 'submitted', submitted_by = 'mw', submitted_at = now() where id = $1`, [d.id]);
  assert.equal((await one(`select attested_at from gfs_deliverables where id = $1`, [d.id])).attested_at, null, "a new submission starts without one");

  const iv = await one(`insert into gfs_deliverables (event_id, kind, required, due_at) values ($1, 'interviews', 3, now()) returning id`, [geneva.id]);
  await refused(`update gfs_deliverables set status = 'done' where id = $1`, [iv.id], "gfs_deliverable_short");
  await refused(`update gfs_deliverables set delivered = 3, status = 'done' where id = $1`, [iv.id], "gfs_featured_required");
  await refused(`update gfs_deliverables set delivered = 3, status = 'submitted' where id = $1`, [iv.id], "gfs_deliverable_status|check");
  await q(`update gfs_deliverables set delivered = 3, featured = array[$2::uuid], status = 'done' where id = $1`, [iv.id, dee.id]);
});

test("B3: the last screened adult can't step away from a youth creator, even in a race", async () => {
  const ev = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                        values ('Lima2027', 'Lima clinic', 'clinic', 'midwest', 'Lima', 'OH', 'America/New_York', '2027-03-06', '2027-03-06', now(), 'k') returning *`);
  const crew = async (creator, role, status) => (await one(`insert into gfs_crew (event_id, creator_id, role, status, assigned_by) values ($1, $2, $3, $4, 'x') returning id`, [ev.id, creator.id, role, status])).id;
  const lead = await crew(adult, "lead", "confirmed");
  const y = await crew(youth, "shooter", "confirmed");
  await refused(`update gfs_crew set status = 'invited' where id = $1`, [lead], "crew_youth_left_alone");
  await refused(`update gfs_crew set role = 'editor' where id = $1`, [lead], "crew_youth_left_alone");
  await q(`update gfs_crew set role = 'shooter' where id = $1`, [lead]);
  await q(`update gfs_crew set note = 'family rating later', family_rating = 4.5 where id = $1`, [lead]);

  // Screening that lapsed doesn't anchor anyone: a second youth creator can't
  // be confirmed beside an adult whose check is too old for this event.
  const y2c = await one(`insert into gfs_creators (code, name, region, tier, contract_signed_on, background_check_on, safety_training_on, created_by)
                         values ('YOUT2', 'Creator Y2', 'midwest', 'youth', '2026-09-01', '2026-09-01', '2026-09-01', 'k') returning *`);
  const y2 = await crew(y2c, "shadow", "invited");
  await q(`update gfs_creators set background_check_on = '2025-01-01' where id = $1`, [adult.id]);
  await refused(`update gfs_crew set status = 'confirmed' where id = $1`, [y2], "crew_youth_needs_adult");
  await q(`update gfs_creators set background_check_on = '2026-09-01' where id = $1`, [adult.id]);

  // Two people at once: one confirms a youth creator, the other removes the
  // only adult. The event row lock makes the second one see the first.
  await q(`update gfs_crew set status = 'removed' where id = $1`, [y]);
  const c1 = await pool.connect();
  const c2 = await pool.connect();
  try {
    await c1.query("begin");
    await c2.query("begin");
    await c1.query(`update gfs_crew set status = 'confirmed' where id = $1`, [y2]);
    const second = c2.query(`update gfs_crew set status = 'removed' where id = $1`, [lead]);
    await new Promise((r) => setTimeout(r, 150));
    await c1.query("commit");
    await assert.rejects(second, /crew_youth_left_alone/);
    await c2.query("rollback");
  } finally {
    c1.release();
    c2.release();
  }
  const state = await one(`select count(*) filter (where x.status = 'confirmed' and y.tier = 'youth')::int as youth,
                                  count(*) filter (where x.status = 'confirmed' and y.tier = 'adult')::int as adults
                             from gfs_crew x join gfs_creators y on y.id = x.creator_id where x.event_id = $1`, [ev.id]);
  assert.deepEqual([state.youth, state.adults], [1, 1]);

  // S11: the tier doesn't change while the creator is on an upcoming crew.
  await refused(`update gfs_creators set tier = 'adult' where id = $1`, [y2c.id], "gfs_creator_on_crew");
  // Minor 13: a rating lands even with the creator paused since.
  await q(`update gfs_creators set status = 'paused' where id = $1`, [adult2.id]);
  const old = await one(`select x.id from gfs_crew x where x.creator_id = $1 limit 1`, [adult2.id]);
  await q(`update gfs_crew set family_rating = 4.7, rating_count = 2 where id = $1`, [old.id]);
  await q(`update gfs_creators set status = 'active' where id = $1`, [adult2.id]);
});

test("B1: a roster that loads after a takedown starts with the athlete held", async () => {
  const later = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                           values ('Ontario2027', 'Girls Flag · Ontario, CA', 'one_day', 'west', 'Ontario', 'CA', 'America/Los_Angeles', '2027-02-13', '2027-02-13', now(), 'k') returning *`);
  const row = await one(`insert into gfs_roster (event_id, roster_id, team, jersey, consent_capture, do_not_publish) values ($1, 'ST-1001', 'Ohio Heat 14U', '7', true, false) returning *`, [later.id]);
  assert.ok(row.takedown_at && row.do_not_publish, "the takedown logged at Geneva stands here");
  await q(`update gfs_roster set roster_id = 'ST-OTHER' where id = $1`, [row.id]);
  assert.equal((await one(`select roster_id from gfs_roster where id = $1`, [row.id])).roster_id, "ST-1001", "a roster row's athlete doesn't change");
});

test("B2, S8: a roster correction re-tags clips, and a consent change pulls a live listing", async () => {
  const ev = await one(`insert into gfs_events (code, name, size, region, city, state, tz, starts_on, ends_on, ends_at, created_by)
                        values ('Dayton2027', 'Dayton Flag', 'one_day', 'midwest', 'Dayton', 'OH', 'America/New_York', '2027-04-03', '2027-04-03', now(), 'k') returning *`);
  const athlete = (rid, jersey) => one(`insert into gfs_roster (event_id, roster_id, team, division, jersey, under_13, consent_capture, consent_marketing, consent_sale, public_display)
                                        values ($1, $2, 'Dayton Dragons 14U', '14U', $3, false, true, true, true, true) returning *`, [ev.id, rid, jersey]);
  const a = await athlete("DA-1", "31");
  const b = await athlete("DA-2", "40");
  const clip = async (r, file, tagSource = "jersey") => {
    const c = await one(`insert into gfs_clips (event_id, log_key, file, jersey, roster_row, match, tag_source, team, team_given, label, logged_by)
                         values ($1, $2, $3, $4, $5, 'matched', $6, 'Dayton Dragons 14U', null, 'Dayton2027-NA-31-Sideline-001', 'x') returning id`, [ev.id, ev.id + "|" + file, file, r.jersey, r.id, tagSource]);
    return c.id;
  };
  const shot = await clip(a, "31-Sideline-001.mp4");
  const outId = await clip(b, "40-EndZone-002.mp4");
  for (const st of ["tagged", "edited"]) await q(`update gfs_clips set stage = $2 where id = $1`, [outId, st]);
  await q(`update gfs_clips set stage = 'approved', approved_by = 'j', approved_at = now(), exported_at = now(), export_visibility = 'public' where id = $1`, [outId]);
  await q(`update gfs_clips set listed_at = now(), visibility = 'public' where id = $1`, [outId]);

  await q(`update gfs_roster set jersey = '13' where id = $1`, [a.id]);
  const back = await one(`select match, why, roster_row, stage, label from gfs_clips where id = $1`, [shot]);
  assert.deepEqual([back.match, back.why, back.roster_row, back.stage, back.label], ["unmatched", "roster_changed", null, "shot", null]);

  // S8 first: public display comes off for the listed athlete.
  await q(`update gfs_roster set public_display = false where id = $1`, [b.id]);
  let c = await one(`select pull_reason, held from gfs_clips where id = $1`, [outId]);
  assert.deepEqual([c.pull_reason, c.held], ["not_public", false]);
  let counts = await one(`select * from gfs_event_counts(array[$1]::uuid[])`, [ev.id]);
  assert.deepEqual([counts.to_family_only, counts.needs_removal], [1, 0]);
  await q(`update gfs_clips set visibility = 'family', export_visibility = 'family' where id = $1`, [outId]);
  assert.equal((await one(`select pull_reason from gfs_clips where id = $1`, [outId])).pull_reason, null, "family-only now: nothing to pull");
  await q(`update gfs_roster set consent_sale = false where id = $1`, [b.id]);
  assert.equal((await one(`select pull_reason from gfs_clips where id = $1`, [outId])).pull_reason, "no_sale_consent");
  counts = await one(`select * from gfs_event_counts(array[$1]::uuid[])`, [ev.id]);
  assert.equal(counts.needs_removal, 1, "no sale consent: it comes down");
  await q(`update gfs_roster set consent_sale = true where id = $1`, [b.id]);

  // B2 for a clip that's out: held, and its athlete fixed until it comes down.
  await q(`update gfs_roster set jersey = '41' where id = $1`, [b.id]);
  c = await one(`select held, hold_reason, retag, roster_row from gfs_clips where id = $1`, [outId]);
  assert.deepEqual([c.held, c.hold_reason, c.retag, c.roster_row], [true, "roster_changed", true, b.id]);
  await q(`update gfs_clips set retag = false, updated_at = now() where id = $1`, [outId]);
  assert.equal((await one(`select retag from gfs_clips where id = $1`, [outId])).retag, true, "it sticks until the clip is tagged again");
  await refused(`update gfs_clips set roster_row = $2, stage = 'shot' where id = $1`, [outId, a.id], "gfs_clip_already_out");
  await q(`update gfs_clips set removed_at = now() where id = $1`, [outId]);
  await q(`update gfs_clips set roster_row = $2, stage = 'shot', match = 'matched' where id = $1`, [outId, b.id]);
  await q(`update gfs_clips set match = 'unmatched', roster_row = null where id = $1`, [outId]);
  c = await one(`select held, retag from gfs_clips where id = $1`, [outId]);
  assert.deepEqual([c.held, c.retag], [false, false], "tagged again after coming down: the hold clears");
});

test("S9: under 13 in the database, however the division is written", async () => {
  const ev = (await one(`select id from gfs_events where code = 'Dayton2027'`)).id;
  let i = 0;
  for (const [div, want] of [["12U", true], ["U12", true], ["U-12", true], ["12-U", true], ["2026 U12", true], ["Under 12", true], ["12 & Under", true], ["10U Girls", true], ["Girls U-10", true], ["14U", false], ["HS Varsity", false], ["2026", false]]) {
    const r = await one(`insert into gfs_roster (event_id, roster_id, team, division, under_13) values ($1, $2, 'T', $3, false) returning id`, [ev, "U13-" + i++, div]);
    const got = (await one(`select gfs_under_13(r) as u from gfs_roster r where id = $1`, [r.id])).u;
    assert.equal(got, want, div);
  }
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
