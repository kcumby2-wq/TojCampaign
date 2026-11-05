// The marketplace's family side (routes/sm-market-public.js), in-process on
// the fake Supabase, a fake Storage and a stand-in for Stripe: who sees what,
// the QR form and its confirm link, the family page, checkout, the webhook's
// paid() and the order page's downloads.
//
//   node --test tests/sm-market-public.test.js

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.ADMIN_EMAILS = "kyron@toj.test";
process.env.SM_SITE_BASE = "https://www.subjectmedias.com";
process.env.SUPABASE_URL = "https://ckaocyldpvypegwbyahh.supabase.co";
delete process.env.EMAIL_USER;
delete process.env.EMAIL_PASS;

const express = require("express");
const { setSupabase } = require("../utils/supabase");
const { fakeSupabase } = require("./helpers/fake-supabase");
const { fakeStorage } = require("./helpers/fake-storage");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const S = require("../utils/creator-stripe");
const M = require("../utils/sm-market");
const router = require("../routes/sm-market-public");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EV = id(1);
const DRAFT = id(2);
const LIGHTNING = id(10);
const STORM = id(11);
const A7 = id(20); // OK to sell
const A11 = id(21); // family only, has a family link
const A23 = id(22); // no answer yet
const A9 = id(23); // kept out
const [M1, M2, M3, M4, M5, M6, M7] = [31, 32, 33, 34, 35, 36, 37].map(id);

let server, base, db, store, mails, pushes, sessions, created, familyToken;

async function get(path) {
  const r = await fetch(base + path, { redirect: "manual" });
  return { status: r.status, html: await r.text(), headers: r.headers };
}
async function post(path, fields, { headers = {} } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, x);
  const r = await fetch(base + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

before(async () => {
  const app = express();
  // As server.js does: the webhook's raw body is kept for its signature.
  app.use(express.json({ verify: (req, _res, buf) => { if (req.originalUrl.startsWith("/api/creators/stripe/webhook")) req.rawBody = Buffer.from(buf); } }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/m", router);
  app.use("/api/creators", require("../routes/creators"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  push.setSender(async (sub, payload) => { pushes.push({ to: sub.email, payload }); return {}; });
});
after(() => { server && server.close(); mailer.setSender(null); push.setSender(null); S._set(null); setSupabase(null); });

function fakeStripe() {
  sessions = new Map();
  created = [];
  return {
    mode: "test",
    stripe: {
      checkout: {
        sessions: {
          async create(params) {
            const sid = "cs_test_" + crypto.randomBytes(10).toString("hex");
            created.push({ id: sid, params });
            sessions.set(sid, { id: sid, status: "open", payment_status: "unpaid", amount_total: params.line_items.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0), metadata: params.metadata, livemode: false });
            return { id: sid, url: `https://checkout.stripe.com/c/pay/${sid}` };
          },
          async retrieve(sid) {
            return sessions.get(sid);
          },
        },
      },
      webhooks: {
        constructEvent: (raw, sig) => {
          if (sig !== "good") throw new Error("bad signature");
          return JSON.parse(Buffer.from(raw).toString("utf8"));
        },
      },
    },
  };
}
// Stripe, after the buyer pays.
function pay(sid, email = "Dana@Example.com") {
  const s = sessions.get(sid);
  Object.assign(s, { status: "complete", payment_status: "paid", customer_details: { email } });
  return s;
}

beforeEach(() => {
  router._reset();
  mails = [];
  pushes = [];
  const fam = M.newToken();
  familyToken = fam.token;
  const tag = (media, athlete, confirmed = true) => ({ media_id: media, athlete_id: athlete, event_id: EV, source: "ai", confidence: 0.9, confirmed, confirmed_by: confirmed ? "crew@toj.test" : null });
  const item = (mid, kind, over = {}) => ({ id: mid, event_id: EV, kind, status: "approved", object_key: M.originalKey(EV, mid, kind === "clip" ? "mp4" : "jpg"), preview_key: M.previewKey(EV, mid, kind), poster_key: M.posterKey(EV, mid), duration_ms: kind === "clip" ? 12480 : null, approved_at: `2026-11-21T20:${mid.slice(-2)}:00Z`, ...over });
  db = fakeSupabase(
    {
      sm_market_events: [
        { id: EV, code: "AB2CD3", name: "Fall Showcase", sport: "Football", starts_on: "2026-11-21", ends_on: "2026-11-22", venue: "Memorial Stadium", city: "Houston", state: "TX", status: "live", clip_cents: 1200, photo_cents: 800 },
        { id: DRAFT, code: "XY4ZW5", name: "Winter Classic", starts_on: "2026-12-05", ends_on: "2026-12-05", status: "draft", clip_cents: 1200, photo_cents: 800 },
      ],
      sm_market_teams: [{ id: LIGHTNING, event_id: EV, name: "Lightning" }, { id: STORM, event_id: EV, name: "Storm" }],
      sm_market_athletes: [
        { id: A7, event_id: EV, team_id: LIGHTNING, jersey: "7", keep_out: false },
        { id: A11, event_id: EV, team_id: LIGHTNING, jersey: "11", keep_out: false },
        { id: A23, event_id: EV, team_id: LIGHTNING, jersey: "23", keep_out: false },
        { id: A9, event_id: EV, team_id: STORM, jersey: "9", keep_out: false },
      ],
      sm_market_consents: [
        { id: id(40), athlete_id: A7, email: "dana@example.com", level: "sell", under_13: false, source: "qr", confirmed_at: "2026-11-21T10:00:00Z" },
        { id: id(41), athlete_id: A11, email: "sam@example.com", level: "family", under_13: true, source: "qr", confirmed_at: "2026-11-21T10:00:00Z", family_hash: fam.hash },
        { id: id(42), athlete_id: A9, email: "lee@example.com", level: "out", under_13: false, source: "qr", confirmed_at: null },
      ],
      sm_market_media: [
        item(M1, "clip"), // #7 alone: on #7's event page
        item(M2, "photo"), // #7 and #23 (no answer): nowhere
        item(M3, "clip"), // #7 by the AI only: nowhere
        item(M4, "clip", { status: "review" }), // not approved: nowhere
        item(M5, "clip"), // #11 alone: #11's family page
        item(M6, "photo"), // #11 and #7: #11's family page, not #7's event page
        item(M7, "clip"), // #9, kept out: nowhere
      ],
      sm_market_tags: [tag(M1, A7), tag(M2, A7), tag(M2, A23), tag(M3, A7, false), tag(M4, A7), tag(M5, A11), tag(M6, A11), tag(M6, A7), tag(M7, A9)],
      team_members: [{ email: "lead@toj.test", role: "approver", tools: ["market"], status: "active" }],
      push_subscriptions: [{ id: "p1", email: "kyron@toj.test", endpoint: "https://push.test/1", p256dh: "k", auth: "a", kind: "web", fail_count: 0 }],
    },
    { unique: { sm_market_orders: ["token_hash"], sm_market_consents: ["family_hash"], creator_webhook_events: ["event_id"] } }
  );
  store = fakeStorage();
  db.storage = store;
  for (const m of db.tables.sm_market_media) for (const k of [m.object_key, m.preview_key, m.poster_key]) store.put(M.BUCKET, k, "x");
  setSupabase(db);
  S._set(fakeStripe());
});

const shown = (html) => [M1, M2, M3, M4, M5, M6, M7].filter((m) => html.includes(`value="${m}"`));

// ── The event page ───────────────────────────────────────────────────────
test("the event page: its own locked-down headers, the teams, no athlete listed", async () => {
  const r = await get("/m/AB2CD3");
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /script-src 'nonce-[^']+'/);
  assert.match(csp, /media-src https:\/\/ckaocyldpvypegwbyahh\.supabase\.co/);
  assert.match(csp, /form-action 'self' https:\/\/checkout\.stripe\.com/);
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(r.html, /<h1 class="ev-name">Fall Showcase<\/h1>/);
  assert.match(text(r.html), /Nov 21–22, 2026 at Memorial Stadium, Houston, TX/);
  assert.match(r.html, /<option value="[^"]+">Lightning<\/option><option value="[^"]+">Storm<\/option>/);
  assert.ok(!/style="/.test(r.html), "no inline style attributes (the CSP would block them)");
  assert.equal((await get("/m/ZZZZZZ")).status, 404);
  assert.equal((await get("/m/not-a-code")).status, 404);
  assert.match(text((await get("/m/XY4ZW5")).html), /Not open yet/);
});

test("a team and a number show only what everyone in it said may be sold", async () => {
  const seven = await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=07`);
  assert.equal(seven.status, 200);
  assert.deepEqual(shown(seven.html), [M1], "not the photo with #23, the AI's guess, one in review, or one with a family-only athlete");
  assert.match(seven.html, /<video controls playsinline preload="none" poster="https:\/\/store\.test\/object\/sign\/sm-market\/events\/[^"]+-poster\.jpg[^"]*" src="https:\/\/store\.test\/object\/sign\/sm-market\/events\/[^"]+\/previews\/[^"]+\.mp4/);
  assert.ok(!seven.html.includes("/originals/"), "never the original");
  assert.match(text(seven.html), /Lightning #7/);
  assert.match(text(seven.html), /1 clip/);
  assert.deepEqual(shown((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=11`)).html), [], "family only: never on the event page");
  assert.deepEqual(shown((await get(`/m/AB2CD3?team=${STORM}&jersey=9`)).html), [], "kept out");
  // No signal about who exists or who answered: the same words either way.
  const said = (html) => text(html).match(/Nothing for [^.]+ yet\. Our crew checks[^.]+\./)[0].replace(/#\d+/, "#N");
  const a = said((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=23`)).html);
  const b = said((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=88`)).html);
  assert.equal(a, b);
  assert.equal((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=seven`)).status, 400);
});

test("a keep-out asked for today hides footage at once, confirmed or not", async () => {
  db.tables.sm_market_consents.push({ id: id(43), athlete_id: A7, email: "pat@example.com", level: "out", under_13: false, source: "qr", confirmed_at: null });
  assert.deepEqual(shown((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=7`)).html), []);
});

// ── Checkout and paying ──────────────────────────────────────────────────
test("checkout takes only what may be sold, prices it from the event, and goes to Stripe", async () => {
  const r = await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1, M2, M7, "nope"] });
  assert.equal(r.status, 303);
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  const order = db.tables.sm_market_orders[0];
  assert.equal(order.status, "pending");
  assert.equal(order.amount_cents, 1200, "M2 and M7 aren't for sale here, whatever the form says");
  assert.equal(order.mode, "test");
  assert.deepEqual(db.tables.sm_market_order_items.map((i) => [i.media_id, i.price_cents]), [[M1, 1200]]);
  const { params } = created[0];
  assert.deepEqual(params.line_items, [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1200, product_data: { name: "Clip from Fall Showcase" } } }]);
  assert.equal(params.metadata.kind, "sm_market");
  assert.equal(params.metadata.order_id, order.id);
  assert.equal(M.hashToken(params.metadata.order_token), order.token_hash, "the link's token travels; only its hash is stored");
  assert.equal(params.success_url, `https://www.subjectmedias.com/m/o/${params.metadata.order_token}?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.cancel_url, `https://www.subjectmedias.com/m/AB2CD3?team=${LIGHTNING}&jersey=7`);
  assert.equal(order.stripe_session_id, created[0].id);
  // Nothing picked: back to the page, no order.
  const none = await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7" });
  assert.equal(none.status, 303);
  assert.equal(db.tables.sm_market_orders.length, 1);
});

test("checkout before Stripe is set up says so, and charges nothing", async () => {
  S._set(null);
  const before = process.env.CREATOR_STRIPE_SECRET_KEY;
  delete process.env.CREATOR_STRIPE_SECRET_KEY;
  try {
    const r = await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
    assert.equal(r.status, 503);
    assert.match(text(r.html), /Checkout isn't open yet/);
    assert.equal((db.tables.sm_market_orders || []).length, 0);
  } finally {
    if (before !== undefined) process.env.CREATOR_STRIPE_SECRET_KEY = before;
  }
});

test("paid: the webhook marks the order, emails the link once, and tells staff", async () => {
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  const ses = pay(created[0].id);
  const r = await router.paid(ses);
  assert.deepEqual(r, { ok: true, flipped: true });
  const order = db.tables.sm_market_orders[0];
  assert.equal(order.status, "paid");
  assert.equal(order.email, "dana@example.com");
  assert.ok(order.paid_at && order.emailed_at);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["dana@example.com"]);
  assert.ok(mails[0].text.includes(`https://www.subjectmedias.com/m/o/${created[0].params.metadata.order_token}`));
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].payload.title, "New marketplace sale");
  assert.equal(pushes[0].payload.body, "Fall Showcase: 1 item, $12.00 (test)");
  // Stripe sends it again: nothing new happens.
  assert.deepEqual(await router.paid(ses), { ok: true, flipped: false });
  assert.equal(mails.length, 1);
  // A session whose total doesn't match the order isn't taken as paid.
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  const odd = { ...pay(created[1].id), amount_total: 100 };
  assert.equal((await router.paid(odd)).reason, "amount_mismatch");
  assert.equal(db.tables.sm_market_orders[1].status, "pending");
});

test("the Stripe webhook the Creator Club already uses hands marketplace checkouts here", async () => {
  process.env.CREATOR_STRIPE_WEBHOOK_SECRET = "whsec_test";
  const hook = (event) => fetch(base + "/api/creators/stripe/webhook", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "good" }, body: JSON.stringify(event) });
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  const r = await hook({ id: "evt_m1", type: "checkout.session.completed", livemode: false, data: { object: pay(created[0].id) } });
  assert.equal(r.status, 200);
  assert.equal(db.tables.sm_market_orders[0].status, "paid");
  assert.equal((db.tables.creator_orders || []).length, 0, "not a Creator Club sale");
  assert.equal(mails.length, 1);
  assert.equal((await (await hook({ id: "evt_m1", type: "checkout.session.completed", livemode: false, data: { object: sessions.get(created[0].id) } })).json()).duplicate, true);
  assert.equal(mails.length, 1);
  await hook({ id: "evt_m2", type: "checkout.session.expired", livemode: false, data: { object: sessions.get(created[1].id) } });
  assert.equal(db.tables.sm_market_orders[1].status, "expired");
});

test("the order page: back from Stripe before the webhook, it asks Stripe and opens the downloads", async () => {
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  const { id: sid, params } = created[0];
  const token = params.metadata.order_token;
  const waiting = await get(`/m/o/${token}`);
  assert.match(waiting.html, /<meta http-equiv="refresh" content="5">/);
  assert.match(text(waiting.html), /Confirming your payment/);
  pay(sid);
  const r = await get(`/m/o/${token}?session_id=${sid}`);
  assert.equal(r.status, 200);
  assert.match(text(r.html), /Your downloads/);
  assert.match(text(r.html), /test mode: no real charge/);
  const dl = r.html.match(/href="(https:\/\/store\.test\/object\/sign\/sm-market\/events\/[^"]+\/originals\/[^"]+)"/);
  assert.ok(dl, "a signed link to the original");
  assert.match(dl[1], /download=Fall-Showcase-clip-00000000\.mp4/);
  assert.equal(db.tables.sm_market_orders[0].status, "paid");
  assert.equal(mails.length, 1, "the link is emailed from here when the webhook hasn't yet");
  // The webhook arrives after: no second email.
  await router.paid(sessions.get(sid));
  assert.equal(mails.length, 1);
  assert.equal((await get("/m/o/" + "x".repeat(43))).status, 404);
  assert.equal((await get("/m/o/short")).status, 404);
});

test("a family's keep-out after a sale closes that file's download", async () => {
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  await router.paid(pay(created[0].id));
  db.tables.sm_market_athletes.find((a) => a.id === A7).keep_out = true;
  const r = await get(`/m/o/${created[0].params.metadata.order_token}`);
  assert.ok(!/\/originals\//.test(r.html));
  assert.match(text(r.html), /taken down at a family's request/);
});

test("an expired checkout says so", async () => {
  await post("/m/AB2CD3/checkout", { team: LIGHTNING, jersey: "7", item: [M1] });
  await router.expired(sessions.get(created[0].id));
  assert.equal(db.tables.sm_market_orders[0].status, "expired");
  const r = await get(`/m/o/${created[0].params.metadata.order_token}`);
  assert.match(text(r.html), /Checkout expired/);
});

// ── The QR form ──────────────────────────────────────────────────────────
const choice = (over = {}) => ({ team_id: LIGHTNING, jersey: "#4", level: "family", under_13: "yes", email: "Jo@Example.com", guardian: "yes", ...over });

test("the QR form: a choice waits for the email link; a scanner's visit confirms nothing; the button does", async () => {
  const form = await get("/m/AB2CD3/consent");
  assert.match(text(form.html), /Your choice/);
  assert.match(form.html, /name="sm_trap"/);
  const r = await post("/m/AB2CD3/consent", choice());
  assert.equal(r.status, 303);
  assert.equal(r.location, "/m/AB2CD3/consent/sent?m=1");
  const a = db.tables.sm_market_athletes.find((x) => x.team_id === LIGHTNING && x.jersey === "4");
  assert.ok(a, "a number not on the roster yet is added by the guardian's answer");
  const c = db.tables.sm_market_consents.find((x) => x.athlete_id === a.id);
  assert.equal(c.email, "jo@example.com");
  assert.equal(c.confirmed_at, null);
  assert.equal(c.source, "qr");
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Confirm your choice for Lightning #4 at Fall Showcase/);
  const link = mails[0].text.match(/https:\/\/www\.subjectmedias\.com\/m\/confirm\/([A-Za-z0-9_-]{43})/);
  assert.ok(link);
  assert.equal(c.confirm_hash, M.hashToken(link[1]));
  const sent = await get(r.location);
  assert.match(text(sent.html), /Check your email/);
  // A mail scanner opening the link changes nothing.
  const look = await get(`/m/confirm/${link[1]}`);
  assert.match(text(look.html), /Lightning #4: Family only/);
  assert.equal(c.confirmed_at, null);
  const done = await post(`/m/confirm/${link[1]}`, {});
  assert.equal(done.status, 200);
  assert.ok(c.confirmed_at);
  assert.equal(c.confirm_hash, null);
  const fam = done.html.match(/https:\/\/www\.subjectmedias\.com\/m\/f\/([A-Za-z0-9_-]{43})/);
  assert.ok(fam, "the family link is shown");
  assert.equal(c.family_hash, M.hashToken(fam[1]));
  assert.equal(mails.length, 2);
  assert.ok(mails[1].text.includes(fam[0]), "and emailed");
  assert.match(text((await post(`/m/confirm/${link[1]}`, {})).html), /Link already used/);
});

test("a keep-out counts the moment it's sent, with a note to the address given", async () => {
  const r = await post("/m/AB2CD3/consent", choice({ jersey: "7", level: "out", under_13: "no", email: "pat@example.com" }));
  assert.equal(r.location, "/m/AB2CD3/consent/sent?k=out&m=1");
  assert.deepEqual(shown((await get(`/m/AB2CD3?team=${LIGHTNING}&jersey=7`)).html), []);
  assert.match(mails[0].subject, /^Kept out: Lightning #7 at Fall Showcase/);
  assert.ok(!/\/m\/confirm\//.test(mails[0].text), "nothing to confirm");
  assert.match(text((await get(r.location)).html), /Kept out/);
});

test("the form's rules: every field, never public under 13, the right team, bots get the usual answer", async () => {
  const bad = await post("/m/AB2CD3/consent", { team_id: STORM.replace(/1$/, "9"), jersey: "A", level: "public", under_13: "maybe", email: "nope" });
  assert.equal(bad.status, 400);
  for (const f of ["team_id", "jersey", "under_13", "email"]) assert.match(bad.html, new RegExp(`class="f[^"]* bad"[^>]*>(<span>|<legend>)`), f);
  assert.match(bad.html, /class="check bad"/);
  const kid = await post("/m/AB2CD3/consent", choice({ level: "public", under_13: "yes" }));
  assert.equal(kid.status, 400, "never public for an athlete 12 or younger");
  assert.match(text(kid.html), /Showing publicly isn't open for athletes 12 or younger/);
  assert.match(kid.html, /value="public" checked/, "what they entered stays");
  const bot = await post("/m/AB2CD3/consent", choice({ sm_trap: "x" }));
  assert.equal(bot.status, 303);
  assert.equal(db.tables.sm_market_consents.length, 3, "nothing saved");
  assert.equal(mails.length, 0);
});

test("a new answer from the same guardian replaces the old one and needs confirming again", async () => {
  const before = db.tables.sm_market_consents.find((c) => c.athlete_id === A11);
  await post("/m/AB2CD3/consent", choice({ jersey: "11", level: "sell", under_13: "yes", email: "sam@example.com" }));
  const c = db.tables.sm_market_consents.find((x) => x.athlete_id === A11);
  assert.equal(c, before, "one answer per guardian per athlete");
  assert.equal(c.level, "sell");
  assert.equal(c.confirmed_at, null);
  assert.equal(c.family_hash, null, "the old family link stops until they confirm");
  assert.equal((await get(`/m/f/${familyToken}`)).status, 404);
});

test("when email isn't working, the page says what to do instead", async () => {
  mailer.setSender(async () => ({ sent: false, reason: "email_not_configured" }));
  try {
    const r = await post("/m/AB2CD3/consent", choice());
    assert.equal(r.location, "/m/AB2CD3/consent/sent?m=0");
    assert.match(text((await get(r.location)).html), /We couldn't email you just now/);
  } finally {
    mailer.setSender(async (m) => { mails.push(m); return { sent: true }; });
  }
});

test("too many tries from one visitor: slow down", async () => {
  let last;
  for (let i = 0; i < 13; i++) last = await post("/m/AB2CD3/consent", choice({ jersey: String(40 + i) }), { headers: { "X-Forwarded-For": "203.0.113.9" } });
  assert.equal(last.status, 429);
  const other = await post("/m/AB2CD3/consent", choice({ jersey: "60" }), { headers: { "X-Forwarded-For": "203.0.113.10" } });
  assert.equal(other.status, 303);
});

// ── A family's page ──────────────────────────────────────────────────────
test("the family page: their own athlete at family level, with others only where they may be sold", async () => {
  const r = await get(`/m/f/${familyToken}`);
  assert.equal(r.status, 200);
  assert.deepEqual(shown(r.html), [M5, M6]);
  assert.match(text(r.html), /Your family link for Lightning #11/);
  const buy = await post(`/m/f/${familyToken}/checkout`, { item: [M5, M6, M1] });
  assert.equal(buy.status, 303);
  const order = db.tables.sm_market_orders[0];
  assert.equal(order.amount_cents, 2000, "a clip and a photo; M1 isn't theirs");
  assert.deepEqual(created[0].params.line_items.map((l) => [l.price_data.product_data.name, l.quantity, l.price_data.unit_amount]), [["Clip from Fall Showcase", 1, 1200], ["Photo from Fall Showcase", 1, 800]]);
  assert.equal(created[0].params.cancel_url, `https://www.subjectmedias.com/m/f/${familyToken}`);
  // #7's family keeps them out: the shared photo goes too.
  db.tables.sm_market_athletes.find((a) => a.id === A7).keep_out = true;
  assert.deepEqual(shown((await get(`/m/f/${familyToken}`).then((x) => x)).html), [M5]);
  // Their own keep-out: nothing at all.
  db.tables.sm_market_athletes.find((a) => a.id === A11).keep_out = true;
  const none = await get(`/m/f/${familyToken}`);
  assert.deepEqual(shown(none.html), []);
  assert.match(text(none.html), /Nothing to show/);
  assert.equal((await get("/m/f/" + "y".repeat(43))).status, 404);
});

test("before migration 033: a plain 'not open yet' page", async () => {
  const broken = fakeSupabase({});
  const from = broken.from;
  broken.from = (name) => {
    const q = from(name);
    q.then = (res) => Promise.resolve({ data: null, error: { code: "42P01", message: "relation does not exist" } }).then(res);
    return q;
  };
  setSupabase(broken);
  const r = await get("/m/AB2CD3");
  assert.equal(r.status, 503);
  assert.match(text(r.html), /Not open yet/);
});
