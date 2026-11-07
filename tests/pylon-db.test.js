// Migration 036 on a real Postgres: what pylon_requests and pylon_newsletter
// refuse, that the API roles are shut out, and the routes' writes (a request,
// a payment arriving twice at once, a hand-marked payment racing Stripe, a
// second payment, a monthly plan's changes, a delete, the newsletter's link)
// through tests/helpers/pg-supabase.js.
//
// Needs a throwaway Postgres: TEST_DATABASE_URL=postgres://… node --test tests/
// Works in its own schema (gfs_pylon_test), which it DROPS and recreates.
// Never point it at a real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const URL_ = process.env.TEST_DATABASE_URL;
if (!URL_) {
  test("migration 036 on Postgres (skipped: set TEST_DATABASE_URL to a throwaway Postgres)", { skip: true }, () => {});
  return;
}

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.PYLON_STRIPE_WEBHOOK_SECRET = "whsec_test_pylon_db_0123456789";
const express = require("express");
const session = require("express-session");
const Stripe = require("stripe");
const { setSupabase } = require("../utils/supabase");
const { pgSupabase } = require("./helpers/pg-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const PS = require("../utils/pylon-stripe");
const U = require("../utils/pylon");
const router = require("../routes/pylon");

const NAME = "gfs_pylon_test";
let pool, server, base, mails = [];
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), cookie: r.headers.get("set-cookie") };
}
const staff = async () => (await call("POST", "/__test/session", {})).cookie.split(";")[0];
const refused = (p) => p.then(() => false, (e) => /violates|invalid input/.test(e.message));
const helper = new Stripe("sk_test_helper_only");
function signed(event) {
  const payload = JSON.stringify(event);
  return call("POST", "/api/pylon/stripe/webhook", payload, { "Stripe-Signature": helper.webhooks.generateTestHeaderString({ payload, secret: process.env.PYLON_STRIPE_WEBHOOK_SECRET }) });
}
let n = 0;
const expired = [];
// Live, as the public meets it (test mode is for staff only).
const fakeStripe = {
  mode: "live",
  stripe: {
    checkout: {
      sessions: {
        create: async () => { n += 1; const id = "cs_live_db" + String(n).padStart(8, "0"); return { id, url: "https://checkout.stripe.com/c/pay/" + id }; },
        expire: async (id) => { expired.push(id); return { id, status: "expired" }; },
      },
    },
    promotionCodes: { list: async () => ({ data: [] }) },
  },
};
// A form as the page sends it, with the consent words it showed.
const withWords = (f) => ({ ...f, consent_words: U.consentText(f.kind, f.who) });
const player = (over = {}) => withWords({ kind: "player_package", package: "13", who: "parent", consent_confirm: true, athlete_name: "Jordan Ellis", position: "WR", class_year: "2028", team_name: "Elite", event: "Pylon Dallas", contact_name: "Pat Ellis", contact_email: "pat@example.com", ...over });
const paidEvent = (row, over = {}) => ({ id: "evt_" + row.id.slice(0, 8), type: "checkout.session.completed", data: { object: { id: row.checkout_session_id, client_reference_id: row.id, payment_status: "paid", amount_total: row.price_cents, livemode: true, metadata: { kind: "pylon", request_id: row.id }, ...over } } });

before(async () => {
  const admin = new Pool({ connectionString: URL_ });
  await admin.query(`drop schema if exists ${NAME} cascade; create schema ${NAME};`);
  for (const r of ["anon", "authenticated", "service_role"]) await admin.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${r}') then create role ${r} nologin; end if; end $$`);
  await admin.end();
  pool = new Pool({ connectionString: URL_, options: `-c search_path=${NAME} -c timezone=UTC`, max: 6 });
  await pool.query(`create table ${NAME}.push_subscriptions (id uuid primary key default gen_random_uuid(), email text, endpoint text, p256dh text, auth text, kind text, fail_count int default 0, apns_env text)`);
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "036_pylon_requests.sql"), "utf8").replace(/public\./g, `${NAME}.`);
  await pool.query(sql);
  await pool.query(sql); // runs twice without complaint
  setSupabase(pgSupabase(pool, NAME));
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  app.use(session({ secret: "pylon-db", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => { req.session.userEmail = "kyron@toj.test"; req.session.userRole = "staff"; res.json({ ok: true }); });
  app.use("/api/pylon", router);
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
  PS._set(null);
  await pool.query(`drop schema if exists ${NAME} cascade`);
  await pool.end();
});

// A row straight into the table, with the shape the routes write.
const row = (over = {}) => ({
  kind: "player_package", package: "13", package_name: "Pylon Player Story", price_cents: 9900, cadence: "once",
  contact_role: "parent", contact_name: "Pat Ellis", contact_email: "pat@example.com", athlete_name: "Jordan Ellis",
  consent: "parent", consent_text: "I'm the athlete's parent. I agree.", details: {}, ...over,
});
function insert(r) {
  const cols = Object.keys(r);
  return pool.query(`insert into pylon_requests (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")}) returning id`, cols.map((c) => (c === "details" || c === "extra_payments" ? JSON.stringify(r[c]) : r[c])));
}

test("the API roles are shut out of both tables", async () => {
  const { rows } = await pool.query(`select relname, relrowsecurity from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = $1 and relname in ('pylon_requests','pylon_newsletter') order by 1`, [NAME]);
  assert.deepEqual(rows.map((x) => [x.relname, x.relrowsecurity]), [["pylon_newsletter", true], ["pylon_requests", true]]);
  const { rows: grants } = await pool.query(`select grantee from information_schema.role_table_grants where table_schema = $1 and table_name like 'pylon_%' and grantee in ('anon','authenticated')`, [NAME]);
  assert.equal(grants.length, 0);
});

test("an athlete always comes with the consent answer, and the answer names the contact", async () => {
  assert.ok((await insert(row())).rows[0].id);
  assert.ok(await refused(insert(row({ consent: null, consent_text: null }))), "an athlete without consent");
  assert.ok(await refused(insert(row({ consent_text: null }))), "an answer without its words");
  assert.ok(await refused(insert(row({ consent: "adult" }))), "18+ but the contact is a parent");
  assert.ok(await refused(insert(row({ consent: "guardian" }))), "guardian answer, parent contact");
  assert.ok((await insert(row({ consent: "adult", contact_role: "athlete" }))).rows[0].id);
  assert.ok(await refused(insert(row({ kind: "transcript", athlete_name: null, consent: null, consent_text: null }))), "an athlete's kind needs the athlete");
});

test("each kind's shape: a team names no athlete; an application is never priced or paid", async () => {
  const team = { kind: "team_package", package: "1a", package_name: "Pylon Team Recap", contact_role: "coach", athlete_name: null, consent: null, consent_text: null };
  assert.ok((await insert(row(team))).rows[0].id);
  assert.ok(await refused(insert(row({ ...team, athlete_name: "Jordan Ellis", consent: "parent", consent_text: "x" }))));
  assert.ok(await refused(insert(row({ ...team, contact_role: "parent" }))));
  const amb = { kind: "ambassador", package: "standard", package_name: "Pylon Ambassador: Standard", price_cents: null, cadence: null };
  assert.ok((await insert(row(amb))).rows[0].id);
  assert.ok(await refused(insert(row({ ...amb, price_cents: 5000 }))));
  assert.ok(await refused(insert(row({ ...amb, paid_at: new Date(), paid_cents: 0, paid_via: "manual" }))));
});

test("a payment is whole, and one through Stripe is a checkout's", async () => {
  assert.ok(await refused(insert(row({ paid_at: new Date() }))), "when, without how much or how");
  assert.ok(await refused(insert(row({ paid_at: new Date(), paid_cents: 9900, paid_via: "stripe" }))), "Stripe, without a checkout");
  assert.ok(await refused(insert(row({ checkout_session_id: "cs_test_abcdefgh12" }))), "a checkout without its mode");
  assert.ok(await refused(insert(row({ checkout_session_id: "not-a-session", checkout_mode: "test" }))));
  assert.ok((await insert(row({ checkout_session_id: "cs_test_abcdefgh12", checkout_mode: "test", paid_at: new Date(), paid_cents: 9900, paid_via: "stripe" }))).rows[0].id);
  assert.ok(await refused(insert(row({ checkout_session_id: "cs_test_abcdefgh12", checkout_mode: "test" }))), "one request per checkout");
  assert.ok(await refused(insert(row({ extra_payments: {} }))), "further payments are a list");
  assert.ok(await refused(insert(row({ contact_verified_at: new Date() }))), "a check of the contact says who made it");
  assert.ok((await insert(row({ contact_verified_at: new Date(), contact_verified_by: "kyron@toj.test" }))).rows[0].id);
});

test("a monthly plan's subscription is only on a monthly package, by Stripe's names", async () => {
  const monthly = { kind: "recruiting", package: "hbcu_monthly", package_name: "HBCU Premium Concierge", price_cents: 14900, cadence: "month", contact_role: "guardian", consent: "guardian" };
  assert.ok((await insert(row({ ...monthly, stripe_subscription_id: "sub_ABC123456", subscription_status: "past_due" }))).rows[0].id);
  assert.ok(await refused(insert(row({ stripe_subscription_id: "sub_ABC654321", subscription_status: "active" }))), "a one-time package has no plan");
  assert.ok(await refused(insert(row({ ...monthly, stripe_subscription_id: "nope", subscription_status: "active" }))));
  assert.ok(await refused(insert(row({ ...monthly, stripe_subscription_id: "sub_ABC999999", subscription_status: "gone" }))));
});

test("plain lowercase addresses, known statuses, tidy package keys", async () => {
  assert.ok(await refused(insert(row({ contact_email: "Pat@Example.com" }))));
  assert.ok(await refused(insert(row({ contact_email: "x@y.co?cc=a@b.c" }))));
  assert.ok(await refused(insert(row({ status: "paid" }))));
  assert.ok(await refused(insert(row({ package: "13; drop table" }))));
  assert.ok(await refused(insert(row({ details: [] }))), "details are an object");
  assert.ok(await refused(pool.query(`insert into pylon_newsletter (email, unsubscribe_token, status) values ('fan@example.com', $1, 'confirmed')`, ["a".repeat(64)])), "confirmed needs a time");
});

test("the routes on Postgres: a request, its checkout, and a payment delivered twice at once", async () => {
  PS._set(fakeStripe);
  const r = await call("POST", "/api/pylon/requests", player({ public_ok: true }));
  assert.equal(r.status, 200);
  assert.match(r.data.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
  const { rows: [saved] } = await pool.query("select * from pylon_requests where id = $1", [r.data.id]);
  assert.equal(saved.details.public_ok, undefined, "the form never clears public posting");
  assert.equal(saved.consent_text, U.consentText("player_package", "parent"));
  assert.equal(saved.checkout_mode, "live");
  assert.deepEqual(saved.extra_payments, []);
  const ev = paidEvent(saved);
  mails = [];
  const both = await Promise.all([signed(ev), signed(ev)]);
  assert.deepEqual(both.map((x) => x.status), [200, 200]);
  await wait();
  const { rows: [paid] } = await pool.query("select paid_at, paid_cents, paid_via, paid_emailed_at from pylon_requests where id = $1", [saved.id]);
  assert.ok(paid.paid_at && paid.paid_emailed_at);
  assert.equal(paid.paid_via, "stripe");
  assert.equal(mails.filter((m) => /payment received/.test(m.subject)).length, 1, "one receipt note");
  // Staff can't mark it paid again, or take Stripe's payment back.
  const c = await staff();
  assert.equal((await call("PATCH", `/api/pylon/requests/${saved.id}`, { paid: true }, { Cookie: c })).status, 409);
  assert.equal((await call("PATCH", `/api/pylon/requests/${saved.id}`, { paid: false }, { Cookie: c })).status, 409);
});

test("a hand-marked payment and Stripe's arriving together: one of them lands", async () => {
  PS._set(fakeStripe);
  const r = await call("POST", "/api/pylon/requests", { kind: "team_package", package: "1a", contact_name: "Coach Lee", contact_email: "coach@example.com", team_name: "Elite", region: "west" }, { "X-Forwarded-For": "198.51.100.77" });
  const { rows: [saved] } = await pool.query("select * from pylon_requests where id = $1", [r.data.id]);
  const c = await staff();
  const [hook, hand] = await Promise.all([signed(paidEvent(saved)), call("PATCH", `/api/pylon/requests/${saved.id}`, { paid: true }, { Cookie: c })]);
  assert.equal(hook.status, 200);
  assert.ok([200, 409].includes(hand.status));
  const { rows: [after] } = await pool.query("select paid_via, paid_cents, extra_payments from pylon_requests where id = $1", [saved.id]);
  assert.equal(after.paid_via, hand.status === 200 ? "manual" : "stripe", "whoever landed first is the record, and nothing overwrote it");
  assert.equal(after.paid_cents, 29900);
  assert.equal(after.extra_payments.length, hand.status === 200 ? 1 : 0, "Stripe's money after a hand-marked payment is kept on the request");
});

test("a second payment delivered twice at once is recorded once", async () => {
  PS._set(fakeStripe);
  const r = await call("POST", "/api/pylon/requests", player({ contact_email: "second@example.com" }), { "X-Forwarded-For": "198.51.100.78" });
  const c = await staff();
  assert.equal((await call("PATCH", `/api/pylon/requests/${r.data.id}`, { paid: true }, { Cookie: c })).status, 200);
  const { rows: [saved] } = await pool.query("select * from pylon_requests where id = $1", [r.data.id]);
  assert.ok(expired.includes(saved.checkout_session_id), "the open checkout was closed");
  const ev = paidEvent(saved);
  const both = await Promise.all([signed(ev), signed(ev)]);
  assert.ok(both.some((x) => x.status === 200));
  // A delivery that lost the race asks Stripe to send it again; then it's a repeat.
  assert.equal((await signed(ev)).status, 200);
  const { rows: [after] } = await pool.query("select paid_via, extra_payments from pylon_requests where id = $1", [saved.id]);
  assert.equal(after.paid_via, "manual");
  assert.equal(after.extra_payments.length, 1);
  assert.equal(after.extra_payments[0].checkout_session_id, saved.checkout_session_id);
  assert.equal((await call("PATCH", `/api/pylon/requests/${saved.id}`, { paid: false }, { Cookie: c })).data.error, "extra_payments");
  assert.equal((await call("DELETE", `/api/pylon/requests/${saved.id}`, undefined, { Cookie: c })).data.error, "paid_keep");
});

test("a monthly plan on Postgres: the subscription joins the request, and its changes land", async () => {
  PS._set(fakeStripe);
  const r = await call("POST", "/api/pylon/requests", withWords({ kind: "recruiting", package: "standard_monthly", who: "adult", consent_confirm: true, athlete_name: "Alex Brown", contact_email: "alex@example.com", contact_phone: "555-010-2030", position_class: "WR 2027", target_level: "ncaa_d2" }), { "X-Forwarded-For": "198.51.100.79" });
  assert.equal(r.status, 200);
  const { rows: [saved] } = await pool.query("select * from pylon_requests where id = $1", [r.data.id]);
  assert.equal((await signed(paidEvent(saved, { mode: "subscription", subscription: "sub_DB0000001" }))).status, 200);
  const sub = (type, over) => signed({ id: "evt_sub", type, data: { object: { id: "sub_DB0000001", object: "subscription", status: "past_due", metadata: { kind: "pylon", request_id: saved.id }, ...over } } });
  assert.equal((await sub("customer.subscription.updated", {})).status, 200);
  assert.equal((await sub("customer.subscription.deleted", { status: "canceled", ended_at: 1794000000 })).status, 200);
  const { rows: [after] } = await pool.query("select stripe_subscription_id, subscription_status, subscription_ended_at from pylon_requests where id = $1", [saved.id]);
  assert.equal(after.stripe_subscription_id, "sub_DB0000001");
  assert.equal(after.subscription_status, "canceled");
  assert.ok(String(after.subscription_ended_at).startsWith("2026-11-06T21:20:00"), String(after.subscription_ended_at));
});

test("staff delete on Postgres: an unpaid request goes, a paid one stays", async () => {
  const c = await staff();
  const { rows: [{ id: unpaid }] } = await insert(row());
  const { rows: [{ id: paid }] } = await insert(row({ paid_at: new Date(), paid_cents: 9900, paid_via: "manual" }));
  assert.equal((await call("DELETE", `/api/pylon/requests/${unpaid}`, undefined, { Cookie: c })).status, 200);
  assert.equal((await pool.query("select 1 from pylon_requests where id = $1", [unpaid])).rows.length, 0);
  assert.equal((await call("DELETE", `/api/pylon/requests/${paid}`, undefined, { Cookie: c })).status, 409);
  assert.equal((await pool.query("select 1 from pylon_requests where id = $1", [paid])).rows.length, 1);
});

test("the newsletter on Postgres: one row per address, the link works once", async () => {
  mails = [];
  assert.equal((await call("POST", "/api/pylon/newsletter/subscribe", { email: "fan@example.com" }, { "X-Forwarded-For": "203.0.113.90" })).status, 200);
  await wait();
  const token = /confirm=([0-9a-f]{64})/.exec(mails.find((m) => [].concat(m.to).includes("fan@example.com")).text)[1];
  // Twice at once, from elsewhere: still one row.
  router._reset();
  await Promise.all([1, 2].map((i) => call("POST", "/api/pylon/newsletter/subscribe", { email: "fan2@example.com" }, { "X-Forwarded-For": `203.0.113.9${i}` })));
  const { rows } = await pool.query("select email, count(*)::int as n from pylon_newsletter group by email order by email");
  assert.deepEqual(rows, [{ email: "fan2@example.com", n: 1 }, { email: "fan@example.com", n: 1 }]);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token })).status, 200);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token })).status, 404);
  const { rows: [fan] } = await pool.query("select status, confirmed_at, confirm_token_hash from pylon_newsletter where email = 'fan@example.com'");
  assert.equal(fan.status, "confirmed");
  assert.ok(fan.confirmed_at);
  assert.equal(fan.confirm_token_hash, null);
});
