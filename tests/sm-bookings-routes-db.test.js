// The bookings routes on a real Postgres (tests/helpers/pg-supabase.js): the
// app before migration 035 is applied, and the unfinished-checkout reminder's
// queries and claim after it.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schemas (gfs_smroutes_pre_test, gfs_smroutes_test), which
// it DROPS and recreates. Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test("sm bookings routes on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_BOOKINGS_SECRET = "test-secret-0123456789-abcdefgh";
const express = require("express");
const session = require("express-session");
const { setSupabase } = require("../utils/supabase");
const { pgSupabase } = require("./helpers/pg-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const router = require("../routes/sm-bookings");

const SECRET = process.env.SM_BOOKINGS_SECRET;
const PRE = "gfs_smroutes_pre_test", FULL = "gfs_smroutes_test";
const pools = {};
let server, base, mails = [];
const wait = () => new Promise((r) => setTimeout(r, 80));
async function call(method, p, body, headers = {}, cookie) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get("set-cookie") };
}
const good = (over = {}) => ({ kind: "athlete", package: "video", sport: "Football", event_date: "2027-01-16", event_city: "Dallas", event_state: "TX", contact_name: "Pat Parent", contact_email: "pat@example.com", adult_confirmed: true, ...over });
const form = (body, visitor = "203.0.113.7") => call("POST", "/api/sm/bookings", body, { "X-SM-Secret": SECRET, "X-SM-Visitor": visitor });
const staff = async () => (await call("POST", "/__test/session", {})).cookie.split(";")[0];

async function schema(name, files) {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${name} cascade; create schema ${name};`);
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  const pool = new Pool({ connectionString: URL_, options: `-c search_path=${name} -c timezone=UTC`, max: 6 });
  await pool.query(`create table ${name}.gfs_creators (id uuid primary key default gen_random_uuid(), name text not null, status text, region text, home_city text, tier text, contract_signed_on date, background_check_on date, safety_training_on date, age_checked_on date, guardian_email text)`);
  await pool.query(`create table ${name}.creators (id uuid primary key default gen_random_uuid(), slug text, brand_name text, location text, status text, page_status text)`);
  await pool.query(`create table ${name}.push_subscriptions (id uuid primary key default gen_random_uuid(), email text, endpoint text, p256dh text, auth text, kind text, fail_count int default 0)`);
  for (const f of files) await pool.query(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", f), "utf8").replace(/public\./g, `${name}.`));
  return pool;
}

before(async () => {
  pools[PRE] = await schema(PRE, ["030_sm_bookings.sql", "034_sm_bookings_more.sql"]);
  pools[FULL] = await schema(FULL, ["030_sm_bookings.sql", "034_sm_bookings_more.sql", "035_sm_checkout_reminder.sql"]);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "sm-routes-db", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = "kyron@toj.test"; req.session.userRole = "staff"; res.json({ ok: true }); });
  app.use("/api/sm/bookings", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  push.setSender(async () => ({}));
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
});
after(async () => {
  server && server.close();
  push.setSender(null);
  mailer.setSender(null);
  setSupabase(null);
  router._setStripe(null);
  for (const [name, pool] of Object.entries(pools)) {
    await pool.query(`drop schema if exists ${name} cascade`);
    await pool.end();
  }
});

test("before migration 035: a pay-now request still lands (without the flag), and the list still works", async () => {
  setSupabase(pgSupabase(pools[PRE], PRE));
  router._resetLimits();
  mails = [];
  const r = await form(good({ pay_now: true }));
  assert.equal(r.status, 200);
  assert.ok(r.data.id, "saved, so the checkout carries its id");
  await wait();
  const row = (await pools[PRE].query(`select * from sm_bookings where id = $1`, [r.data.id])).rows[0];
  assert.ok(row && !("pay_now" in row));
  assert.ok(!mails.some((m) => /not saved/.test(m.subject)), "no fallback email");
  const list = await call("GET", "/api/sm/bookings", undefined, {}, await staff());
  assert.equal(list.status, 200);
  assert.ok(list.data.bookings.find((b) => b.id === r.data.id));
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  process.env.SM_STRIPE_READ_KEY = "rk_live_" + "a".repeat(24);
  try {
    assert.deepEqual(await router._remind(pgSupabase(pools[PRE], PRE)), { off: "no_migration" }, "the reminder waits, quietly");
  } finally {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    delete process.env.SM_STRIPE_READ_KEY;
  }
});

test("after 035: one reminder, Stripe asked first, claimed once even with two servers at once", async () => {
  const pool = pools[FULL];
  const sb = pgSupabase(pool, FULL);
  setSupabase(sb);
  router._resetLimits();
  const sessions = [];
  router._setStripe(() => ({ checkout: { sessions: { list: async () => ({ data: sessions, has_more: false }) } } }));
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  process.env.SM_STRIPE_READ_KEY = "rk_live_" + "a".repeat(24);
  try {
    const due = await form(good({ pay_now: true, contact_email: "due@example.com" }), "198.51.100.1");
    const clearing = await form(good({ pay_now: true, contact_email: "bank@example.com" }), "198.51.100.2");
    const fresh = await form(good({ pay_now: true, contact_email: "fresh@example.com" }), "198.51.100.3");
    await wait();
    assert.equal((await pool.query(`select pay_now from sm_bookings where id = $1`, [due.data.id])).rows[0].pay_now, true);
    await pool.query(`update sm_bookings set created_at = now() - interval '90 minutes' where id = any($1)`, [[due.data.id, clearing.data.id]]);
    // A bank payment still clearing: complete at Stripe, unknown to the app.
    sessions.push({ id: "cs_live_clearing00001", status: "complete", payment_status: "unpaid", client_reference_id: clearing.data.id, payment_link: "plink_x", metadata: {}, created: Math.floor(Date.now() / 1000) });
    mails = [];
    const key = require.resolve("../routes/sm-bookings");
    delete require.cache[key];
    const other = require("../routes/sm-bookings");
    other._setStripe(() => ({ checkout: { sessions: { list: async () => ({ data: sessions, has_more: false }) } } }));
    other._notePayNowVisitor(due.data.id, "198.51.100.1");
    other._notePayNowVisitor(clearing.data.id, "198.51.100.2");
    const both = await Promise.all([router._remind(sb), other._remind(sb)]);
    other._setStripe(null);
    const sent = mails.filter((m) => m.subject === "Subject Medias: finish your booking");
    assert.equal(sent.length, 1, JSON.stringify(both));
    assert.deepEqual(sent[0].to, ["due@example.com"]);
    assert.deepEqual(both.map((x) => x.sent).sort(), [0, 1]);
    const rows = (await pool.query(`select id, checkout_reminded_at from sm_bookings where id = any($1)`, [[due.data.id, clearing.data.id, fresh.data.id]])).rows;
    assert.deepEqual(rows.filter((x) => x.checkout_reminded_at).map((x) => x.id), [due.data.id]);
    assert.deepEqual(await router._remind(sb), { sent: 0 }, "once");
  } finally {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    delete process.env.SM_STRIPE_READ_KEY;
    router._setStripe(null);
  }
});
