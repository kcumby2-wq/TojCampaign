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
const SITE_LINK = (sid) => `https://www.subjectmedias.com/details?paid=${sid}`;
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

test("the booker's note couldn't go: the row says so, and its place in the limits comes back", async () => {
  mailer.setSender(async (m) => { mails.push(m); return m.to.includes("kyron@toj.test") ? { sent: true } : { sent: false, reason: "send_failed" }; });
  try {
    for (let i = 0; i < 3; i++) await form(good({ event_date: "2027-01-16" }), "198.51.100." + i);
    await wait();
    assert.equal(theirs("jamie@example.com").length, 3, "each one tried: a failed note doesn't use up the mailbox's two");
    assert.ok(db.tables.sm_bookings.every((b) => b.booker_emailed_at === null), "the app shows it didn't go");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
  await form(good({ event_date: "2027-01-16" }), "198.51.100.9");
  await wait();
  assert.equal(theirs("jamie@example.com").length, 4);
  assert.ok(db.tables.sm_bookings[3].booker_emailed_at);
});

test("the booker's limits count the mailbox, not the spelling, and the visitor too", async () => {
  // Gmail ignores dots and +tags: one inbox, two notes a day.
  for (const [i, e] of ["jamie.parent@gmail.com", "jamieparent+1@gmail.com", "J.a.m.i.e.parent+x@googlemail.com"].entries()) await form(good({ event_date: "2027-01-16", contact_email: e }), "203.0.113." + (10 + i));
  await wait();
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 2);
  assert.equal(B.mailbox("J.a.m.i.e.parent+x@GoogleMail.com"), "jamieparent@gmail.com");
  assert.equal(B.mailbox("pat.smith+games@example.com"), "pat.smith@example.com", "dots count elsewhere");
  // One visitor, many inboxes: three notes a day.
  mails = [];
  for (let i = 0; i < 5; i++) await form(good({ event_date: "2027-01-16", contact_email: `someone${i}@example.com` }), "198.51.100.200");
  await wait();
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 3);
  assert.equal(db.tables.sm_bookings.length, 8, "every booking is still saved");
});

test("cutting text never leaves half an emoji", () => {
  const note = "x".repeat(999) + "🏈🏈";
  assert.equal(B.clip(note, 1000), "x".repeat(999) + "🏈");
  assert.ok(!/[\uD800-\uDBFF]$/.test(B.normalize(good({ notes: note }), { now: NOW }).value.notes));
  const joined = B.joinNotes("y".repeat(990), "From the checkout: 🏈🏈🏈🏈");
  assert.equal(Array.from(joined).length, 1000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(joined));
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
  assert.equal(row.adult_confirmed, true);
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
  assert.equal(db.tables.sm_bookings[0].adult_confirmed, true, "they ticked the box");
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

test("webhook first, then the buyer's answers: their answers win over the checkout's fields", async () => {
  const sid = "cs_live_answerswin123";
  await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", event_date: "2026-11-21", event_city: "Austin", event_state: "TX", notes: "Shirt size: M" });
  await wait();
  pushes = [];
  mails = [];
  const r = await detailsCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", event_date: "2026-12-05", event_city: "Dallas", event_state: "TX", notes: "Field 3", checkout_notes: "Shirt size: M" });
  assert.equal(r.status, 200);
  const row = db.tables.sm_bookings[0];
  assert.equal(row.event_date, "2026-12-05");
  assert.equal(row.event_city, "Dallas");
  assert.equal(row.notes, "Shirt size: M\n\nFrom the event details form: Field 3", "the checkout's own notes once");
  await wait();
  assert.match(staffMails()[0].subject, /^Event details in: Video coverage, Dallas, TX, Dec 5, 2026/);
  assert.equal(pushes[0].payload.tag, `sm-booking-${row.id}-details`, "its own notification, not a quiet replacement");
});

test("details first, with the checkout's notes: they come once, whichever order", async () => {
  const sid = "cs_live_notesonce1234";
  await detailsCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", event_date: "2026-12-05", event_city: "Dallas", event_state: "TX", notes: "Field 3", checkout_notes: "Shirt size: M" });
  await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com", notes: "Shirt size: M" });
  assert.equal(db.tables.sm_bookings[0].notes, "Field 3\n\nFrom the checkout: Shirt size: M");
});

test("the answers couldn't be added: staff get them by email, and the page hears the truth", async () => {
  const sid = "cs_live_fillfails1234";
  await paidCall({ stripe_session_id: sid, package: "video", amount_cents: 9999, contact_email: "buyer@example.com" });
  await wait();
  mails = [];
  const real = db.from.bind(db);
  db.from = (name) => {
    const q = real(name);
    if (name !== "sm_bookings") return q;
    const update = q.update.bind(q);
    q.update = (patch) => (patch.details_at ? { eq: () => ({ is: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57014", message: "statement timeout" } }) }) }) }) } : update(patch));
    return q;
  };
  try {
    const r = await detailsCall({ stripe_session_id: sid, event_date: "2026-12-05", event_city: "Dallas", event_state: "TX", team_jersey: "Elite #4" });
    assert.equal(r.status, 200);
    const staff = staffMails();
    assert.equal(staff.length, 1);
    assert.match(staff[0].subject, /^Event details for paid booking cs_live_fillfails1234 \(not saved/);
    assert.match(staff[0].text, /Team and jersey: Elite #4/);
    assert.equal(staff[0].critical, true);
    mailer.setSender(async (m) => { mails.push(m); return { sent: false, reason: "send_failed" }; });
    const again = await detailsCall({ stripe_session_id: sid, event_date: "2026-12-05", event_city: "Dallas", event_state: "TX" });
    assert.equal(again.status, 503, "not stored and not emailed: the page shows the email address");
  } finally {
    db.from = real;
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("a checkout that names a request already paid: a booking of its own, flagged, with no details link", async () => {
  const made = await form(good({ event_date: "2027-01-16" }));
  await paidCall({ stripe_session_id: "cs_live_firstpay1234", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  await wait();
  mails = [];
  const r = await paidCall({ stripe_session_id: "cs_live_secondpay123", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  assert.equal(r.status, 200);
  const extra = db.tables.sm_bookings.find((b) => b.stripe_session_id === "cs_live_secondpay123");
  assert.equal(extra.source, "stripe");
  assert.match(extra.notes, new RegExp(`named booking request ${made.data.id}`));
  await wait();
  const note = theirs("jamie@example.com");
  assert.equal(note.length, 1);
  assert.ok(!note[0].text.includes("?paid="), "the details page wouldn't ask about it");
});

test("every column the routes write is one the migrations make", async () => {
  const fs = require("fs"), path = require("path");
  const sql = ["030_sm_bookings.sql", "034_sm_bookings_more.sql", "035_sm_checkout_reminder.sql"].map((f) => fs.readFileSync(path.join(__dirname, "..", "db", "migrations", f), "utf8")).join("\n");
  const table = /create table if not exists public\.sm_bookings \(([\s\S]*?)\n\);/.exec(sql)[1];
  const cols = new Set([...table.matchAll(/^\s{2}([a-z_]+) [a-z]/gm)].map((m) => m[1]).filter((c) => c !== "constraint"));
  for (const m of sql.matchAll(/add column if not exists ([a-z_]+)/g)) cols.add(m[1]);
  await form(good({ event_date: "2027-01-16", offer: "first10" }));
  await form(good({ event_date: "2027-01-16" }), "198.51.100.40");
  const payNow = await form(good({ event_date: "2027-01-16", package: "photo", pay_now: true, contact_email: "c@example.com" }), "198.51.100.42");
  await paidCall({ stripe_session_id: "cs_live_columnsjoin1", booking_id: payNow.data.id, package: "photo", amount_cents: 4999, contact_email: "c@example.com" });
  const unpaid = await form(good({ event_date: "2027-01-16", package: "video", pay_now: true, contact_email: "d@example.com" }), "198.51.100.43");
  db.tables.sm_bookings.find((b) => b.id === unpaid.data.id).created_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  process.env.SM_STRIPE_READ_KEY = "rk_live_" + "a".repeat(24);
  router._setStripe(() => ({ checkout: { sessions: { list: async () => ({ data: [], has_more: false }), retrieve: async (id) => ({ id }) } } }));
  try { assert.deepEqual(await router._remind(db), { sent: 1 }); } finally { delete process.env.EMAIL_USER; delete process.env.EMAIL_PASS; delete process.env.SM_STRIPE_READ_KEY; router._setStripe(null); }
  await paidCall({ stripe_session_id: "cs_live_columns12345", package: "video", amount_cents: 9999, contact_email: "a@example.com", contact_phone: "555-010-0000", event_date: "2026-11-21", event_city: "Dallas", event_state: "TX", team_jersey: "x", notes: "n" });
  await detailsCall({ stripe_session_id: "cs_live_columns67890", package: "video", amount_cents: 9999, contact_email: "b@example.com", event_date: "2026-12-05", event_city: "Dallas", event_state: "TX", athletes: "2", checkout_notes: "c" });
  await detailsCall({ stripe_session_id: "cs_live_columns12345", event_date: "2026-12-05", event_city: "Dallas", event_state: "TX" }, "198.51.100.41");
  await wait();
  for (const row of db.tables.sm_bookings) for (const k of Object.keys(row)) assert.ok(cols.has(k) || ["id", "created_at", "updated_at"].includes(k), `sm_bookings has no column ${k}`);
});

test("a short note isn't lost because the same words appear inside another", () => {
  const p = B.fillPatch({ source: "stripe", package: "video", notes: "Lot B, field 3" }, { notes: "3" }, { from: "the event details form", override: true, checkoutNotes: "Lot B, field 3" });
  assert.equal(p.notes, "Lot B, field 3\n\nFrom the event details form: 3");
});

test("the not-saved details email says the booking is in the app, and what to do", () => {
  const m = B.emailText({ source: "stripe", package: "video", stripe_session_id: "cs_live_x12345678", id: "not-saved", contact_name: "Pat", contact_email: "p@example.com", team_jersey: "Elite #4" }, null, "https://tojcampaign.com", { saved: false, detailsFor: "cs_live_x12345678" });
  assert.match(m.text, /The paid booking is in the app \(Stripe checkout cs_live_x12345678\), but these details aren't\. Add them there\./);
  assert.doesNotMatch(m.text, /NOT in the app/);
});

test("an IPv6 visitor's /64 is the same however the address is written", () => {
  const k = router._visitorKey;
  for (const a of ["2001:db8::5:1:2:3", "2001:0db8:0000:0000:0005:0001:0002:0003", "2001:DB8:0:0:ffff::1", "2001:db8::"]) assert.equal(k(a), "2001:db8:0:0::/64", a);
  assert.equal(k("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(k("::ffff:203.0.113.5"), "203.0.113.5");
  assert.equal(k("203.0.113.5"), "203.0.113.5");
  assert.equal(k("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(k("not:an:address::zz"), "not:an:address::zz", "anything odd stays as written");
});

test("one visitor on IPv6 is their /64 for the booker's limits", async () => {
  for (let i = 0; i < 5; i++) await form(good({ event_date: "2027-01-16", contact_email: `v6person${i}@example.com` }), `2001:db8:1:2:${i}::${i + 1}`);
  await wait();
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 3);
});

// ── Pay now: a package's Buy button takes the request on to Stripe ───────
test("pay now: the request lands quietly for the booker; the thanks note goes when the payment joins", async () => {
  const made = await form(good({ event_date: "2027-01-16", package: "video", pay_now: true }));
  assert.equal(made.status, 200);
  await wait();
  assert.equal(theirs("jamie@example.com").length, 0, "no \"nothing is charged until then\" to someone paying now");
  assert.match(staffMails()[0].text, /went on to Stripe to pay for it/);
  assert.equal(db.tables.sm_bookings[0].pay_now, true, "kept for the reminder (migration 035)");
  mails = [];
  pushes = [];
  const r = await paidCall({ stripe_session_id: "cs_live_paynow123456", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  assert.equal(r.data.joined, true);
  await wait();
  const note = theirs("jamie@example.com");
  assert.equal(note.length, 1);
  assert.equal(note[0].subject, "Subject Medias: thanks for booking");
  assert.match(note[0].text, /Your payment came through/);
  assert.match(note[0].text, /Paid: \$99\.99/);
  assert.match(note[0].text, /Game day: Sat, Jan 16, 2027/);
  assert.ok(!note[0].text.includes("?paid="), "we know the game already");
  assert.equal(pushes[0].payload.title, "Paid booking");
  // A retry of the webhook sends nothing more.
  await paidCall({ stripe_session_id: "cs_live_paynow123456", booking_id: made.data.id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  await wait();
  assert.equal(theirs("jamie@example.com").length, 1);
});

test("pay now only for the three priced packages, and never with the 10% claim (that's confirmed by hand)", () => {
  const v = (over) => B.normalize(good({ event_date: "2027-01-16", pay_now: true, ...over }), { now: NOW }).value.pay_now;
  for (const p of ["photo", "video", "elite"]) assert.equal(v({ package: p }), true, p);
  for (const p of ["transcript", "team", "event", "unsure"]) assert.equal(v({ package: p }), false, p);
  assert.equal(v({ package: "elite", offer: "first10" }), false);
  assert.equal(v({ package: "elite", pay_now: "true" }), false, "only a real true");
});

test("pay now, never paid: no note, and staff know to follow up", async () => {
  await form(good({ event_date: "2027-01-16", package: "elite", pay_now: true }));
  await wait();
  assert.equal(theirs("jamie@example.com").length, 0);
  assert.equal(db.tables.sm_bookings[0].booker_emailed_at || null, null);
  assert.match(staffMails()[0].text, /if not, follow up like any request/);
});

// ── The unfinished checkout: one reminder, after Stripe says nothing came ─
const HOUR_MS = 60 * 60 * 1000;
const crypto = require("crypto");
const LIVE_KEY = "rk_live_" + "a".repeat(24);
// Stripe as the reminder sees it: one account, the checkouts it knows (the
// one the app already holds, made in withReminders), and the completed ones
// since a moment.
const ACCOUNT_SID = "cs_live_accountknown0001";
let stripeSessions = [], stripeCalls = [], stripeFails = false, stripePages = 1, otherAccount = false;
const fakeStripe = {
  checkout: {
    sessions: {
      retrieve: async (id) => {
        if (stripeFails) throw Object.assign(new Error("api down"), { type: "StripeConnectionError" });
        if (!otherAccount && id === ACCOUNT_SID) return { id };
        throw Object.assign(new Error("No such checkout.session: " + id), { code: "resource_missing", statusCode: 404 });
      },
      list: async (params) => {
        stripeCalls.push(params);
        if (stripeFails) throw Object.assign(new Error("api down"), { type: "StripeConnectionError" });
        const since = params.created.gte;
        const data = stripeSessions.filter((x) => x.status === "complete" && x.created >= since);
        return { data, has_more: stripeCalls.length < stripePages };
      },
    },
  },
};
const completed = (over = {}) => ({ id: "cs_live_" + crypto.randomBytes(6).toString("hex"), status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), payment_link: "plink_x", metadata: {}, ...over });
async function withReminders(fn, { key = LIVE_KEY, known = true } = {}) {
  process.env.EMAIL_USER = "subjectmedias@gmail.com";
  process.env.EMAIL_PASS = "app-password";
  if (key) process.env.SM_STRIPE_READ_KEY = key;
  stripeSessions = [];
  stripeCalls = [];
  stripeFails = false;
  stripePages = 1;
  otherAccount = false;
  router._setStripe(() => fakeStripe);
  router._forgetKeyCheck();
  // A package someone bought earlier: the live checkout the app holds, which
  // shows the key is for the site's account.
  if (known && !(db.tables.sm_bookings || []).some((b) => b.stripe_session_id === ACCOUNT_SID)) {
    await paidCall({ stripe_session_id: ACCOUNT_SID, package: "photo", amount_cents: 4999, contact_email: "earlier-buyer@example.com" });
    await wait();
    mails = [];
  }
  try {
    return await fn();
  } finally {
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASS;
    delete process.env.SM_STRIPE_READ_KEY;
    router._setStripe(null);
  }
}
const rowOf = (id) => db.tables.sm_bookings.find((b) => b.id === id);
const age = (id, ms) => { rowOf(id).created_at = new Date(Date.now() - ms).toISOString(); };
const reminders = () => mails.filter((m) => m.subject === "Subject Medias: finish your booking");
let nextVisitor = 10;
// A pay-now request, sent an hour and a minute ago, from its own visitor.
async function due(over = {}, visitor = `198.51.100.${nextVisitor++ % 250}`) {
  const r = await form(good({ event_date: "2027-01-16", package: "video", pay_now: true, ...over }), visitor);
  assert.equal(r.status, 200);
  age(r.data.id, HOUR_MS + 60000);
  return r.data.id;
}

test("no payment an hour on: one reminder with the request's checkout, in fixed words", () => withReminders(async () => {
  const r = await form(good({ event_date: "2027-01-16", package: "video", pay_now: true }));
  await wait();
  mails = [];
  assert.deepEqual(await router._remind(db), { sent: 0 }, "not inside the hour");
  age(r.data.id, HOUR_MS + 60000);
  assert.deepEqual(await router._remind(db), { sent: 1 });
  const m = reminders();
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, ["jamie@example.com"]);
  assert.equal(m[0].replyTo, "hello@subjectmedias.com");
  assert.match(m[0].text, /^Your Subject Medias booking details are saved\. We haven't received a payment for it yet\.$/m);
  assert.ok(m[0].text.includes(`https://buy.stripe.com/eVqfZidmP5TY70seoFebu05?client_reference_id=${r.data.id}\n`), "the package's checkout, joined to the request, nothing else in the link");
  assert.match(m[0].text, /^What: Video coverage, \$99\.99$/m);
  assert.match(m[0].text, /^Game day: Sat, Jan 16, 2027$/m);
  assert.match(m[0].text, /^State: CA$/m);
  assert.match(m[0].text, /Already paid\? Then you're all set\. A payment can take a little while to reach us/);
  assert.match(m[0].text, /Didn't start this booking\? You can ignore this email\./);
  for (const typed of ["Jamie", "jamie", "Los Angeles", "Lightning", "#11", "Pylon Girls Flag", "roster", "555", "locked in", "didn't go through"]) assert.ok(!m[0].text.includes(typed), `not in it: ${typed}`);
  assert.ok(rowOf(r.data.id).checkout_reminded_at, "the row says when");
  assert.equal(stripeCalls.length, 1, "Stripe was asked first");
  assert.equal(stripeCalls[0].status, "complete");
  assert.deepEqual(await router._remind(db), { sent: 0 }, "once");
  assert.equal(reminders().length, 1);
}));

test("Stripe has it: a checkout for the request (paid, or a bank payment still clearing), or one from the same mailbox on a payment link", () => withReminders(async () => {
  const clearing = await due({ contact_email: "bank@example.com" });
  const paidLate = await due({ contact_email: "late@example.com" });
  const otherLink = await due({ contact_email: "Same.Box+x@gmail.com" });
  const market = await due({ contact_email: "clips@example.com" });
  await wait();
  stripeSessions = [
    completed({ client_reference_id: clearing, payment_status: "unpaid", customer_details: { email: "someone-else@example.com" } }),
    completed({ client_reference_id: paidLate.toUpperCase(), customer_details: { email: "late@example.com" } }),
    completed({ client_reference_id: null, customer_details: { email: "samebox@gmail.com" } }),
    // A marketplace order isn't a booking: it doesn't stand for one.
    completed({ client_reference_id: "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a99", payment_link: null, metadata: { kind: "sm_market" }, customer_details: { email: "clips@example.com" } }),
    // An open checkout (left at Stripe) isn't a payment.
    completed({ client_reference_id: market, status: "open" }),
  ];
  mails = [];
  assert.deepEqual(await router._remind(db), { sent: 1 });
  assert.deepEqual(reminders().map((m) => m.to), [["clips@example.com"]]);
  for (const id of [clearing, paidLate, otherLink]) assert.equal(rowOf(id).checkout_reminded_at || null, null, id);
}));

test("no trusted Stripe answer, no reminders: no key, a test or full secret key, another account's, an error, or too many checkouts", async () => {
  const id = await withReminders(async () => due());
  await wait();
  await withReminders(async () => assert.deepEqual(await router._remind(db), { off: "no_stripe_key" }), { key: null });
  await withReminders(async () => assert.deepEqual(await router._remind(db), { off: "no_stripe_key" }), { key: "rk_test_" + "a".repeat(24) });
  await withReminders(async () => assert.deepEqual(await router._remind(db), { off: "no_stripe_key" }), { key: "sk_live_" + "a".repeat(24) });
  // A live key for another Stripe account: it doesn't know the app's checkout.
  await withReminders(async () => {
    otherAccount = true;
    assert.deepEqual(await router._remind(db), { off: "stripe_key_unverified" });
    assert.equal(stripeCalls.length, 0, "its list is never read");
  });
  await withReminders(async () => {
    stripeFails = true;
    assert.deepEqual(await router._remind(db), { off: "stripe_unavailable" });
  });
  await withReminders(async () => {
    stripeSessions = [completed({ created: Math.floor(Date.now() / 1000) })];
    stripePages = 99;
    assert.deepEqual(await router._remind(db), { off: "stripe_too_many" });
  });
  assert.equal(rowOf(id).checkout_reminded_at || null, null);
  assert.equal(reminders().length, 0);
});

test("no live checkout in the app yet (before the first payment), no reminders: the key can't be checked", () => withReminders(async () => {
  const id = await due();
  await wait();
  assert.deepEqual(await router._remind(db), { off: "stripe_key_unverified" });
  assert.equal(rowOf(id).checkout_reminded_at || null, null);
}, { known: false }));

test("Stripe looks back a week: a bank payment from days ago, or a checkout opened before the request, still counts", () => withReminders(async () => {
  const days = await due({ contact_email: "bank-days@example.com" });
  const tab = await due({ contact_email: "early-tab@example.com" });
  const fine = await due({ contact_email: "nothing-paid@example.com" });
  await wait();
  const ago = (ms) => Math.floor((Date.now() - ms) / 1000);
  stripeSessions = [
    completed({ payment_status: "unpaid", created: ago(3 * 24 * HOUR_MS), customer_details: { email: "bank-days@example.com" } }),
    completed({ created: ago(3 * HOUR_MS), customer_details: { email: "early-tab@example.com" } }),
    completed({ created: ago(8 * 24 * HOUR_MS), customer_details: { email: "nothing-paid@example.com" } }),
  ];
  assert.deepEqual(await router._remind(db), { sent: 1 });
  assert.deepEqual(reminders().map((m) => m.to), [["nothing-paid@example.com"]], "a checkout over a week old doesn't stand for this one");
  assert.ok(stripeCalls[0].created.gte <= ago(7 * 24 * HOUR_MS) + 5);
  for (const id of [days, tab]) assert.equal(rowOf(id).checkout_reminded_at || null, null, id);
  assert.ok(rowOf(fine).checkout_reminded_at);
}));

test("one visitor's three a day are shared with their notes: a visitor whose requests sent three notes sends no reminder", () => withReminders(async () => {
  for (let i = 0; i < 3; i++) await form(good({ event_date: "2027-01-16", contact_email: `asked${i}@example.com` }), "203.0.113.150");
  const id = await due({ contact_email: "asked3@example.com" }, "203.0.113.150");
  await wait();
  assert.equal(mails.filter((m) => /we got your booking request/.test(m.subject)).length, 3);
  assert.deepEqual(await router._remind(db), { sent: 0 });
  assert.equal(rowOf(id).checkout_reminded_at || null, null);
}));

test("off with the setting, and without email set up: nothing claimed", () => withReminders(async () => {
  const id = await due();
  await wait();
  process.env.SM_CHECKOUT_REMINDERS = "off";
  try {
    assert.deepEqual(await router._remind(db), { off: "setting" });
  } finally {
    delete process.env.SM_CHECKOUT_REMINDERS;
  }
  delete process.env.EMAIL_USER;
  assert.deepEqual(await router._remind(db), { off: "no_email" });
  assert.equal(rowOf(id).checkout_reminded_at || null, null);
  assert.equal(stripeCalls.length, 0, "Stripe isn't asked when nothing can go");
}));

test("no reminder once it's paid, taken on, two days old, for a game today or past, or when the same mailbox paid or came back", () => withReminders(async () => {
  const paidOne = await due({ contact_email: "paid@example.com" });
  await paidCall({ stripe_session_id: "cs_live_paidlater0001", booking_id: paidOne, package: "video", amount_cents: 9999, contact_email: "paid@example.com" });
  const taken = await due({ contact_email: "taken@example.com" });
  rowOf(taken).status = "contacted";
  const old = await due({ contact_email: "old@example.com" });
  age(old, 2 * 24 * HOUR_MS + 60000);
  const today = await due({ contact_email: "today@example.com" });
  rowOf(today).event_date = B.nyDay();
  const past = await due({ contact_email: "past@example.com" });
  rowOf(past).event_date = "2026-10-01";
  const plain = await due({ contact_email: "plain@example.com", pay_now: false });
  // They came back: a newer request from the same inbox (Gmail ignores dots
  // and +tags).
  const came = await due({ contact_email: "Came.Back+gameday@gmail.com" });
  await form(good({ package: "video", event_date: "2027-01-16", contact_email: "cameback@gmail.com" }), "198.51.100.251");
  // Two pay-now requests from one inbox (two tabs, or sent again): the older
  // one was paid, so the newer one isn't reminded either.
  const first = await due({ contact_email: "twotabs@example.com" });
  const second = await due({ contact_email: "twotabs@example.com" });
  age(first, HOUR_MS + 120000);
  await paidCall({ stripe_session_id: "cs_live_firsttab00001", booking_id: first, package: "video", amount_cents: 9999, contact_email: "twotabs@example.com" });
  await wait();
  mails = [];
  assert.deepEqual(await router._remind(db), { sent: 0 });
  assert.equal(reminders().length, 0);
  for (const id of [taken, old, today, past, plain, came, second]) assert.equal(rowOf(id).checkout_reminded_at || null, null, id);
}));

test("a server that didn't see the request (a restart since) sends no reminder for it", () => withReminders(async () => {
  const id = await due();
  await wait();
  router._forgetVisitors();
  assert.deepEqual(await router._remind(db), { sent: 0 });
  assert.equal(rowOf(id).checkout_reminded_at || null, null);
}));

test("reminders keep their own limits: three a day from one visitor, one a day to a mailbox, ten a run and an hour", () => withReminders(async () => {
  // One visitor, five addresses.
  for (let i = 0; i < 5; i++) await due({ contact_email: `stranger${i}@example.com` }, "203.0.113.99");
  await wait();
  mails = [];
  assert.deepEqual(await router._remind(db), { sent: 3 });
  // One mailbox: a second request after its reminder, from another visitor.
  const a = await due({ contact_email: "once@example.com" }, "203.0.113.100");
  await wait();
  assert.deepEqual(await router._remind(db), { sent: 1 });
  const b = await due({ contact_email: "once@example.com" }, "203.0.113.101");
  await wait();
  assert.deepEqual(await router._remind(db), { sent: 0 }, "one a day to a mailbox");
  assert.ok(rowOf(a).checkout_reminded_at);
  assert.equal(rowOf(b).checkout_reminded_at || null, null);
  // Ten a run, and ten an hour in all.
  router._resetLimits();
  for (let i = 0; i < 14; i++) await due({ contact_email: `many${i}@example.com` });
  await wait();
  assert.deepEqual(await router._remind(db), { sent: 10 });
  assert.deepEqual(await router._remind(db), { sent: 0 }, "the hour's ten are used");
}));

test("a reminder never takes the booker's own notes: the thanks note still goes", () => withReminders(async () => {
  // A request this morning (its note is the inbox's first of the day), then
  // a pay-now request later.
  const plain = await form(good({ event_date: "2027-01-16" }), "198.51.100.200");
  age(plain.data.id, 3 * HOUR_MS);
  const id = await due({}, "198.51.100.201");
  await wait();
  assert.deepEqual(await router._remind(db), { sent: 1 });
  mails = [];
  await paidCall({ stripe_session_id: "cs_live_afterremind02", booking_id: id, package: "video", amount_cents: 9999, contact_email: "jamie@example.com" });
  await wait();
  assert.equal(theirs("jamie@example.com").filter((m) => m.subject === "Subject Medias: thanks for booking").length, 1);
}));

test("a mailer that can't send now ends the run, its claim given back: no churn through the rest", () => withReminders(async () => {
  const one = await due({ contact_email: "one@example.com" });
  const two = await due({ contact_email: "two@example.com" });
  await wait();
  let calls = 0;
  try {
    mailer.setSender(async () => { calls += 1; return { sent: false, reason: "daily_limit" }; });
    assert.deepEqual(await router._remind(db), { sent: 0 });
    assert.equal(calls, 1, "the run stops at the first");
    assert.equal(rowOf(one).checkout_reminded_at, null, "its claim is given back");
    assert.equal(rowOf(two).checkout_reminded_at || null, null, "the second wasn't claimed");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
  assert.deepEqual(await router._remind(db), { sent: 2 }, "a later run sends both");
}));

test("a send that throws is tried three times, the others still go", () => withReminders(async () => {
  const bad = await due({ contact_email: "bounces@example.com" }, "198.51.100.210");
  await wait();
  let tries = 0;
  try {
    mailer.setSender(async () => { tries += 1; throw Object.assign(new Error("550 5.1.1 <bounces@example.com> no such user"), { responseCode: 550 }); });
    for (let i = 0; i < 5; i++) await router._remind(db);
    assert.equal(tries, 3, "three tries, then it stops");
    assert.equal(rowOf(bad).checkout_reminded_at, null, "the app doesn't say it went");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
  const good2 = await due({ contact_email: "fine@example.com" }, "198.51.100.211");
  await wait();
  assert.deepEqual(await router._remind(db), { sent: 1 });
  assert.ok(rowOf(good2).checkout_reminded_at);
}));

test("the app says no payment yet and when the reminder went; paying finishes it", () => withReminders(async () => {
  const r = await form(good({ event_date: "2027-01-16", package: "photo", pay_now: true }));
  await wait();
  const cookie = await staffCookie();
  const mine = async () => (await call("GET", "/api/sm/bookings", undefined, {}, cookie)).data.bookings.find((b) => b.id === r.data.id);
  let b = await mine();
  assert.equal(b.pay_now, true);
  assert.equal(b.unfinished, false, "still on its way, inside the hour");
  assert.ok(!("contact_email" in b) && !("notes" in b), "the list still carries no contact details or notes");
  age(r.data.id, HOUR_MS + 60000);
  b = await mine();
  assert.equal(b.unfinished, true);
  assert.equal(b.checkout_reminded_at, null);
  await router._remind(db);
  const one = await call("GET", "/api/sm/bookings/" + r.data.id, undefined, {}, cookie);
  assert.equal(one.data.booking.unfinished, true);
  assert.ok(one.data.booking.checkout_reminded_at);
  mails = [];
  await paidCall({ stripe_session_id: "cs_live_afterremind01", booking_id: r.data.id, package: "photo", amount_cents: 4999, contact_email: "jamie@example.com" });
  await wait();
  const after = await call("GET", "/api/sm/bookings/" + r.data.id, undefined, {}, cookie);
  assert.equal(after.data.booking.paid, true);
  assert.equal(after.data.booking.unfinished, false);
  assert.equal(theirs("jamie@example.com").filter((m) => m.subject === "Subject Medias: thanks for booking").length, 1, "the thanks note still goes");
}));

test("the checkout link, the hour and the game day, by the rules", () => {
  const id = "8f14e45f-ceea-467e-a1d0-6f1d4c6b2a01";
  assert.equal(B.checkoutLink({ id, package: "elite", contact_email: "a+your.account.is.locked@example.com" }), `https://buy.stripe.com/dRm14o82vbeidoQ5S9ebu03?client_reference_id=${id}`, "no address (and no +tag words) in the link");
  assert.equal(B.checkoutLink({ id: id.toUpperCase(), package: "photo" }), `https://buy.stripe.com/28E00kgz1dmqckMcgxebu04?client_reference_id=${id}`);
  assert.equal(B.checkoutLink({ id, package: "transcript" }), null, "not a pay-now package");
  assert.equal(B.checkoutLink({ id: "1 or 1=1", package: "photo" }), null);
  const base = { pay_now: true, source: "form", status: "new", created_at: new Date(Date.now() - 2 * HOUR_MS).toISOString() };
  assert.equal(B.checkoutUnfinished(base), true);
  assert.equal(B.checkoutUnfinished({ ...base, stripe_session_id: "cs_live_x12345678" }), false);
  assert.equal(B.checkoutUnfinished({ ...base, status: "staffed" }), false);
  assert.equal(B.checkoutUnfinished({ ...base, pay_now: false }), false);
  assert.equal(B.checkoutUnfinished({ ...base, source: "stripe" }), false);
  assert.equal(B.checkoutUnfinished({ ...base, created_at: new Date().toISOString() }), false);
  assert.equal(B.checkoutUnfinished({ ...base, created_at: "not a date" }), false);
  // 23:00 UTC on Nov 7 is still Nov 7 in New York: a Nov 7 game is today.
  const late = new Date("2026-11-07T23:00:00Z");
  assert.equal(B.nyDay(late), "2026-11-07");
  assert.equal(B.gameAfterToday({ event_date: "2026-11-06" }, late), false);
  assert.equal(B.gameAfterToday({ event_date: "2026-11-07" }, late), false, "game day is too late for a reminder");
  assert.equal(B.gameAfterToday({ event_date: "2026-11-08" }, late), true);
  assert.equal(B.gameAfterToday({ event_date: "2026-11-08" }, new Date("2026-11-08T06:00:00Z")), false, "1 a.m. in New York is the next day");
  assert.equal(B.gameAfterToday({ event_date: null }, late), false);
  assert.deepEqual(Object.keys(B.PAY_NOW), ["photo", "video", "elite"]);
});
