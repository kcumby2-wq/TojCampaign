"use strict";
// Subject Medias bookings (migration 030; the rules are in utils/sm-bookings.js).
//
//   POST  /api/sm/bookings          the booking form, through subjectmedias.com's
//                                    /api/book function
//   POST  /api/sm/bookings/paid     subjectmedias.com's Stripe webhook
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

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const B = require("../utils/sm-bookings");

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
// emails go out at most 30 an hour, so a flood can't use up the Gmail account
// the reports send from; every booking is still saved and pushed.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const MAX_TRACKED = 5000;
const HOUR = 60 * 60 * 1000;
const MAX_FORMS_PER_HOUR = 120;
const MAX_EMAILS_PER_HOUR = 30;
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
  const r = underHourly(emails, MAX_EMAILS_PER_HOUR, now);
  emails = r.list;
  return r.ok;
}
const visitor = (req) => String(req.headers["x-sm-visitor"] || "").split(",")[0].trim().slice(0, 100) || "unknown";

// ── Alerts ───────────────────────────────────────────────────────────────
async function findMatches(sb, booking) {
  const [crew, club] = await Promise.all([
    booking.region ? sb.from("gfs_creators").select(CREW_COLUMNS).eq("status", "active").eq("region", booking.region) : Promise.resolve({ data: [] }),
    sb.from("creators").select("slug,brand_name,location,status,page_status").eq("status", "active").eq("page_status", "live"),
  ]);
  return B.rankCreators(booking, (crew && crew.data) || [], (club && club.data) || []);
}

// Push and email to staff, then note on the row when they went and who was
// suggested. Never throws.
async function alertStaff(sb, row) {
  try {
    const matches = await findMatches(sb, row);
    const to = [...staffEmails()];
    push.notifySoon(to, B.pushPayload(row, matches.crew.length));
    if (emailAllowed()) {
      const mail = B.emailText(row, matches, APP_BASE());
      mailer
        .sendMail({ to, subject: mail.subject, text: mail.text })
        .then((r) => { if (!r.sent) console.warn(`[sm-bookings] email not sent (${r.reason})`); })
        .catch((e) => console.warn("[sm-bookings] email failed:", e && e.message));
    } else console.warn("[sm-bookings] over the hourly email budget: push only");
    const snapshot = matches.crew.map((c) => ({ id: c.id, name: c.name, home_city: c.home_city, tier: c.tier, screened: c.screened }));
    await sb.from("sm_bookings").update({ alerted_at: new Date().toISOString(), matches: snapshot }).eq("id", row.id);
  } catch (e) {
    console.warn("[sm-bookings] alert failed:", e && e.message);
  }
}

// The booking couldn't be stored: email it to staff whole, so it isn't lost.
// Always sent (it's the only copy), whatever the hourly budget.
async function emailUnsaved(row) {
  try {
    const mail = B.emailText({ ...row, id: "not-saved" }, null, APP_BASE(), { saved: false });
    emailAllowed();
    const r = await mailer.sendMail({ to: [...staffEmails()], subject: `${mail.subject} (not saved: the app's database didn't take it)`, text: mail.text });
    return !!(r && r.sent);
  } catch (e) {
    console.error("[sm-bookings] fallback email failed:", e && e.message);
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

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("sm_bookings").insert(row).select().single();
    if (!error && data) {
      res.json({ ok: true, id: data.id });
      setImmediate(() => alertStaff(sb, data));
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
  if (paid.notes) patch.notes = [b.notes, `From the checkout: ${paid.notes}`].filter(Boolean).join("\n\n").slice(0, 1000);
  // Only while unpaid: two deliveries of one webhook can't both join it.
  const { data, error: e2 } = await sb.from("sm_bookings").update(patch).eq("id", b.id).is("stripe_session_id", null).select().maybeSingle();
  if (e2) return e2.code === "23505" ? { duplicate: true } : {};
  return data ? { row: data } : {};
}

router.post("/paid", safe(async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { errors, value } = B.normalizePaid(bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const { booking_id: requestId, ...paid } = value;

  const sb = getSupabase();
  if (sb) {
    if (requestId) {
      const joined = await payRequest(sb, requestId, paid);
      if (joined.duplicate) return res.json({ ok: true, duplicate: true });
      if (joined.row) {
        res.json({ ok: true, id: joined.row.id, joined: true });
        setImmediate(() => alertStaff(sb, joined.row));
        return;
      }
      // Not a request we have, or one already paid: a booking of its own.
    }
    const { data, error } = await sb.from("sm_bookings").insert({ ...paid, status: "new" }).select().single();
    if (!error && data) {
      res.json({ ok: true, id: data.id });
      setImmediate(() => alertStaff(sb, data));
      return;
    }
    // Stripe retries a webhook: the same checkout arrives again. Already here.
    if (error && error.code === "23505") return res.json({ ok: true, duplicate: true });
    console.error("[sm-bookings] paid insert failed:", error && (error.code || "") + " " + (error.message || ""));
  }
  // Not stored: the email carries it, and Stripe can stop retrying. If the
  // email can't go either, a 503 makes Stripe try again later.
  if (await emailUnsaved(paid)) return res.json({ ok: true, id: null });
  return res.status(503).json({ error: "storage_unavailable" });
}));

// ── Staff: the list, one booking, its status ──────────────────────────
const LIST_FIELDS = ["id", "source", "kind", "package", "sport", "event_name", "event_date", "event_city", "event_state", "region", "athletes", "amount_cents", "status", "staffed_creator_id", "created_at"];
const LIST_COLUMNS = [...LIST_FIELDS, "stripe_session_id"].join(",");
// The list never carries contact details or notes, whatever the query returns.
const listRow = (b) => ({ ...Object.fromEntries(LIST_FIELDS.map((k) => [k, b[k] === undefined ? null : b[k]])), paid: B.paid(b) });

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
  res.json({ booking: { ...b, summary: B.summary(b), paid: B.paid(b) }, matches, staffed, statuses: B.STATUSES, packages: B.PACKAGES, regions: B.REGION_WORDS });
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
  res.json({ booking: { ...data, summary: B.summary(data), paid: B.paid(data) } });
}));

router._limited = limited;
router._resetLimits = () => { hits.clear(); forms = []; emails = []; };
router._hits = hits;
module.exports = router;
