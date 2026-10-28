// Subject Medias bookings: the form's rules, the creators it suggests, what
// alerts may say, and the routes (in-process, on the fake Supabase).
//
//   node --test tests/sm-bookings.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_BOOKINGS_SECRET = "test-secret-0123456789-abcdefgh";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const express = require("express");
const session = require("express-session");
const B = require("../utils/sm-bookings");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const router = require("../routes/sm-bookings");

const NOW = new Date("2026-10-28T15:00:00Z");
const good = (over = {}) => ({
  kind: "athlete",
  package: "video",
  sport: "Girls Flag Football",
  event_name: "Pylon Girls Flag",
  event_date: "2026-11-21",
  event_city: "Los Angeles",
  event_state: "ca",
  athletes: "1",
  team_jersey: "Lightning #11",
  contact_name: "Jamie Parent",
  contact_email: "Jamie@Example.com",
  contact_phone: "(555) 010-2030",
  notes: "Her name is on the roster as #11.",
  adult_confirmed: true,
  ...over,
});

// ── The rules ────────────────────────────────────────────────────────────
test("a good booking passes, cleaned up", () => {
  const { errors, value } = B.normalize(good(), { now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(value.contact_email, "jamie@example.com");
  assert.equal(value.event_state, "CA");
  assert.equal(value.region, "west");
  assert.equal(value.athletes, 1);
  assert.equal(value.package, "video");
});

test("every missing or wrong field is named", () => {
  const { errors } = B.normalize({ kind: "fan", event_date: "next friday", event_state: "ZZ", contact_email: "nope", contact_phone: "12", athletes: "0" }, { now: NOW });
  for (const f of ["kind", "event_date", "event_city", "event_state", "athletes", "contact_name", "contact_email", "contact_phone", "adult_confirmed"]) assert.ok(errors.includes(f), f);
});

test("dates: not in the past (a day's grace), not more than two years out, real days only", () => {
  const at = (d) => B.normalize(good({ event_date: d }), { now: NOW }).errors.includes("event_date");
  assert.equal(at("2026-10-27"), false, "yesterday is fine for time zones behind UTC");
  assert.equal(at("2026-10-26"), true);
  assert.equal(at("2028-11-01"), true);
  assert.equal(at("2026-02-30"), true);
  assert.equal(at("2027-06-01"), false);
});

test("only an adult can book: the box has to be ticked", () => {
  assert.ok(B.normalize(good({ adult_confirmed: false }), { now: NOW }).errors.includes("adult_confirmed"));
  assert.deepEqual(B.normalize(good({ adult_confirmed: "on" }), { now: NOW }).errors, []);
});

test("an unknown package is 'not sure yet', not an error", () => {
  const { errors, value } = B.normalize(good({ package: "platinum" }), { now: NOW });
  assert.deepEqual(errors, []);
  assert.equal(value.package, "unsure");
});

test("every state has a region", () => {
  assert.equal(B.regionFor("CA"), "west");
  assert.equal(B.regionFor("tx"), "south_central");
  assert.equal(B.regionFor("NJ"), "northeast");
  assert.equal(B.regionFor("DC"), "northeast");
  assert.equal(B.regionFor("OH"), "midwest");
  assert.equal(B.regionFor("FL"), "southeast");
  assert.equal(Object.keys(B.STATE_REGION).length, 51);
});

test("screened means all three checks, each under a year old on the game's date", () => {
  const c = { contract_signed_on: "2026-01-10", background_check_on: "2026-01-10", safety_training_on: "2026-01-10" };
  assert.equal(B.screened(c, "2026-11-21"), true);
  assert.equal(B.screened(c, "2027-02-01"), false, "a year and more by the game");
  assert.equal(B.screened({ ...c, safety_training_on: null }, "2026-11-21"), false);
  assert.equal(B.screened({ ...c, contract_signed_on: "2026-12-01" }, "2026-11-21"), false, "signed after the game");
});

const ok = { contract_signed_on: "2026-06-01", background_check_on: "2026-06-01", safety_training_on: "2026-06-01" };
const pool = [
  { id: "a", name: "Zed Far", home_city: "San Diego", region: "west", tier: "adult", status: "active", ...ok },
  { id: "b", name: "Amy Near", home_city: "Los Angeles", region: "west", tier: "adult", status: "active", ...ok },
  { id: "c", name: "Bo Young", home_city: "Los Angeles", region: "west", tier: "youth", status: "active", ...ok },
  { id: "d", name: "Cy Unscreened", home_city: "Los Angeles", region: "west", tier: "adult", status: "active" },
  { id: "e", name: "Paused", home_city: "Los Angeles", region: "west", tier: "adult", status: "paused", ...ok },
  { id: "f", name: "Texan", home_city: "Dallas", region: "south_central", tier: "adult", status: "active", ...ok },
];

test("suggestions: the region's active creators, same city first, screened next, adults before youth", () => {
  const booking = B.normalize(good(), { now: NOW }).value;
  const { crew } = B.rankCreators(booking, pool, []);
  assert.deepEqual(crew.map((c) => c.id), ["b", "c", "d", "a"]);
  assert.equal(crew.find((c) => c.id === "d").screened, false);
  assert.equal(crew.find((c) => c.id === "c").tier, "youth");
});

test("suggestions: creators with a live page whose area names the city or state", () => {
  const booking = B.normalize(good(), { now: NOW }).value;
  const club = [
    { slug: "la-shots", brand_name: "LA Shots", location: "Los Angeles, CA", status: "active", page_status: "live" },
    { slug: "socal", brand_name: "SoCal Media", location: "Orange County, CA", status: "active", page_status: "live" },
    { slug: "draft", brand_name: "Draft", location: "Los Angeles, CA", status: "draft", page_status: "live" },
    { slug: "nope", brand_name: "Not Live", location: "Los Angeles, CA", status: "active", page_status: "requested" },
    { slug: "vegas", brand_name: "Vegas", location: "Las Vegas, NV", status: "active", page_status: "live" },
    { slug: "cab", brand_name: "Cabin", location: "Cabo", status: "active", page_status: "live" },
  ];
  assert.deepEqual(B.rankCreators(booking, [], club).pages.map((p) => p.slug), ["la-shots", "socal"]);
});

test("a push names the job, never the people", () => {
  const b = { id: "x1", ...B.normalize(good(), { now: NOW }).value, source: "form" };
  const p = B.pushPayload(b, 2);
  const all = JSON.stringify(p);
  for (const secret of ["Jamie", "jamie@example.com", "555", "Lightning", "#11", "roster"]) assert.ok(!all.includes(secret), secret);
  assert.equal(p.url, "/app/#booking/x1");
  assert.match(p.body, /Video coverage · Girls Flag Football · Los Angeles, CA · Nov 21, 2026 · 2 creators in the region/);
  assert.match(B.pushPayload({ ...b, region: null }, 0).body, /no place given/);
});

test("the staff email has the booker's contact, not the notes or the athlete", () => {
  const b = { id: "x1", ...B.normalize(good(), { now: NOW }).value, source: "form" };
  const crew = B.rankCreators(b, pool, []).crew;
  const { subject, text } = B.emailText(b, { crew, pages: [] }, "https://tojcampaign.com/");
  assert.equal(subject, "New booking: Video coverage, Los Angeles, CA, Nov 21, 2026");
  assert.match(text, /Booked by: Jamie Parent, jamie@example.com, \(555\) 010-2030/);
  assert.match(text, /When: Sat, Nov 21, 2026/);
  assert.match(text, /Bo Young \(Los Angeles; youth, needs a screened adult; screened\)/);
  assert.match(text, /https:\/\/tojcampaign.com\/app\/#booking\/x1/);
  assert.ok(!text.includes("roster") && !text.includes("Lightning"));
});

test("a paid package: the session id is required, the rest is best effort", () => {
  assert.ok(B.normalizePaid({ contact_email: "a@b.co" }).errors.includes("stripe_session_id"));
  const { errors, value } = B.normalizePaid({ stripe_session_id: "cs_live_abc12345", package: "team", amount_cents: 39900, contact_email: "Coach@Team.org", event_state: "tx" });
  assert.deepEqual(errors, []);
  assert.equal(value.kind, "team");
  assert.equal(value.contact_name, "Stripe customer");
  assert.equal(value.region, "south_central");
  assert.equal(value.source, "stripe");
});

// ── The routes ───────────────────────────────────────────────────────────
let server, base, db, pushes, mails;
const wait = () => new Promise((r) => setTimeout(r, 60));
async function call(method, path, body, headers = {}, cookie) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get("set-cookie") };
}
async function staffCookie() {
  const r = await call("POST", "/__test/session", { email: "kyron@toj.test", role: "staff" });
  return r.cookie.split(";")[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "sm-bookings-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    res.json({ ok: true });
  });
  app.use("/api/sm/bookings", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  push.setSender(async (sub, payload) => { pushes.push({ to: sub.email, payload }); return {}; });
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
});
after(() => { server && server.close(); push.setSender(null); mailer.setSender(null); setSupabase(null); });
beforeEach(() => {
  router._resetLimits();
  pushes = [];
  mails = [];
  db = fakeSupabase({
    gfs_creators: pool.map((c) => ({ ...c })),
    creators: [],
    push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }],
  });
  setSupabase(db);
});

test("the form saves a booking and alerts staff by push and email", async () => {
  const r = await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 200);
  assert.ok(r.data.id);
  const row = db.tables.sm_bookings[0];
  assert.equal(row.source, "form");
  assert.equal(row.region, "west");
  await wait();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, "kyron@toj.test");
  assert.ok(!JSON.stringify(pushes[0].payload).includes("Jamie"));
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["kyron@toj.test"]);
  assert.match(mails[0].text, /Amy Near/);
  assert.ok(db.tables.sm_bookings[0].alerted_at, "the row notes when the alert went");
  assert.equal(db.tables.sm_bookings[0].matches.length, 4);
});

test("a bot that fills the hidden field gets a polite yes and nothing is stored", async () => {
  const r = await call("POST", "/api/sm/bookings", good({ company: "Spam LLC" }));
  assert.equal(r.status, 200);
  assert.equal((db.tables.sm_bookings || []).length, 0);
});

test("a bad form names its fields; nothing is stored", async () => {
  const r = await call("POST", "/api/sm/bookings", { kind: "athlete" });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.includes("contact_email"));
  assert.equal((db.tables.sm_bookings || []).length, 0);
});

test("eight bookings per address per ten minutes, counted by the visitor's address", async () => {
  const from = (ip) => ({ "X-Vercel-Forwarded-For": ip });
  for (let i = 0; i < 8; i++) assert.equal((await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }), from("203.0.113.7"))).status, 200);
  assert.equal((await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }), from("203.0.113.7"))).status, 429);
  assert.equal((await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }), from("198.51.100.4"))).status, 200, "someone else isn't blocked");
});

test("database down: the booking goes to staff by email whole, so it isn't lost", async () => {
  setSupabase(false);
  const r = await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.id, null);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /not saved/);
  assert.match(mails[0].text, /Team and jersey: Lightning #11/);
});

test("database down and no email: the site is told, so it can show the address", async () => {
  setSupabase(false);
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  const r = await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }));
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  assert.equal(r.status, 503);
});

test("paid: only the site's webhook, with the shared secret; a retry is a no-op", async () => {
  db = fakeSupabase({ gfs_creators: [], creators: [], push_subscriptions: [] }, { unique: { sm_bookings: ["stripe_session_id"] } });
  setSupabase(db);
  const body = { stripe_session_id: "cs_live_abc12345", package: "video", amount_cents: 9999, contact_email: "buyer@example.com" };
  assert.equal((await call("POST", "/api/sm/bookings/paid", body)).status, 401);
  assert.equal((await call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": "wrong-secret-0123456789-abcdefgh" })).status, 401);
  const first = await call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": process.env.SM_BOOKINGS_SECRET });
  assert.equal(first.status, 200);
  const again = await call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": process.env.SM_BOOKINGS_SECRET });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(db.tables.sm_bookings.length, 1);
  assert.equal(db.tables.sm_bookings[0].amount_cents, 9999);
});

test("the list and a booking are staff only", async () => {
  await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }));
  assert.equal((await call("GET", "/api/sm/bookings")).status, 401);
  const cookie = await staffCookie();
  const list = await call("GET", "/api/sm/bookings", undefined, {}, cookie);
  assert.equal(list.status, 200);
  assert.equal(list.data.bookings.length, 1);
  assert.ok(!("contact_email" in list.data.bookings[0]), "the list carries no contact");
  const one = await call("GET", "/api/sm/bookings/" + list.data.bookings[0].id, undefined, {}, cookie);
  assert.equal(one.data.booking.contact_name, "Jamie Parent");
  assert.equal(one.data.matches.crew[0].id, "b");
  assert.equal((await call("GET", "/api/sm/bookings/not-a-uuid", undefined, {}, cookie)).status, 404);
});

test("staffing names an active creator; closed bookings leave the open list", async () => {
  const made = await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }));
  const id = made.data.id;
  db.tables.sm_bookings[0].id = "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01";
  const real = "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01";
  assert.ok(id);
  const cookie = await staffCookie();
  assert.equal((await call("PATCH", "/api/sm/bookings/" + real, { status: "staffed" }, {}, cookie)).data.error, "creator_required");
  assert.equal((await call("PATCH", "/api/sm/bookings/" + real, { status: "won" }, {}, cookie)).data.error, "invalid_status");
  assert.equal((await call("PATCH", "/api/sm/bookings/" + real, { staffed_creator_id: "e" }, {}, cookie)).data.error, "creator_not_active");
  const staffed = await call("PATCH", "/api/sm/bookings/" + real, { staffed_creator_id: "b" }, {}, cookie);
  assert.equal(staffed.status, 200);
  assert.equal(staffed.data.booking.status, "staffed");
  assert.equal(staffed.data.booking.status_by, "kyron@toj.test");
  await call("PATCH", "/api/sm/bookings/" + real, { status: "delivered" }, {}, cookie);
  assert.equal((await call("GET", "/api/sm/bookings", undefined, {}, cookie)).data.bookings.length, 0);
  assert.equal((await call("GET", "/api/sm/bookings?all=1", undefined, {}, cookie)).data.bookings.length, 1);
});
