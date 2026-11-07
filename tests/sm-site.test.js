// subjectmedias.com's own counts (routes/sm-site.js, migration 034): visits
// and taps as daily totals, and the staff view of the last 7 and 30 days.
//
//   node --test tests/sm-site.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_EMAILS = "kyron@toj.test";

const express = require("express");
const session = require("express-session");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const router = require("../routes/sm-site");

let server, base, db, counted, calls;
// Counts add up in the server and go to the database once a minute; the tests
// send them on now.
const wait = async () => { await new Promise((r) => setTimeout(r, 20)); await router._flush(); };
async function call(method, path, headers = {}, body) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get("set-cookie") };
}
// What a browser's sendBeacon sends: a POST, no body, its own user agent.
const BROWSER = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const beacon = (e, visitor = "203.0.113.5", ua = BROWSER) => call("POST", "/api/sm/site/count?e=" + encodeURIComponent(e), { "X-Forwarded-For": visitor, "User-Agent": ua });
async function staffCookie() {
  const r = await call("POST", "/__test/session", {}, { email: "kyron@toj.test", role: "staff" });
  return r.cookie.split(";")[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "sm-site-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    res.json({ ok: true });
  });
  app.use("/api/sm/site", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); setSupabase(null); });
beforeEach(() => {
  router._reset();
  counted = [];
  calls = [];
  db = fakeSupabase({ sm_site_counts: [], sm_bookings: [] }, { rpc: { sm_site_count: (_t, args) => { calls.push(args); for (let i = 0; i < args.p_n; i++) counted.push(args.p_name); return { data: null, error: null }; } } });
  setSupabase(db);
});

test("each page and tap counts once, by name; anything else doesn't, and the answer is the same", async () => {
  for (const e of router.NAMES) assert.equal((await beacon(e)).status, 204);
  for (const e of ["", "admin", "visit_home ", "book_open;drop", "constructor"]) assert.equal((await beacon(e)).status, 204);
  assert.equal((await call("POST", "/api/sm/site/count?e=visit_home&e=book_open", { "User-Agent": BROWSER })).status, 204);
  await wait();
  assert.deepEqual(counted, [...router.NAMES]);
});

test("only browsers count: scripts, and crawlers that say what they are, don't", async () => {
  for (const ua of ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1", "Mozilla/5.0 HeadlessChrome/131.0", "curl/8.5.0", "python-requests/2.32", "node", ""]) {
    await beacon("visit_home", "203.0.113.5", ua);
  }
  await wait();
  assert.deepEqual(counted, []);
});

test("40 counts per visitor per 10 minutes; another visitor has their own", async () => {
  for (let i = 0; i < 45; i++) await beacon("book_open", "203.0.113.9");
  await beacon("book_open", "198.51.100.3");
  await wait();
  assert.equal(counted.length, 41);
  assert.deepEqual(calls, [{ p_name: "book_open", p_n: 41 }], "one write for the lot");
});

test("someone changing their forwarded-for header still stops at 5,000 an hour of each kind", async () => {
  const sends = [];
  for (let i = 0; i < 5100; i++) sends.push(beacon("buy_tap", "10.0." + (i >> 8) + "." + (i & 255)));
  await Promise.all(sends);
  await beacon("visit_home", "10.9.9.9");
  await wait();
  assert.equal(counted.filter((n) => n === "buy_tap").length, 5000);
  assert.equal(counted.filter((n) => n === "visit_home").length, 1, "other kinds still count");
});

test("a database that doesn't answer loses the minute's counts, nothing else", async () => {
  db = fakeSupabase({}, { rpc: { sm_site_count: () => ({ data: null, error: { message: "down" } }) } });
  setSupabase(db);
  await beacon("visit_home");
  await wait();
  assert.deepEqual(router._pending(), {}, "dropped, not piled up");
});

test("the counts are staff only", async () => {
  assert.equal((await call("GET", "/api/sm/site/counts")).status, 401);
});

test("the last 7 and 30 days: the site's taps, plus requests, claims and payments from bookings", async () => {
  const day = (n) => new Date(Date.now() - n * 864e5);
  const nyDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  db.tables.sm_site_counts.push(
    { day: nyDay(day(0)), name: "visit_home", n: 10 },
    { day: nyDay(day(3)), name: "visit_home", n: 5 },
    { day: nyDay(day(12)), name: "visit_home", n: 100 },
    { day: nyDay(day(40)), name: "visit_home", n: 999 },
    { day: nyDay(day(1)), name: "book_open", n: 4 },
    { day: nyDay(day(20)), name: "buy_tap", n: 2 },
    { day: nyDay(day(2)), name: "offer_shown", n: 7 },
    { day: nyDay(day(2)), name: "not_a_count", n: 50 }
  );
  db.tables.sm_bookings.push(
    { created_at: day(1).toISOString(), source: "form", offer: "first10", stripe_session_id: null, notes: null },
    { created_at: day(2).toISOString(), source: "form", offer: null, stripe_session_id: "cs_live_x1234567", notes: "Claimed the 10% first-package offer.\nHi" },
    { created_at: day(15).toISOString(), source: "form", offer: null, stripe_session_id: null, notes: "Claimed it? No." },
    { created_at: day(5).toISOString(), source: "stripe", offer: null, stripe_session_id: "cs_live_y1234567", notes: null }
  );
  // More bookings than one Supabase page holds: every one counts.
  for (let i = 0; i < 1500; i++) db.tables.sm_bookings.push({ created_at: day(8).toISOString(), source: "form", offer: null, stripe_session_id: null, notes: null });
  const cookie = await staffCookie();
  const r = await call("GET", "/api/sm/site/counts", { Cookie: cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.today, nyDay(new Date()));
  assert.deepEqual(r.data.week, { visit_home: 15, visit_fellowship: 0, book_open: 4, offer_shown: 7, buy_tap: 0, requests: 2, claims: 2, paid: 2 });
  assert.deepEqual(r.data.month, { visit_home: 115, visit_fellowship: 0, book_open: 4, offer_shown: 7, buy_tap: 2, requests: 1503, claims: 2, paid: 2 });
});
