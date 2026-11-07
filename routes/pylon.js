"use strict";
// The public Pylon pages' requests and newsletter (migration 036; the rules
// are in utils/pylon.js).
//
//   POST  /api/pylon/requests                 a form from a Pylon page
//   POST  /api/pylon/newsletter/subscribe     the free newsletter: emails a confirmation
//   POST  /api/pylon/newsletter/confirm       { token } from that email
//   POST  /api/pylon/newsletter/unsubscribe   { token } from an issue
//   POST  /api/pylon/stripe/webhook           Stripe: a Pylon checkout was paid
//   GET   /api/pylon/requests                 staff: open requests (?all=1 for every one)
//   GET   /api/pylon/requests/:id             staff: one request
//   PATCH /api/pylon/requests/:id             staff: status, a note, or paid outside Stripe
//   GET   /api/pylon/newsletter               staff: the list
//
// A request is saved first. When Pylon's Stripe is set up (utils/pylon-stripe.js)
// and the package has a price, the page then goes on to a Stripe checkout made
// here, at the server's price; otherwise the contact hears we'll send a secure
// payment link. Each request alerts staff (a push and an email that carry what
// came in, not who it's about), and the contact gets one note of their own.
// If the database can't take a request, the staff email carries all of it, so
// nobody's request is lost.
//
// The contact, the athlete and the consent answer are shown to staff (owner
// only, like the Subject Medias bookings: minors' data and money) and appear
// nowhere else.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const U = require("../utils/pylon");
const PS = require("../utils/pylon-stripe");

const router = express.Router();
const env = (k) => String(process.env[k] || "").trim();
const APP_BASE = () => (env("APP_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
// Where the Pylon pages live: Stripe sends people back there.
const SITE_BASE = () => (env("PYLON_SITE_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
const helpEmail = () => U.email(env("PYLON_HELP_EMAIL")) || "hello@pylonfootball.com";
const nowIso = () => new Date().toISOString();

// Express 4 doesn't catch a rejected promise from an async handler, and an
// unhandled rejection stops the whole process. Every handler goes through this.
const safe = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error("[pylon] handler failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

// ── Abuse limits ─────────────────────────────────────────────────────────
// The pages post here through Vercel's rewrite, which sets X-Forwarded-For
// to the visitor's address. 8 forms per visitor per 10 minutes, 120 an hour
// in all. Staff emails at most 30 an hour and 100 a day (every request is
// still saved and pushed).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const MAX_TRACKED = 5000;
const HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR;
const MAX_FORMS_PER_HOUR = 120;
const MAX_STAFF_PER_HOUR = 30;
const MAX_STAFF_PER_DAY = 100;
const hits = new Map();
let forms = [];
let staffTimes = [];

function limited(key, now = Date.now()) {
  const h = hits.get(key);
  if (h && now - h.start <= WINDOW_MS) {
    h.n += 1;
    return h.n > MAX_PER_WINDOW;
  }
  if (h) hits.delete(key);
  hits.set(key, { start: now, n: 1 });
  // Insertion order: the oldest windows are at the front.
  for (const [k, v] of hits) {
    if (now - v.start <= WINDOW_MS && hits.size <= MAX_TRACKED) break;
    hits.delete(k);
  }
  return false;
}
function formAllowed(now = Date.now()) {
  forms = forms.filter((t) => now - t < HOUR);
  if (forms.length >= MAX_FORMS_PER_HOUR) return false;
  forms.push(now);
  return true;
}
function staffMailAllowed(now = Date.now()) {
  staffTimes = staffTimes.filter((t) => now - t < DAY_MS);
  if (staffTimes.length >= MAX_STAFF_PER_DAY || staffTimes.filter((t) => now - t < HOUR).length >= MAX_STAFF_PER_HOUR) return false;
  staffTimes.push(now);
  return true;
}
const visitor = (req) =>
  String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 100) || String((req.socket && req.socket.remoteAddress) || "unknown");
// One visitor on IPv6 is their /64, spelled out to its eight groups first, so
// "::" and leading zeros can't make one /64 look like many.
function visitorKey(v) {
  const a = String(v).toLowerCase().split("%")[0];
  if (!a.includes(":")) return a;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const parts = a.split("::");
  if (parts.length > 2) return a;
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const groups = parts.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

// The notes people get go to an address someone typed. A request's note: at
// most 2 a day to one mailbox. A newsletter confirmation: 1 a day to one
// mailbox. 6 a day from one visitor (families at one event share a network),
// and 30 an hour and 100 a day in all. So the forms can't fill anyone's
// inbox, or use up the account the staff alerts need. Mailboxes and visitors go through an HMAC with a key made
// fresh at each start; never kept. A note that couldn't go gives its place back.
const MAX_NOTES_PER_MAILBOX = 2;
const MAX_CONFIRMS_PER_MAILBOX = 1;
const MAX_NOTES_PER_VISITOR = 6;
const MAX_NOTES_PER_HOUR = 30;
const MAX_NOTES_PER_DAY = 100;
const SALT = crypto.randomBytes(32);
const noteSent = new Map(); // key → times
let noteTimes = [];
const keyOf = (kind, v) => kind + ":" + crypto.createHmac("sha256", SALT).update(String(v)).digest("base64").slice(0, 22);
// Takes a place for one note, or says no (null). Returns the way to give it back.
function noteAllowed(address, who, { confirm = false } = {}, now = Date.now()) {
  noteTimes = noteTimes.filter((t) => now - t < DAY_MS);
  if (noteTimes.length >= MAX_NOTES_PER_DAY) return null;
  if (noteTimes.filter((t) => now - t < HOUR).length >= MAX_NOTES_PER_HOUR) return null;
  const keys = [[keyOf(confirm ? "confirm" : "to", U.mailbox(address)), confirm ? MAX_CONFIRMS_PER_MAILBOX : MAX_NOTES_PER_MAILBOX]];
  if (who) keys.push([keyOf("from", visitorKey(who)), MAX_NOTES_PER_VISITOR]);
  for (const [k, max] of keys) if ((noteSent.get(k) || []).filter((t) => now - t < DAY_MS).length >= max) return null;
  for (const [k] of keys) noteSent.set(k, [...(noteSent.get(k) || []).filter((t) => now - t < DAY_MS), now]);
  noteTimes.push(now);
  if (noteSent.size > 20000) for (const [k, v] of noteSent) if (!v.some((t) => now - t < DAY_MS)) noteSent.delete(k);
  const drop = (list) => {
    const i = list.lastIndexOf(now);
    if (i >= 0) list.splice(i, 1);
  };
  return () => {
    drop(noteTimes);
    for (const [k] of keys) drop(noteSent.get(k) || []);
  };
}

const mailError = mailer.errorCode;
// An error the request itself caused (a value Postgres refuses) isn't the
// database being down.
const inputError = (e) => !!e && /^2[23]/.test(String(e.code || ""));

// ── Alerts ───────────────────────────────────────────────────────────────
// A push and an email to staff. paid: Stripe just confirmed the payment.
// Never throws.
async function alertStaff(sb, row, { paid = false } = {}) {
  try {
    const to = [...staffEmails()];
    push.notifySoon(to, U.pushPayload(row));
    if (staffMailAllowed()) {
      const mail = U.staffEmail(row, APP_BASE(), { paid });
      mailer
        .sendMail({ to, subject: mail.subject, text: mail.text, pool: "pylon" })
        .then((r) => {
          if (!r.sent) console.warn(`[pylon] staff email not sent (${r.reason})`);
        })
        .catch((e) => console.warn("[pylon] staff email failed:", mailError(e)));
    } else console.warn("[pylon] over the staff email budget: push only");
    if (!paid) await sb.from("pylon_requests").update({ alerted_at: nowIso() }).eq("id", row.id);
  } catch (e) {
    console.warn("[pylon] alert failed:", e && e.message);
  }
}

// The database couldn't take the request: email it to staff whole. Always
// sent (it's the only copy), and critical to the mailer's day's budget.
async function emailUnsaved(row) {
  try {
    const mail = U.staffEmail({ ...row, id: "not-saved" }, APP_BASE(), { saved: false });
    staffMailAllowed();
    const r = await mailer.sendMail({ to: [...staffEmails()], subject: `${mail.subject} (not saved)`, text: mail.text, critical: true });
    return !!(r && r.sent);
  } catch (e) {
    console.error("[pylon] fallback email failed:", mailError(e));
    return false;
  }
}

// The contact's note, once: claimed on the row (column) before it goes, so
// two deliveries of one webhook can't both send it. If it couldn't go, the
// claim and its place in the limits are given back. Never throws.
async function emailContact(sb, row, column, build, who = null) {
  try {
    if (!row || !row.contact_email || row[column]) return;
    const giveBack = noteAllowed(row.contact_email, who);
    if (!giveBack) return console.warn("[pylon] contact note over its limits: not sent");
    const claimed = await sb.from("pylon_requests").update({ [column]: nowIso() }).eq("id", row.id).is(column, null).select("id");
    if (claimed.error || !(claimed.data || []).length) return giveBack();
    const mail = build(row);
    let r = null;
    try {
      r = await mailer.sendMail({ to: row.contact_email, subject: mail.subject, text: mail.text, replyTo: helpEmail(), pool: "pylon" });
    } catch (e) {
      console.warn("[pylon] contact note failed:", mailError(e));
    }
    if (!r || !r.sent) {
      if (r) console.warn(`[pylon] contact note not sent (${r.reason})`);
      giveBack();
      await sb.from("pylon_requests").update({ [column]: null }).eq("id", row.id);
    }
  } catch (e) {
    console.warn("[pylon] contact note failed:", mailError(e));
  }
}

// ── Checkout ─────────────────────────────────────────────────────────────
// A creator code is Stripe's to know: an active promotion code by that name
// is applied for the buyer. Anything else, and the buyer can still type one.
async function activePromo(stripe, code) {
  try {
    const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const hit = list && list.data && list.data[0];
    return hit && hit.id ? hit.id : null;
  } catch (e) {
    console.warn("[pylon] creator code lookup failed:", e && (e.code || e.type));
    return null;
  }
}

// A Stripe checkout for a saved request, at the server's price. The URL, or
// null when checkout isn't set up or didn't start (the request stands, and
// the contact hears we'll send a link).
async function startCheckout(sb, row) {
  const item = U.CATALOG[row.kind] && U.CATALOG[row.kind][row.package];
  if (!item || !item.cents || row.kind === "ambassador") return null;
  let s;
  try {
    s = PS.stripe();
  } catch (e) {
    return null;
  }
  const monthly = item.cadence === "month";
  const page = SITE_BASE() + (U.PAGES[row.kind] || "/");
  const meta = { kind: "pylon", request_id: row.id, package: row.package };
  const params = {
    mode: monthly ? "subscription" : "payment",
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "usd", unit_amount: item.cents, product_data: { name: item.name }, ...(monthly ? { recurring: { interval: "month" } } : {}) },
      },
    ],
    client_reference_id: row.id,
    customer_email: row.contact_email,
    metadata: meta,
    success_url: `${page}?paid=1`,
    cancel_url: `${page}?cancelled=1`,
    // Cards (and the wallets that use them) only, so paid means paid at once.
    payment_method_types: ["card"],
  };
  if (monthly) params.subscription_data = { metadata: meta };
  else params.payment_intent_data = { metadata: meta };
  // Creator codes are a player-package offer; no other checkout takes a code.
  if (row.kind === "player_package") {
    const promo = row.referral_code ? await activePromo(s.stripe, row.referral_code) : null;
    if (promo) params.discounts = [{ promotion_code: promo }];
    else params.allow_promotion_codes = true;
  }
  let session;
  try {
    session = await s.stripe.checkout.sessions.create(params);
  } catch (e) {
    console.error("[pylon] checkout didn't start:", e && (e.code || e.type), e && e.message);
    return null;
  }
  if (!session || !session.url || !/^cs_(test|live)_/.test(String(session.id))) return null;
  const { error } = await sb
    .from("pylon_requests")
    .update({ checkout_session_id: session.id, checkout_mode: s.mode, updated_at: nowIso() })
    .eq("id", row.id)
    .is("checkout_session_id", null);
  // The webhook still finds the request by its id if this didn't save.
  if (error) console.warn("[pylon] checkout not noted on the request:", error.code || "", error.message || "");
  return session.url;
}

// ── Public: a form from a Pylon page ─────────────────────────────────────
// Whether a checkout comes next: the pages only change their button's words.
router.get("/checkout", (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json({ open: PS.mode().ok });
});

// Bots fill every field, including the one people never see (pf_trap: a
// name no browser's autofill knows, so a person's form never fills it).
const trapped = (raw) => typeof raw.pf_trap === "string" && raw.pf_trap.trim() !== "";

router.post("/requests", safe(async (req, res) => {
  const raw = bodyOf(req);
  if (trapped(raw)) return res.json({ ok: true, id: null, checkout_url: null });
  const who = visitor(req);
  if (limited(visitorKey(who)) || !formAllowed()) return res.status(429).json({ error: "too_many" });

  const { errors, value } = U.normalize(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const row = { ...value, status: "new" };

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("pylon_requests").insert(row).select().single();
    if (!error && data) {
      const url = await startCheckout(sb, data);
      res.json({ ok: true, id: data.id, checkout_url: url });
      setImmediate(() => {
        alertStaff(sb, data);
        emailContact(sb, data, "contact_emailed_at", (r) => U.contactEmail(r, { checkout: !!url, help: helpEmail() }), who);
      });
      return;
    }
    console.error("[pylon] insert failed:", error && (error.code || "") + " " + (error.message || ""));
    if (inputError(error)) return res.status(400).json({ error: "invalid", fields: [] });
  }
  if (await emailUnsaved(row)) return res.json({ ok: true, id: null, checkout_url: null });
  return res.status(503).json({ error: "storage_unavailable" });
}));

// ── Public: the newsletter ───────────────────────────────────────────────
const newToken = () => crypto.randomBytes(32).toString("hex");
const hashToken = (t) => crypto.createHash("sha256").update(String(t), "utf8").digest("hex");
const confirmLink = (token) => `${SITE_BASE()}/pylon-newsletter.html?confirm=${token}`;

// The answer is the same whatever the address, so the form can't tell anyone
// whether an address is on the list.
router.post("/newsletter/subscribe", safe(async (req, res) => {
  const raw = bodyOf(req);
  if (trapped(raw)) return res.json({ ok: true });
  const who = visitor(req);
  if (limited("nl:" + visitorKey(who)) || !formAllowed()) return res.status(429).json({ error: "too_many" });
  const address = U.email(raw.email);
  if (!address) return res.status(400).json({ error: "invalid", fields: ["email"] });
  const source = U.NEWSLETTER_SOURCES.includes(raw.source) ? raw.source : "newsletter_page";
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });

  const { data: cur, error } = await sb.from("pylon_newsletter").select("id,status").eq("email", address).maybeSingle();
  if (error) {
    console.error("[pylon] newsletter read failed:", error.code || "", error.message || "");
    return res.status(503).json({ error: "storage_unavailable" });
  }
  if (cur && cur.status === "confirmed") return res.json({ ok: true });
  // One confirmation a day to an address; past that, the last link still works.
  const giveBack = noteAllowed(address, who, { confirm: true });
  if (!giveBack) return res.json({ ok: true });
  const token = newToken();
  const at = nowIso();
  const pending = { status: "pending", confirm_token_hash: hashToken(token), confirm_sent_at: at, updated_at: at };
  let saved;
  if (cur) {
    saved = await sb.from("pylon_newsletter").update(pending).eq("id", cur.id).neq("status", "confirmed").select("id");
  } else {
    saved = await sb.from("pylon_newsletter").insert({ email: address, source, unsubscribe_token: newToken(), ...pending }).select("id");
  }
  if (saved.error || !(saved.data || []).length) {
    giveBack();
    // Two sign-ups at once: the other one's email is on its way.
    if (saved.error && saved.error.code === "23505") return res.json({ ok: true });
    if (saved.error) {
      console.error("[pylon] newsletter save failed:", saved.error.code || "", saved.error.message || "");
      return res.status(503).json({ error: "storage_unavailable" });
    }
    return res.json({ ok: true });
  }
  res.json({ ok: true });
  setImmediate(async () => {
    const mail = U.confirmEmail({ confirmUrl: confirmLink(token), help: helpEmail() });
    let r = null;
    try {
      r = await mailer.sendMail({ to: address, subject: mail.subject, text: mail.text, replyTo: helpEmail(), pool: "pylon" });
    } catch (e) {
      console.warn("[pylon] newsletter confirmation failed:", mailError(e));
    }
    if (!r || !r.sent) {
      if (r) console.warn(`[pylon] newsletter confirmation not sent (${r.reason})`);
      giveBack();
    }
  });
}));

router.post("/newsletter/confirm", safe(async (req, res) => {
  if (limited("nlt:" + visitorKey(visitor(req)))) return res.status(429).json({ error: "too_many" });
  const token = String(bodyOf(req).token || "");
  if (!U.isToken(token)) return res.status(400).json({ error: "bad_link" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const at = nowIso();
  const since = new Date(Date.now() - U.CONFIRM_TTL_MS).toISOString();
  const { data, error } = await sb
    .from("pylon_newsletter")
    .update({ status: "confirmed", confirmed_at: at, confirm_token_hash: null, updated_at: at })
    .eq("confirm_token_hash", hashToken(token))
    .eq("status", "pending")
    .gt("confirm_sent_at", since)
    .select("id");
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  if (!(data || []).length) return res.status(404).json({ error: "link_not_active" });
  res.json({ ok: true });
}));

router.post("/newsletter/unsubscribe", safe(async (req, res) => {
  if (limited("nlt:" + visitorKey(visitor(req)))) return res.status(429).json({ error: "too_many" });
  const token = String(bodyOf(req).token || "");
  if (!U.isToken(token)) return res.status(400).json({ error: "bad_link" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: cur, error } = await sb.from("pylon_newsletter").select("id,status").eq("unsubscribe_token", token).maybeSingle();
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  if (!cur) return res.status(404).json({ error: "link_not_active" });
  if (cur.status !== "unsubscribed") {
    const at = nowIso();
    const { error: e2 } = await sb
      .from("pylon_newsletter")
      .update({ status: "unsubscribed", unsubscribed_at: at, confirm_token_hash: null, updated_at: at })
      .eq("id", cur.id);
    if (e2) return res.status(503).json({ error: "storage_unavailable" });
  }
  res.json({ ok: true });
}));

// ── Stripe: a Pylon checkout was paid ────────────────────────────────────
// Finds the request the checkout was made for. Paid once: a resent event, or
// a checkout that isn't this request's, changes nothing. { error } asks
// Stripe to send it again.
async function markPaid(sb, session) {
  if (!session || session.payment_status !== "paid") return {};
  const meta = session.metadata || {};
  const id = String(session.client_reference_id || meta.request_id || "");
  if (!U.UUID.test(id) || !/^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(String(session.id || ""))) return {};
  const { data: row, error } = await sb.from("pylon_requests").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[pylon] paid: read failed:", error.code || "", error.message || "");
    return { error: true };
  }
  if (!row) {
    console.warn("[pylon] paid: no request for that checkout");
    return {};
  }
  if (row.paid_at) return { duplicate: true };
  if (row.checkout_session_id && row.checkout_session_id !== session.id) {
    console.warn("[pylon] paid: a checkout that isn't the request's own: not joined");
    return {};
  }
  if (row.kind === "ambassador") return {};
  const amount = Number(session.amount_total);
  const at = nowIso();
  const patch = {
    paid_at: at,
    paid_cents: Number.isInteger(amount) && amount >= 0 && amount <= U.MAX_CENTS ? amount : row.price_cents || 0,
    paid_via: "stripe",
    checkout_session_id: session.id,
    checkout_mode: session.livemode ? "live" : "test",
    updated_at: at,
  };
  const { data, error: e2 } = await sb.from("pylon_requests").update(patch).eq("id", row.id).is("paid_at", null).select().maybeSingle();
  if (e2) {
    if (e2.code === "23505") return {};
    console.error("[pylon] paid: update failed:", e2.code || "", e2.message || "");
    return { error: true };
  }
  if (!data) return { duplicate: true };
  setImmediate(() => {
    alertStaff(sb, data, { paid: true });
    emailContact(sb, data, "paid_emailed_at", (r) => U.paidEmail(r, { help: helpEmail() }));
  });
  return { row: data };
}

router.post("/stripe/webhook", safe(async (req, res) => {
  const secret = env("PYLON_STRIPE_WEBHOOK_SECRET");
  if (!secret) return res.status(503).json({ error: "webhook_not_configured" });
  let event;
  try {
    event = PS.verify(req.rawBody || Buffer.from(""), req.headers["stripe-signature"], secret);
  } catch (e) {
    return res.status(400).json({ error: "bad_signature" });
  }
  const obj = (event.data && event.data.object) || {};
  const ours = (obj.metadata || {}).kind === "pylon";
  const paidEvent = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
  if (!ours || !paidEvent) return res.json({ received: true });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const r = await markPaid(sb, obj);
  if (r.error) return res.status(500).json({ error: "webhook_failed" });
  res.json({ received: true });
}));

// ── Staff ────────────────────────────────────────────────────────────────
const LIST_FIELDS = "id,kind,package,package_name,price_cents,cadence,contact_name,status,details,paid_at,paid_cents,paid_via,checkout_session_id,created_at";
function listRow(r) {
  return {
    id: r.id,
    kind: r.kind,
    package: r.package,
    package_name: r.package_name,
    price_cents: r.price_cents,
    cadence: r.cadence,
    contact_name: r.contact_name,
    status: r.status,
    summary: U.summary(r),
    paid: !!r.paid_at,
    paid_cents: r.paid_cents,
    paid_via: r.paid_via,
    went_to_checkout: !!r.checkout_session_id,
    created_at: r.created_at,
  };
}
const words = () => ({ kinds: U.KIND_WORDS, statuses: U.STATUS_WORDS, regions: U.REGION_WORDS, levels: U.LEVEL_WORDS, who: U.WHO_WORDS });

router.get("/requests", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let q = sb.from("pylon_requests").select(LIST_FIELDS).order("created_at", { ascending: false }).limit(300);
  if (req.query.all !== "1") q = q.in("status", U.OPEN);
  const { data, error } = await q;
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  res.json({ requests: (data || []).map(listRow), ...words() });
}));

router.get("/requests/:id", requireStaff, safe(async (req, res) => {
  if (!U.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb.from("pylon_requests").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  if (!data) return res.status(404).json({ error: "not_found" });
  res.json({ request: { ...data, summary: U.summary(data) }, ...words() });
}));

// status; team_note; paid: true records a payment made outside Stripe (an
// invoice, cash), at paid_cents or the list price; paid: false takes back
// only such a payment. A Stripe payment is Stripe's: refunds happen there.
router.patch("/requests/:id", requireStaff, safe(async (req, res) => {
  if (!U.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: row, error } = await sb.from("pylon_requests").select("id,kind,price_cents,paid_at,paid_via,status,updated_at").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  if (!row) return res.status(404).json({ error: "not_found" });

  const patch = {};
  if (body.status !== undefined) {
    if (!U.STATUSES.includes(body.status)) return res.status(400).json({ error: "bad_status" });
    if (body.status !== row.status) patch.status = body.status;
  }
  if (body.team_note !== undefined) {
    if (body.team_note !== null && typeof body.team_note !== "string") return res.status(400).json({ error: "bad_note" });
    patch.team_note = U.cleanNotes(body.team_note || "", 2000) || null;
  }
  let paidWhere = null;
  if (body.paid === true) {
    if (row.kind === "ambassador") return res.status(400).json({ error: "nothing_to_pay" });
    if (row.paid_at) return res.status(409).json({ error: "already_paid" });
    const cents = body.paid_cents === undefined || body.paid_cents === null ? row.price_cents : Number(body.paid_cents);
    if (!Number.isInteger(cents) || cents < 0 || cents > U.MAX_CENTS) return res.status(400).json({ error: "bad_amount" });
    Object.assign(patch, { paid_at: nowIso(), paid_cents: cents, paid_via: "manual" });
    paidWhere = "unpaid";
  } else if (body.paid === false) {
    if (row.paid_at && row.paid_via !== "manual") return res.status(409).json({ error: "paid_on_stripe" });
    if (row.paid_at) {
      Object.assign(patch, { paid_at: null, paid_cents: null, paid_via: null });
      paidWhere = "manual";
    }
  } else if (body.paid !== undefined) return res.status(400).json({ error: "bad_paid" });
  if (!Object.keys(patch).length) return res.json({ ok: true });

  patch.status_by = String(req.session.userEmail || "").toLowerCase().slice(0, 200) || null;
  patch.updated_at = nowIso();
  let q = sb.from("pylon_requests").update(patch).eq("id", row.id);
  // A payment changes only from the state that was read: Stripe can't land
  // in between and be overwritten.
  if (paidWhere === "unpaid") q = q.is("paid_at", null);
  if (paidWhere === "manual") q = q.eq("paid_via", "manual");
  const { data, error: e2 } = await q.select().maybeSingle();
  if (e2) return res.status(inputError(e2) ? 400 : 503).json({ error: inputError(e2) ? "invalid" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "changed_meanwhile" });
  res.json({ ok: true, request: { ...data, summary: U.summary(data) } });
}));

router.get("/newsletter", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb
    .from("pylon_newsletter")
    .select("email,status,source,confirmed_at,unsubscribed_at,created_at")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  const rows = data || [];
  const counts = { pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] += 1;
  // Only confirmed addresses are on the list; the rest are counts.
  const confirmed = rows.filter((r) => r.status === "confirmed").map((r) => ({ email: r.email, source: r.source, confirmed_at: r.confirmed_at }));
  res.json({ counts, confirmed });
}));

// Anything else under /api/pylon is gone: the old API (never mounted) had
// other paths, and they answer plainly instead of falling through.
router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
module.exports.markPaid = markPaid;
module.exports.startCheckout = startCheckout;
module.exports._reset = () => {
  hits.clear();
  forms = [];
  staffTimes = [];
  noteSent.clear();
  noteTimes = [];
};
