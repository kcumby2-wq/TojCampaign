// Migrations 030, 034 and 035 in a real Postgres: the rules the database
// enforces for Subject Medias bookings and the site's counts, so no route bug
// can break them, and the unfinished-checkout reminder's queries run here.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (sm_db_test), which it DROPS and recreates. Never
// point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
const S = "sm_db_test";

if (!URL_) {
  test("sm bookings database rules (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

let pool, creator;
const q = (sql, params) => pool.query(sql, params);
async function refused(sql, params, name) {
  try {
    await q(sql, params);
  } catch (e) {
    if (name) assert.match(e.message + " " + (e.constraint || ""), new RegExp(name), `expected ${name}, got: ${e.message}`);
    return;
  }
  assert.fail(`expected a refusal${name ? " (" + name + ")" : ""}: ${sql}`);
}
const form = (over = {}) => {
  const row = { source: "form", kind: "athlete", contact_name: "Jamie Parent", contact_email: "jamie@example.com", adult_confirmed: true, event_state: "CA", ...over };
  const cols = Object.keys(row);
  return [`insert into sm_bookings (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning *`, Object.values(row)];
};

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${S} cascade; create schema ${S};`);
  for (const r of ["anon", "authenticated", "service_role"])
    await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${S}` });
  // The one table 030 points at (migration 024 makes the real one).
  await q(`create table ${S}.gfs_creators (id uuid primary key default gen_random_uuid(), name text not null)`);
  creator = (await q(`insert into gfs_creators (name) values ('Amy Near') returning *`)).rows[0];
  for (const f of ["030_sm_bookings.sql", "034_sm_bookings_more.sql", "035_sm_checkout_reminder.sql"]) {
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", f), "utf8").replace(/public\./g, `${S}.`);
    await q(sql);
    await q(sql); // safe to run twice
  }
});
after(async () => {
  if (pool) await pool.end();
});

test("a form booking needs an adult who said so and an email; a paid one needs its Stripe checkout", async () => {
  const [ok, args] = form();
  assert.equal((await q(ok, args)).rows[0].status, "new");
  await refused(...form({ adult_confirmed: false }), "sm_bookings_source_chk");
  await refused(...form({ contact_email: null }), "sm_bookings_source_chk");
  // A request paid from the success panel carries its checkout.
  const joined = (await q(...form({ stripe_session_id: "cs_test_abcdefgh123", amount_cents: 13999 }))).rows[0];
  assert.equal(joined.source, "form");
  await refused(...form({ source: "stripe" }), "sm_bookings_source_chk");
  const [paid, pargs] = form({ source: "stripe", adult_confirmed: false, stripe_session_id: "cs_live_abcdefgh123" });
  assert.equal((await q(paid, pargs)).rows[0].source, "stripe");
  await refused(paid, pargs, "stripe_session_id");
  await refused(...form({ source: "form", stripe_session_id: "cs_live_abcdefgh123" }), "stripe_session_id");
  await refused(...form({ source: "stripe", stripe_session_id: "not-a-session" }));
  // A checkout without an email still lands.
  const bare = (await q(...form({ source: "stripe", adult_confirmed: false, stripe_session_id: "cs_live_noemail1234", contact_email: null }))).rows[0];
  assert.equal(bare.contact_email, null);
});

test("contact and place stay in shape", async () => {
  await refused(...form({ contact_email: "Jamie@Example.com" }));
  await refused(...form({ contact_email: "x@y.co?cc=thief%40evil.example" }));
  await refused(...form({ contact_email: "x y@z.co" }));
  assert.ok((await q(...form({ contact_email: "o'brien+games@example.co.uk" }))).rows[0].id);
  await refused(...form({ amount_cents: 100000000 }));
  await refused(...form({ amount_cents: -1 }));
  await refused(...form({ event_state: "California" }));
  await refused(...form({ region: "mars" }));
  await refused(...form({ athletes: 0 }));
  await refused(...form({ contact_phone: "12" }));
  await refused(...form({ notes: "x".repeat(1001) }));
  await refused(...form({ kind: "fan" }));
});

test("staffed and delivered name the creator, who then can't be deleted", async () => {
  const b = (await q(...form())).rows[0];
  await refused(`update sm_bookings set status = 'staffed' where id = $1`, [b.id], "sm_bookings_staffed_chk");
  await q(`update sm_bookings set status = 'staffed', staffed_creator_id = $2 where id = $1`, [b.id, creator.id]);
  await refused(`update sm_bookings set status = 'won' where id = $1`, [b.id]);
  await refused(`delete from gfs_creators where id = $1`, [creator.id], "staffed_creator_id|foreign key");
  await refused(`update sm_bookings set staffed_creator_id = null where id = $1`, [b.id], "sm_bookings_staffed_chk");
  await q(`update sm_bookings set status = 'cancelled', staffed_creator_id = null where id = $1`, [b.id]);
});

test("the API roles can't read bookings at all", async () => {
  const anon = await q(`select has_table_privilege('anon', '${S}.sm_bookings', 'select') as can`);
  assert.equal(anon.rows[0].can, false);
  const rls = await q(`select relrowsecurity from pg_class where oid = '${S}.sm_bookings'::regclass`);
  assert.equal(rls.rows[0].relrowsecurity, true);
});

test("034: the offer is the homepage's claim or nothing; details and the booker's note are times", async () => {
  const b = (await q(...form({ offer: "first10" }))).rows[0];
  assert.equal(b.offer, "first10");
  assert.equal(b.details_at, null);
  assert.equal(b.booker_emailed_at, null);
  await refused(...form({ offer: "first20" }));
  await refused(...form({ offer: "" }));
  assert.equal((await q(...form())).rows[0].offer, null, "bookings without one are untouched");
});

test("034: the site's counts are daily totals, added a batch at a time, by name only", async () => {
  await q(`select sm_site_count('visit_home')`);
  await q(`select sm_site_count('visit_home', 4)`);
  await q(`select sm_site_count('book_open', 0)`);
  await q(`select sm_site_count('book_open', -50)`);
  const rows = (await q(`select day, name, n from sm_site_counts order by name`)).rows;
  assert.deepEqual(rows.map((r) => [r.name, r.n]), [["book_open", 2], ["visit_home", 5]], "a batch adds its size; nonsense adds one");
  const ny = (await q(`select (now() at time zone 'America/New_York')::date as d`)).rows[0].d;
  assert.equal(rows[0].day.toISOString(), ny.toISOString(), "New York's day");
  await refused(`select sm_site_count('admin')`, [], "sm_site_counts_name_check|check");
  // A day stops at a million.
  await q(`update sm_site_counts set n = 999990 where name = 'book_open'`);
  await q(`select sm_site_count('book_open', 2000000000)`);
  assert.equal((await q(`select n from sm_site_counts where name = 'book_open'`)).rows[0].n, 1000000);
  await q(`select sm_site_count('book_open', 5)`);
  assert.equal((await q(`select n from sm_site_counts where name = 'book_open'`)).rows[0].n, 1000000);
});

test("034: only the server counts; the API roles can't call it or read the counts", async () => {
  const fn = `${S}.sm_site_count(text, integer)`;
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await q(`select has_function_privilege('${role}', '${fn}', 'execute') as can`)).rows[0].can, false, role);
    assert.equal((await q(`select has_table_privilege('${role}', '${S}.sm_site_counts', 'select') as can`)).rows[0].can, false, role);
  }
  assert.equal((await q(`select has_function_privilege('service_role', '${fn}', 'execute') as can`)).rows[0].can, true);
  assert.equal((await q(`select relrowsecurity from pg_class where oid = '${S}.sm_site_counts'::regclass`)).rows[0].relrowsecurity, true);
});

test("035: pay now is a form request's, and only a pay-now request is reminded", async () => {
  const b = (await q(...form())).rows[0];
  assert.equal(b.pay_now, false, "bookings without it are untouched");
  assert.equal(b.checkout_reminded_at, null);
  assert.equal((await q(...form({ pay_now: true }))).rows[0].pay_now, true);
  await refused(...form({ source: "stripe", adult_confirmed: false, stripe_session_id: "cs_live_paynowstripe1", pay_now: true }), "sm_bookings_pay_now_form");
  await refused(`update sm_bookings set checkout_reminded_at = now() where id = $1`, [b.id], "sm_bookings_reminder_pay_now");
  const idx = await q(`select indexdef from pg_indexes where schemaname = $1 and indexname = 'sm_bookings_unfinished_checkout'`, [S]);
  assert.match(idx.rows[0].indexdef, /WHERE \(pay_now AND \(stripe_session_id IS NULL\) AND \(checkout_reminded_at IS NULL\)\)/);
});

test("035: the reminder's queries on real Postgres: one email, claimed once, the claim given back when it can't go", async () => {
  const { pgSupabase } = require("./helpers/pg-supabase");
  const mailer = require("../utils/mailer");
  const router = require("../routes/sm-bookings");
  const sb = pgSupabase(pool, S);
  const sent = [];
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  mailer.setSender(async (m) => { sent.push(m); return { sent: true }; });
  try {
    router._resetLimits();
    await q(`delete from sm_bookings`);
    const day = (await q(`select (current_date + 30)::text as d`)).rows[0].d;
    const add = async (over) => (await q(...form({ package: "video", event_date: day, pay_now: true, ...over }))).rows[0];
    // Due: a pay-now request from 90 minutes ago, unpaid.
    const due = await add({ contact_email: "due@example.com" });
    await q(`update sm_bookings set created_at = now() - interval '90 minutes' where id = $1`, [due.id]);
    assert.deepEqual(await router._remind(sb), { off: "no_webhook_yet" });
    // The webhook joined a payment to a request: reminders are on.
    await add({ contact_email: "joined@example.com", stripe_session_id: "cs_live_joinedpg0001", amount_cents: 9999 });
    // Not due: inside the hour, and three days old.
    const fresh = await add({ contact_email: "fresh@example.com" });
    const stale = await add({ contact_email: "stale@example.com" });
    await q(`update sm_bookings set created_at = now() - interval '3 days' where id = $1`, [stale.id]);
    mailer.setSender(async () => ({ sent: false, reason: "daily_limit" }));
    assert.deepEqual(await router._remind(sb), { sent: 0 });
    assert.equal((await q(`select checkout_reminded_at from sm_bookings where id = $1`, [due.id])).rows[0].checkout_reminded_at, null, "given back");
    mailer.setSender(async (m) => { sent.push(m); return { sent: true }; });
    assert.deepEqual(await router._remind(sb), { sent: 1 });
    assert.deepEqual(sent.map((m) => m.to), [["due@example.com"]]);
    assert.ok(sent[0].text.includes(`client_reference_id=${due.id}`));
    const rows = (await q(`select id, checkout_reminded_at from sm_bookings where id = any($1)`, [[due.id, fresh.id, stale.id]])).rows;
    assert.deepEqual(rows.filter((r) => r.checkout_reminded_at).map((r) => r.id), [due.id]);
    assert.deepEqual(await router._remind(sb), { sent: 0 }, "once");
    // Two servers at once (a second copy of the module: its own run guard
    // and limits), on the same database: the claim lets one email through.
    await q(`update sm_bookings set checkout_reminded_at = null where id = $1`, [due.id]);
    router._resetLimits();
    sent.length = 0;
    const key = require.resolve("../routes/sm-bookings");
    delete require.cache[key];
    const other = require("../routes/sm-bookings");
    assert.notEqual(other, router);
    const both = await Promise.all([router._remind(sb), other._remind(sb)]);
    assert.equal(sent.length, 1, JSON.stringify(both));
    assert.deepEqual(both.map((r) => r.sent).sort(), [0, 1]);
  } finally {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    mailer.setSender(null);
  }
});
