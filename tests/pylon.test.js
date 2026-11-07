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
const player = (over = {}) => ({
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
  ...over,
});

// ── The rules ────────────────────────────────────────────────────────────
test("a player request passes, cleaned up, at the server's price", () => {
  const { errors, value } = U.normalize(player({ price_cents: 1, amount_cents: 1, package_name: "Free stuff" }));
  assert.deepEqual(errors, []);
  assert.equal(value.price_cents, 9900, "the page's numbers are ignored");
  assert.equal(value.package_name, "Pylon Player Story");
  assert.equal(value.contact_email, "pat@example.com");
  assert.equal(value.contact_role, "parent");
  assert.equal(value.consent, "parent");
  assert.equal(value.details.position, "WR");
  assert.equal(value.details.public_ok, false);
  assert.match(value.consent_text, /^I'm the athlete's parent\. I agree to Pylon filming and photographing them/);
  assert.match(value.consent_text, /won't post the coverage on its own channels/);
});

test("every kind's required fields are named when missing", () => {
  const miss = (raw, fields) => {
    const { errors } = U.normalize(raw);
    for (const f of fields) assert.ok(errors.includes(f), `${raw.kind}: ${f} (got ${errors})`);
  };
  miss({ kind: "team_package", package: "1a" }, ["contact_name", "contact_email", "team_name", "region"]);
  miss({ kind: "player_package", package: "12" }, ["who", "athlete_name", "contact_name", "contact_email", "position", "class_year", "team_name", "event"]);
  miss({ kind: "transcript", package: "individual" }, ["who", "athlete_name", "position_class", "team_name"]);
  miss({ kind: "recruiting", package: "standard_monthly", who: "parent", consent_confirm: true }, ["athlete_name", "position_class", "target_level", "contact_phone"]);
  miss({ kind: "newsletter_premium", package: "premium" }, ["contact_name", "contact_email"]);
  miss({ kind: "ambassador", package: "standard", who: "parent", consent_confirm: true }, ["athlete_name", "athlete_email", "position", "class_year", "team_name", "contact_name", "contact_email"]);
});

test("a package and a kind come only from the list", () => {
  assert.deepEqual(U.normalize({ kind: "toString" }).errors, ["kind"]);
  assert.ok(U.normalize(player({ package: "constructor" })).errors.includes("package"));
  assert.ok(U.normalize(player({ package: "1a" })).errors.includes("package"), "a team package isn't a player package");
  assert.doesNotThrow(() => U.normalize(null));
  assert.doesNotThrow(() => U.normalize([1, 2]));
  const evil = { toString: 1 };
  assert.doesNotThrow(() => U.normalize(player({ athlete_name: evil, contact_email: ["a@b.co"], who: evil, notes: {}, event: [], referral_code: evil })));
});

test("only a parent, a legal guardian or the athlete at 18+ can send one, and the box has to be ticked", () => {
  assert.ok(U.normalize(player({ who: "minor" })).errors.includes("who"), "an athlete under 18 can't");
  assert.ok(U.normalize(player({ who: "friend" })).errors.includes("who"));
  assert.ok(U.normalize(player({ consent_confirm: false })).errors.includes("consent_confirm"));
  assert.ok(U.normalize(player({ consent_confirm: "no" })).errors.includes("consent_confirm"));
  assert.deepEqual(U.normalize(player({ consent_confirm: "on" })).errors, []);
  const g = U.normalize(player({ who: "guardian" })).value;
  assert.equal(g.contact_role, "guardian");
  assert.match(g.consent_text, /^I'm the athlete's legal guardian\./);
  // 18 or older: the athlete is the contact, by their own name when not repeated.
  const a = U.normalize(player({ who: "adult", contact_name: "" })).value;
  assert.equal(a.contact_role, "athlete");
  assert.equal(a.contact_name, "Jordan Ellis");
  assert.match(a.consent_text, /^I'm the athlete and I'm 18 or older\. I agree to Pylon filming and photographing me/);
});

test("Pylon's own channels: only when the family says yes, and the words say which", () => {
  const yes = U.normalize(player({ public_ok: "on" })).value;
  assert.equal(yes.details.public_ok, true);
  assert.match(yes.consent_text, /Pylon may also post the coverage on Pylon's own channels\.$/);
});

test("an ambassador application: a minor's comes from the parent, with an address that isn't the athlete's", () => {
  const base = { kind: "ambassador", package: "featured", who: "parent", consent_confirm: true, athlete_name: "Sam Ray", athlete_email: "sam.ray@gmail.com", position: "QB", class_year: "2028", team_name: "Elite", contact_name: "Mo Ray" };
  assert.ok(U.normalize({ ...base, contact_email: "samray+parent@gmail.com" }).errors.includes("contact_email_same"), "Gmail dots and +tags are the same mailbox");
  const ok = U.normalize({ ...base, contact_email: "mo@example.com", ig_handle: "@sam.ray", tiktok_handle: "bad handle!", follower_count: "5,200", why: "I post film." });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.contact_role, "parent");
  assert.equal(ok.value.details.athlete_email, "sam.ray@gmail.com");
  assert.equal(ok.value.details.ig_handle, "sam.ray");
  assert.equal(ok.value.details.tiktok_handle, undefined);
  assert.equal(ok.value.details.follower_count, 5200);
  assert.equal(ok.value.notes, "I post film.");
  assert.equal(ok.value.price_cents, null, "an application has no price");
  // At 18+, the athlete applies for themselves.
  const adult = U.normalize({ ...base, who: "adult", contact_name: "", contact_email: "" });
  assert.deepEqual(adult.errors, []);
  assert.equal(adult.value.contact_email, "sam.ray@gmail.com");
  assert.equal(adult.value.contact_role, "athlete");
});

test("a creator code is cleaned up, and only a player package keeps one", () => {
  assert.equal(U.normalize(player({ referral_code: " kay-25 " })).value.referral_code, "KAY-25");
  assert.equal(U.normalize(player({ referral_code: "<script>" })).value.referral_code, null);
  const team = U.normalize({ kind: "team_package", package: "1a", contact_name: "Coach Lee", contact_email: "coach@example.com", team_name: "Elite", region: "west", referral_code: "KAY25" }).value;
  assert.equal(team.referral_code, null);
});

test("emails: a plain address only, nothing that could copy someone into a draft", () => {
  const bad = (e) => U.normalize(player({ contact_email: e })).errors.includes("contact_email");
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
  for (const kind of U.ATHLETE_KINDS)
    for (const who of ["parent", "guardian", "adult"])
      for (const publicOk of [false, true]) assert.equal(page(kind, who, publicOk), U.consentText(kind, who, { publicOk }), `${kind} ${who} ${publicOk}`);
  assert.equal(page("player_package", "minor", false), null);
});

test("every page sends what its kind needs, by the field names the server reads", () => {
  const pages = {
    "pylon-team-packages.html": ["team_package", ["team_name", "contact_name", "contact_email", "region", "event", "notes", "pf_trap", "package"]],
    "pylon-player-packages.html": ["player_package", ["who", "athlete_name", "position", "class_year", "team_name", "event", "contact_name", "contact_email", "public_ok", "consent_confirm", "referral_code", "package"]],
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
    assert.ok(!/alert\(|\/api\/pylon\/(packages|subscriptions|recruiting|ambassadors)\b|Kaydon/.test(html), `${file}: nothing of the old form`);
    // Every package button opens a package the server sells.
    for (const m of html.matchAll(/data-package="([a-z0-9_]+)"/g)) assert.ok(U.CATALOG[kind] && U.CATALOG[kind][m[1]], `${file}: package ${m[1]}`);
  }
  const news = fs.readFileSync(path.join(ROOT, "public", "pylon-newsletter.html"), "utf8");
  assert.ok(!/Issue #0\d/.test(news), "no made-up past issues");
});

test("the notes say what came in, and staff alerts carry no names", () => {
  const r = { ...U.normalize(player()).value, id: "11111111-1111-4111-8111-111111111111" };
  const p = U.pushPayload(r);
  const s = U.staffEmail(r, "https://tojcampaign.com");
  for (const text of [p.title, p.body, s.subject, s.text]) {
    assert.ok(!text.includes("Jordan") && !text.includes("Pat") && !text.includes("example.com"), text);
  }
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
  const coach = U.contactEmail({ ...U.normalize({ kind: "team_package", package: "1b", contact_name: "Coach Lee", contact_email: "coach@example.com", team_name: "Elite", region: "west" }).value });
  assert.match(coach.text, /only post an athlete's footage publicly once their parent or guardian has said yes/);
  const nobody = (t) => !/viral|followers|exposure|guarantee/i.test(t);
  assert.ok(nobody(c.text) && nobody(coach.text), "no promises of reach");
  assert.equal(U.money(999), "$9.99");
  assert.equal(U.money(149900), "$1,499");
  assert.equal(U.priceWords({ price_cents: 9900, cadence: "month" }), "$99 a month");
});

// ── The routes ───────────────────────────────────────────────────────────
let server, base, db, pushes, mails, sessions;
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
const form = (body, ip = "203.0.113.7") => call("POST", "/api/pylon/requests", body, { "X-Forwarded-For": ip });
async function staffCookie(email = "kyron@toj.test", role = "staff") {
  const r = await call("POST", "/__test/session", { email, role });
  return r.cookie.split(";")[0];
}
const stripeHelper = new Stripe("sk_test_helper_only");
function signed(event, secret = process.env.PYLON_STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const header = stripeHelper.webhooks.generateTestHeaderString({ payload, secret });
  return call("POST", "/api/pylon/stripe/webhook", payload, { "Stripe-Signature": header });
}
const paidEvent = (id, sid, over = {}) => ({
  id: "evt_test_1",
  type: "checkout.session.completed",
  data: { object: { id: sid, object: "checkout.session", client_reference_id: id, payment_status: "paid", amount_total: 9900, livemode: false, metadata: { kind: "pylon", request_id: id, package: "13" }, ...over } },
});

// A fake Stripe: records the checkouts it's asked for.
let created, promos;
function fakeStripe({ fail = false } = {}) {
  return {
    mode: "test",
    stripe: {
      checkout: {
        sessions: {
          create: async (params) => {
            if (fail) throw Object.assign(new Error("boom"), { type: "StripeAPIError" });
            const id = "cs_test_" + String(created.length + 1).padStart(10, "a");
            created.push(params);
            return { id, url: "https://checkout.stripe.com/c/pay/" + id };
          },
        },
      },
      promotionCodes: { list: async ({ code }) => ({ data: promos[code] ? [{ id: promos[code] }] : [] }) },
    },
  };
}

before(async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
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
  promos = {};
  db = fakeSupabase(
    { push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }] },
    { unique: { pylon_requests: ["checkout_session_id"], pylon_newsletter: ["email", "unsubscribe_token", "confirm_token_hash"] } }
  );
  setSupabase(db);
});

test("a request is saved, staff get a push and an email, and the contact one note", async () => {
  const r = await form(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.checkout_url, null, "no Stripe set up: no checkout");
  await wait();
  const row = db.tables.pylon_requests[0];
  assert.equal(row.id, r.data.id);
  assert.equal(row.price_cents, 9900);
  assert.equal(row.status, "new");
  assert.ok(row.alerted_at && row.contact_emailed_at);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.url, `/app/#pylon-request/${row.id}`);
  const staff = mails.find((m) => m.to.includes("kyron@toj.test"));
  const contact = mails.find((m) => m.to.includes("pat@example.com"));
  assert.ok(staff && contact);
  assert.ok(!staff.text.includes("Jordan"), "the staff email names no one");
  assert.match(contact.text, /send a secure payment link/);
  assert.equal(contact.replyTo, "hello@pylonfootball.com");
});

test("a bad form is refused with its fields, a bot's is dropped quietly", async () => {
  const r = await form(player({ who: "minor", event: "" }));
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.includes("who") && r.data.fields.includes("event"));
  const bot = await form(player({ pf_trap: "http://spam.example" }));
  assert.equal(bot.status, 200);
  assert.equal(bot.data.id, null);
  assert.equal((db.tables.pylon_requests || []).length, 0);
});

test("limits: a visitor gets 8 forms in 10 minutes", async () => {
  for (let i = 0; i < 8; i++) assert.equal((await form(player())).status, 200);
  assert.equal((await form(player())).status, 429);
  assert.equal((await form(player(), "198.51.100.9")).status, 200, "another visitor is fine");
  // One IPv6 /64 is one visitor, however it's written.
  router._reset();
  for (let i = 0; i < 8; i++) assert.equal((await form(player(), `2001:db8:0:1::${i + 1}`)).status, 200);
  assert.equal((await form(player(), "2001:0db8:0000:0001:ffff::1")).status, 429);
});

test("the contact's notes: at most 2 a day to one mailbox, however the address is written", async () => {
  await form(player({ contact_email: "pat.ellis@gmail.com" }), "203.0.113.1");
  await form(player({ contact_email: "patellis+a@gmail.com" }), "203.0.113.2");
  await form(player({ contact_email: "PAT.ELLIS@googlemail.com" }), "203.0.113.3");
  await wait();
  const notes = mails.filter((m) => !m.to.includes("kyron@toj.test"));
  assert.equal(notes.length, 2);
  assert.equal(db.tables.pylon_requests.length, 3, "every request is still saved");
  assert.equal(db.tables.pylon_requests.filter((x) => x.contact_emailed_at).length, 2, "the app shows which got one");
});

test("a note that couldn't go is given back: the app shows it didn't", async () => {
  mailer.setSender(async (m) => { mails.push(m); return m.to.includes("kyron@toj.test") ? { sent: true } : { sent: false, reason: "send_failed" }; });
  try {
    await form(player());
    await wait();
    assert.equal(db.tables.pylon_requests[0].contact_emailed_at, null);
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("the database down: the whole request goes to staff by email, marked critical", async () => {
  setSupabase(null);
  const r = await form(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.id, null);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].critical, true);
  assert.match(mails[0].text, /only copy/);
  assert.match(mails[0].text, /Jordan Ellis/);
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  try {
    assert.equal((await form(player())).status, 503, "neither the database nor email: say so");
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("with Stripe set up: a checkout at the server's price, for this request, and the page goes there", async () => {
  PS._set(fakeStripe());
  const r = await form(player({ price_cents: 1 }));
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
  assert.equal(p.allow_promotion_codes, true, "a player package can take a creator code");
  assert.equal(db.tables.pylon_requests[0].checkout_session_id, "cs_test_aaaaaaaaa1");
  assert.equal(db.tables.pylon_requests[0].checkout_mode, "test");
  await wait();
  assert.match(mails.find((m) => m.to.includes("pat@example.com")).text, /Stripe's secure checkout/);
});

test("a monthly package is a subscription; a season one is one payment; an application has none", async () => {
  PS._set(fakeStripe());
  await form({ kind: "recruiting", package: "hbcu_monthly", who: "guardian", consent_confirm: true, athlete_name: "A B", contact_name: "C D", contact_email: "c@example.com", contact_phone: "555-010-2030", position_class: "WR 2027", target_level: "hbcu" });
  assert.equal(created[0].mode, "subscription");
  assert.deepEqual(created[0].line_items[0].price_data.recurring, { interval: "month" });
  assert.equal(created[0].line_items[0].price_data.unit_amount, 14900);
  assert.ok(created[0].subscription_data && !created[0].payment_intent_data);
  assert.equal(created[0].allow_promotion_codes, undefined, "no codes outside player packages");
  await form({ kind: "transcript", package: "combine", who: "adult", consent_confirm: true, athlete_name: "A B", contact_email: "ab@example.com", position_class: "WR 2027", team_name: "X" }, "198.51.100.2");
  assert.equal(created[1].mode, "payment");
  assert.equal(created[1].line_items[0].price_data.unit_amount, 24900);
  const app = await form({ kind: "ambassador", package: "flagship", who: "adult", consent_confirm: true, athlete_name: "Sam Ray", athlete_email: "sam@example.com", position: "QB", class_year: "2027", team_name: "X" }, "198.51.100.3");
  assert.equal(app.data.checkout_url, null);
  assert.equal(created.length, 2);
});

test("an active creator code is applied for the buyer; Stripe is the judge", async () => {
  PS._set(fakeStripe());
  promos.KAY25 = "promo_123";
  await form(player({ referral_code: "kay25" }));
  assert.deepEqual(created[0].discounts, [{ promotion_code: "promo_123" }]);
  assert.equal(created[0].allow_promotion_codes, undefined, "Stripe takes one or the other");
  assert.equal(db.tables.pylon_requests[0].price_cents, 9900, "the list price stays on the request");
});

test("a checkout that doesn't start leaves the request standing", async () => {
  PS._set(fakeStripe({ fail: true }));
  const r = await form(player());
  assert.equal(r.status, 200);
  assert.equal(r.data.checkout_url, null);
  assert.equal(db.tables.pylon_requests.length, 1);
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

test("the page learns whether a checkout comes next, and nothing else", async () => {
  assert.deepEqual((await call("GET", "/api/pylon/checkout")).data, { open: false });
  PS._set(fakeStripe());
  assert.deepEqual((await call("GET", "/api/pylon/checkout")).data, { open: true });
});

test("the webhook: only Stripe's signature, and only Pylon's checkouts", async () => {
  PS._set(fakeStripe());
  const r = await form(player());
  const id = r.data.id;
  const sid = db.tables.pylon_requests[0].checkout_session_id;
  assert.equal((await call("POST", "/api/pylon/stripe/webhook", JSON.stringify(paidEvent(id, sid)), { "Stripe-Signature": "t=1,v1=nope" })).status, 400);
  assert.equal((await signed(paidEvent(id, sid), "whsec_someone_else")).status, 400);
  assert.equal(db.tables.pylon_requests[0].paid_at ?? null, null);
  // Not ours (another kind on the same account): acknowledged, nothing changes.
  assert.equal((await signed(paidEvent(id, sid, { metadata: { kind: "sm_market" } }))).status, 200);
  assert.equal(db.tables.pylon_requests[0].paid_at ?? null, null);
  // Not paid yet (a delayed method): nothing changes.
  await signed(paidEvent(id, sid, { payment_status: "unpaid" }));
  assert.equal(db.tables.pylon_requests[0].paid_at ?? null, null);
});

test("a payment joins its request once; staff hear, and the contact gets a receipt note", async () => {
  PS._set(fakeStripe());
  const r = await form(player());
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
  assert.ok(row.paid_emailed_at);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, "Pylon: paid");
  assert.ok(mails.some((m) => m.to.includes("kyron@toj.test") && /Pylon payment/.test(m.subject)));
  assert.ok(mails.some((m) => m.to.includes("pat@example.com") && /payment received/.test(m.subject)));
  // Stripe sends it again: nothing more.
  mails = [];
  assert.equal((await signed(paidEvent(id, sid))).status, 200);
  await wait();
  assert.equal(mails.length, 0);
  assert.equal(db.tables.pylon_requests.length, 1);
});

test("a checkout that isn't the request's own doesn't join it", async () => {
  PS._set(fakeStripe());
  const r = await form(player());
  await signed(paidEvent(r.data.id, "cs_test_someotherone1"));
  assert.equal(db.tables.pylon_requests[0].paid_at ?? null, null);
  // The checkout's id didn't save on the request: the webhook joins it by the request's id.
  db.tables.pylon_requests[0].checkout_session_id = null;
  db.tables.pylon_requests[0].checkout_mode = null;
  await signed(paidEvent(r.data.id, "cs_test_someotherone1"));
  assert.ok(db.tables.pylon_requests[0].paid_at);
  assert.equal(db.tables.pylon_requests[0].checkout_session_id, "cs_test_someotherone1");
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
  await form(player());
  const id = db.tables.pylon_requests[0].id;
  assert.equal((await call("GET", "/api/pylon/requests")).status, 401);
  const stranger = await staffCookie("someone@else.test", "creator");
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: stranger })).status, 403);
  const c = await staffCookie();
  const list = await call("GET", "/api/pylon/requests", undefined, { Cookie: c });
  assert.equal(list.status, 200);
  assert.equal(list.data.requests.length, 1);
  assert.equal(list.data.requests[0].summary, "Pylon Player Story, $99, Pylon Dallas Regional, Nov 21");
  assert.equal(list.data.requests[0].athlete_name, undefined, "the list carries no athlete");
  const one = await call("GET", `/api/pylon/requests/${id}`, undefined, { Cookie: c });
  assert.equal(one.data.request.athlete_name, "Jordan Ellis");
  assert.equal((await call("GET", "/api/pylon/requests/not-a-uuid", undefined, { Cookie: c })).status, 404);
  const p = await call("PATCH", `/api/pylon/requests/${id}`, { status: "contacted", team_note: "Called, voicemail." }, { Cookie: c });
  assert.equal(p.status, 200);
  assert.equal(db.tables.pylon_requests[0].status, "contacted");
  assert.equal(db.tables.pylon_requests[0].team_note, "Called, voicemail.");
  assert.equal(db.tables.pylon_requests[0].status_by, "kyron@toj.test");
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { status: "paid" }, { Cookie: c })).status, 400);
  // Closed requests drop off the open list.
  await call("PATCH", `/api/pylon/requests/${id}`, { status: "closed" }, { Cookie: c });
  assert.equal((await call("GET", "/api/pylon/requests", undefined, { Cookie: c })).data.requests.length, 0);
  assert.equal((await call("GET", "/api/pylon/requests?all=1", undefined, { Cookie: c })).data.requests.length, 1);
});

test("paid another way: staff record it, and take back only that", async () => {
  await form(player());
  const id = db.tables.pylon_requests[0].id;
  const c = await staffCookie();
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true, paid_cents: "lots" }, { Cookie: c })).status, 400);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true }, { Cookie: c })).status, 200);
  const row = db.tables.pylon_requests[0];
  assert.equal(row.paid_cents, 9900);
  assert.equal(row.paid_via, "manual");
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: true }, { Cookie: c })).status, 409);
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: false }, { Cookie: c })).status, 200);
  assert.equal(db.tables.pylon_requests[0].paid_at, null);
  // A Stripe payment stays.
  Object.assign(db.tables.pylon_requests[0], { paid_at: new Date().toISOString(), paid_cents: 9900, paid_via: "stripe", checkout_session_id: "cs_test_aaaaaaaaaa" });
  assert.equal((await call("PATCH", `/api/pylon/requests/${id}`, { paid: false }, { Cookie: c })).status, 409);
  assert.equal(db.tables.pylon_requests[0].paid_via, "stripe");
});

test("the newsletter: a confirmation first, the same answer for everyone, one email a day", async () => {
  const r = await call("POST", "/api/pylon/newsletter/subscribe", { email: "Fan@Example.com", source: "newsletter_page" }, { "X-Forwarded-For": "203.0.113.50" });
  assert.equal(r.status, 200);
  await wait();
  const row = db.tables.pylon_newsletter[0];
  assert.equal(row.status, "pending");
  assert.equal(row.email, "fan@example.com");
  assert.match(row.unsubscribe_token, /^[0-9a-f]{64}$/);
  assert.equal(mails.length, 1);
  const link = /pylon-newsletter\.html\?confirm=([0-9a-f]{64})/.exec(mails[0].text);
  assert.ok(link, "the email carries the link");
  assert.notEqual(row.confirm_token_hash, link[1], "only its hash is kept");
  // Again the same day: the same answer, no second email.
  assert.equal((await call("POST", "/api/pylon/newsletter/subscribe", { email: "fan@example.com" }, { "X-Forwarded-For": "203.0.113.51" })).status, 200);
  await wait();
  assert.equal(mails.length, 1);
  // Confirm.
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: "f".repeat(64) })).status, 404);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: "nope" })).status, 400);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: link[1] })).status, 200);
  assert.equal(db.tables.pylon_newsletter[0].status, "confirmed");
  assert.equal(db.tables.pylon_newsletter[0].confirm_token_hash, null);
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token: link[1] })).status, 404, "a link works once");
  // Subscribed already: the same answer, and no email.
  mails = [];
  router._reset();
  assert.equal((await call("POST", "/api/pylon/newsletter/subscribe", { email: "fan@example.com" })).status, 200);
  await wait();
  assert.equal(mails.length, 0);
  // Staff see the confirmed list.
  const c = await staffCookie();
  const list = await call("GET", "/api/pylon/newsletter", undefined, { Cookie: c });
  assert.deepEqual(list.data.counts, { pending: 0, confirmed: 1, unsubscribed: 0 });
  assert.equal(list.data.confirmed[0].email, "fan@example.com");
  assert.equal((await call("GET", "/api/pylon/newsletter")).status, 401);
  // Unsubscribe, twice.
  const tok = db.tables.pylon_newsletter[0].unsubscribe_token;
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: tok })).status, 200);
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: tok })).status, 200);
  assert.equal(db.tables.pylon_newsletter[0].status, "unsubscribed");
  assert.equal((await call("POST", "/api/pylon/newsletter/unsubscribe", { token: "a".repeat(64) })).status, 404);
});

test("a confirmation link stops working after 7 days", async () => {
  await call("POST", "/api/pylon/newsletter/subscribe", { email: "late@example.com" });
  await wait();
  const token = /confirm=([0-9a-f]{64})/.exec(mails[0].text)[1];
  db.tables.pylon_newsletter[0].confirm_sent_at = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  assert.equal((await call("POST", "/api/pylon/newsletter/confirm", { token })).status, 404);
  assert.equal(db.tables.pylon_newsletter[0].status, "pending");
});

test("the old API's paths answer 404, not someone else's route", async () => {
  for (const p of ["/api/pylon/teams", "/api/pylon/athletes", "/api/pylon/dashboard", "/api/pylon/packages/order"]) {
    assert.equal((await call(p.endsWith("order") ? "POST" : "GET", p, p.endsWith("order") ? {} : undefined)).status, 404, p);
  }
});

test("one visitor's notes: 6 a day, to different mailboxes; every request is still saved", async () => {
  for (let i = 0; i < 7; i++) assert.equal((await form(player({ contact_email: `parent${i}@example.com` }), "203.0.113.70")).status, 200);
  await wait();
  assert.equal(db.tables.pylon_requests.length, 7);
  assert.equal(mails.filter((m) => !m.to.includes("kyron@toj.test")).length, 6, "the 7th note from one visitor doesn't go");
  assert.equal(db.tables.pylon_requests.filter((r) => r.contact_emailed_at).length, 6);
});
