// The public Pylon pages: the rules each form must meet, the consent words,
// the emails, and the routes (in-process, on the fake Supabase), with a fake
// Stripe for checkouts and Stripe's own signatures for the webhook.
//
//   node --test tests/pylon.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

process.env.ADMIN_EMAILS = "kyron@toj.test";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;
delete process.env.PYLON_STRIPE_SECRET_KEY;
delete process.env.PYLON_SITE_BASE;
process.env.PYLON_STRIPE_WEBHOOK_SECRET = "whsec_test_pylon_0123456789";

const express = require("express");
const session = require("express-session");
const Stripe = require("stripe");
const U = require("../utils/pylon");
const PS = require("../utils/pylon-stripe");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const router = require("../routes/pylon");

const ROOT = path.join(__dirname, "..");
const NOW = new Date("2026-11-07T12:00:00Z");
// A form as the page sends it: with the consent words it showed.
function form_(base, over) {
  const f = { ...base, ...over };
  if (!("consent_words" in (over || {})) && U.ATHLETE_KINDS.includes(f.kind)) f.consent_words = U.consentText(f.kind, f.who) || "";
  return f;
}
const player = (over = {}) =>
  form_(
    {
      kind: "player_package",
      package: "13",
      who: "parent",
      consent_confirm: true,
      athlete_name: "Jordan Ellis",
      position: "wr",
      class_year: "2028",
      team_name: "Dallas Elite 15U",
      event: "Pylon Dallas Regional, Nov 21",
      contact_name: "Pat Ellis",
      contact_email: "Pat@Example.com",
    },
    over
  );
const ambassador = (over = {}) =>
  form_({ kind: "ambassador", package: "featured", who: "parent", consent_confirm: true, athlete_name: "Sam Ray", athlete_email: "sam.ray@gmail.com", position: "QB", class_year: "2028", team_name: "Elite", contact_name: "Mo Ray", contact_email: "mo@example.com" }, over);
const recruiting = (over = {}) =>
  form_({ kind: "recruiting", package: "hbcu_monthly", who: "guardian", consent_confirm: true, athlete_name: "Alex Brown", contact_name: "Dana Brown", contact_email: "dana@example.com", contact_phone: "555-010-2030", position_class: "WR 2027", target_level: "hbcu" }, over);
const team = (over = {}) => ({ kind: "team_package", package: "1a", contact_name: "Lee Carter", contact_email: "coach@example.com", team_name: "Dallas Elite 15U", region: "south_central", ...over });
const norm = (raw) => U.normalize(raw, { now: NOW });

// ── The rules ────────────────────────────────────────────────────────────
test("a player request passes, cleaned up, at the server's price", () => {
  const { errors, value } = norm(player({ price_cents: 1, amount_cents: 1, package_name: "Free stuff" }));
  assert.deepEqual(errors, []);
  assert.equal(value.price_cents, 9900, "the page's numbers are ignored");
  assert.equal(value.package_name, "Pylon Player Story");
  assert.equal(value.contact_email, "pat@example.com");
  assert.equal(value.contact_role, "parent");
  assert.equal(value.consent, "parent");
  assert.equal(value.details.position, "WR");
  assert.equal(value.consent_text, U.consentText("player_package", "parent"));
});

test("the form never clears public posting: that's a separate yes, recorded at the event", () => {
  for (const who of ["parent", "guardian", "adult"]) {
    assert.match(U.consentText("player_package", who), /posts it publicly only with (a separate yes from a parent or guardian|my separate yes), recorded at the event\.$/);
  }
  const { value } = norm(player({ public_ok: "on" }));
  assert.equal(value.details.public_ok, undefined);
  assert.ok(![...Object.keys(value), ...Object.keys(value.details)].some((k) => /public/.test(k)), "nothing on the request says it may be posted");
});

test("every kind's required fields are named when missing", () => {
  const miss = (raw, fields) => {
    const { errors } = norm(raw);
    for (const f of fields) assert.ok(errors.includes(f), `${raw.kind}: ${f} (got ${errors})`);
  };
  miss({ kind: "team_package", package: "1a" }, ["contact_name", "contact_email", "team_name", "region"]);
  miss({ kind: "player_package", package: "12" }, ["who", "athlete_name", "contact_name", "contact_email", "position", "class_year", "team_name", "event"]);
  miss({ kind: "transcript", package: "individual" }, ["who", "athlete_name", "position_class", "team_name"]);
  miss(form_({ kind: "recruiting", package: "standard_monthly", who: "parent", consent_confirm: true }), ["athlete_name", "position_class", "target_level", "contact_phone"]);
  miss({ kind: "newsletter_premium", package: "premium" }, ["contact_name", "contact_email"]);
  miss(form_({ kind: "ambassador", package: "standard", who: "parent", consent_confirm: true }), ["athlete_name", "athlete_email", "position", "class_year", "team_name", "contact_name", "contact_email"]);
});

test("a package and a kind come only from the list; odd JSON never throws", () => {
  assert.deepEqual(norm({ kind: "toString" }).errors, ["kind"]);
  assert.ok(norm(player({ package: "constructor" })).errors.includes("package"));
  assert.ok(norm(player({ package: "1a" })).errors.includes("package"), "a team package isn't a player package");
  assert.doesNotThrow(() => U.normalize(null));
  assert.doesNotThrow(() => U.normalize([1, 2]));
  const evil = { toString: 1 };
  assert.doesNotThrow(() => norm(player({ athlete_name: evil, contact_email: ["a@b.co"], who: evil, notes: {}, event: [], referral_code: evil, consent_words: evil })));
});

test("only a parent, a legal guardian or the athlete at 18+ can send one, and the box has to be ticked", () => {
  assert.ok(norm(player({ who: "minor" })).errors.includes("who"), "an athlete under 18 can't");
  assert.ok(norm(player({ who: "friend" })).errors.includes("who"));
  assert.ok(norm(player({ consent_confirm: false })).errors.includes("consent_confirm"));
  assert.ok(norm(player({ consent_confirm: "no" })).errors.includes("consent_confirm"));
  assert.deepEqual(norm(player({ consent_confirm: "on" })).errors, []);
  const g = norm(player({ who: "guardian" })).value;
  assert.equal(g.contact_role, "guardian");
  assert.match(g.consent_text, /^I'm the athlete's legal guardian\./);
  const a = norm(player({ who: "adult", contact_name: "" })).value;
  assert.equal(a.contact_role, "athlete");
  assert.equal(a.contact_name, "Jordan Ellis");
  assert.match(a.consent_text, /^I'm the athlete and I'm 18 or older\. I agree to Pylon filming and photographing me/);
});

test("18 or older can't go with a class that isn't 18 yet", () => {
  // Nov 2026: seniors are the class of 2027; 2028 can be 18, 2029 on can't.
  assert.deepEqual(norm(player({ who: "adult", class_year: "2028" })).errors, []);
  assert.ok(norm(player({ who: "adult", class_year: "2029" })).errors.includes("who_age"));
  assert.ok(norm(ambassador({ who: "adult", class_year: "2031", contact_name: "", contact_email: "" })).errors.includes("who_age"));
  assert.ok(norm(recruiting({ who: "adult", position_class: "WR 2030", contact_name: "" })).errors.includes("who_age"), "the year in 'WR 2030'");
  assert.deepEqual(norm(player({ who: "parent", class_year: "2032" })).errors, [], "a parent can send for any class");
  assert.equal(U.seniorClass(new Date("2027-03-01T00:00:00Z")), 2027);
  assert.equal(U.seniorClass(new Date("2027-08-15T00:00:00Z")), 2028);
});

test("the words stored are the words the page showed: anything else is refused", () => {
  assert.ok(norm(player({ consent_words: "I agree to whatever." })).errors.includes("consent_words"));
  assert.ok(norm(player({ consent_words: undefined })).errors.includes("consent_words"));
  assert.ok(norm(player({ consent_words: U.consentText("player_package", "guardian") })).errors.includes("consent_words"), "another answer's words");
  assert.deepEqual(norm(player({ consent_words: "  " + U.consentText("player_package", "parent") + " " })).errors, [], "spacing aside");
});

test("names are names: nothing that reads as a link or an address", () => {
  for (const bad of ["https://evil.example/login", "evil.example", "Visit evil.com now", "Bob 2", "a@b.co", "Pat <b>", "x:y"]) {
    assert.ok(norm(player({ contact_name: bad })).errors.includes("contact_name"), bad);
    assert.ok(norm(player({ athlete_name: bad })).errors.includes("athlete_name"), bad);
  }
  for (const good of ["Mary-Jane O’Neil", "D'Andre Smith", "Ellis, Jr.", "José Ñúñez", "A. B. Carter", "李小龙", "A.J. Brown", "T.J. Watt", "J.J.", "J.T. Smith"]) assert.deepEqual(norm(player({ contact_name: good })).errors, [], good);
  for (const bad of ["x.co", "Pat at evil.example", "a.b.cd"]) assert.ok(norm(player({ contact_name: bad })).errors.includes("contact_name"), bad);
  assert.ok(norm(team({ contact_name: "https://x.example" })).errors.includes("contact_name"));
  assert.ok(norm({ kind: "newsletter_premium", package: "premium", contact_name: "go to evil.example", contact_email: "a@b.co" }).errors.includes("contact_name"));
});

test("an ambassador application: a minor's comes from the parent, with an address that isn't the athlete's", () => {
  assert.ok(norm(ambassador({ contact_email: "samray+parent@gmail.com" })).errors.includes("contact_email_same"), "Gmail dots and +tags are the same mailbox");
  const ok = norm(ambassador({ ig_handle: "@sam.ray", tiktok_handle: "bad handle!", follower_count: "5,200", why: "I post film." }));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.contact_role, "parent");
  assert.equal(ok.value.details.athlete_email, "sam.ray@gmail.com");
  assert.equal(ok.value.details.ig_handle, "sam.ray");
  assert.equal(ok.value.details.tiktok_handle, undefined);
  assert.equal(ok.value.details.follower_count, 5200);
  assert.equal(ok.value.notes, "I post film.");
  assert.equal(ok.value.price_cents, null, "an application has no price");
  const adult = norm(ambassador({ who: "adult", contact_name: "", contact_email: "" }));
  assert.deepEqual(adult.errors, []);
  assert.equal(adult.value.contact_email, "sam.ray@gmail.com");
  assert.equal(adult.value.contact_role, "athlete");
});

test("a creator code is cleaned up, and only a player package keeps one", () => {
  assert.equal(norm(player({ referral_code: " kay-25 " })).value.referral_code, "KAY-25");
  assert.equal(norm(player({ referral_code: "<script>" })).value.referral_code, null);
  assert.equal(norm(team({ referral_code: "KAY25" })).value.referral_code, null);
});

test("emails: a plain address only, nothing that could copy someone into a draft", () => {
  const bad = (e) => norm(player({ contact_email: e })).errors.includes("contact_email");
  assert.equal(bad("x@y.co?cc=thief%40evil.example"), true);
  assert.equal(bad("x@y.co#frag"), true);
  assert.equal(bad("a b@c.co"), true);
  assert.equal(bad("o'brien+games@example.co.uk"), false);
});

test("the page's consent words are the server's, for every kind and answer", () => {
  const src = fs.readFileSync(path.join(ROOT, "public", "pylon-forms.js"), "utf8");
  const box = { window: {} };
  vm.runInNewContext(src, box);
  const page = box.window.PylonForms.consentWords;
  for (const kind of U.ATHLETE_KINDS) for (const who of ["parent", "guardian", "adult"]) assert.equal(page(kind, who), U.consentText(kind, who), `${kind} ${who}`);
  assert.equal(page("player_package", "minor"), null);
});

test("every page sends what its kind needs, by the field names the server reads", () => {
  const pages = {
    "pylon-team-packages.html": ["team_package", ["team_name", "contact_name", "contact_email", "region", "event", "notes", "pf_trap", "package"]],
    "pylon-player-packages.html": ["player_package", ["who", "athlete_name", "position", "class_year", "team_name", "event", "contact_name", "contact_email", "consent_confirm", "referral_code", "package"]],
    "pylon-athlete-subscribe.html": ["transcript", ["who", "athlete_name", "position_class", "team_name", "contact_email", "consent_confirm", "package"]],
    "pylon-recruiting.html": ["recruiting", ["who", "athlete_name", "position_class", "target_level", "contact_email", "contact_phone", "consent_confirm", "package"]],
    "pylon-ambassadors.html": ["ambassador", ["who", "athlete_name", "athlete_email", "position", "class_year", "team_name", "contact_name", "contact_email", "package", "why", "consent_confirm"]],
    "pylon-newsletter.html": ["newsletter_premium", ["contact_name", "contact_email", "email", "pf_trap"]],
  };
  for (const [file, [kind, names]] of Object.entries(pages)) {
    const html = fs.readFileSync(path.join(ROOT, "public", file), "utf8");
    assert.ok(html.includes(`data-kind="${kind}"`), `${file}: ${kind}`);
    assert.ok(html.includes('src="/pylon-forms.js"'), `${file}: the shared script`);
    for (const n of names) assert.ok(html.includes(`name="${n}"`), `${file}: ${n}`);
    assert.ok(!html.includes('name="public_ok"'), `${file}: no public-posting box`);
    assert.ok(!/alert\(|\/api\/pylon\/(packages|subscriptions|recruiting|ambassadors)\b|Kaydon/.test(html), `${file}: nothing of the old form`);
    assert.ok(!/amplification|guaranteed|already reaching out/i.test(html), `${file}: no promises the program can't keep`);
    for (const m of html.matchAll(/data-package="([a-z0-9_]+)"/g)) assert.ok(U.CATALOG[kind] && U.CATALOG[kind][m[1]], `${file}: package ${m[1]}`);
  }
  const concierge = fs.readFileSync(path.join(ROOT, "public", "pylon-recruiting.html"), "utf8");
  assert.ok(!/Momentum Score|AI agent|sentiment/i.test(concierge), "the Concierge is people drafting messages a parent approves");
  const news = fs.readFileSync(path.join(ROOT, "public", "pylon-newsletter.html"), "utf8");
  assert.ok(!/Issue #0\d/.test(news), "no made-up past issues");
});

test("the notes say what came in, and staff alerts carry no names", () => {
  const r = { ...norm(player()).value, id: "11111111-1111-4111-8111-111111111111" };
  const p = U.pushPayload(r);
  const s = U.staffEmail(r, "https://tojcampaign.com");
  for (const text of [p.title, p.body, s.subject, s.text]) assert.ok(!text.includes("Jordan") && !text.includes("Pat") && !text.includes("example.com"), text);
  assert.match(s.text, /#pylon-request\/11111111-1111-4111-8111-111111111111/);
  const unsaved = U.staffEmail(r, "https://tojcampaign.com", { saved: false });
  assert.match(unsaved.text, /only copy/);
  assert.match(unsaved.text, /Jordan Ellis/);
  const c = U.contactEmail(r, { checkout: false });
  assert.match(c.text, /^Hi Pat,/);
  assert.match(c.text, /Pylon Player Story \(\$99\) for Jordan Ellis/);
  assert.match(c.text, /Nothing is charged until you pay it/);
  assert.match(c.text, /What you agreed to on the form:\nI'm the athlete's parent/);
  assert.match(c.text, /Didn't send this\?/);
  assert.match(U.contactEmail(r, { checkout: true }).text, /Stripe's secure checkout/);
  const coach = U.contactEmail(norm(team({ package: "1b" })).value);
  assert.match(coach.text, /only post an athlete's footage publicly once their parent or guardian has said yes/);
  const nobody = (t) => !/viral|followers|exposure|guarantee/i.test(t);
  assert.ok(nobody(c.text) && nobody(coach.text), "no promises of reach");
  // A test payment says so, to staff and on the note.
  const paidTest = { ...r, paid_at: "2026-11-07T12:00:00Z", paid_cents: 9900, paid_via: "stripe", checkout_mode: "test", checkout_session_id: "cs_test_abcdefgh12" };
  assert.equal(U.pushPayload(paidTest).title, "Pylon: test payment");
  assert.match(U.staffEmail(paidTest, "x", { paid: true }).subject, /^Pylon TEST payment/);
  assert.match(U.paidEmail(paidTest).subject, /^\[TEST\]/);
  assert.match(U.paidEmail(paidTest).text, /No money moved/);
  assert.equal(U.paidEmail({ ...paidTest, checkout_mode: "live" }).subject, "Pylon: payment received");
  assert.equal(U.money(999), "$9.99");
  assert.equal(U.money(149900), "$1,499");
});

// ── The routes ───────────────────────────────────────────────────────────
let server, base, db, pushes, mails, created, expired, promos, stripeStatus;
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, body, headers = {}) {
  const r = await fetch(base + p, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  return { status: r.status, data, cookie: r.headers.get("set-cookie") };
}
const send = (body, ip = "203.0.113.7", headers = {}) => call("POST", "/api/pylon/requests", body, { "X-Forwarded-For": ip, ...headers });
async function staffCookie(email = "kyron@toj.test", role = "staff") {
  const r = await call("POST", "/__test/session", { email, role });
  return r.cookie.split(";")[0];
}
const helper = new Stripe("sk_test_helper_only");
function signed(event, secret = process.env.PYLON_STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  return call("POST", "/api/pylon/stripe/webhook", payload, { "Stripe-Signature": helper.webhooks.generateTestHeaderString({ payload, secret }) });
}
const paidEvent = (id, sid, over = {}) => ({
  id: "evt_test_1",
  type: "checkout.session.completed",
  data: { object: { id: sid, object: "checkout.session", client_reference_id: id, payment_status: "paid", amount_total: 9900, livemode: true, metadata: { kind: "pylon", request_id: id, package: "13" }, ...over } },
});
// A fake Stripe: records the checkouts it's asked for and the ones it closes.
function fakeStripe({ mode = "live", fail = false } = {}) {
  return {
    mode,
    stripe: {
      checkout: {
        sessions: {
          create: async (params) => {
            if (fail) throw Object.assign(new Error("boom"), { type: "StripeAPIError" });
            const id = `cs_${mode}_` + String(created.length + 1).padStart(10, "a");
            created.push(params);
            return { id, url: "https://checkout.stripe.com/c/pay/" + id };
          },
          expire: async (id) => {
            if (stripeStatus[id] && stripeStatus[id] !== "open") throw Object.assign(new Error("not open"), { type: "StripeInvalidRequestError" });
            expired.push(id);
            stripeStatus[id] = "expired";
            return { id, status: "expired" };
          },
          retrieve: async (id) => ({ id, status: stripeStatus[id] || "open" }),
        },
      },
      promotionCodes: { list: async ({ code }) => ({ data: promos[code] ? [promos[code]] : [] }) },
    },
  };
}

before(async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "pylon-test", resave: false, saveUninitialized: false }));
  app.post("/__test/session", (req, res) => {
    req.session.userEmail = req.body.email;
    req.session.userRole = req.body.role;
    res.json({ ok: true });
  });
  app.use("/api/pylon", router);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  push.setSender(async (sub, payload) => { pushes.push({ to: sub.email, payload }); return {}; });
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
});
after(() => { server && server.close(); push.setSender(null); mailer.setSender(null); setSupabase(null); PS._set(null); });
beforeEach(() => {
  router._reset();
  PS._set(null);
  pushes = [];
  mails = [];
  created = [];
  expired = [];
  promos = {};
  stripeStatus = {};
  db = fakeSupabase(
    { push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }] },
    { unique: { pylon_requests: ["checkout_session_id"], pylon_newsletter: ["email", "unsubscribe_token", "confirm_token_hash"] } }
  );
  setSupabase(db);
});

test("a request is saved, staff get a push and an email, and the contact one note", async () => {
  const r = await send(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.checkout_url, null, "no Stripe set up: no checkout");
  await wait();
  const row = db.tables.pylon_requests[0];
  assert.equal(row.id, r.data.id);
  assert.equal(row.price_cents, 9900);
  assert.equal(row.consent_text, U.consentText("player_package", "parent"));
  assert.ok(row.alerted_at && row.contact_emailed_at);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.url, `/app/#pylon-request/${row.id}`);
  const staff = mails.find((m) => m.to.includes("kyron@toj.test"));
  const contact = mails.find((m) => m.to.includes("pat@example.com"));
  assert.ok(staff && contact);
  assert.ok(!staff.text.includes("Jordan"), "the staff email names no one");
  assert.equal(contact.replyTo, "hello@pylonfootball.com");
});

test("only JSON from the site's own pages: another site's form is refused", async () => {
  // A hidden form on another site posts urlencoded (or text/plain): refused.
  const enc = new URLSearchParams({ kind: "team_package", package: "1a", contact_name: "Lee Carter", contact_email: "x@example.com", team_name: "T", region: "west" }).toString();
  assert.equal((await call("POST", "/api/pylon/requests", enc, { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.example" })).status, 415);
  assert.equal((await call("POST", "/api/pylon/requests", JSON.stringify(team()), { "Content-Type": "text/plain" })).status, 415);
  // JSON with another site's Origin: refused. The site's own, or none: fine.
  assert.equal((await send(team(), "203.0.113.8", { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await send(team(), "203.0.113.8", { Origin: "null" })).status, 403, "a sandboxed frame's");
  assert.equal((await send(team(), "203.0.113.8", { Origin: "https://tojcampaign.com" })).status, 200);
  assert.equal((await send(team(), "203.0.113.8", { Origin: "https://www.tojcampaign.com" })).status, 200);
  assert.equal((await send(team(), "203.0.113.8", { Origin: base })).status, 200, "the app's own host");
  for (const p of ["/api/pylon/newsletter/subscribe", "/api/pylon/newsletter/confirm", "/api/pylon/newsletter/unsubscribe"]) {
    assert.equal((await call("POST", p, "email=a%40b.co", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415, p);
    assert.equal((await call("POST", p, { email: "a@b.co", token: "x" }, { Origin: "https://attacker.example" })).status, 403, p);
  }
  assert.equal((db.tables.pylon_requests || []).length, 3);
});

test("a bad form is refused with its fields, a bot's is dropped quietly", async () => {
  const r = await send(player({ who: "minor", event: "" }));
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.includes("who") && r.data.fields.includes("event"));
  const words = await send(player({ consent_words: "I agree to anything." }));
  assert.deepEqual(words.data.fields, ["consent_words"]);
  const bot = await send(player({ pf_trap: "http://spam.example" }));
  assert.equal(bot.status, 200);
  assert.equal(bot.data.id, null);
  assert.equal((db.tables.pylon_requests || []).length, 0);
});

test("limits: 12 forms per visitor per 10 minutes, however an IPv6 /64 is written", async () => {
  for (let i = 0; i < 12; i++) assert.equal((await send(player())).status, 200);
  assert.equal((await send(player())).status, 429);
  assert.equal((await send(player(), "198.51.100.9")).status, 200, "another visitor is fine");
  router._reset();
  for (let i = 0; i < 12; i++) assert.equal((await send(player(), `2001:db8:0:1::${i + 1}`)).status, 200);
  assert.equal((await send(player(), "2001:0db8:0000:0001:ffff::1")).status, 429);
});

test("made-up visitor addresses from one caller still meet the connection's limit", async () => {
  let ok = 0;
  for (let i = 0; i < 160; i++) if ((await send(team(), `192.0.${Math.floor(i / 200)}.${i % 200}`)).status === 200) ok += 1;
  assert.equal(ok, 150, "150 forms that pass per connection per 10 minutes, whatever X-Forwarded-For says");
});

test("junk from many visitors doesn't use up the connection's count", async () => {
  for (let v = 0; v < 20; v++) for (let i = 0; i < 10; i++) assert.equal((await send({ kind: "team_package", package: "1a" }, `198.18.7.${v}`)).status, 400);
  assert.equal((await send(team(), "203.0.113.120")).status, 200, "a real coach after 200 junk posts");
  for (let i = 0; i < 70; i++) await call("POST", "/api/pylon/newsletter/unsubscribe", { token: "a".repeat(64) }, { "X-Forwarded-For": `198.18.8.${i}` });
  const tok = "b".repeat(64);
  db.tables.pylon_newsletter = [{ id: "n1", email: "fan@example.com", status: "confirmed", confirmed_at: new Date().toISOString(), unsubscribe_token: tok }];
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: tok }, { "X-Forwarded-For": "203.0.113.121" })).status, 200, "bad links from others don't block a real unsubscribe");
});

test("the hour's count is of forms that pass: junk can't lock people out", async () => {
  const L = router._limits;
  const fresh = () => { L.perVisitor.reset(); L.perPeer.reset(); };
  for (let i = 0; i < 310; i++) {
    if (i % 50 === 0) fresh();
    assert.equal((await send({ kind: "team_package", package: "1a" }, `198.18.${i % 200}.1`)).status, 400);
  }
  fresh();
  assert.equal((await send(team(), "203.0.113.99")).status, 200, "310 bad forms later, a good one gets in");
  for (let i = 1; i < 300; i++) {
    if (i % 50 === 0) fresh();
    assert.equal((await send(team(), `198.19.${i % 250}.${Math.floor(i / 250)}`)).status, 200);
  }
  fresh();
  assert.equal((await send(team(), "203.0.113.100")).status, 429, "300 good ones an hour");
  assert.equal((await call("POST", "/api/pylon/newsletter/subscribe", { email: "fan@example.com" }, { "X-Forwarded-For": "203.0.113.98" })).status, 200, "the newsletter has its own count");
});

test("the contact's notes: at most 2 a day to one mailbox, however the address is written", async () => {
  await send(player({ contact_email: "pat.ellis@gmail.com" }), "203.0.113.1");
  await send(player({ contact_email: "patellis+a@gmail.com" }), "203.0.113.2");
  await send(player({ contact_email: "PAT.ELLIS@googlemail.com" }), "203.0.113.3");
  await wait();
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 2);
  assert.equal(db.tables.pylon_requests.length, 3, "every request is still saved");
  assert.equal(db.tables.pylon_requests.filter((x) => x.contact_emailed_at).length, 2, "the app shows which got one");
});

test("one visitor's notes: 6 a day, to different mailboxes; every request is still saved", async () => {
  for (let i = 0; i < 7; i++) assert.equal((await send(player({ contact_email: `parent${i}@example.com` }), "203.0.113.70")).status, 200);
  await wait();
  assert.equal(db.tables.pylon_requests.length, 7);
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 6, "the 7th note from one visitor doesn't go");
});

test("a note that couldn't go is given back: the app shows it didn't", async () => {
  mailer.setSender(async (m) => { mails.push(m); return m.to.includes("kyron@toj.test") ? { sent: true } : { sent: false, reason: "send_failed" }; });
  try {
    await send(player());
    await wait();
    assert.equal(db.tables.pylon_requests[0].contact_emailed_at, null);
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("the database down: the whole request goes to staff by email, within its own budget", async () => {
  setSupabase(null);
  const r = await send(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.id, null);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].critical, true);
  assert.match(mails[0].text, /only copy/);
  for (let i = 0; i < 12; i++) await send(team(), `198.51.100.${i}`);
  assert.equal(mails.length, 10, "10 an hour, so an outage plus junk can't spend the day");
  assert.equal((await send(team(), "198.51.100.200")).status, 503, "past it: say so");
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  try {
    router._reset();
    assert.equal((await send(player())).status, 503, "neither the database nor email: say so");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("the tables not there yet: 503, and no fallback email", async () => {
  const failing = (error) => ({ from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }) }) });
  setSupabase(failing({ code: "PGRST205", message: "Could not find the table 'public.pylon_requests' in the schema cache" }));
  assert.equal((await send(player())).status, 503);
  setSupabase(failing({ code: "42P01", message: 'relation "public.pylon_requests" does not exist' }));
  assert.equal((await send(player(), "198.51.100.41")).status, 503);
  setSupabase(failing({ code: "PGRST102", message: "Bad Request" }));
  assert.equal((await send(player(), "198.51.100.40")).status, 400, "PostgREST refusing the body is the input's fault");
  assert.equal(mails.length, 0);
});

test("with live Stripe: a checkout at the server's price, for this request, and the page goes there", async () => {
  PS._set(fakeStripe());
  assert.deepEqual((await call("GET", "/api/pylon/checkout")).data, { open: true });
  const r = await send(player({ price_cents: 1 }));
  assert.equal(r.status, 200);
  assert.match(r.data.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
  const p = created[0];
  assert.equal(p.mode, "payment");
  assert.equal(p.line_items[0].price_data.unit_amount, 9900);
  assert.equal(p.line_items[0].price_data.product_data.name, "Pylon Player Story");
  assert.equal(p.client_reference_id, r.data.id);
  assert.equal(p.metadata.kind, "pylon");
  assert.equal(p.customer_email, "pat@example.com");
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.allow_promotion_codes, undefined, "no typed codes: only Pylon's creator codes, by the link");
  assert.equal(p.success_url, "https://tojcampaign.com/pylon-player-packages.html?paid=1");
  assert.equal(db.tables.pylon_requests[0].checkout_mode, "live");
  await wait();
  assert.match(mails.find((m) => m.to.includes("pat@example.com")).text, /Stripe's secure checkout/);
});

test("Stripe's test mode is for staff only: the public never meets a test checkout", async () => {
  PS._set(fakeStripe({ mode: "test" }));
  assert.deepEqual((await call("GET", "/api/pylon/checkout")).data, { open: false });
  const anon = await send(player());
  assert.equal(anon.data.checkout_url, null);
  assert.equal(created.length, 0);
  await wait();
  assert.match(mails.find((m) => m.to.includes("pat@example.com")).text, /send you a secure payment link|payment link/i);
  const c = await staffCookie();
  assert.deepEqual((await call("GET", "/api/pylon/checkout", undefined, { Cookie: c })).data, { open: true });
  const staff = await send(player(), "203.0.113.50", { Cookie: c });
  assert.match(staff.data.checkout_url, /cs_test_/);
  assert.equal(db.tables.pylon_requests[1].checkout_mode, "test");
});

test("a test payment shows as one, to staff and on the note", async () => {
  PS._set(fakeStripe({ mode: "test" }));
  const c = await staffCookie();
  const r = await send(player(), "203.0.113.51", { Cookie: c });
  const row = db.tables.pylon_requests[0];
  await wait();
  mails = [];
  pushes = [];
  await signed(paidEvent(r.data.id, row.checkout_session_id, { livemode: false }));
  await wait();
  assert.equal(db.tables.pylon_requests[0].checkout_mode, "test");
  assert.equal(pushes[0].payload.title, "Pylon: test payment");
  assert.ok(mails.some((m) => /^Pylon TEST payment/.test(m.subject)));
  assert.ok(mails.some((m) => /^\[TEST\] Pylon: payment received/.test(m.subject)));
  const list = await call("GET", "/api/pylon/requests", undefined, { Cookie: c });
  assert.equal(list.data.requests[0].test, true);
});

test("a monthly package is a subscription; a season one is one payment; an application has none", async () => {
  PS._set(fakeStripe());
  await send(recruiting());
  assert.equal(created[0].mode, "subscription");
  assert.deepEqual(created[0].line_items[0].price_data.recurring, { interval: "month" });
  assert.equal(created[0].line_items[0].price_data.unit_amount, 14900);
  assert.ok(created[0].subscription_data && !created[0].payment_intent_data);
  await send(form_({ kind: "transcript", package: "combine", who: "adult", consent_confirm: true, athlete_name: "Alex Brown", contact_email: "ab@example.com", position_class: "WR 2027", team_name: "Elite" }), "198.51.100.2");
  assert.equal(created[1].mode, "payment");
  assert.equal(created[1].line_items[0].price_data.unit_amount, 24900);
  const app = await send(ambassador({ who: "adult", contact_name: "", contact_email: "", package: "flagship" }), "198.51.100.3");
  assert.equal(app.data.checkout_url, null);
  assert.equal(created.length, 2);
});

test("only Pylon's creator codes come off: one marked pylon_creator=yes", async () => {
  PS._set(fakeStripe());
  promos.KAY25 = { id: "promo_123", metadata: { pylon_creator: "yes" } };
  promos.GAMEDAY10 = { id: "promo_999", metadata: {} };
  await send(player({ referral_code: "kay25" }));
  assert.deepEqual(created[0].discounts, [{ promotion_code: "promo_123" }]);
  await send(player({ referral_code: "gameday10" }), "198.51.100.5");
  assert.equal(created[1].discounts, undefined, "another business's code on the account doesn't apply");
  assert.equal(db.tables.pylon_requests[0].price_cents, 9900, "the list price stays on the request");
});

test("a checkout that doesn't start leaves the request standing", async () => {
  PS._set(fakeStripe({ fail: true }));
  const r = await send(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.checkout_url, null);
  assert.equal(db.tables.pylon_requests[0].checkout_session_id ?? null, null);
});

test("a live key stays off until PYLON_STRIPE_LIVE=yes", () => {
  process.env.PYLON_STRIPE_SECRET_KEY = "sk_live_0123456789";
  try {
    assert.equal(PS.mode().error, "live_key_refused");
    process.env.PYLON_STRIPE_LIVE = "yes";
    assert.equal(PS.mode().mode, "live");
    process.env.PYLON_STRIPE_SECRET_KEY = "pk_live_nope";
    assert.equal(PS.mode().error, "stripe_key_unrecognized");
  } finally {
    delete process.env.PYLON_STRIPE_SECRET_KEY;
    delete process.env.PYLON_STRIPE_LIVE;
  }
  assert.equal(PS.mode().error, "stripe_not_configured");
});

test("the webhook: only Stripe's signature, and only Pylon's checkouts", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  const id = r.data.id;
  const sid = db.tables.pylon_requests[0].checkout_session_id;
  assert.equal((await call("POST", "/api/pylon/stripe/webhook", JSON.stringify(paidEvent(id, sid)), { "Stripe-Signature": "t=1,v1=nope" })).status, 400);
  assert.equal((await signed(paidEvent(id, sid), "whsec_someone_else")).status, 400);
  assert.equal((await signed(paidEvent(id, sid, { metadata: { kind: "sm_market" } }))).status, 200);
  await signed(paidEvent(id, sid, { payment_status: "unpaid" }));
  assert.equal(db.tables.pylon_requests[0].paid_at ?? null, null);
});

test("a payment joins its request once; staff hear, and the contact gets a receipt note", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  await wait();
  mails = [];
  pushes = [];
  const id = r.data.id;
  const sid = db.tables.pylon_requests[0].checkout_session_id;
  assert.equal((await signed(paidEvent(id, sid))).status, 200);
  await wait();
  const row = db.tables.pylon_requests[0];
  assert.ok(row.paid_at);
  assert.equal(row.paid_cents, 9900);
  assert.equal(row.paid_via, "stripe");
  assert.equal(pushes[0].payload.title, "Pylon: paid");
  assert.ok(mails.some((m) => m.to.includes("pat@example.com") && m.subject === "Pylon: payment received"));
  mails = [];
  assert.equal((await signed(paidEvent(id, sid))).status, 200);
  await wait();
  assert.equal(mails.length, 0, "Stripe sending it again changes nothing");
});

test("the payment's note isn't held up by the forms' limits", async () => {
  PS._set(fakeStripe());
  // Two requests already used the mailbox's 2 form notes today.
  await send(player(), "203.0.113.21");
  await send(player(), "203.0.113.22");
  const r = await send(player(), "203.0.113.23");
  await wait();
  mails = [];
  await signed(paidEvent(r.data.id, db.tables.pylon_requests[2].checkout_session_id));
  await wait();
  assert.ok(mails.some((m) => m.to.includes("pat@example.com") && m.subject === "Pylon: payment received"));
});

test("a 100%-off code completes with no payment due: recorded as paid, $0", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  await signed(paidEvent(r.data.id, db.tables.pylon_requests[0].checkout_session_id, { payment_status: "no_payment_required", amount_total: 0 }));
  assert.ok(db.tables.pylon_requests[0].paid_at);
  assert.equal(db.tables.pylon_requests[0].paid_cents, 0);
});

test("a second payment is never dropped: kept on the request, staff told", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  const id = r.data.id;
  const sid = db.tables.pylon_requests[0].checkout_session_id;
  const c = await staffCookie();
  // Staff mark it paid another way: the family's open checkout is closed.
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true }, { Cookie: c })).status, 200);
  assert.deepEqual(expired, [sid]);
  // Stripe took money anyway (the checkout finished first).
  await wait();
  pushes = [];
  mails = [];
  assert.equal((await signed(paidEvent(id, sid))).status, 200);
  await wait();
  const row = db.tables.pylon_requests[0];
  assert.equal(row.paid_via, "manual", "the record stays as it was");
  assert.equal(row.extra_payments.length, 1);
  assert.equal(row.extra_payments[0].checkout_session_id, sid);
  assert.equal(row.extra_payments[0].amount_cents, 9900);
  assert.equal(pushes[0].payload.title, "Pylon: a second payment");
  assert.ok(mails.some((m) => /second payment/.test(m.subject)));
  // Again: nothing new.
  assert.equal((await signed(paidEvent(id, sid))).status, 200);
  assert.equal(db.tables.pylon_requests[0].extra_payments.length, 1);
  // It stays paid, and on file, while that's sorted out in Stripe.
  const list = await call("GET", "/api/pylon/requests", undefined, { Cookie: c });
  assert.equal(list.data.requests[0].extra_payments, 1);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: false }, { Cookie: c })).data.error, "extra_payments");
  assert.equal((await call("DELETE", `/api/pylon/requests/${id}`, undefined, { Cookie: c })).status, 409);
});

test("a checkout that isn't the request's own is recorded and flagged, not joined", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  await signed(paidEvent(r.data.id, "cs_live_someotherone1"));
  const row = db.tables.pylon_requests[0];
  assert.equal(row.paid_at ?? null, null);
  assert.equal(row.extra_payments[0].checkout_session_id, "cs_live_someotherone1");
  // The checkout's id didn't save on the request: the webhook joins it by the request's id.
  Object.assign(db.tables.pylon_requests[0], { checkout_session_id: null, checkout_mode: null, extra_payments: [] });
  await signed(paidEvent(r.data.id, "cs_live_someotherone1"));
  assert.ok(db.tables.pylon_requests[0].paid_at);
});

test("a monthly plan's changes reach the request; staff hear when it stops", async () => {
  PS._set(fakeStripe());
  const r = await send(recruiting());
  const id = r.data.id;
  await signed(paidEvent(id, db.tables.pylon_requests[0].checkout_session_id, { mode: "subscription", subscription: "sub_ABC123456", amount_total: 14900 }));
  assert.equal(db.tables.pylon_requests[0].stripe_subscription_id, "sub_ABC123456");
  assert.equal(db.tables.pylon_requests[0].subscription_status, "active");
  await wait();
  pushes = [];
  const subEvent = (type, over) => ({ id: "evt_sub", type, data: { object: { id: "sub_ABC123456", object: "subscription", status: "past_due", metadata: { kind: "pylon", request_id: id }, ...over } } });
  await signed(subEvent("customer.subscription.updated", {}));
  assert.equal(db.tables.pylon_requests[0].subscription_status, "past_due");
  await wait();
  await signed(subEvent("customer.subscription.deleted", { status: "canceled", ended_at: 1794000000 }));
  assert.equal(db.tables.pylon_requests[0].subscription_status, "canceled");
  assert.ok(db.tables.pylon_requests[0].subscription_ended_at);
  await wait();
  assert.deepEqual(pushes.map((p) => p.payload.title), ["Pylon: monthly plan payment failed", "Pylon: monthly plan cancelled"]);
  // Someone else's subscription naming this request: ignored.
  await signed(subEvent("customer.subscription.updated", { id: "sub_OTHER999999", status: "active" }));
  assert.equal(db.tables.pylon_requests[0].subscription_status, "canceled");
});

test("a plan that ended stays ended, and a late or older event changes nothing", async () => {
  PS._set(fakeStripe());
  const plan = async (ip) => {
    const r = await send(recruiting(), ip);
    return r.data.id;
  };
  const ev = (id, type, status, created, subId) => ({ id: "evt_" + created, type, created, data: { object: { id: subId, object: "subscription", status, metadata: { kind: "pylon", request_id: id } } } });
  const rowOf = (id) => db.tables.pylon_requests.find((r) => r.id === id);
  // Ended, then an older "active" arrives late (a retried delivery).
  const a = await plan("198.51.100.70");
  await signed({ ...paidEvent(a, rowOf(a).checkout_session_id, { mode: "subscription", subscription: "sub_AAA111111", amount_total: 14900 }), created: 1794000000 });
  await signed(ev(a, "customer.subscription.updated", "past_due", 1794000100, "sub_AAA111111"));
  await signed(ev(a, "customer.subscription.deleted", "canceled", 1794000200, "sub_AAA111111"));
  await signed(ev(a, "customer.subscription.updated", "active", 1794000150, "sub_AAA111111"));
  await signed(ev(a, "customer.subscription.updated", "active", 1794000300, "sub_AAA111111"));
  assert.equal(rowOf(a).subscription_status, "canceled", "ended stays ended");
  assert.ok(rowOf(a).subscription_ended_at);
  // Out of order: the newer past_due first, then an older active.
  const b = await plan("198.51.100.71");
  await signed(ev(b, "customer.subscription.updated", "past_due", 1794001000, "sub_BBB111111"));
  await signed(ev(b, "customer.subscription.updated", "active", 1794000900, "sub_BBB111111"));
  assert.equal(rowOf(b).subscription_status, "past_due");
  // The same second: the ending wins, whichever comes first.
  await signed(ev(b, "customer.subscription.deleted", "canceled", 1794001100, "sub_BBB111111"));
  await signed(ev(b, "customer.subscription.updated", "active", 1794001100, "sub_BBB111111"));
  assert.equal(rowOf(b).subscription_status, "canceled");
  // The plan's own events before the checkout's: the checkout doesn't revive it.
  const c = await plan("198.51.100.72");
  await signed(ev(c, "customer.subscription.deleted", "canceled", 1794002000, "sub_CCC111111"));
  await signed({ ...paidEvent(c, rowOf(c).checkout_session_id, { mode: "subscription", subscription: "sub_CCC111111", amount_total: 14900 }), created: 1794001900 });
  assert.equal(rowOf(c).subscription_status, "canceled");
  assert.ok(rowOf(c).paid_at, "the payment itself is still recorded");
});

test("money alerts have their own budget: busy forms can't hold them up", async () => {
  PS._set(fakeStripe());
  const r = await send(player());
  const sid = db.tables.pylon_requests[0].checkout_session_id;
  for (let i = 0; i < 30; i++) router._limits.staffMailAllowed();
  const c = await staffCookie();
  await call("PATCH", `/api/pylon/requests/${r.data.id}`, { paid: true }, { Cookie: c });
  await wait();
  mails = [];
  await signed(paidEvent(r.data.id, sid));
  await wait();
  assert.ok(mails.some((m) => /second payment/.test(m.subject)), "the second payment's email still goes");
});

test("an athlete's request is Confirmed or Done only once staff checked who they are", async () => {
  await send(player());
  await send(team(), "198.51.100.80");
  const [athleteReq, teamReq] = db.tables.pylon_requests.map((r) => r.id);
  const c = await staffCookie();
  const patch = (id, body) => call("PATCH", `/api/pylon/requests/${id}`, body, { Cookie: c });
  assert.equal((await patch(athleteReq, { status: "confirmed" })).data.error, "check_first");
  assert.equal((await patch(athleteReq, { status: "done" })).data.error, "check_first");
  assert.equal((await patch(athleteReq, { verified: true, status: "confirmed" })).status, 200, "checked and confirmed in one go");
  assert.equal((await patch(athleteReq, { verified: false })).data.error, "check_first", "can't un-check a confirmed one");
  assert.equal((await patch(athleteReq, { verified: false, status: "contacted" })).status, 200);
  assert.equal((await patch(teamReq, { status: "confirmed" })).status, 200, "a coach's booking names no athlete");
});

test("no signing secret: the webhook says it isn't set up", async () => {
  const saved = process.env.PYLON_STRIPE_WEBHOOK_SECRET;
  delete process.env.PYLON_STRIPE_WEBHOOK_SECRET;
  try {
    assert.equal((await call("POST", "/api/pylon/stripe/webhook", "{}", { "Stripe-Signature": "x" })).status, 503);
  } finally {
    process.env.PYLON_STRIPE_WEBHOOK_SECRET = saved;
  }
});

test("staff only: the list, one request, and changes", async () => {
  await send(player());
  const id = db.tables.pylon_requests[0].id;
  assert.equal((await call("GET", "/api/pylon/requests")).status, 401);
  const stranger = await staffCookie("someone@else.test", "creator");
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: stranger })).status, 403);
  const c = await staffCookie();
  const list = await call("GET", "/api/pylon/requests", undefined, { Cookie: c });
  assert.equal(list.data.requests[0].summary, "Pylon Player Story, $99, Pylon Dallas Regional, Nov 21");
  assert.equal(list.data.requests[0].athlete_name, undefined, "the list carries no athlete");
  assert.equal((await call("GET", `/api/pylon/requests/${id}`, undefined, { Cookie: c })).data.request.athlete_name, "Jordan Ellis");
  assert.equal((await call("GET", "/api/pylon/requests/not-a-uuid", undefined, { Cookie: c })).status, 404);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { status: "contacted", team_note: "Called, voicemail." }, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests[0].status_by, "kyron@toj.test");
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { status: "paid" }, { Cookie: c })).status, 400);
  await call("PATCH", `/api/pylon/requests/${id}`, { status: "closed" }, { Cookie: c });
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: c })).data.requests.length, 0);
  assert.equal((await call("GET", "/api/pylon/requests?all=1", undefined, { Cookie: c })).data.requests.length, 1);
});

test("staff record who checked the contact, and when; and can take it back", async () => {
  await send(player());
  const id = db.tables.pylon_requests[0].id;
  const c = await staffCookie();
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: c })).data.requests[0].verified, false);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { verified: "yes" }, { Cookie: c })).status, 400);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { verified: true }, { Cookie: c })).status, 200);
  const at = db.tables.pylon_requests[0].contact_verified_at;
  assert.ok(at);
  assert.equal(db.tables.pylon_requests[0].contact_verified_by, "kyron@toj.test");
  await call("PATCH", `/api/pylon/requests/${id}`, { verified: true }, { Cookie: c });
  assert.equal(db.tables.pylon_requests[0].contact_verified_at, at, "checking again keeps the first check");
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: c })).data.requests[0].verified, true);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { verified: false }, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests[0].contact_verified_at, null);
  assert.equal(db.tables.pylon_requests[0].contact_verified_by, null);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { verified: true })).status, 401);
});

test("paid another way: staff record it, and take back only that", async () => {
  await send(player());
  const id = db.tables.pylon_requests[0].id;
  const c = await staffCookie();
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true, paid_cents: "lots" }, { Cookie: c })).status, 400);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true }, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests[0].paid_via, "manual");
  assert.equal(db.tables.pylon_requests[0].paid_cents, 9900);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true }, { Cookie: c })).status, 409);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: false }, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests[0].paid_at, null);
  Object.assign(db.tables.pylon_requests[0], { paid_at: new Date().toISOString(), paid_cents: 9900, paid_via: "stripe", checkout_session_id: "cs_live_aaaaaaaaaa", checkout_mode: "live" });
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: false }, { Cookie: c })).status, 409);
});

test("delete closes the request's Stripe checkout first; one Stripe shows paid stays", async () => {
  PS._set(fakeStripe());
  await send(player());
  await send(player(), "198.51.100.62");
  await send(player(), "198.51.100.63");
  const [a, b, c2] = db.tables.pylon_requests.map((r) => [r.id, r.checkout_session_id]);
  const c = await staffCookie();
  assert.equal((await call("DELETE", `/api/pylon/requests/${a[0]}`, undefined, { Cookie: c })).status, 200);
  assert.deepEqual(expired, [a[1]], "the open checkout was closed");
  stripeStatus[b[1]] = "complete";
  assert.equal((await call("DELETE", `/api/pylon/requests/${b[0]}`, undefined, { Cookie: c })).data.error, "checkout_complete");
  PS._set(null);
  assert.equal((await call("DELETE", `/api/pylon/requests/${c2[0]}`, undefined, { Cookie: c })).data.error, "stripe_unavailable", "can't tell: it stays");
  assert.equal(db.tables.pylon_requests.length, 2);
});

test("a payment for a request that isn't in the app reaches staff", async () => {
  PS._set(fakeStripe());
  const ghost = "22222222-2222-4222-8222-222222222222";
  assert.equal((await signed(paidEvent(ghost, "cs_live_ghostghost01"))).status, 200);
  await wait();
  assert.equal(pushes[0].payload.title, "Pylon: a payment with no request");
  assert.ok(mails.some((m) => /a payment with no request \(\$99\)/.test(m.subject) && /cs_live_ghostghost01/.test(m.text)));
});

test("\"didn't send this\": staff delete an unpaid request; a paid one stays", async () => {
  await send(player());
  await send(player(), "198.51.100.61");
  const [a, b] = db.tables.pylon_requests.map((r) => r.id);
  assert.equal((await call("DELETE", `/api/pylon/requests/${a}`)).status, 401);
  const c = await staffCookie();
  assert.equal((await call("DELETE", `/api/pylon/requests/${a}`, undefined, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests.length, 1);
  assert.equal(db.tables.pylon_requests[0].id, b);
  assert.equal((await call("DELETE", `/api/pylon/requests/${a}`, undefined, { Cookie: c })).status, 404);
  Object.assign(db.tables.pylon_requests[0], { paid_at: new Date().toISOString(), paid_cents: 9900, paid_via: "manual" });
  assert.equal((await call("DELETE", `/api/pylon/requests/${b}`, undefined, { Cookie: c })).data.error, "paid_keep");
});

test("the newsletter: a confirmation first, the same answer for everyone, one email a day", async () => {
  const sub = (email, ip) => call("POST", "/api/pylon/newsletter/subscribe", { email }, { "X-Forwarded-For": ip });
  assert.equal((await sub("Fan@Example.com", "203.0.113.50")).status, 200);
  await wait();
  const row = db.tables.pylon_newsletter[0];
  assert.equal(row.status, "pending");
  assert.match(row.unsubscribe_token, /^[0-9a-f]{64}$/);
  const mail = mails.find((m) => m.to.includes("fan@example.com"));
  const link = /pylon-newsletter\.html\?confirm=([0-9a-f]{64})/.exec(mail.text);
  assert.ok(link);
  assert.notEqual(row.confirm_token_hash, link[1], "only its hash is kept");
  assert.equal((await sub("fan@example.com", "203.0.113.51")).status, 200);
  await wait();
  assert.equal(mails.filter((m) => m.to.includes("fan@example.com")).length, 1, "one a day");
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: "f".repeat(64) })).status, 404);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: "nope" })).status, 400);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: link[1] })).status, 200);
  assert.equal(db.tables.pylon_newsletter[0].status, "confirmed");
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: link[1] })).status, 404, "a link works once");
  const c = await staffCookie();
  const list = await call("GET", "/api/pylon/newsletter", undefined, { Cookie: c });
  assert.deepEqual(list.data.counts, { pending: 0, confirmed: 1, unsubscribed: 0 });
  assert.equal(list.data.confirmed[0].email, "fan@example.com");
  assert.equal(list.data.confirmed[0].unsubscribe_url, `https://tojcampaign.com/pylon-newsletter.html?unsubscribe=${row.unsubscribe_token}`);
  assert.equal((await call("GET", "/api/pylon/newsletter")).status, 401);
  const tok = db.tables.pylon_newsletter[0].unsubscribe_token;
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: tok })).status, 200);
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: tok })).status, 200);
  assert.equal(db.tables.pylon_newsletter[0].status, "unsubscribed");
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: "a".repeat(64) })).status, 404);
});

test("a confirmation link stops working after 7 days", async () => {
  await call("POST", "/api/pylon/newsletter/subscribe", { email: "late@example.com" });
  await wait();
  const token = /confirm=([0-9a-f]{64})/.exec(mails.find((m) => m.to.includes("late@example.com")).text)[1];
  db.tables.pylon_newsletter[0].confirm_sent_at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token })).status, 404);
});

test("the old API's paths answer 404, not someone else's route", async () => {
  for (const p of ["/api/pylon/teams", "/api/pylon/athletes", "/api/pylon/dashboard"]) assert.equal((await call("GET", p)).status, 404, p);
  assert.equal((await call("POST", "/api/pylon/packages/order", {})).status, 404);
});
