// Subject Medias bookings: the form's rules, the creators it suggests, what
// alerts may say, and the routes (in-process, on the fake Supabase).
//
//   node --test tests/sm-bookings.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

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

const SECRET = process.env.SM_BOOKINGS_SECRET;
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
  assert.equal(value.sport, "Girls Flag Football");
});

test("every missing or wrong field is named", () => {
  const { errors } = B.normalize({ kind: "fan", event_date: "next friday", event_state: "ZZ", contact_email: "nope", contact_phone: "12", athletes: "0" }, { now: NOW });
  for (const f of ["kind", "event_date", "event_city", "event_state", "athletes", "contact_name", "contact_email", "contact_phone", "adult_confirmed"]) assert.ok(errors.includes(f), f);
});

test("odd JSON (objects, arrays, numbers) is treated as missing, never thrown on", () => {
  const evil = { toString: 1, valueOf: 1 };
  const raw = { kind: "athlete", package: evil, sport: evil, event_name: ["x"], event_date: ["2026-11-21"], event_city: evil, event_state: evil, athletes: evil, team_jersey: evil, contact_name: evil, contact_email: {}, contact_phone: evil, notes: evil, adult_confirmed: evil };
  const { errors, value } = B.normalize(raw, { now: NOW });
  for (const f of ["event_date", "event_city", "event_state", "contact_name", "contact_email", "adult_confirmed"]) assert.ok(errors.includes(f), f);
  assert.equal(value.package, "unsure");
  assert.equal(value.sport, null);
  assert.equal(value.athletes, null);
  assert.doesNotThrow(() => B.normalize(null));
  assert.doesNotThrow(() => B.normalize([1, 2]));
  assert.doesNotThrow(() => B.normalizePaid({ stripe_session_id: evil, amount_cents: evil, booking_id: evil, contact_email: evil }));
  assert.equal(B.normalize(good({ athletes: 12 }), { now: NOW }).value.athletes, 12, "a number is still a number");
});

test("control characters go: no NUL reaches Postgres, notes keep their line breaks", () => {
  const { value } = B.normalize(good({ event_city: "Los\u0000 Angeles", notes: "line one\r\nline\u0000 two" }), { now: NOW });
  assert.equal(value.event_city, "Los Angeles");
  assert.equal(value.notes, "line one\nline two");
});

test("emails: a plain address only, nothing that could copy someone into a draft", () => {
  const at = (e) => B.normalize(good({ contact_email: e }), { now: NOW }).errors.includes("contact_email");
  assert.equal(at("x@y.co?cc=thief%40evil.example&bcc=a@b.c"), true);
  assert.equal(at("x@y.co#frag"), true);
  assert.equal(at("a b@c.co"), true);
  assert.equal(at("x/y@z.co"), true);
  assert.equal(at("o'brien+games@example.co.uk"), false);
  assert.equal(at("Coach.K@School.EDU"), false);
});

test("the sport comes from the form's list; anything else is Other", () => {
  assert.equal(B.normalize(good({ sport: "basketball" }), { now: NOW }).value.sport, "Basketball");
  assert.equal(B.normalize(good({ sport: "Jamie Smith #11" }), { now: NOW }).value.sport, "Other");
  assert.equal(B.normalize(good({ sport: "" }), { now: NOW }).value.sport, null);
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
  assert.equal(B.normalize(good({ package: "toString" }), { now: NOW }).value.package, "unsure", "only the package list's own keys");
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

// The Pylon rule (utils/gfs.js credentialProblems), judged on the game's date.
const cleared = { status: "active", tier: "adult", contract_signed_on: "2026-01-10", background_check_on: "2026-01-10", safety_training_on: "2026-01-10", age_checked_on: "2026-01-10" };

test("screened is the Pylon rule: checks within the year before the game, an age check, a guardian for youth", () => {
  assert.equal(B.screened(cleared, "2026-11-21"), true);
  assert.equal(B.screened(cleared, "2027-02-01"), false, "the background check is over a year old by the game");
  assert.equal(B.screened({ ...cleared, safety_training_on: null }, "2026-11-21"), false);
  assert.equal(B.screened({ ...cleared, age_checked_on: null }, "2026-11-21"), false, "nobody works before their age is checked");
  assert.equal(B.screened({ ...cleared, tier: "youth" }, "2026-11-21"), false, "a youth creator needs a guardian of record");
  assert.equal(B.screened({ ...cleared, tier: "youth", guardian_email: "mom@example.com" }, "2026-11-21"), true);
  assert.equal(B.screened({ ...cleared, background_check_on: "2025-11-21", safety_training_on: "2025-11-21" }, "2026-11-21"), true, "a check made exactly a year before still counts");
  assert.equal(B.screened({ ...cleared, contract_signed_on: "2024-03-01" }, "2026-11-21"), true, "a contract doesn't expire");
});

test("only a screened adult can be staffed on a booking", () => {
  assert.deepEqual(B.staffProblems(cleared, "2026-11-21"), []);
  assert.ok(B.staffProblems({ ...cleared, tier: "youth", guardian_email: "mom@example.com" }, "2026-11-21").includes("youth_alone"));
  assert.ok(B.staffProblems({ ...cleared, age_checked_on: null }, "2026-11-21").includes("age_not_checked"));
  assert.ok(B.staffProblems({ ...cleared, status: "paused" }, "2026-11-21").includes("creator_not_active"));
  assert.deepEqual(B.staffProblems(cleared, null), [], "no date: judged on today");
});

const ok = { contract_signed_on: "2026-06-01", background_check_on: "2026-06-01", safety_training_on: "2026-06-01", age_checked_on: "2026-06-01" };
const pool = [
  { id: "a", name: "Zed Far", home_city: "San Diego", region: "west", tier: "adult", status: "active", ...ok },
  { id: "b", name: "Amy Near", home_city: "Los Angeles", region: "west", tier: "adult", status: "active", ...ok },
  { id: "c", name: "Bo Young", home_city: "Los Angeles", region: "west", tier: "youth", status: "active", guardian_email: "guardian@example.com", ...ok },
  { id: "d", name: "Cy Unscreened", home_city: "Los Angeles", region: "west", tier: "adult", status: "active" },
  { id: "e", name: "Paused", home_city: "Los Angeles", region: "west", tier: "adult", status: "paused", ...ok },
  { id: "f", name: "Texan", home_city: "Dallas", region: "south_central", tier: "adult", status: "active", ...ok },
  { id: "g", name: "Al Unchecked", home_city: "Los Angeles", region: "west", tier: "adult", status: "active", ...ok, age_checked_on: null },
];

test("suggestions: the region's active creators, same city first, screened next, adults before youth", () => {
  const booking = B.normalize(good(), { now: NOW }).value;
  const { crew } = B.rankCreators(booking, pool, []);
  assert.deepEqual(crew.map((c) => c.id), ["b", "c", "g", "d", "a"]);
  assert.equal(crew.find((c) => c.id === "d").screened, false);
  assert.equal(crew.find((c) => c.id === "g").screened, false, "an adult without an age check isn't screened");
  assert.equal(crew.find((c) => c.id === "c").tier, "youth");
  assert.deepEqual(crew.filter((c) => c.can_staff).map((c) => c.id), ["b", "a"], "only screened adults can be staffed");
  assert.ok(!JSON.stringify(crew).includes("guardian@"), "suggestions never carry a guardian's address");
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

test("a push names the job in fixed words only: no people, no city, nothing typed", () => {
  const b = { id: "x1", ...B.normalize(good(), { now: NOW }).value, source: "form" };
  const p = B.pushPayload(b, 2);
  const all = JSON.stringify(p);
  for (const secret of ["Jamie", "jamie@example.com", "555", "Lightning", "#11", "roster", "Los Angeles", "Pylon Girls Flag"]) assert.ok(!all.includes(secret), secret);
  assert.equal(p.url, "/app/#booking/x1");
  assert.equal(p.title, "New booking");
  assert.equal(p.body, "Video coverage · Girls Flag Football · CA · Nov 21, 2026 · 2 creators in the region");
  assert.match(B.pushPayload({ ...b, region: null }, 0).body, /no place given/);
  assert.match(B.pushPayload({ ...b, sport: "Jamie Smith" }, 0).body, /^Video coverage · CA/, "a sport off the list never goes out");
  assert.equal(B.pushPayload({ ...b, stripe_session_id: "cs_test_12345678" }, 0).title, "Paid booking");
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

test("an email for a booking that isn't stored carries all of it and says so", () => {
  const b = { id: "not-saved", ...B.normalize(good(), { now: NOW }).value, source: "form" };
  const { text } = B.emailText(b, null, "https://tojcampaign.com", { saved: false });
  assert.match(text, /Team and jersey: Lightning #11/);
  assert.match(text, /Notes: Her name is on the roster/);
  assert.match(text, /No creators were looked up/);
  assert.ok(!/No creator in the West/.test(text), "it doesn't claim the region is empty");
  assert.ok(!/Open it in the TOJ app/.test(text));
});

test("a paid package: the checkout id is required, the rest is best effort", () => {
  assert.deepEqual(B.normalizePaid({ contact_email: "a@b.co" }).errors, ["stripe_session_id"]);
  const { errors, value } = B.normalizePaid({ stripe_session_id: "cs_live_abc12345", package: "team", amount_cents: 39900, contact_email: "Coach@Team.org", event_state: "tx" });
  assert.deepEqual(errors, []);
  assert.equal(value.kind, "team");
  assert.equal(value.contact_name, "Stripe customer");
  assert.equal(value.region, "south_central");
  assert.equal(value.source, "stripe");
  const bare = B.normalizePaid({ stripe_session_id: "cs_live_abc12345", amount_cents: 2 ** 31 });
  assert.deepEqual(bare.errors, [], "no email still lands");
  assert.equal(bare.value.contact_email, null);
  assert.equal(bare.value.amount_cents, null, "an amount the column can't hold is dropped, not refused");
  assert.equal(B.normalizePaid({ stripe_session_id: "cs_live_abc12345", booking_id: "8F14E45F-CEEA-467E-A1D0-6F1D4C6B2A01" }).value.booking_id, "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01");
  assert.equal(B.normalizePaid({ stripe_session_id: "cs_live_abc12345", booking_id: "1 or 1=1" }).value.booking_id, null);
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
// The site's /api/book function: the secret, and the visitor as Vercel saw them.
const form = (body, visitor = "203.0.113.7") => call("POST", "/api/sm/bookings", body, { "X-SM-Secret": SECRET, "X-SM-Visitor": visitor });
const paidCall = (body) => call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": SECRET });
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
  db = fakeSupabase(
    {
      gfs_creators: pool.map((c) => ({ ...c })),
      creators: [],
      push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }],
    },
    { unique: { sm_bookings: ["stripe_session_id"] } }
  );
  setSupabase(db);
});

test("the form saves a booking and alerts staff by push and email", async () => {
  const r = await form(good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 200);
  assert.ok(r.data.id);
  const row = db.tables.sm_bookings[0];
  assert.equal(row.source, "form");
  assert.equal(row.region, "west");
  await wait();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].to, "kyron@toj.test");
  assert.ok(!JSON.stringify(pushes[0].payload).includes("Jamie"));
  const staff = mails.filter((m) => m.to.includes("kyron@toj.test"));
  assert.equal(staff.length, 1);
  assert.deepEqual(staff[0].to, ["kyron@toj.test"]);
  assert.match(staff[0].text, /Amy Near/);
  // And the booker's own note.
  const theirs = mails.filter((m) => m.to.includes("jamie@example.com"));
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].subject, "Subject Medias: we got your booking request");
  assert.ok(db.tables.sm_bookings[0].alerted_at, "the row notes when the alert went");
  assert.equal(db.tables.sm_bookings[0].matches.length, 5);
});

test("the form takes only the site's call: no secret, no booking (forged addresses don't help)", async () => {
  const bare = await call("POST", "/api/sm/bookings", good({ event_date: "2027-01-16" }), { "X-Vercel-Forwarded-For": "198.51.100.9", "X-SM-Visitor": "198.51.100.9" });
  assert.equal(bare.status, 401);
  assert.equal((db.tables.sm_bookings || []).length, 0);
});

test("a secret with odd bytes is refused, and the server stays up", async () => {
  const odd = "é".repeat(SECRET.length);
  const status = await new Promise((resolve, reject) => {
    const u = new URL(base + "/api/sm/bookings/paid");
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "Content-Type": "application/json", "X-SM-Secret": Buffer.from(odd, "latin1").toString("latin1") } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ stripe_session_id: "cs_live_abc12345" }));
  });
  assert.equal(status, 401);
  assert.equal((await form(good({ event_date: "2027-01-16" }))).status, 200, "still serving");
});

test("odd JSON gets a 400, not a crash", async () => {
  const r = await form({ kind: "athlete", sport: { toString: 1 }, package: ["video"], athletes: { valueOf: 1 } });
  assert.equal(r.status, 400);
  assert.equal((await form(good({ event_date: "2027-01-16" }))).status, 200, "still serving");
});

test("a bot that fills the hidden field gets a polite yes and nothing is stored", async () => {
  const r = await form(good({ company: "Spam LLC" }));
  assert.equal(r.status, 200);
  assert.equal((db.tables.sm_bookings || []).length, 0);
});

test("a bad form names its fields; nothing is stored", async () => {
  const r = await form({ kind: "athlete" });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.includes("contact_email"));
  assert.equal((db.tables.sm_bookings || []).length, 0);
});

test("eight bookings per visitor per ten minutes, counted by the address Vercel saw", async () => {
  for (let i = 0; i < 8; i++) assert.equal((await form(good({ event_date: "2027-01-16" }), "203.0.113.7")).status, 200);
  assert.equal((await form(good({ event_date: "2027-01-16" }), "203.0.113.7")).status, 429);
  assert.equal((await form(good({ event_date: "2027-01-16" }), "198.51.100.4")).status, 200, "someone else isn't blocked");
});

test("the visitor list stays bounded however many addresses come", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 6000; i++) router._limited("10.0." + Math.floor(i / 256) + "." + (i % 256), t0 + i);
  assert.ok(router._hits.size <= 5000, `tracked ${router._hits.size}`);
  router._limited("late", t0 + 11 * 60 * 1000 + 6000);
  assert.equal(router._hits.size, 1, "expired windows are dropped");
});

test("120 form bookings an hour in all; at most 30 alert emails an hour, pushes still go", async () => {
  let okCount = 0;
  for (let i = 0; i < 121; i++) {
    const r = await form(good({ event_date: "2027-01-16" }), "192.0.2." + i);
    if (r.status === 200) okCount++;
    else assert.equal(r.status, 429);
  }
  assert.equal(okCount, 120);
  await wait();
  await wait();
  assert.equal(db.tables.sm_bookings.length, 120, "every accepted booking is stored");
  assert.equal(mails.filter((m) => m.to.includes("kyron@toj.test")).length, 30);
  // One address booked 120 times: its owner hears from us twice, not 120 times.
  assert.equal(mails.filter((m) => m.to.includes("jamie@example.com")).length, 2);
  assert.equal(pushes.length, 120);
});

test("database unreachable: the booking goes to staff by email whole, so it isn't lost", async () => {
  setSupabase(false);
  const r = await form(good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 200);
  assert.equal(r.data.id, null);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /not saved/);
  assert.match(mails[0].text, /Team and jersey: Lightning #11/);
  assert.match(mails[0].text, /No creators were looked up/);
});

const failingDb = (error) => ({
  from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }) }),
});

test("a value the database refuses is the booker's to fix: a 400, no 'database down' email", async () => {
  setSupabase(failingDb({ code: "23514", message: "check constraint" }));
  const r = await form(good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 400);
  assert.equal(mails.length, 0);
});

test("the table not there yet (or any other storage error): the email carries it", async () => {
  setSupabase(failingDb({ code: "PGRST205", message: "Could not find the table" }));
  const r = await form(good({ event_date: "2027-01-16" }));
  assert.equal(r.status, 200);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /not saved/);
});

test("database down and no email: the site is told, so it can show the address", async () => {
  setSupabase(false);
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  const r = await form(good({ event_date: "2027-01-16" }));
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  assert.equal(r.status, 503);
});

test("paid: only the site's webhook, with the shared secret; a retry is a no-op", async () => {
  const body = { stripe_session_id: "cs_live_abc12345", package: "video", amount_cents: 9999, contact_email: "buyer@example.com" };
  assert.equal((await call("POST", "/api/sm/bookings/paid", body)).status, 401);
  assert.equal((await call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": "wrong-secret-0123456789-abcdefgh" })).status, 401);
  assert.equal((await call("POST", "/api/sm/bookings/paid", body, { "X-SM-Secret": SECRET.slice(0, -1) })).status, 401);
  const first = await paidCall(body);
  assert.equal(first.status, 200);
  const again = await paidCall(body);
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(db.tables.sm_bookings.length, 1);
  assert.equal(db.tables.sm_bookings[0].amount_cents, 9999);
  await wait();
  assert.equal(pushes[0].payload.title, "Paid booking");
});

test("paid with no email on the checkout still lands", async () => {
  const r = await paidCall({ stripe_session_id: "cs_live_noemail123", package: "photo", amount_cents: 4999 });
  assert.equal(r.status, 200);
  assert.equal(db.tables.sm_bookings[0].contact_email, null);
  await wait();
  assert.match(mails[0].text, /no email on the checkout/);
  assert.match(mails[0].text, /Stripe checkout: cs_live_noemail123/);
});

test("paid from the success panel: the payment joins its request, once", async () => {
  const made = await form(good({ event_date: "2027-01-16", package: "unsure", contact_phone: "" }));
  const id = made.data.id;
  await wait();
  pushes = [];
  mails = [];
  const pay = { stripe_session_id: "cs_live_joined1234", booking_id: id, package: "elite", amount_cents: 13999, contact_email: "jamie@example.com", contact_phone: "555-010-2030", notes: "Event & date: Pylon Dallas Jan 16" };
  const r = await paidCall(pay);
  assert.equal(r.status, 200);
  assert.equal(r.data.joined, true);
  assert.equal(r.data.id, id);
  assert.equal(db.tables.sm_bookings.length, 1, "no second booking");
  const row = db.tables.sm_bookings[0];
  assert.equal(row.stripe_session_id, "cs_live_joined1234");
  assert.equal(row.amount_cents, 13999);
  assert.equal(row.package, "elite", "what they paid for");
  assert.equal(row.source, "form");
  assert.equal(row.contact_phone, "555-010-2030", "a phone the request didn't have");
  assert.match(row.notes, /Her name is on the roster[\s\S]*From the checkout: Event & date: Pylon Dallas Jan 16/);
  await wait();
  assert.equal(pushes[0].payload.title, "Paid booking");
  assert.match(mails[0].text, /for the request they sent from the booking form/);
  const again = await paidCall(pay);
  assert.equal(again.data.duplicate, true);
  assert.equal(db.tables.sm_bookings.length, 1);

  const cookie = await staffCookie();
  const list = await call("GET", "/api/sm/bookings", undefined, {}, cookie);
  assert.equal(list.data.bookings[0].paid, true);
  assert.ok(!("stripe_session_id" in list.data.bookings[0]));
});

test("paid for a request we don't have, or one already paid: a booking of its own", async () => {
  const stranger = await paidCall({ stripe_session_id: "cs_live_stranger12", booking_id: "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01", package: "photo", amount_cents: 4999, contact_email: "a@example.com" });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.data.joined, undefined);
  const made = await form(good({ event_date: "2027-01-16" }));
  await paidCall({ stripe_session_id: "cs_live_firstpay1", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  const second = await paidCall({ stripe_session_id: "cs_live_secondpay", booking_id: made.data.id, package: "photo", amount_cents: 4999, contact_email: "jamie@example.com" });
  assert.equal(second.status, 200);
  assert.equal(second.data.joined, undefined);
  assert.equal(db.tables.sm_bookings.length, 3);
});

test("paid, database down: the email carries the payment; with no email either, Stripe retries", async () => {
  setSupabase(false);
  const body = { stripe_session_id: "cs_live_dbdown1234", package: "video", amount_cents: 9999, contact_email: "buyer@example.com" };
  const r = await paidCall(body);
  assert.equal(r.status, 200);
  assert.match(mails[0].subject, /^Paid booking.*not saved/);
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  assert.equal((await paidCall(body)).status, 503);
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
});

test("the list and a booking are staff only", async () => {
  await form(good({ event_date: "2027-01-16" }));
  assert.equal((await call("GET", "/api/sm/bookings")).status, 401);
  const cookie = await staffCookie();
  const list = await call("GET", "/api/sm/bookings", undefined, {}, cookie);
  assert.equal(list.status, 200);
  assert.equal(list.data.bookings.length, 1);
  assert.ok(!("contact_email" in list.data.bookings[0]), "the list carries no contact");
  assert.equal(list.data.bookings[0].paid, false);
  const one = await call("GET", "/api/sm/bookings/" + list.data.bookings[0].id, undefined, {}, cookie);
  assert.equal(one.data.booking.contact_name, "Jamie Parent");
  assert.equal(one.data.matches.crew[0].id, "b");
  assert.equal((await call("GET", "/api/sm/bookings/not-a-uuid", undefined, {}, cookie)).status, 404);
});

test("staffing: a screened adult only; closed bookings keep who they had", async () => {
  const made = await form(good({ event_date: "2027-01-16" }));
  assert.ok(made.data.id);
  const real = "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01";
  db.tables.sm_bookings[0].id = real;
  const cookie = await staffCookie();
  const patch = (body) => call("PATCH", "/api/sm/bookings/" + real, body, {}, cookie);
  assert.equal((await patch({ status: "staffed" })).data.error, "creator_required");
  assert.equal((await patch({ status: "won" })).data.error, "invalid_status");
  assert.equal((await patch({ staffed_creator_id: "e" })).data.error, "creator_not_active");
  assert.equal((await patch({ staffed_creator_id: { toString: 1 } })).data.error, "creator_not_active");
  const youth = await patch({ staffed_creator_id: "c" });
  assert.equal(youth.data.error, "creator_not_cleared");
  assert.ok(youth.data.problems.includes("youth_alone"));
  assert.equal((await patch({ staffed_creator_id: "d" })).data.error, "creator_not_cleared", "screening not on file");
  assert.equal((await patch({ staffed_creator_id: "g" })).data.error, "creator_not_cleared", "no age check");
  const staffed = await patch({ staffed_creator_id: "b" });
  assert.equal(staffed.status, 200);
  assert.equal(staffed.data.booking.status, "staffed");
  assert.equal(staffed.data.booking.status_by, "kyron@toj.test");
  await patch({ status: "delivered" });
  const swap = await patch({ staffed_creator_id: "a" });
  assert.equal(swap.status, 409);
  assert.equal(swap.data.error, "booking_closed");
  assert.equal(db.tables.sm_bookings[0].staffed_creator_id, "b", "who delivered it stays");
  assert.equal((await call("GET", "/api/sm/bookings", undefined, {}, cookie)).data.bookings.length, 0);
  assert.equal((await call("GET", "/api/sm/bookings?all=1", undefined, {}, cookie)).data.bookings.length, 1);
});

// ── The booker's note, the offer, and details after a direct Buy (034) ──
const SITE_LINK = (sid) => `https://www.subjectmedias.com/?paid=${sid}#details`;
const theirs = (addr) => mails.filter((m) => m.to.includes(addr));
const staffMails = () => mails.filter((m) => m.to.includes("kyron@toj.test"));
const detailsCall = (body, visitor = "198.51.100.9") => call("POST", "/api/sm/bookings/paid", { details: true, adult_confirmed: true, ...body }, { "X-SM-Secret": SECRET, "X-SM-Visitor": visitor });

test("the 10% offer: only the homepage's claim is kept", () => {
  for (const [given, want] of [["first10", "first10"], ["FIRST10", null], ["free", null], [true, null], [{ a: 1 }, null], [undefined, null]]) {
    assert.equal(B.normalize(good({ offer: given }), { now: NOW }).value.offer, want, String(given));
  }
});

test("the booker's note carries fixed words only, never what anyone typed", () => {
  const junk = "Win $500 at http://evil.example now";
  const { value } = B.normalize(good({ event_date: "2026-11-21", event_name: junk, event_city: junk, contact_name: junk, notes: junk, team_jersey: junk, sport: junk, offer: "first10" }), { now: NOW });
  const m = B.bookerEmail({ ...value, id: "b1", source: "form" });
  assert.equal(m.subject, "Subject Medias: we got your booking request");
  assert.ok(!m.text.includes("evil") && !m.text.includes("$500"), m.text);
  assert.match(m.text, /What: Video coverage/);
  assert.match(m.text, /Game day: Sat, Nov 21, 2026/);
  assert.match(m.text, /State: CA/);
  assert.doesNotMatch(m.text, /Sport:/, "a sport off the list is Other, and Other isn't worth saying");
  assert.match(m.text, /Offer: 10% off your first package/);
  assert.match(m.text, /Nothing is booked or charged until then/);
  assert.match(m.text, /Didn't send this\? You can ignore this email/);
  // Bought from a payment link: thanks, the amount, and the details link when we need it.
  const paid = B.normalizePaid({ stripe_session_id: "cs_live_abcdefgh1234", package: "elite", amount_cents: 13999, contact_name: junk, notes: junk }).value;
  const asked = B.bookerEmail({ ...paid, id: "b2" }, { detailsUrl: SITE_LINK("cs_live_abcdefgh1234") });
  assert.equal(asked.subject, "Subject Medias: thanks for booking");
  assert.match(asked.text, /Paid: \$139\.99/);
  assert.ok(asked.text.includes(SITE_LINK("cs_live_abcdefgh1234")));
  assert.ok(!asked.text.includes("evil"));
  assert.doesNotMatch(asked.text, /Offer:/);
  const told = B.bookerEmail({ ...paid, id: "b2", details_at: "2026-10-28T15:00:00Z", event_date: "2026-11-21", event_state: "TX" });
  assert.doesNotMatch(told.text, /One more step/);
  assert.match(told.text, /Game day: Sat, Nov 21, 2026/);
});

test("details after a direct Buy: the date, the place and the adult box, as on the form", () => {
  const sid = "cs_live_details12345";
  const bad = B.normalizePaid({ stripe_session_id: sid, details: true, athletes: "0", contact_phone: "12" }, { now: NOW });
  for (const f of ["event_date", "event_city", "event_state", "athletes", "contact_phone", "adult_confirmed"]) assert.ok(bad.errors.includes(f), f);
  const ok = B.normalizePaid({ stripe_session_id: sid, details: true, adult_confirmed: true, event_date: "2026-11-21", event_city: "Dallas", event_state: "tx", athletes: "12", team_jersey: "Elite 7v7 #4" }, { now: NOW });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.details, true);
  assert.equal(ok.value.region, "south_central");
  assert.equal(ok.value.athletes, 12);
  // The webhook stays easy-going: a payment always lands.
  assert.deepEqual(B.normalizePaid({ stripe_session_id: sid, event_date: "soon" }, { now: NOW }).errors, []);
  assert.equal(B.normalizePaid({ stripe_session_id: sid, event_date: "2020-01-01" }, { now: NOW }).value.event_date, "2020-01-01");
});

test("filling in: only what's missing; notes add on, saying where they came from", () => {
  const have = { source: "stripe", package: "unsure", kind: "athlete", contact_name: B.STRIPE_NAME, event_city: "Austin", event_state: null, event_date: null, notes: "Event & date: Fall Classic", contact_phone: "555-111-2222" };
  const inc = { package: "video", kind: "athlete", contact_name: "Pat Buyer", event_city: "Dallas", event_state: "TX", event_date: "2026-11-21", notes: "Gate 4", contact_phone: "555-999-0000" };
  const p = B.fillPatch(have, inc, { from: "the event details form" });
  assert.deepEqual(p, { event_date: "2026-11-21", event_state: "TX", region: "south_central", package: "video", kind: "athlete", contact_name: "Pat Buyer", notes: "Event & date: Fall Classic\n\nFrom the event details form: Gate 4" });
  assert.deepEqual(B.fillPatch({ ...have, ...p }, inc, { from: "the event details form" }), {}, "the same answers twice change nothing");
});

test("the booker hears once for a request, and not again when it's paid", async () => {
  const made = await form(good({ event_date: "2027-01-16", offer: "first10" }));
  await wait();
  const row = db.tables.sm_bookings[0];
  assert.equal(row.offer, "first10");
  assert.ok(row.booker_emailed_at);
  const note = theirs("jamie@example.com");
  assert.equal(note.length, 1);
  assert.equal(note[0].replyTo, "hello@subjectmedias.com");
  assert.match(note[0].text, /Offer: 10% off your first package/);
  assert.ok(!note[0].text.includes("Lightning") && !note[0].text.includes("Los Angeles") && !note[0].text.includes("Pylon"), "nothing typed");
  assert.match(staffMails()[0].text, /Offer: claimed 10% off the first package/);
  // Paid from the success panel: Stripe's receipt covers it.
  await paidCall({ stripe_session_id: "cs_live_joinedmail1", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  await wait();
  assert.equal(theirs("jamie@example.com").length, 1);
  const cookie = await staffCookie();
  const list = await call("GET", "/api/sm/bookings", undefined, {}, cookie);
  assert.equal(list.data.bookings[0].offer, "first10");
});

test("a direct Buy: thanks, with a link to tell us about the game; a retry sends nothing more", async () => {
  const sid = "cs_live_directbuy123";
  await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "Buyer@Example.com" });
  await wait();
  const note = theirs("buyer@example.com");
  assert.equal(note.length, 1);
  assert.equal(note[0].subject, "Subject Medias: thanks for booking");
  assert.ok(note[0].text.includes(SITE_LINK(sid)), note[0].text);
  await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com" });
  await wait();
  assert.equal(theirs("buyer@example.com").length, 1);
  assert.equal(pushes.length, 1, "a retry is quiet");
});

test("the booker's note couldn't go: it's let go, so the next delivery can send it", async () => {
  mailer.setSender(async (m) => { mails.push(m); return m.to.includes("kyron@toj.test") ? { sent: true } : { sent: false, reason: "send_failed" }; });
  try {
    await form(good({ event_date: "2027-01-16" }));
    await wait();
    assert.equal(theirs("jamie@example.com").length, 1, "it tried");
    assert.equal(db.tables.sm_bookings[0].booker_emailed_at, null);
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("details after the webhook: filled in once, staff hear, nobody's emailed twice", async () => {
  const sid = "cs_live_webhookfirst1";
  await paidCall({ stripe_session_id: sid, package: "elite", amount_cents: 13999, contact_email: "buyer@example.com", contact_name: "Pat Buyer" });
  await wait();
  pushes = [];
  mails = [];
  const r = await detailsCall({ stripe_session_id: sid, package: "elite", amount_cents: 13999, contact_email: "buyer@example.com", event_date: "2026-11-21", event_city: "Dallas", event_state: "TX", sport: "7v7 Football", team_jersey: "Elite 7v7 #4", notes: "Field 3" });
  assert.equal(r.status, 200);
  assert.equal(db.tables.sm_bookings.length, 1);
  const row = db.tables.sm_bookings[0];
  assert.equal(row.event_city, "Dallas");
  assert.equal(row.region, "south_central");
  assert.equal(row.team_jersey, "Elite 7v7 #4");
  assert.ok(row.details_at);
  assert.match(row.notes, /From the event details form: Field 3/);
  await wait();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, "Event details in");
  assert.match(staffMails()[0].subject, /^Event details in: Elite coverage, Dallas, TX/);
  assert.equal(theirs("buyer@example.com").length, 0);
  // A second answer changes nothing.
  const again = await detailsCall({ stripe_session_id: sid, event_date: "2026-12-05", event_city: "Houston", event_state: "TX", notes: "Changed my mind" });
  assert.equal(again.status, 200);
  assert.equal(again.data.already, true);
  assert.equal(db.tables.sm_bookings[0].event_city, "Dallas");
  assert.doesNotMatch(db.tables.sm_bookings[0].notes, /Changed my mind/);
});

test("details before the webhook: one booking, their answers kept; the webhook fills only the gaps", async () => {
  const sid = "cs_live_detailsfirst1";
  const r = await detailsCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", contact_name: "Pat Buyer", event_date: "2026-11-21", event_city: "Dallas", event_state: "TX" });
  assert.equal(r.status, 200);
  await wait();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, "Paid booking");
  const note = theirs("buyer@example.com");
  assert.equal(note.length, 1);
  assert.ok(!note[0].text.includes("?paid="), "they've told us already: no link");
  const hook = await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", contact_phone: "555-010-9999", event_city: "Austin", event_state: "TX", notes: "Team: Elite" });
  assert.equal(hook.status, 200);
  assert.equal(hook.data.duplicate, true);
  assert.equal(db.tables.sm_bookings.length, 1);
  const row = db.tables.sm_bookings[0];
  assert.equal(row.event_city, "Dallas", "the buyer's answer stands");
  assert.equal(row.contact_phone, "555-010-9999", "a gap filled");
  assert.match(row.notes, /From the checkout: Team: Elite/);
  await wait();
  assert.equal(pushes.length, 1, "no second alert");
  assert.equal(theirs("buyer@example.com").length, 1, "no second note");
});

test("details: wrong answers name their fields; the hidden field and the form's limits apply", async () => {
  const sid = "cs_live_detailslimit1";
  const bad = await detailsCall({ stripe_session_id: sid, event_date: "someday", adult_confirmed: false });
  assert.equal(bad.status, 400);
  for (const f of ["event_date", "event_city", "event_state", "adult_confirmed"]) assert.ok(bad.data.fields.includes(f), f);
  const bot = await detailsCall({ stripe_session_id: sid, event_date: "2026-11-21", event_city: "Dallas", event_state: "TX", company: "Acme" });
  assert.equal(bot.status, 200);
  assert.equal((db.tables.sm_bookings || []).length, 0);
  for (let i = 0; i < 8; i++) await detailsCall({ stripe_session_id: sid, event_date: "x" }, "198.51.100.77");
  assert.equal((await detailsCall({ stripe_session_id: sid, event_date: "x" }, "198.51.100.77")).status, 429);
});

test("a details answer never joins a request: the request keeps its own details", async () => {
  const made = await form(good({ event_date: "2027-01-16" }));
  await wait();
  const r = await detailsCall({ stripe_session_id: "cs_live_neverjoins1", booking_id: made.data.id, event_date: "2026-11-21", event_city: "Dallas", event_state: "TX" });
  assert.equal(r.status, 200);
  const request = db.tables.sm_bookings.find((b) => b.id === made.data.id);
  assert.equal(request.stripe_session_id || null, null);
  assert.equal(request.event_city, "Los Angeles");
});
