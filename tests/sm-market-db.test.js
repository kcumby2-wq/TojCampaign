// Migration 033 in a real Postgres: the shape the database holds for the
// Subject Medias marketplace, so no route bug can break it.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (sm_market_db_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "sm_market_db_test";

if (!URL_) {
  test("marketplace database rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool, ev, ev2, team, team2, athlete, media;
const q = (sql, params) => pool.query(sql, params);
const one = async (sql, params) => (await q(sql, params)).rows[0];
async function refused(sql, params, name) {
  try {
    await q(sql, params);
  } catch (e) {
    if (name) assert.match(e.message + " " + (e.constraint || ""), new RegExp(name), `expected ${name}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal${name ? " (" + name + ")" : ""}: ${sql}`);
}
const H = (c) => c.repeat(64);
let n = 0;
const key = (eventId, kind = "originals", ext = "mp4") => `events/${eventId}/${kind}/${(++n).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.${ext}`;

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${S} cascade; create schema ${S};`);
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${S}` });
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "033_sm_market.sql"), "utf8").replace(/public\./g, `${S}.`);
  await q(sql);
  await q(sql); // safe to run twice
  ev = await one(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('AB2CD3', 'Fall Showcase', '2026-11-21', '2026-11-22', 'ABCD2345', 'kyron@toj.test') returning *`);
  ev2 = await one(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('XY4ZW5', 'Winter Classic', '2026-12-05', '2026-12-05', 'WXYZ6789', 'kyron@toj.test') returning *`);
  team = await one(`insert into sm_market_teams (event_id, name) values ($1, 'Lightning') returning *`, [ev.id]);
  team2 = await one(`insert into sm_market_teams (event_id, name) values ($1, 'Storm') returning *`, [ev2.id]);
  athlete = await one(`insert into sm_market_athletes (event_id, team_id, jersey) values ($1, $2, '7') returning *`, [ev.id, team.id]);
  media = await one(`insert into sm_market_media (event_id, kind, object_key, uploaded_by) values ($1, 'clip', $2, 'crew@toj.test') returning *`, [ev.id, key(ev.id)]);
});
after(async () => {
  if (pool) await pool.end();
});

test("events: a readable code, real dates, sensible prices", async () => {
  assert.equal(ev.clip_cents, 1200);
  assert.equal(ev.photo_cents, 800);
  assert.equal(ev.status, "draft");
  await refused(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('AB0CD1', 'x', '2026-11-21', '2026-11-21', 'QRST2345', 'k@t.co')`);
  await refused(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('AB2CD3', 'x', '2026-11-21', '2026-11-21', 'QRST2345', 'k@t.co')`, null, "unique|duplicate");
  await refused(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('QQ2CD3', 'x', '2026-11-21', '2026-11-20', 'QRST2345', 'k@t.co')`, null, "sm_market_events_days_chk");
  await refused(`insert into sm_market_events (code, name, starts_on, ends_on, view_key, created_by) values ('QQ3CD3', 'x', '2026-11-01', '2026-11-30', 'QRST2345', 'k@t.co')`, null, "sm_market_events_days_chk");
  await refused(`update sm_market_events set clip_cents = 10 where id = $1`, [ev.id]);
  await refused(`update sm_market_events set status = 'open' where id = $1`, [ev.id]);
  // The clips page's access code: always there, eight readable characters.
  await refused(`insert into sm_market_events (code, name, starts_on, ends_on, created_by) values ('QQ4CD4', 'x', '2026-11-21', '2026-11-21', 'k@t.co')`, null, "view_key|null");
  await refused(`update sm_market_events set view_key = 'ABCD0123' where id = $1`, [ev.id]);
  await refused(`update sm_market_events set view_key = 'ABC' where id = $1`, [ev.id]);
});

test("the roster: a team at the same event, a jersey number, no names", async () => {
  await refused(`insert into sm_market_teams (event_id, name) values ($1, 'LIGHTNING')`, [ev.id], "sm_market_teams_name_idx|duplicate");
  await refused(`insert into sm_market_athletes (event_id, team_id, jersey) values ($1, $2, '7')`, [ev.id, team.id], "unique|duplicate");
  await refused(`insert into sm_market_athletes (event_id, team_id, jersey) values ($1, $2, 'A7')`, [ev.id, team.id]);
  // A team from another event can't be used.
  await refused(`insert into sm_market_athletes (event_id, team_id, jersey) values ($1, $2, '9')`, [ev.id, team2.id], "foreign key");
  await refused(`update sm_market_athletes set keep_out = true where id = $1`, [athlete.id], "sm_market_athletes_keep_out_chk");
  const cols = (await q(`select column_name from information_schema.columns where table_schema = $1 and table_name = 'sm_market_athletes'`, [S])).rows.map((r) => r.column_name);
  assert.ok(!cols.some((c) => /name|birth|school|email|phone/.test(c)), "the roster has no place for a name or contact: " + cols.join(","));
});

test("consent: a plain email, a real choice, never public under 13, staff records confirmed", async () => {
  const c = await one(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band, confirm_hash) values ($1, 'dana@example.com', 'sell', false, '16_17', $2) returning *`, [athlete.id, H("a")]);
  assert.equal(c.source, "qr");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'dana@example.com', 'family', false, '16_17')`, [athlete.id], "unique|duplicate");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'Pat@Example.com', 'family', false, '16_17')`, [athlete.id]);
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'pat@example.com', 'everything', false, '16_17')`, [athlete.id]);
  // 12 or younger: family only or kept out.
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'pat@example.com', 'public', true, 'u13')`, [athlete.id], "sm_market_consents_u13_chk");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'pat@example.com', 'sell', true, 'u13')`, [athlete.id], "sm_market_consents_u13_chk");
  // The age band and the flag agree, and a band is always given.
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'pat@example.com', 'family', false, 'u13')`, [athlete.id], "sm_market_consents_age_chk");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band) values ($1, 'pat@example.com', 'family', false, '12')`, [athlete.id]);
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13) values ($1, 'pat@example.com', 'family', false)`, [athlete.id], "age_band|null");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band, source) values ($1, 'pat@example.com', 'sell', false, '16_17', 'staff')`, [athlete.id], "sm_market_consents_staff_chk");
  await refused(`update sm_market_consents set family_hash = $2 where id = $1`, [c.id, H("b")], "sm_market_consents_family_chk");
  await refused(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band, confirm_hash) values ($1, 'other@example.com', 'sell', false, '16_17', $2)`, [athlete.id, H("a")], "sm_market_consents_confirm_idx|duplicate");
  const staff = await one(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band, source, confirmed_at, recorded_by) values ($1, 'pat@example.com', 'family', false, '16_17', 'staff', now(), 'kyron@toj.test') returning *`, [athlete.id]);
  assert.ok(staff.confirmed_at);
  // A pending change: whole, with its link, keeping the 12-or-younger rule, never a keep-out (that counts at once).
  await refused(`update sm_market_consents set pending_level = 'sell', pending_under_13 = false, pending_age_band = '16_17' where id = $1`, [staff.id], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'sell', confirm_hash = $2 where id = $1`, [staff.id, H("e")], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'sell', pending_under_13 = false, confirm_hash = $2 where id = $1`, [staff.id, H("e")], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'public', pending_under_13 = true, pending_age_band = 'u13', confirm_hash = $2 where id = $1`, [staff.id, H("e")], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'sell', pending_under_13 = true, pending_age_band = 'u13', confirm_hash = $2 where id = $1`, [staff.id, H("e")], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'sell', pending_under_13 = false, pending_age_band = 'u13', confirm_hash = $2 where id = $1`, [staff.id, H("e")], "sm_market_consents_pending_chk");
  await refused(`update sm_market_consents set pending_level = 'out', pending_under_13 = false, pending_age_band = '16_17', confirm_hash = $2 where id = $1`, [staff.id, H("e")]);
  await q(`update sm_market_consents set pending_level = 'public', pending_under_13 = false, pending_age_band = '18_plus', confirm_hash = $2 where id = $1`, [staff.id, H("e")]);
  // A row saying 12 or younger can wait on an older answer, holding family only meanwhile.
  await q(`insert into sm_market_consents (athlete_id, email, level, under_13, age_band, pending_level, pending_under_13, pending_age_band, confirm_hash) values ($1, 'kim@example.com', 'family', true, 'u13', 'public', false, '18_plus', $2)`, [athlete.id, H("f")]);
});

test("media: a key in the event's folder, ready only with a preview, approved by someone", async () => {
  await refused(`insert into sm_market_media (event_id, kind, object_key, uploaded_by) values ($1, 'clip', '../../etc/passwd', 'crew@toj.test')`, [ev.id]);
  await refused(`insert into sm_market_media (event_id, kind, object_key, uploaded_by) values ($1, 'clip', $2, 'crew@toj.test')`, [ev.id, media.object_key], "unique|duplicate");
  await refused(`insert into sm_market_media (event_id, kind, object_key, uploaded_by) values ($1, 'clip', $2, 'crew@toj.test')`, [ev.id, `events/${ev.id}/originals/x.exe`]);
  await refused(`update sm_market_media set status = 'review' where id = $1`, [media.id], "sm_market_media_ready_chk");
  const id = media.id;
  await q(`update sm_market_media set status = 'review', preview_key = $2, poster_key = $3 where id = $1`, [id, `events/${ev.id}/previews/${id}.mp4`, `events/${ev.id}/previews/${id}-poster.jpg`]);
  await refused(`update sm_market_media set status = 'approved' where id = $1`, [id], "sm_market_media_approved_chk");
  await refused(`update sm_market_media set status = 'approved', approved_at = now(), approved_by = 'kyron@toj.test' where id = $1`, [id], "sm_market_media_approved_chk");
  await q(`update sm_market_media set status = 'approved', approved_at = now(), approved_by = 'kyron@toj.test', everyone_tagged_at = now(), everyone_tagged_by = 'kyron@toj.test' where id = $1`, [id]);
  await refused(`update sm_market_media set status = 'sold' where id = $1`, [id]);
});

test("tags: the clip and the athlete at the same event; confirmed by someone", async () => {
  await q(`insert into sm_market_tags (media_id, athlete_id, event_id, source, confidence) values ($1, $2, $3, 'ai', 0.91)`, [media.id, athlete.id, ev.id]);
  await refused(`insert into sm_market_tags (media_id, athlete_id, event_id, source) values ($1, $2, $3, 'staff')`, [media.id, athlete.id, ev.id], "duplicate|pkey");
  await refused(`update sm_market_tags set confirmed = true where media_id = $1`, [media.id], "sm_market_tags_confirmed_chk");
  await refused(`update sm_market_tags set confidence = 1.5 where media_id = $1`, [media.id]);
  const other = await one(`insert into sm_market_athletes (event_id, team_id, jersey) values ($1, $2, '3') returning *`, [ev2.id, team2.id]);
  await refused(`insert into sm_market_tags (media_id, athlete_id, event_id, source) values ($1, $2, $3, 'staff')`, [media.id, other.id, ev.id], "foreign key");
  await refused(`insert into sm_market_tags (media_id, athlete_id, event_id, source) values ($1, $2, $3, 'staff')`, [media.id, other.id, ev2.id], "foreign key");
  await q(`update sm_market_tags set confirmed = true, confirmed_by = 'crew@toj.test', confirmed_at = now() where media_id = $1`, [media.id]);
});

test("orders: paid means a checkout and a time; a sold item can't be deleted", async () => {
  const o = await one(`insert into sm_market_orders (event_id, amount_cents, token_hash) values ($1, 1200, $2) returning *`, [ev.id, H("c")]);
  await refused(`update sm_market_orders set status = 'paid' where id = $1`, [o.id], "sm_market_orders_paid_chk");
  await q(`update sm_market_orders set status = 'paid', paid_at = now(), stripe_session_id = 'cs_test_abcdefgh123' where id = $1`, [o.id]);
  await refused(`update sm_market_orders set stripe_payment_intent = 'ch_123456789' where id = $1`, [o.id]);
  await q(`update sm_market_orders set stripe_payment_intent = 'pi_test_abcdefgh123', status = 'refunded' where id = $1`, [o.id]);
  await q(`update sm_market_orders set status = 'paid' where id = $1`, [o.id]);
  await refused(`insert into sm_market_orders (event_id, amount_cents, token_hash) values ($1, 1200, $2)`, [ev.id, H("c")], "unique|duplicate");
  await refused(`insert into sm_market_orders (event_id, amount_cents, token_hash) values ($1, 10, $2)`, [ev.id, H("d")]);
  await q(`insert into sm_market_order_items (order_id, media_id, price_cents) values ($1, $2, 1200)`, [o.id, media.id]);
  await refused(`delete from sm_market_media where id = $1`, [media.id], "foreign key");
  await refused(`delete from sm_market_events where id = $1`, [ev.id], "foreign key");
});

test("the API roles can't read any of it", async () => {
  for (const t of ["sm_market_events", "sm_market_athletes", "sm_market_consents", "sm_market_media", "sm_market_orders"]) {
    const r = await one(`select has_table_privilege('anon', '${S}.${t}', 'select') as anon, has_table_privilege('authenticated', '${S}.${t}', 'select') as auth, (select relrowsecurity from pg_class where oid = '${S}.${t}'::regclass) as rls`);
    assert.deepEqual(r, { anon: false, auth: false, rls: true }, t);
  }
});
