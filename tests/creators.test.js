// The Creator Club, phase 1 — intake and checks, the page on request (the
// owner approves), events and QR codes, crew codes, the event CSV, Stripe
// Connect in test mode (a stand-in for Stripe), the webhook, and the rules:
// live keys refused, a guardian for under-18 creators, no buyer data on the
// page or in notifications. Made-up data only.
//
//   node --test tests/creators.test.js

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

process.env.ADMIN_EMAILS = "kyron@example.com";
process.env.CREATOR_PAGE_BASE = "https://tojcampaign.com";
delete process.env.CREATOR_STRIPE_SECRET_KEY;
delete process.env.CREATOR_STRIPE_LIVE;

const { fakeSupabase } = require("./helpers/fake-supabase");
const { setSupabase } = require("../utils/supabase");
const S = require("../utils/creator-stripe");
const P = require("../utils/push");
const C = require("../utils/creators");

let db, server, base;
let sent = [];
const calls = { accounts: [], links: [], sessions: [] };
const fakeStripe = {
  accounts: {
    create: async (p) => { calls.accounts.push(p); return { id: "acct_test_1" }; },
    retrieve: async () => ({ id: "acct_test_1", charges_enabled: true, payouts_enabled: true, details_submitted: true }),
  },
  accountLinks: { create: async (p) => { calls.links.push(p); return { url: "https://connect.stripe.com/setup/e/test" }; } },
  checkout: { sessions: { create: async (p) => { calls.sessions.push(p); return { id: "cs_test_" + calls.sessions.length, url: "https://checkout.stripe.com/c/pay/cs_test" }; } } },
  webhooks: {
    constructEvent: (raw, sig) => {
      if (sig !== "good") throw new Error("bad signature");
      return JSON.parse(Buffer.from(raw).toString("utf8"));
    },
  },
};

before(async () => {
  db = fakeSupabase(
    {
      users: [{ email: "kyron@example.com", hash: "x", role: "admin" }],
      team_members: [
        { email: "member@example.com", name: "Mo", role: "member", tools: ["studio", "creators"], status: "active" },
        { email: "viewer@example.com", name: "Vi", role: "viewer", tools: ["creators"], status: "active" },
        { email: "studio-only@example.com", name: "St", role: "approver", tools: ["studio"], status: "active" },
      ],
    },
    { unique: { creators: ["slug"], creator_events: ["code"], creator_orders: ["stripe_session_id"], creator_webhook_events: ["event_id"], creator_crew: ["code"] } }
  );
  setSupabase(db);
  P.setSender(async (s, payload) => sent.push({ to: s.email, ...payload }));
  db.tables.push_subscriptions = [
    { id: "p1", email: "kyron@example.com", endpoint: "https://push.example.com/k", p256dh: "p", auth: "a", fail_count: 0, kind: "web" },
    { id: "p2", email: "member@example.com", endpoint: "https://push.example.com/m", p256dh: "p", auth: "a", fail_count: 0, kind: "web" },
  ];

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { if (req.originalUrl.startsWith("/api/creators/stripe/webhook")) req.rawBody = Buffer.from(buf); } }));
  app.use(session({ secret: "t", resave: false, saveUninitialized: false }));
  app.post("/test-login", (req, res) => { req.session.userEmail = req.body.email; req.session.userRole = req.body.role || "creator"; req.session.save(() => res.json({ ok: true })); });
  app.use("/api/creators", require("../routes/creators"));
  app.use("/c", require("../routes/creators").pageRouter);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { S._set(null); server && server.close(); });

function client() {
  let cookie = "";
  return async (path, { method = "GET", body, headers = {}, raw } = {}) => {
    const r = await fetch(base + path, { method, headers: { ...(body || raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: raw || (body ? JSON.stringify(body) : undefined) });
    const c = r.headers.get("set-cookie");
    if (c) cookie = c.split(";")[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  };
}
async function as(email, role) {
  const c = client();
  await c("/test-login", { method: "POST", body: { email, role } });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let kyron, mem, view, id, ev, crew;

test("only people with the Creators tool get in; members add creators from a Jotform export", async () => {
  kyron = await as("kyron@example.com", "admin");
  mem = await as("member@example.com");
  view = await as("viewer@example.com");
  const studioOnly = await as("studio-only@example.com");
  assert.equal((await client()("/api/creators")).status, 401);
  assert.equal((await studioOnly("/api/creators")).status, 403, "Studio access isn't Creators access");
  assert.equal((await view("/api/creators")).status, 200);
  assert.equal((await view("/api/creators", { method: "POST", body: { intake: { brandName: "Nope" } } })).status, 403, "viewers can't add");

  const answers = { answers: {
    "3": { text: "Business name", answer: "Sample Desert Media" },
    "4": { text: "Instagram / social handle", answer: "sampledesert" },
    "5": { text: "Coverage area", answer: "Phoenix, AZ" },
    "6": { text: "One-line tagline", answer: "Elite desert sports film. Highlight tape that gets noticed." },
    "7": { text: "Primary color (hex)", answer: "#3b82f6" },
    "8": { text: "Video package price", answer: "$109" },
    "9": { text: "Creator email", answer: "Creator@Example.com" },
  } };
  const r = await mem("/api/creators", { method: "POST", body: answers });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  id = r.json.creator.id;
  assert.equal(r.json.creator.slug, "sample-desert-media");
  assert.equal(r.json.creator.handle, "@sampledesert");
  assert.equal(r.json.creator.packages[1].price, 109);
  assert.deepEqual(r.json.creator.packages.map((k) => k.name), ["Photo Coverage", "Video Coverage", "Full Coverage"], "no banned words in the default packages");
  assert.ok(r.json.checks.some((c) => c.level === "block" && c.field === "tagline" && /elite/.test(c.message)), "the banned word in the tagline blocks");
  assert.equal((await mem("/api/creators", { method: "POST", body: answers })).json.creator.slug, "sample-desert-media-2", "a second one gets its own address");
});

test("the page is on request: blockers stop the request, the owner approves, then /c/<slug> is live", async () => {
  assert.equal((await mem(`/api/creators/${id}/page/request`, { method: "POST" })).json.error, "fix_blockers_first");
  const fix = await mem(`/api/creators/${id}`, { method: "PATCH", body: { tagline: "Desert sports film, delivered within 48 hours." } });
  assert.equal(fix.status, 200);
  assert.equal(C.blockers(fix.json.checks).length, 0);
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { split_percent: 90 } })).json.error, "owner_only");
  assert.equal((await client()("/c/sample-desert-media")).status, 404, "not live yet");
  const prev = await view(`/api/creators/${id}/page/preview`);
  assert.equal(prev.status, 200);
  assert.match(prev.text, /Preview\. This page isn't live yet\./);
  assert.match(prev.headers.get("content-security-policy"), /script-src 'nonce-/);

  sent = [];
  assert.equal((await mem(`/api/creators/${id}/page/request`, { method: "POST" })).status, 200);
  for (let i = 0; i < 40 && !sent.length; i++) await wait(10);
  assert.deepEqual(sent.map((s) => s.to), ["kyron@example.com"], "the owner hears about it");
  assert.equal((await mem(`/api/creators/${id}/page/approve`, { method: "POST" })).status, 403, "members can't put a page live");
  const ok = await kyron(`/api/creators/${id}/page/approve`, { method: "POST" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.page_url, "https://tojcampaign.com/c/sample-desert-media");
  assert.equal(ok.json.creator.rung, 2);
  const page = await client()("/c/sample-desert-media");
  assert.equal(page.status, 200);
  assert.match(page.text, /Sample Desert Media/);
  assert.match(page.text, /Checkout isn't switched on yet/);
  assert.doesNotMatch(page.text, /creator@example\.com/i, "no emails on the page");
});

test("a live page: members can't edit what the public sees, and nobody can break it", async () => {
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { tagline: "New words" } })).json.error, "page_live_owner_edits");
  const bad = await kyron(`/api/creators/${id}`, { method: "PATCH", body: { packages: [{ id: "photo", name: "Elite Photos", price: 49, desc: "x", features: [] }] } });
  assert.equal(bad.json.error, "would_break_live_page");
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { camera: "Sony FX30" } })).status, 200, "members can still edit what isn't public");
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { slug: "other" } })).json.error, "slug_locked");
});

test("under 18: a guardian's email is required, and they hold the Stripe account", async () => {
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { under_18: true } })).json.error, "guardian_required");
  assert.equal((await mem(`/api/creators/${id}`, { method: "PATCH", body: { under_18: true, guardian_email: "Parent@Example.com" } })).status, 200);
  assert.equal((await kyron(`/api/creators/${id}/stripe/connect`, { method: "POST" })).json.error, "stripe_not_configured", "no key: refused with the reason");
  S._set({ stripe: fakeStripe, mode: "test" });
  assert.equal((await mem(`/api/creators/${id}/stripe/connect`, { method: "POST" })).status, 403, "only the owner starts Stripe");
  const r = await kyron(`/api/creators/${id}/stripe/connect`, { method: "POST" });
  assert.equal(r.status, 200);
  assert.equal(r.json.holder, "parent_or_guardian");
  assert.equal(calls.accounts[0].email, "parent@example.com");
  assert.equal(calls.accounts[0].type, "express");
  assert.equal(calls.links[0].type, "account_onboarding");
  assert.equal((await mem(`/api/creators/${id}/stripe/refresh`, { method: "POST" })).json.ready, true);
});

test("events get a code and a QR; crew get a code that credits their sales", async () => {
  const e = await mem(`/api/creators/${id}/events`, { method: "POST", body: { name: "Spring 7v7 Classic", venue: "Test Fields", event_date: "2026-11-07", sport: "7v7" } });
  assert.equal(e.status, 200);
  ev = e.json.event;
  assert.match(ev.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(ev.page_url, `https://tojcampaign.com/c/sample-desert-media?e=${ev.code}`);
  const m = await mem(`/api/creators/${id}/crew`, { method: "POST", body: { name: "Jordan Sample", role: "lead" } });
  crew = m.json.crew;
  assert.match(crew.code, /^[A-HJ-NP-Z2-9]{4}$/);
  assert.equal((await mem(`/api/creators/${id}/crew`, { method: "POST", body: { name: "X", role: "boss" } })).json.error, "invalid_role");
  const qr = await view(`/api/creators/${id}/events/${ev.id}/qr.svg?crew=${crew.code}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(qr.text, /^<svg/);
  const card = await view(`/api/creators/${id}/events/${ev.id}/card?crew=${crew.code}`);
  assert.match(card.text, /Spring 7v7 Classic/);
  assert.match(card.text, /Ask for Jordan</, "first name only");
  assert.doesNotMatch(card.text, /Sample</);
  const page = await client()(`/c/sample-desert-media?e=${ev.code}&r=${crew.code}`);
  assert.match(page.text, /Spring 7v7 Classic/);
  assert.match(page.text, new RegExp(`value="${crew.code}" selected`));
  assert.match(page.text, /Test mode\. No real charges/);
});

test("checkout: consent and a team/jersey are required; the creator's share goes to their account", async () => {
  const anon = client();
  const url = "/api/creators/public/sample-desert-media/checkout";
  assert.equal((await anon(url, { method: "POST", body: { package_id: "video", team_jersey: "Test Team #2" } })).json.error, "consent_required");
  assert.equal((await anon(url, { method: "POST", body: { package_id: "video", consent_delivery: true } })).json.error, "team_jersey_required");
  assert.equal((await anon(url, { method: "POST", body: { package_id: "nope", team_jersey: "T", consent_delivery: true } })).json.error, "unknown_package");
  const r = await anon(url, { method: "POST", body: { package_id: "video", event_code: ev.code, crew_code: crew.code, team_jersey: "Test Team #2", instagram: "@test_athlete", consent_delivery: true, consent_public: false } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.url, "https://checkout.stripe.com/c/pay/cs_test");
  const s = calls.sessions.at(-1);
  assert.equal(s.line_items[0].price_data.unit_amount, 10900);
  assert.equal(s.payment_intent_data.application_fee_amount, 2180, "20% stays with the platform");
  assert.equal(s.payment_intent_data.transfer_data.destination, "acct_test_1");
  assert.equal(s.metadata.creator_cents, "8720");
  assert.equal(s.metadata.event_id, ev.id);
  assert.equal(s.metadata.crew_code, crew.code);
  assert.equal(s.metadata.consent_public, "no");
  assert.match(s.success_url, /\/c\/sample-desert-media\?paid=1&e=/);
});

test("the webhook turns a paid checkout into an order, once; the sale alert has no buyer details", async () => {
  process.env.CREATOR_STRIPE_WEBHOOK_SECRET = "whsec_test";
  const md = calls.sessions.at(-1).metadata;
  const event = { id: "evt_1", type: "checkout.session.completed", livemode: false, data: { object: { id: "cs_test_1", payment_status: "paid", amount_total: 10900, metadata: md, customer_details: { name: "Pat Parent", email: "Pat@Example.com", phone: "+15555550100" } } } };
  const hook = client();
  assert.equal((await hook("/api/creators/stripe/webhook", { method: "POST", raw: JSON.stringify(event), headers: { "stripe-signature": "bad" } })).status, 400);
  sent = [];
  const r = await hook("/api/creators/stripe/webhook", { method: "POST", raw: JSON.stringify(event), headers: { "stripe-signature": "good" } });
  assert.equal(r.status, 200);
  assert.equal(db.tables.creator_orders.length, 1);
  const o = db.tables.creator_orders[0];
  assert.deepEqual([o.amount_cents, o.creator_cents, o.platform_cents, o.mode, o.buyer_email, o.team_jersey, o.crew_code, o.consent_public], [10900, 8720, 2180, "test", "pat@example.com", "Test Team #2", crew.code, false]);
  assert.equal((await hook("/api/creators/stripe/webhook", { method: "POST", raw: JSON.stringify(event), headers: { "stripe-signature": "good" } })).json.duplicate, true);
  assert.equal(db.tables.creator_orders.length, 1, "a retried event doesn't double the order");
  for (let i = 0; i < 40 && sent.length < 2; i++) await wait(10);
  assert.deepEqual(sent.map((s) => s.to).sort(), ["kyron@example.com", "member@example.com"]);
  assert.ok(!JSON.stringify(sent).match(/Pat|pat@|Test Team/), "no buyer or athlete details in the alert");
});

test("the event CSV: chosen columns, formulas defused, members only", async () => {
  db.tables.creator_orders.push({ id: "o2", creator_id: id, event_id: ev.id, package_id: "photo", package_name: "Photo Coverage", amount_cents: 4900, creator_cents: 3920, platform_cents: 980, buyer_name: "=cmd()", buyer_email: "x@example.com", status: "Paid", mode: "test", created_at: "2026-11-07T15:00:00Z" });
  assert.equal((await view(`/api/creators/${id}/orders.csv`)).status, 403, "viewers can't export buyer details");
  const r = await mem(`/api/creators/${id}/orders.csv?event=${ev.id}&columns=date,package,amount,creator_share,buyer_name,crew,mode`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), new RegExp(`sample-desert-media-${ev.code}-sales-\\d{4}-\\d{2}-\\d{2}\\.csv`));
  const lines = r.text.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines[0], "Date,Package,Amount,Creator share,Buyer,Crew,Mode");
  assert.equal(lines.length, 3);
  assert.ok(lines.some((l) => l.includes("'=cmd()")), "a formula is written as text");
  assert.ok(lines.some((l) => l.includes(`Jordan Sample (${crew.code})`)));
  const st = await mem(`/api/creators/${id}/orders/o2`, { method: "PATCH", body: { status: "Delivered" } });
  assert.equal(st.json.order.status, "Delivered");
  const one = await view(`/api/creators/${id}`);
  assert.equal(one.json.totals.orders, 2);
  assert.equal(one.json.events[0].totals.sales_cents, 15800);
  assert.equal(one.json.creator.stripe_account_id, undefined, "the account id stays on the server");
});

test("live Stripe keys are refused until counsel signs off; a paused creator's page goes dark", async () => {
  S._set(null);
  process.env.CREATOR_STRIPE_SECRET_KEY = "sk_live_123";
  assert.deepEqual(S.mode(), { ok: false, error: "live_key_refused" });
  process.env.CREATOR_STRIPE_LIVE = "yes";
  assert.equal(S.mode().mode, "live");
  process.env.CREATOR_STRIPE_SECRET_KEY = "sk_test_123";
  delete process.env.CREATOR_STRIPE_LIVE;
  assert.equal(S.mode().mode, "test");
  delete process.env.CREATOR_STRIPE_SECRET_KEY;
  assert.equal((await kyron(`/api/creators/${id}`, { method: "PATCH", body: { status: "paused" } })).status, 200);
  assert.equal((await client()("/c/sample-desert-media")).status, 404);
  assert.equal((await client()("/c/../etc")).status, 404);
});
