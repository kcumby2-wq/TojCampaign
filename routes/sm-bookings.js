"use strict";
// Subject Medias bookings (migration 030; the rules are in utils/sm-bookings.js).
//
//   POST  /api/sm/bookings          the booking form, through subjectmedias.com's
//                                    /api/book function
//   POST  /api/sm/bookings/paid     subjectmedias.com's Stripe webhook, and its
//                                    /api/details function: what the buyer of a
//                                    package tells us about their game (details:
//                                    true), after the site checked the payment
//   GET   /api/sm/bookings          staff: open bookings (?all=1 for every one)
//   GET   /api/sm/bookings/:id      staff: one booking and its suggested creators
//   PATCH /api/sm/bookings/:id      staff: status, and the creator who's staffed
//
// The two POSTs take only the site's calls: they carry the shared
// SM_BOOKINGS_SECRET in X-SM-Secret. The form's call also carries the visitor's
// address as Vercel saw it (X-SM-Visitor), which the abuse limits count by.
//
// Each new booking alerts staff (ADMIN_EMAILS): a push to the TOJ app and an
// email, each listing the creators who work that region. A failed alert never
// fails the booking. If the database can't take a booking, the email carries
// it instead, so nobody's booking (or payment) is lost.
//
// The booker gets a note of their own, once (booker_emailed_at): we got your
// request, or thanks for booking with a link to tell us about the game. It
// carries fixed words only (utils/sm-bookings.js, bookerEmail) and has its
// own limits, per address and in all.
//
// A request sent from a package's Buy button (pay now) that isn't paid an
// hour on gets one reminder with its checkout, once the site's webhook is
// known to work (remindUnfinished, below; migration 035).

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const B = require("../utils/sm-bookings");
const { helpEmail, siteBase } = require("../utils/sm-market");

const router = express.Router();
const APP_BASE = () => String(process.env.APP_BASE || "https://tojcampaign.com").replace(/\/+$/, "");
const CREW_COLUMNS = "id,name,home_city,region,tier,status,contract_signed_on,background_check_on,safety_training_on,age_checked_on,guardian_email";

// Express 4 doesn't catch a rejected promise from an async handler, and an
// unhandled rejection stops the whole process. Every handler goes through this.
const safe = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error("[sm-bookings] handler failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

// ── The site's calls ─────────────────────────────────────────────────────
// Both sides hashed first: the comparison can't throw on odd bytes and says
// nothing about the secret's length.
function secretOk(req) {
  const want = String(process.env.SM_BOOKINGS_SECRET || "");
  if (want.length < 24) return false;
  const got = String(req.headers["x-sm-secret"] || "");
  const hash = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
  return crypto.timingSafeEqual(hash(got), hash(want));
}

// ── Abuse limits ─────────────────────────────────────────────────────────
// 8 form bookings per visitor per 10 minutes, and 120 an hour in all. Staff
// emails go out at most 30 an hour and 100 a day, so a flood can't use up the
// Gmail account everything sends from (utils/mailer.js keeps a day's budget
// for all of it); every booking is still saved and pushed.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const MAX_TRACKED = 5000;
const HOUR = 60 * 60 * 1000;
const MAX_FORMS_PER_HOUR = 120;
const MAX_EMAILS_PER_HOUR = 30;
const MAX_EMAILS_PER_DAY = 100;
const hits = new Map();
let forms = [];
let emails = [];

function limited(key, now = Date.now()) {
  const h = hits.get(key);
  if (h && now - h.start <= WINDOW_MS) {
    h.n += 1;
    return h.n > MAX_PER_WINDOW;
  }
  if (h) hits.delete(key);
  hits.set(key, { start: now, n: 1 });
  // A Map keeps insertion order, so the oldest windows are at the front: drop
  // the expired ones, and past the cap the oldest, so memory stays bounded.
  for (const [k, v] of hits) {
    if (now - v.start <= WINDOW_MS && hits.size <= MAX_TRACKED) break;
    hits.delete(k);
  }
  return false;
}
function underHourly(list, max, now) {
  const kept = list.filter((t) => now - t < HOUR);
  if (kept.length >= max) return { ok: false, list: kept };
  kept.push(now);
  return { ok: true, list: kept };
}
function formAllowed(now = Date.now()) {
  const r = underHourly(forms, MAX_FORMS_PER_HOUR, now);
  forms = r.list;
  return r.ok;
}
function emailAllowed(now = Date.now()) {
  emails = emails.filter((t) => now - t < 24 * HOUR);
  if (emails.length >= MAX_EMAILS_PER_DAY || emails.filter((t) => now - t < HOUR).length >= MAX_EMAILS_PER_HOUR) return false;
  emails.push(now);
  return true;
}
const visitor = (req) => String(req.headers["x-sm-visitor"] || "").split(",")[0].trim().slice(0, 100) || "unknown";
// For the booker's limits, one visitor on IPv6 is their /64: a home or a
// phone gets a whole /64 and can change addresses inside it at will. The
// address is spelled out to its eight groups first, so "::" and leading
// zeros can't make one /64 look like many.
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

// The booker's note goes to an address someone typed. At most 2 a day to one
// mailbox (Gmail's dots and +tags count as the same one), 3 a day from one
// visitor, and 30 an hour and 100 a day in all: the form can't fill anyone's
// inbox, or use up the Gmail account the staff alerts need. Mailboxes and
// visitors go through an HMAC with a key made fresh each start; never kept.
// A note that couldn't go gives its place back.
const DAY_MS = 24 * HOUR;
const MAX_BOOKER_PER_MAILBOX = 2;
const MAX_BOOKER_PER_VISITOR = 3;
const MAX_BOOKER_PER_HOUR = 30;
const MAX_BOOKER_PER_DAY = 100;
const SALT = crypto.randomBytes(32);
const bookerSent = new Map(); // mailbox or visitor key → times
let bookerTimes = [];
const keyOf = (kind, v) => kind + ":" + crypto.createHmac("sha256", SALT).update(String(v)).digest("base64").slice(0, 22);
// Takes a place for one note, or says no. Returns the way to give it back.
function bookerMailAllowed(address, who, now = Date.now()) {
  bookerTimes = bookerTimes.filter((t) => now - t < DAY_MS);
  if (bookerTimes.length >= MAX_BOOKER_PER_DAY) return null;
  if (bookerTimes.filter((t) => now - t < HOUR).length >= MAX_BOOKER_PER_HOUR) return null;
  const keys = [[keyOf("to", B.mailbox(address)), MAX_BOOKER_PER_MAILBOX]];
  if (who) keys.push([keyOf("from", visitorKey(who)), MAX_BOOKER_PER_VISITOR]);
  for (const [k, max] of keys) if ((bookerSent.get(k) || []).filter((t) => now - t < DAY_MS).length >= max) return null;
  for (const [k] of keys) bookerSent.set(k, [...(bookerSent.get(k) || []).filter((t) => now - t < DAY_MS), now]);
  bookerTimes.push(now);
  if (bookerSent.size > 20000) for (const [k, v] of bookerSent) if (!v.some((t) => now - t < DAY_MS)) bookerSent.delete(k);
  const drop = (list) => { const i = list.lastIndexOf(now); if (i >= 0) list.splice(i, 1); };
  return () => {
    drop(bookerTimes);
    for (const [k] of keys) drop(bookerSent.get(k) || []);
  };
}
// Where a buyer tells us about their game: the site's details page for this
// checkout (subjectmedias-site's details.html and api/details.js).
const detailsLink = (sid) => `${siteBase()}/details?paid=${encodeURIComponent(sid)}`;

// ── Alerts ───────────────────────────────────────────────────────────────
async function findMatches(sb, booking) {
  const [crew, club] = await Promise.all([
    booking.region ? sb.from("gfs_creators").select(CREW_COLUMNS).eq("status", "active").eq("region", booking.region) : Promise.resolve({ data: [] }),
    sb.from("creators").select("slug,brand_name,location,status,page_status").eq("status", "active").eq("page_status", "live"),
  ]);
  return B.rankCreators(booking, (crew && crew.data) || [], (club && club.data) || []);
}

// Push and email to staff, then note on the row when they went and who was
// suggested. detailsIn: the buyer of a paid package just told us about their
// game. Never throws.
async function alertStaff(sb, row, { detailsIn = false, payNow = false } = {}) {
  try {
    const matches = await findMatches(sb, row);
    const to = [...staffEmails()];
    push.notifySoon(to, B.pushPayload(row, matches.crew.length, { detailsIn }));
    if (emailAllowed()) {
      const mail = B.emailText(row, matches, APP_BASE(), { detailsIn, payNow });
      mailer
        .sendMail({ to, subject: mail.subject, text: mail.text, pool: "bookings" })
        .then((r) => { if (!r.sent) console.warn(`[sm-bookings] email not sent (${r.reason})`); })
        .catch((e) => console.warn("[sm-bookings] email failed:", mailError(e)));
    } else console.warn("[sm-bookings] over the email budget: push only");
    const snapshot = matches.crew.map((c) => ({ id: c.id, name: c.name, home_city: c.home_city, tier: c.tier, screened: c.screened }));
    await sb.from("sm_bookings").update({ alerted_at: new Date().toISOString(), matches: snapshot }).eq("id", row.id);
  } catch (e) {
    console.warn("[sm-bookings] alert failed:", e && e.message);
  }
}

// What went wrong with an email, without the addresses a mail server's error
// message can carry.
const mailError = mailer.errorCode;

// The booker's own note, once. A request that went on to pay (its package's
// Buy button) gets it when the payment joins it: thanks, it's paid. Any other
// request had its note when it came in, and Stripe sends the receipt. Claimed
// on the row before it
// goes, so two deliveries of one webhook can't both send it; if it couldn't
// go, the claim and its place in the limits are given back (nothing sends it
// again by itself: staff see in the app whether it went). askDetails false:
// don't send the details link (the checkout named a request, so the details
// page won't ask). Never throws.
async function emailBooker(sb, row, { who = null, askDetails = true } = {}) {
  try {
    if (!row || !row.contact_email || row.booker_emailed_at) return;
    const giveBack = bookerMailAllowed(row.contact_email, who);
    if (!giveBack) return console.warn("[sm-bookings] booker note over its limits: not sent");
    const claimed = await sb.from("sm_bookings").update({ booker_emailed_at: new Date().toISOString() }).eq("id", row.id).is("booker_emailed_at", null).select("id");
    if (claimed.error || !(claimed.data || []).length) return giveBack();
    const ask = askDetails && row.source === "stripe" && !row.details_at && row.stripe_session_id;
    const mail = B.bookerEmail(row, { detailsUrl: ask ? detailsLink(row.stripe_session_id) : null, help: helpEmail(), site: siteBase() });
    let r = null;
    try {
      r = await mailer.sendMail({ to: row.contact_email, subject: mail.subject, text: mail.text, replyTo: helpEmail(), pool: "bookings" });
    } catch (e) {
      console.warn("[sm-bookings] booker note failed:", mailError(e));
    }
    if (!r || !r.sent) {
      if (r) console.warn(`[sm-bookings] booker note not sent (${r.reason})`);
      giveBack();
      await sb.from("sm_bookings").update({ booker_emailed_at: null }).eq("id", row.id);
    }
  } catch (e) {
    console.warn("[sm-bookings] booker note failed:", mailError(e));
  }
}

// The booking couldn't be stored: email it to staff whole, so it isn't lost.
// Always sent (it's the only copy), whatever the hourly budget, and critical
// to the mailer's day's budget. detailsFor: these are the event details for a
// paid booking we have (by its checkout) but couldn't add them to.
async function emailUnsaved(row, { detailsFor = null } = {}) {
  try {
    const mail = B.emailText({ ...row, id: "not-saved" }, null, APP_BASE(), { saved: false, detailsFor });
    const subject = detailsFor
      ? `Event details for paid booking ${detailsFor} (not saved: add them in the app)`
      : `${mail.subject} (not saved: the app's database didn't take it)`;
    emailAllowed();
    const r = await mailer.sendMail({ to: [...staffEmails()], subject, text: mail.text, critical: true });
    return !!(r && r.sent);
  } catch (e) {
    console.error("[sm-bookings] fallback email failed:", mailError(e));
    return false;
  }
}

// An error the booking itself caused (a value Postgres refuses) isn't the
// database being down; anything else (unreachable, the table not there yet)
// means it can't be stored right now.
const inputError = (e) => !!e && /^2[23]/.test(String(e.code || ""));

// ── Public: the booking form ───────────────────────────────────────────
router.post("/", safe(async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  const raw = bodyOf(req);
  // Bots fill every field, including the one people never see.
  if (raw.company) return res.json({ ok: true });
  if (limited(visitor(req)) || !formAllowed()) return res.status(429).json({ error: "too_many" });

  const { errors, value } = B.normalize(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const row = { ...value, source: "form", status: "new" };
  if (!row.offer) delete row.offer;
  // On its way to Stripe: the note waits for the payment (thanks, it's paid),
  // and the row says so (migration 035), for the reminder if it doesn't come.
  const payNow = row.pay_now === true;
  if (!payNow) delete row.pay_now;
  const who = visitor(req);

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("sm_bookings").insert(row).select().single();
    if (!error && data) {
      res.json({ ok: true, id: data.id });
      setImmediate(() => {
        alertStaff(sb, data, { payNow });
        if (!payNow) emailBooker(sb, data, { who });
      });
      return;
    }
    console.error("[sm-bookings] insert failed:", error && (error.code || "") + " " + (error.message || ""));
    if (inputError(error)) return res.status(400).json({ error: "invalid", fields: [] });
  }
  if (await emailUnsaved(row)) return res.json({ ok: true, id: null });
  return res.status(503).json({ error: "storage_unavailable" });
}));

// ── The site's Stripe webhook: a paid package ─────────────────────────
// Paid from the form's success panel: the checkout names the request, so the
// payment joins it instead of arriving as a second booking.
async function payRequest(sb, id, paid) {
  const { data: b, error } = await sb.from("sm_bookings").select("id,source,stripe_session_id,contact_phone,notes").eq("id", id).maybeSingle();
  if (error || !b || b.source !== "form") return {};
  if (b.stripe_session_id === paid.stripe_session_id) return { duplicate: true };
  if (b.stripe_session_id) return {}; // paid already, with another checkout
  const patch = { stripe_session_id: paid.stripe_session_id, amount_cents: paid.amount_cents, updated_at: new Date().toISOString() };
  if (paid.package !== "unsure") patch.package = paid.package;
  if (!b.contact_phone && paid.contact_phone) patch.contact_phone = paid.contact_phone;
  if (paid.notes) patch.notes = B.joinNotes(b.notes, `From the checkout: ${paid.notes}`);
  // Only while unpaid: two deliveries of one webhook can't both join it.
  const { data, error: e2 } = await sb.from("sm_bookings").update(patch).eq("id", b.id).is("stripe_session_id", null).select().maybeSingle();
  if (e2) return e2.code === "23505" ? { duplicate: true } : {};
  return data ? { row: data } : {};
}

// The same checkout again: Stripe retrying its webhook, or the second of the
// webhook and the details form (either can come first). The buyer's answers
// win over what the checkout said; the webhook only fills what's missing
// (utils/sm-bookings.js, fillPatch). The details form counts once per booking:
// a second answer changes nothing. { error } when the database didn't answer.
async function fillIn(sb, inc, details, checkoutNotes) {
  const { data: b, error } = await sb.from("sm_bookings").select("*").eq("stripe_session_id", inc.stripe_session_id).maybeSingle();
  if (error) {
    console.error("[sm-bookings] fill-in read failed:", error.code || "", error.message || "");
    return { error: true };
  }
  if (!b) return { error: true };
  if (details && b.details_at) return { already: true };
  const at = new Date().toISOString();
  const patch = details
    ? B.fillPatch(b, inc, { from: "the event details form", override: true, checkoutNotes })
    : B.fillPatch(b, inc, { from: "the checkout" });
  if (details) patch.details_at = at;
  if (!Object.keys(patch).length) return { row: b };
  patch.updated_at = at;
  // A details answer only while there's none; a webhook's fill only if
  // nothing changed the booking since it was read.
  let q = sb.from("sm_bookings").update(patch).eq("id", b.id);
  q = details ? q.is("details_at", null) : q.eq("updated_at", b.updated_at);
  const { data, error: e2 } = await q.select().maybeSingle();
  if (e2) {
    console.error("[sm-bookings] fill-in failed:", e2.code || "", e2.message || "");
    return { error: true };
  }
  if (!data) return details ? { already: true } : { row: b };
  return { row: data, filled: true };
}

router.post("/paid", safe(async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  const raw = bodyOf(req);
  // The details form is someone's answers, like the booking form: the same
  // hidden field and limits. (A webhook is Stripe, and isn't limited.)
  const details = raw.details === true;
  if (details) {
    if (raw.company) return res.json({ ok: true });
    if (limited(visitor(req)) || !formAllowed()) return res.status(429).json({ error: "too_many" });
  }
  const { errors, value } = B.normalizePaid(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const { booking_id: requestId, details: _answers, checkout_notes: checkoutNotes, ...paid } = value;
  // A webhook checkout that named a request we couldn't join it to (paid
  // already, or not ours): a booking of its own, and the details page won't
  // ask about it, so the thanks note doesn't link there.
  let named = false;

  const sb = getSupabase();
  if (sb) {
    // A details answer never joins a request: a request has its details.
    if (requestId && !details) {
      const joined = await payRequest(sb, requestId, paid);
      if (joined.duplicate) return res.json({ ok: true, duplicate: true });
      if (joined.row) {
        res.json({ ok: true, id: joined.row.id, joined: true });
        setImmediate(() => {
          alertStaff(sb, joined.row);
          emailBooker(sb, joined.row);
        });
        return;
      }
      named = true;
    }
    const row = { ...paid, status: "new" };
    if (details) {
      row.details_at = new Date().toISOString();
      row.notes = B.joinNotes(paid.notes, checkoutNotes && `From the checkout: ${checkoutNotes}`);
    }
    if (named) row.notes = B.joinNotes(`This checkout named booking request ${requestId}, which was paid already or isn't ours.`, row.notes);
    const { data, error } = await sb.from("sm_bookings").insert(row).select().single();
    if (!error && data) {
      res.json({ ok: true, id: data.id });
      setImmediate(() => {
        alertStaff(sb, data);
        emailBooker(sb, data, { askDetails: !named });
      });
      return;
    }
    // Already here: fill in what's missing. Staff hear when a buyer's details
    // come in; a webhook's retry is quiet.
    if (error && error.code === "23505") {
      const r = await fillIn(sb, paid, details, checkoutNotes);
      if (r.already) return res.json({ ok: true, duplicate: true, already: true });
      if (r.error && details) {
        // We have the booking but couldn't add the answers: staff get them by
        // email so they aren't lost; with no email either, the page says so.
        if (await emailUnsaved({ ...paid, notes: B.joinNotes(paid.notes, checkoutNotes && `From the checkout: ${checkoutNotes}`) }, { detailsFor: paid.stripe_session_id })) return res.json({ ok: true, id: null });
        return res.status(503).json({ error: "storage_unavailable" });
      }
      if (details && r.row && r.filled) setImmediate(() => alertStaff(sb, r.row, { detailsIn: true }));
      return res.json({ ok: true, duplicate: true, id: (r.row && r.row.id) || null });
    }
    console.error("[sm-bookings] paid insert failed:", error && (error.code || "") + " " + (error.message || ""));
  }
  // Not stored: the email carries it, and Stripe can stop retrying. If the
  // email can't go either, a 503 makes Stripe try again later.
  const all = details ? { ...paid, notes: B.joinNotes(paid.notes, checkoutNotes && `From the checkout: ${checkoutNotes}`) } : paid;
  if (await emailUnsaved(all)) return res.json({ ok: true, id: null });
  return res.status(503).json({ error: "storage_unavailable" });
}));

// ── The unfinished checkout ──────────────────────────────────────────
// A pay-now request still unpaid an hour on: the booker left Stripe without
// paying. They get one reminder with their checkout (fixed words, like their
// note, and within their note's limits), and the app says "Checkout not
// finished". Only once the site's webhook has joined a payment to a request
// in the last 60 days: until then the app can't tell who paid, and nobody who
// paid may be told they didn't. Never for a request more than two days old,
// one staff have taken on (not new any more), a game that's passed, or a
// booker who came back since (a newer booking from the same mailbox). Runs
// every few minutes; SM_CHECKOUT_REMINDERS=off on Render stops it.
const REMIND_EVERY_MS = 5 * 60 * 1000;
const REMIND_WITHIN_MS = 2 * DAY_MS;
const WEBHOOK_SEEN_MS = 60 * DAY_MS;
const MAX_REMIND_TRIES = 3;
const remindTries = new Map(); // booking id → sends that failed, in this process
let reminding = false;

// The site's webhook works: a payment joined a form request lately (only the
// webhook joins one; the details page never does).
async function webhookJoins(sb, now) {
  const { data, error } = await sb.from("sm_bookings").select("id").eq("source", "form").not("stripe_session_id", "is", null)
    .gte("created_at", new Date(now - WEBHOOK_SEEN_MS).toISOString()).limit(1);
  return !error && (data || []).length > 0;
}

// One reminder: a place in the booker's limits, then the claim on the row
// (only while it's still unpaid, new and not reminded), then the email. Not
// sent: the place and the claim go back, so a later run can try while it's
// due; a send that failed counts toward three tries.
async function remindOne(sb, b) {
  const giveBack = bookerMailAllowed(b.contact_email, null);
  if (!giveBack) return false;
  const at = new Date().toISOString();
  const claimed = await sb.from("sm_bookings").update({ checkout_reminded_at: at })
    .eq("id", b.id).is("checkout_reminded_at", null).is("stripe_session_id", null).eq("status", "new").select("id");
  if (claimed.error || !(claimed.data || []).length) {
    giveBack();
    return false;
  }
  const mail = B.checkoutReminderEmail(b, { payUrl: B.checkoutLink(b), help: helpEmail(), site: siteBase() });
  let r = null;
  try {
    r = await mailer.sendMail({ to: b.contact_email, subject: mail.subject, text: mail.text, replyTo: helpEmail(), pool: "bookings" });
  } catch (e) {
    remindTries.set(b.id, (remindTries.get(b.id) || 0) + 1);
    console.warn("[sm-bookings] checkout reminder failed:", mailError(e));
  }
  if (r && r.sent) return true;
  if (r) console.warn(`[sm-bookings] checkout reminder not sent (${r.reason})`);
  giveBack();
  await sb.from("sm_bookings").update({ checkout_reminded_at: null }).eq("id", b.id).eq("checkout_reminded_at", at);
  return false;
}

async function remindUnfinished(sb = getSupabase(), now = Date.now()) {
  if (String(process.env.SM_CHECKOUT_REMINDERS || "").trim().toLowerCase() === "off") return { off: "setting" };
  if (!sb) return { off: "no_database" };
  if (!mailer.configured()) return { off: "no_email" };
  if (reminding) return { off: "running" };
  reminding = true;
  try {
    if (!(await webhookJoins(sb, now))) return { off: "no_webhook_yet" };
    const { data, error } = await sb.from("sm_bookings")
      .select("id,source,status,package,sport,event_date,event_state,contact_email,pay_now,stripe_session_id,checkout_reminded_at,created_at")
      .eq("pay_now", true).is("stripe_session_id", null).is("checkout_reminded_at", null).eq("status", "new")
      .lte("created_at", new Date(now - B.REMIND_AFTER_MS).toISOString())
      .gte("created_at", new Date(now - REMIND_WITHIN_MS).toISOString())
      .order("created_at", { ascending: true }).limit(20);
    if (error) {
      console.warn("[sm-bookings] checkout reminders: read failed:", error.code || "", error.message || "");
      return { error: true };
    }
    const due = (data || []).filter((b) => B.checkoutUnfinished(b, now) && B.gameNotPast(b, now) && B.isEmail(b.contact_email) && B.checkoutLink(b) && (remindTries.get(b.id) || 0) < MAX_REMIND_TRIES);
    if (!due.length) return { sent: 0 };
    // Came back since: a newer booking from the same mailbox, a request sent
    // again or a payment of its own.
    const { data: later, error: e2 } = await sb.from("sm_bookings").select("id,contact_email,created_at").gt("created_at", due[0].created_at).limit(1000);
    if (e2) return { error: true };
    let sent = 0;
    for (const b of due) {
      const box = B.mailbox(b.contact_email), t = Date.parse(b.created_at);
      if ((later || []).some((x) => x.id !== b.id && Date.parse(x.created_at) > t && B.mailbox(x.contact_email) === box)) continue;
      if (await remindOne(sb, b)) sent += 1;
    }
    return { sent };
  } catch (e) {
    console.warn("[sm-bookings] checkout reminders failed:", e && e.message);
    return { error: true };
  } finally {
    reminding = false;
  }
}
const remindTimer = setInterval(() => { remindUnfinished().catch(() => {}); }, REMIND_EVERY_MS);
if (remindTimer.unref) remindTimer.unref();

// ── Staff: the list, one booking, its status ──────────────────────────
const LIST_FIELDS = ["id", "source", "kind", "package", "sport", "event_name", "event_date", "event_city", "event_state", "region", "athletes", "amount_cents", "offer", "details_at", "pay_now", "checkout_reminded_at", "status", "staffed_creator_id", "created_at"];
const LIST_COLUMNS = [...LIST_FIELDS, "stripe_session_id"].join(",");
// The list never carries contact details or notes, whatever the query returns.
const listRow = (b) => ({ ...Object.fromEntries(LIST_FIELDS.map((k) => [k, b[k] === undefined ? null : b[k]])), paid: B.paid(b), unfinished: B.checkoutUnfinished(b) });
const fullRow = (b) => ({ ...b, summary: B.summary(b), paid: B.paid(b), unfinished: B.checkoutUnfinished(b) });

router.get("/", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let q = sb.from("sm_bookings").select(LIST_COLUMNS).order("created_at", { ascending: false }).limit(200);
  if (req.query.all !== "1") q = q.in("status", [...B.OPEN]);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "storage_error" });
  res.json({ bookings: (data || []).map((b) => ({ ...listRow(b), summary: B.summary(b) })), statuses: B.STATUSES });
}));

router.get("/:id", requireStaff, safe(async (req, res) => {
  if (!B.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: b, error } = await sb.from("sm_bookings").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: "storage_error" });
  if (!b) return res.status(404).json({ error: "not_found" });
  const matches = await findMatches(sb, b);
  let staffed = null;
  if (b.staffed_creator_id) {
    const { data } = await sb.from("gfs_creators").select("id,name,home_city,tier").eq("id", b.staffed_creator_id).maybeSingle();
    staffed = data || null;
  }
  res.json({ booking: fullRow(b), matches, staffed, statuses: B.STATUSES, packages: B.PACKAGES, regions: B.REGION_WORDS });
}));

router.patch("/:id", requireStaff, safe(async (req, res) => {
  if (!B.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const body = bodyOf(req);
  const { data: b } = await sb.from("sm_bookings").select("id,status,staffed_creator_id,event_date").eq("id", req.params.id).maybeSingle();
  if (!b) return res.status(404).json({ error: "not_found" });

  const patch = {};
  if (body.staffed_creator_id !== undefined) {
    // A delivered or cancelled booking keeps who it had. Reopen it first.
    if (B.CLOSED.includes(b.status)) return res.status(409).json({ error: "booking_closed" });
    if (body.staffed_creator_id === null) patch.staffed_creator_id = null;
    else {
      const cid = typeof body.staffed_creator_id === "string" ? body.staffed_creator_id.slice(0, 64) : "";
      const { data: c } = cid ? await sb.from("gfs_creators").select(CREW_COLUMNS).eq("id", cid).maybeSingle() : { data: null };
      if (!c || c.status !== "active") return res.status(400).json({ error: "creator_not_active" });
      // An adult whose screening is current on the game's date (the Pylon rule).
      const problems = B.staffProblems(c, b.event_date);
      if (problems.length) return res.status(400).json({ error: "creator_not_cleared", problems });
      patch.staffed_creator_id = c.id;
      if (body.status === undefined && B.OPEN.includes(b.status)) patch.status = "staffed";
    }
  }
  if (body.status !== undefined) {
    if (!B.STATUSES.includes(body.status)) return res.status(400).json({ error: "invalid_status" });
    patch.status = body.status;
  }
  const status = patch.status || b.status;
  const creator = patch.staffed_creator_id !== undefined ? patch.staffed_creator_id : b.staffed_creator_id;
  if ((status === "staffed" || status === "delivered") && !creator) return res.status(400).json({ error: "creator_required" });
  if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_change" });

  patch.status_by = String((req.session && req.session.userEmail) || "").toLowerCase().slice(0, 200) || null;
  patch.updated_at = new Date().toISOString();
  const { data, error } = await sb.from("sm_bookings").update(patch).eq("id", b.id).select().single();
  if (error) return res.status(500).json({ error: "storage_error" });
  res.json({ booking: fullRow(data) });
}));

router._limited = limited;
router._resetLimits = () => { hits.clear(); forms = []; emails = []; bookerSent.clear(); bookerTimes = []; remindTries.clear(); };
router._remind = remindUnfinished;
router._hits = hits;
router._visitorKey = visitorKey;
module.exports = router;
