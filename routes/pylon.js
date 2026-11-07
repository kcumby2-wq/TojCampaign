"use strict";
// The public Pylon pages' requests and newsletter (migration 036; the rules
// are in utils/pylon.js).
//
//   GET    /api/pylon/checkout                  whether a checkout comes next (the button's words)
//   POST   /api/pylon/requests                  a form from a Pylon page
//   POST   /api/pylon/newsletter/subscribe      the free newsletter: emails a confirmation
//   POST   /api/pylon/newsletter/confirm        { token } from that email
//   POST   /api/pylon/newsletter/unsubscribe    { token } from an issue
//   POST   /api/pylon/stripe/webhook            Stripe: a Pylon checkout paid, a subscription changed
//   GET    /api/pylon/requests                  staff: open requests (?all=1 for every one)
//   GET    /api/pylon/requests/:id              staff: one request
//   PATCH  /api/pylon/requests/:id              staff: status, a note, who they checked, or paid outside Stripe
//   DELETE /api/pylon/requests/:id              staff: remove an unpaid request ("didn't send this")
//   GET    /api/pylon/newsletter                staff: the list, with each address's unsubscribe link
//
// A request is saved first. When Pylon's Stripe is set up (utils/pylon-stripe.js)
// and the package has a price, the page then goes on to a Stripe checkout made
// here, at the server's price; otherwise the contact hears we'll send a secure
// payment link. Stripe's test mode is offered only to staff signed in on the
// site, so the public never meets a checkout that takes no money. Each request
// alerts staff (a push and an email that carry what came in, not who it's
// about), and the contact gets one note of their own. If the database can't
// take a request, the staff email carries all of it, so nobody's request is
// lost (within its own budget).
//
// The public posts take JSON from the site's own pages only (another site's
// form can't send JSON, and the browser names the page it came from).
//
// The contact, the athlete and the consent answer are shown to staff (owner
// only, like the Subject Medias bookings: minors' data and money) and appear
// nowhere else.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, isStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const { logActivity } = require("../utils/team");
const U = require("../utils/pylon");
const PS = require("../utils/pylon-stripe");
const H = require("../utils/pylon-http");

const router = express.Router();
const safe = H.safe("pylon");
const bodyOf = H.bodyOf;
const env = (k) => String(process.env[k] || "").trim();
const APP_BASE = () => (env("APP_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
// Where the Pylon pages live: Stripe sends people back there.
const SITE_BASE = () => (env("PYLON_SITE_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
const helpEmail = () => U.email(env("PYLON_HELP_EMAIL")) || "hello@pylonfootball.com";
const nowIso = () => new Date().toISOString();
const HOUR = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR;

// ── Abuse limits ─────────────────────────────────────────────────────────
// Per visitor (the first X-Forwarded-For address, which Vercel's rewrite
// sets): 12 forms per 10 minutes, so families on one event's Wi-Fi get
// through. Per connection (the caller Render saw: Vercel itself, or someone
// going straight at Render with made-up headers): 60 per 10 minutes. Only
// forms that pass the checks count toward the hour's total (300, separately
// for requests and the newsletter), so junk can't lock everyone out.
const perVisitor = H.windowLimiter(12, 10 * 60 * 1000);
const perPeer = H.windowLimiter(60, 10 * 60 * 1000);
const linkTries = H.windowLimiter(30, 10 * 60 * 1000);
function hourly(max) {
  let times = [];
  const take = (now = Date.now()) => {
    times = times.filter((t) => now - t < HOUR);
    if (times.length >= max) return false;
    times.push(now);
    return true;
  };
  take.reset = () => { times = []; };
  return take;
}
const requestsThisHour = hourly(300);
const signupsThisHour = hourly(300);
const pushesThisHour = hourly(60);
// The staff email for each request and payment: 30 an hour, 100 a day.
function budget(perHour, perDay) {
  let times = [];
  const take = (now = Date.now()) => {
    times = times.filter((t) => now - t < DAY_MS);
    if (times.length >= perDay || times.filter((t) => now - t < HOUR).length >= perHour) return false;
    times.push(now);
    return true;
  };
  take.reset = () => { times = []; };
  return take;
}
const staffMailAllowed = budget(30, 100);
// When the database can't take a request, its email is the only copy: 10 an
// hour and 30 a day, so an outage plus junk can't spend the account's day.
const fallbackAllowed = budget(10, 30);
const limitedVisitor = (req, prefix = "") => perVisitor(prefix + H.visitorKey(H.visitor(req))) || perPeer(prefix + H.peer(req));

// The notes people get go to an address someone typed. A request's note: at
// most 2 a day to one mailbox. A newsletter confirmation: 1 a day to one
// mailbox. 6 a day from one visitor, and 30 an hour and 100 a day in all. So
// the forms can't fill anyone's inbox, or use up the account the staff
// alerts need. A payment's note comes from Stripe, not a form: it has its own
// count (5 a day to one mailbox, 30 an hour, 100 a day), so junk forms can't
// hold it up. Mailboxes and visitors go through an HMAC with a key made fresh
// at each start; never kept. A note that couldn't go gives its place back.
const SALT = crypto.randomBytes(32);
const keyOf = (kind, v) => kind + ":" + crypto.createHmac("sha256", SALT).update(String(v)).digest("base64").slice(0, 22);
function noteCounter({ perHour, perDay }) {
  const sent = new Map();
  let times = [];
  function allowed(keys, now = Date.now()) {
    times = times.filter((t) => now - t < DAY_MS);
    if (times.length >= perDay) return null;
    if (times.filter((t) => now - t < HOUR).length >= perHour) return null;
    for (const [k, max] of keys) if ((sent.get(k) || []).filter((t) => now - t < DAY_MS).length >= max) return null;
    for (const [k] of keys) sent.set(k, [...(sent.get(k) || []).filter((t) => now - t < DAY_MS), now]);
    times.push(now);
    if (sent.size > 20000) for (const [k, v] of sent) if (!v.some((t) => now - t < DAY_MS)) sent.delete(k);
    const drop = (list) => {
      const i = list.lastIndexOf(now);
      if (i >= 0) list.splice(i, 1);
    };
    return () => {
      drop(times);
      for (const [k] of keys) drop(sent.get(k) || []);
    };
  }
  allowed.reset = () => {
    sent.clear();
    times = [];
  };
  return allowed;
}
const formNotes = noteCounter({ perHour: 30, perDay: 100 });
const paidNotes = noteCounter({ perHour: 30, perDay: 100 });
function noteAllowed(address, who, { confirm = false } = {}) {
  const keys = [[keyOf(confirm ? "confirm" : "to", U.mailbox(address)), confirm ? 1 : 2]];
  if (who) keys.push([keyOf("from", H.visitorKey(who)), 6]);
  return formNotes(keys);
}
const paidNoteAllowed = (address) => paidNotes([[keyOf("paid", U.mailbox(address)), 5]]);

const mailError = mailer.errorCode;
// An error the request itself caused (a value Postgres or PostgREST refuses)
// isn't the database being down.
const inputError = (e) => !!e && /^(2[23]|PGRST1)/.test(String(e.code || ""));
// The tables aren't there yet (the code deployed before migration 036).
const notSetUp = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(String(e.message || "")));

// ── Alerts ───────────────────────────────────────────────────────────────
// A push and an email to staff. Never throws.
function tellStaff(pushPayload, mail) {
  const to = [...staffEmails()];
  if (pushesThisHour()) push.notifySoon(to, pushPayload);
  if (mail && staffMailAllowed()) {
    mailer
      .sendMail({ to, subject: mail.subject, text: mail.text, pool: "pylon" })
      .then((r) => {
        if (!r.sent) console.warn(`[pylon] staff email not sent (${r.reason})`);
      })
      .catch((e) => console.warn("[pylon] staff email failed:", mailError(e)));
  } else if (mail) console.warn("[pylon] over the staff email budget: push only");
}
async function alertStaff(sb, row, { paid = false } = {}) {
  try {
    tellStaff(U.pushPayload(row), U.staffEmail(row, APP_BASE(), { paid }));
    if (!paid) await sb.from("pylon_requests").update({ alerted_at: nowIso() }).eq("id", row.id);
  } catch (e) {
    console.warn("[pylon] alert failed:", e && e.message);
  }
}

// The database couldn't take the request: email it to staff whole. Critical
// to the mailer's day (it's the only copy), within its own small budget.
async function emailUnsaved(row) {
  try {
    if (!fallbackAllowed()) return false;
    const mail = U.staffEmail({ ...row, id: "not-saved" }, APP_BASE(), { saved: false });
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
async function emailContact(sb, row, column, build, giveBackFn) {
  try {
    if (!row || !row.contact_email || row[column]) return;
    const giveBack = giveBackFn();
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
// A live checkout for anyone; Stripe's test mode only for staff signed in on
// the site (trying the flow). Null: no checkout for this visitor.
function checkoutFor(req) {
  const m = PS.mode();
  if (!m.ok) return null;
  if (m.mode === "live") return m;
  return req && isStaff(req) ? m : null;
}

// A creator code is Stripe's to know, and only Pylon's creator codes count: an
// active promotion code by that name whose metadata says pylon_creator=yes.
// Nothing else, typed or linked, takes money off a Pylon checkout.
async function creatorPromo(stripe, code) {
  try {
    const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const hit = list && list.data && list.data[0];
    return hit && hit.id && hit.metadata && hit.metadata.pylon_creator === "yes" ? hit.id : null;
  } catch (e) {
    console.warn("[pylon] creator code lookup failed:", e && (e.code || e.type));
    return null;
  }
}

// A Stripe checkout for a saved request, at the server's price. The URL, or
// null when checkout isn't open to this visitor or didn't start (the request
// stands, and the contact hears we'll send a link).
async function startCheckout(sb, row, req) {
  const item = U.CATALOG[row.kind] && U.CATALOG[row.kind][row.package];
  if (!item || !item.cents || row.kind === "ambassador") return null;
  if (!checkoutFor(req)) return null;
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
  // A player package's creator code, when it's one of Pylon's.
  if (row.kind === "player_package" && row.referral_code) {
    const promo = await creatorPromo(s.stripe, row.referral_code);
    if (promo) params.discounts = [{ promotion_code: promo }];
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

// ── Public ───────────────────────────────────────────────────────────────
// JSON from the site's own pages only.
function publicPost(req, res, next) {
  if (!req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (!H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  next();
}

// Whether a checkout comes next: the pages only change their button's words.
router.get("/checkout", (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ open: !!checkoutFor(req) });
});

// Bots fill every field, including the one people never see (pf_trap: a
// name no browser's autofill knows, so a person's form never fills it).
const trapped = (raw) => typeof raw.pf_trap === "string" && raw.pf_trap.trim() !== "";

router.post("/requests", publicPost, safe(async (req, res) => {
  const raw = bodyOf(req);
  if (trapped(raw)) return res.json({ ok: true, id: null, checkout_url: null });
  if (limitedVisitor(req)) return res.status(429).json({ error: "too_many" });
  const { errors, value } = U.normalize(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!requestsThisHour()) return res.status(429).json({ error: "too_many" });
  const row = { ...value, status: "new" };
  const who = H.visitor(req);

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("pylon_requests").insert(row).select().single();
    if (!error && data) {
      const url = await startCheckout(sb, data, req);
      res.json({ ok: true, id: data.id, checkout_url: url });
      setImmediate(() => {
        alertStaff(sb, data);
        emailContact(sb, data, "contact_emailed_at", (r) => U.contactEmail(r, { checkout: !!url, help: helpEmail() }), () => noteAllowed(data.contact_email, who));
      });
      return;
    }
    console.error("[pylon] insert failed:", error && (error.code || "") + " " + (error.message || ""));
    if (inputError(error)) return res.status(400).json({ error: "invalid", fields: [] });
    if (notSetUp(error)) return res.status(503).json({ error: "storage_unavailable" });
  }
  if (await emailUnsaved(row)) return res.json({ ok: true, id: null, checkout_url: null });
  return res.status(503).json({ error: "storage_unavailable" });
}));

const newToken = () => crypto.randomBytes(32).toString("hex");
const hashToken = (t) => crypto.createHash("sha256").update(String(t), "utf8").digest("hex");
const confirmLink = (token) => `${SITE_BASE()}/pylon-newsletter.html?confirm=${token}`;
const unsubscribeLink = (token) => `${SITE_BASE()}/pylon-newsletter.html?unsubscribe=${token}`;

// The answer is the same whatever the address, so the form can't tell anyone
// whether an address is on the list.
router.post("/newsletter/subscribe", publicPost, safe(async (req, res) => {
  const raw = bodyOf(req);
  if (trapped(raw)) return res.json({ ok: true });
  if (limitedVisitor(req, "nl:")) return res.status(429).json({ error: "too_many" });
  const address = U.email(raw.email);
  if (!address) return res.status(400).json({ error: "invalid", fields: ["email"] });
  if (!signupsThisHour()) return res.status(429).json({ error: "too_many" });
  const source = U.NEWSLETTER_SOURCES.includes(raw.source) ? raw.source : "newsletter_page";
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const who = H.visitor(req);

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

router.post("/newsletter/confirm", publicPost, safe(async (req, res) => {
  if (linkTries(H.visitorKey(H.visitor(req))) || perPeer("nlt:" + H.peer(req))) return res.status(429).json({ error: "too_many" });
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

router.post("/newsletter/unsubscribe", publicPost, safe(async (req, res) => {
  if (linkTries(H.visitorKey(H.visitor(req))) || perPeer("nlt:" + H.peer(req))) return res.status(429).json({ error: "too_many" });
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

// ── Stripe ───────────────────────────────────────────────────────────────
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const SUB_ID = /^sub_[A-Za-z0-9]{6,200}$/;
const SUB_STATUSES = ["active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "trialing", "paused"];

// Money Stripe took that the request already has, or that came through a
// checkout that isn't the request's own: kept on the request, and staff told,
// so nobody pays twice without someone knowing.
async function extraPayment(sb, row, session, amount) {
  const list = Array.isArray(row.extra_payments) ? row.extra_payments : [];
  if (list.some((p) => p && p.checkout_session_id === session.id)) return { duplicate: true };
  const entry = { checkout_session_id: session.id, amount_cents: amount, mode: session.livemode ? "live" : "test", at: nowIso() };
  const { data, error } = await sb
    .from("pylon_requests")
    .update({ extra_payments: [...list, entry], updated_at: nowIso() })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .select()
    .maybeSingle();
  if (error) {
    console.error("[pylon] extra payment not saved:", error.code || "", error.message || "");
    return { error: true };
  }
  // Changed meanwhile: Stripe sends it again, and the next try reads it fresh.
  if (!data) return { error: true };
  console.warn("[pylon] a further payment came in for a request");
  tellStaff(
    { title: "Pylon: a second payment", body: `${U.money(amount)} more on Stripe for ${row.package_name}`, url: `/app/#pylon-request/${row.id}`, tag: `pylon-extra-${row.id}` },
    {
      subject: `Pylon: a second payment for ${row.package_name} (${U.money(amount)})`,
      text: [
        `Stripe took ${U.money(amount)}${entry.mode === "test" ? " (test mode: no money moved)" : ""} for a request that already ${row.paid_at ? "shows as paid" : "had another checkout"}.`,
        "Check it in the app and refund one in Stripe if it's paid twice.",
        "",
        `Open it in the TOJ app: ${APP_BASE()}/app/#pylon-request/${row.id}`,
      ].join("\n"),
    }
  );
  return { extra: data };
}

// Finds the request the checkout was made for, and records the payment once.
// { error } asks Stripe to send the event again.
async function markPaid(sb, session) {
  if (!session || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) return {};
  const meta = session.metadata || {};
  const id = String(session.client_reference_id || meta.request_id || "");
  if (!U.UUID.test(id) || !SESSION_ID.test(String(session.id || ""))) return {};
  const { data: row, error } = await sb.from("pylon_requests").select("*").eq("id", id).maybeSingle();
  if (error) {
    console.error("[pylon] paid: read failed:", error.code || "", error.message || "");
    return { error: true };
  }
  if (!row) {
    console.warn("[pylon] paid: no request for that checkout");
    return {};
  }
  if (row.kind === "ambassador") return {};
  const amount = Number(session.amount_total);
  const cents = Number.isInteger(amount) && amount >= 0 && amount <= U.MAX_CENTS ? amount : row.price_cents || 0;
  // The same checkout again (Stripe retrying): nothing new.
  if (row.paid_at && row.paid_via === "stripe" && row.checkout_session_id === session.id) return { duplicate: true };
  // Paid already (by hand, or through another checkout), or a checkout that
  // isn't this request's own: record it and tell staff.
  if (row.paid_at || (row.checkout_session_id && row.checkout_session_id !== session.id)) return extraPayment(sb, row, session, cents);
  const at = nowIso();
  const patch = {
    paid_at: at,
    paid_cents: cents,
    paid_via: "stripe",
    checkout_session_id: session.id,
    checkout_mode: session.livemode ? "live" : "test",
    updated_at: at,
  };
  if (typeof session.subscription === "string" && SUB_ID.test(session.subscription)) {
    patch.stripe_subscription_id = session.subscription;
    patch.subscription_status = "active";
  }
  const { data, error: e2 } = await sb.from("pylon_requests").update(patch).eq("id", row.id).is("paid_at", null).select().maybeSingle();
  if (e2) {
    if (e2.code === "23505") return {};
    console.error("[pylon] paid: update failed:", e2.code || "", e2.message || "");
    return { error: true };
  }
  if (!data) {
    // Something marked it paid between the read and now: read it again.
    const { data: again } = await sb.from("pylon_requests").select("*").eq("id", row.id).maybeSingle();
    if (again && again.paid_at && !(again.paid_via === "stripe" && again.checkout_session_id === session.id)) return extraPayment(sb, again, session, cents);
    return { duplicate: true };
  }
  setImmediate(() => {
    alertStaff(sb, data, { paid: true });
    emailContact(sb, data, "paid_emailed_at", (r) => U.paidEmail(r, { help: helpEmail() }), () => paidNoteAllowed(data.contact_email));
  });
  return { row: data };
}

// A monthly plan changed on Stripe's side (cancelled, a renewal failed): the
// request shows it, and staff hear when it stops being active.
async function subscriptionChanged(sb, sub, { deleted = false } = {}) {
  const meta = sub.metadata || {};
  const id = String(meta.request_id || "");
  if (!U.UUID.test(id) || !SUB_ID.test(String(sub.id || ""))) return {};
  const status = deleted ? "canceled" : SUB_STATUSES.includes(sub.status) ? sub.status : null;
  if (!status) return {};
  const { data: row, error } = await sb.from("pylon_requests").select("id,package_name,stripe_subscription_id,subscription_status").eq("id", id).maybeSingle();
  if (error) return { error: true };
  if (!row || (row.stripe_subscription_id && row.stripe_subscription_id !== sub.id)) return {};
  if (row.subscription_status === status) return { duplicate: true };
  const ended = status === "canceled" ? (Number.isInteger(sub.ended_at) ? new Date(sub.ended_at * 1000).toISOString() : nowIso()) : null;
  const { error: e2 } = await sb
    .from("pylon_requests")
    .update({ stripe_subscription_id: sub.id, subscription_status: status, subscription_ended_at: ended, updated_at: nowIso() })
    .eq("id", row.id);
  if (e2) return { error: true };
  if (["past_due", "unpaid", "canceled"].includes(status)) {
    const words = status === "canceled" ? "was cancelled" : "has a payment that didn't go through";
    tellStaff(
      { title: `Pylon: monthly plan ${status === "canceled" ? "cancelled" : "payment failed"}`, body: row.package_name, url: `/app/#pylon-request/${row.id}`, tag: `pylon-sub-${row.id}` },
      { subject: `Pylon: a monthly plan ${words}`, text: `${row.package_name} ${words} on Stripe.\n\nOpen it in the TOJ app: ${APP_BASE()}/app/#pylon-request/${row.id}` }
    );
  }
  return { ok: true };
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
  if ((obj.metadata || {}).kind !== "pylon") return res.json({ received: true });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let r = {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") r = await markPaid(sb, obj);
  else if (event.type === "customer.subscription.updated") r = await subscriptionChanged(sb, obj);
  else if (event.type === "customer.subscription.deleted") r = await subscriptionChanged(sb, obj, { deleted: true });
  if (r.error) return res.status(500).json({ error: "webhook_failed" });
  res.json({ received: true });
}));

// ── Staff ────────────────────────────────────────────────────────────────
const LIST_FIELDS = "id,kind,package,package_name,price_cents,cadence,contact_name,status,details,paid_at,paid_cents,paid_via,checkout_session_id,checkout_mode,extra_payments,subscription_status,contact_verified_at,created_at";
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
    test: U.testPaid(r),
    went_to_checkout: !!r.checkout_session_id,
    extra_payments: Array.isArray(r.extra_payments) ? r.extra_payments.length : 0,
    subscription_status: r.subscription_status || null,
    verified: !!r.contact_verified_at,
    created_at: r.created_at,
  };
}
const words = () => ({ kinds: U.KIND_WORDS, statuses: U.STATUS_WORDS, regions: U.REGION_WORDS, levels: U.LEVEL_WORDS, who: U.WHO_WORDS });
const staffWho = (req) => String(req.session.userEmail || "").toLowerCase().slice(0, 200) || null;

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
  res.json({ request: { ...data, summary: U.summary(data), test: U.testPaid(data) }, ...words() });
}));

// The family's open checkout, closed when staff record a payment made
// another way, so they can't also pay on Stripe. Best effort.
async function closeCheckout(sessionId) {
  try {
    const s = PS.stripe();
    await s.stripe.checkout.sessions.expire(sessionId);
  } catch (e) {
    // Already paid, already expired, or Stripe isn't set up: nothing to close.
  }
}

// status; team_note; verified: true records that this staff member checked,
// on a call or in person, that the contact is who the form says (false takes
// it back); paid: true records a payment made outside Stripe (an invoice,
// cash), at paid_cents or the list price; paid: false takes back only such a
// payment. A Stripe payment is Stripe's: refunds happen there.
router.patch("/requests/:id", requireStaff, safe(async (req, res) => {
  if (!U.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const body = bodyOf(req);
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: row, error } = await sb.from("pylon_requests").select("id,kind,price_cents,paid_at,paid_via,status,checkout_session_id,extra_payments,contact_verified_at,updated_at").eq("id", req.params.id).maybeSingle();
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
  if (body.verified === true) {
    if (!row.contact_verified_at) Object.assign(patch, { contact_verified_at: nowIso(), contact_verified_by: staffWho(req) });
  } else if (body.verified === false) {
    if (row.contact_verified_at) Object.assign(patch, { contact_verified_at: null, contact_verified_by: null });
  } else if (body.verified !== undefined) return res.status(400).json({ error: "bad_verified" });
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
    // Stripe took money on it too: the record stays paid while that's sorted
    // out in Stripe (refund the one that shouldn't stand).
    if (row.paid_at && Array.isArray(row.extra_payments) && row.extra_payments.length) return res.status(409).json({ error: "extra_payments" });
    if (row.paid_at) {
      Object.assign(patch, { paid_at: null, paid_cents: null, paid_via: null });
      paidWhere = "manual";
    }
  } else if (body.paid !== undefined) return res.status(400).json({ error: "bad_paid" });
  if (!Object.keys(patch).length) return res.json({ ok: true });

  patch.status_by = staffWho(req);
  patch.updated_at = nowIso();
  let q = sb.from("pylon_requests").update(patch).eq("id", row.id);
  // A payment changes only from the state that was read: Stripe can't land
  // in between and be overwritten.
  if (paidWhere === "unpaid") q = q.is("paid_at", null);
  if (paidWhere === "manual") q = q.eq("paid_via", "manual");
  const { data, error: e2 } = await q.select().maybeSingle();
  if (e2) return res.status(inputError(e2) ? 400 : 503).json({ error: inputError(e2) ? "invalid" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "changed_meanwhile" });
  if (paidWhere === "unpaid" && data.checkout_session_id) await closeCheckout(data.checkout_session_id);
  res.json({ ok: true, request: { ...data, summary: U.summary(data), test: U.testPaid(data) } });
}));

// "Didn't send this? Reply and we'll delete it." An unpaid request goes; a
// paid one stays (payment records are kept: refund it in Stripe, and close it).
router.delete("/requests/:id", requireStaff, safe(async (req, res) => {
  if (!U.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: row, error } = await sb.from("pylon_requests").select("id,paid_at,extra_payments").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.paid_at || (Array.isArray(row.extra_payments) && row.extra_payments.length)) return res.status(409).json({ error: "paid_keep" });
  const { error: e2 } = await sb.from("pylon_requests").delete().eq("id", row.id).is("paid_at", null);
  if (e2) {
    if (e2.code === "23503") return res.status(409).json({ error: "has_messages" });
    return res.status(503).json({ error: "storage_unavailable" });
  }
  logActivity(staffWho(req), "pylon_request_deleted", row.id);
  res.json({ ok: true });
}));

router.get("/newsletter", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb
    .from("pylon_newsletter")
    .select("email,status,source,confirmed_at,unsubscribe_token,created_at")
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  const rows = data || [];
  const counts = { pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] += 1;
  // Only confirmed addresses are on the list, each with the unsubscribe link
  // every issue must carry; the rest are counts.
  const confirmed = rows
    .filter((r) => r.status === "confirmed")
    .map((r) => ({ email: r.email, source: r.source, confirmed_at: r.confirmed_at, unsubscribe_url: unsubscribeLink(r.unsubscribe_token) }));
  res.set("Cache-Control", "private, no-store");
  res.json({ counts, confirmed });
}));

// Anything else under /api/pylon is gone: the old API (never mounted) had
// other paths, and they answer plainly instead of falling through.
router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
module.exports.markPaid = markPaid;
module.exports.startCheckout = startCheckout;
// Tests: every limit, and _reset() to start them all over.
module.exports._limits = { perVisitor, perPeer, linkTries, requestsThisHour, signupsThisHour, pushesThisHour, staffMailAllowed, fallbackAllowed, formNotes, paidNotes };
module.exports._reset = () => {
  for (const f of Object.values(module.exports._limits)) f.reset();
};
