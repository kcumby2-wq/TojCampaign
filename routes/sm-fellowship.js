"use strict";
// Applications to the Subject Medias creator fellowship (migration 032; the
// rules are in utils/sm-fellowship.js).
//
//   POST   /api/sm/fellowship            the application form, through
//                                         subjectmedias.com's /api/apply function
//   GET    /api/sm/fellowship            staff: open applications (?all=1 for every one)
//   GET    /api/sm/fellowship/:id        staff: one application and its approval note
//   PATCH  /api/sm/fellowship/:id        staff: its status, and a private note
//   POST   /api/sm/fellowship/:id/note   staff: email the approval note
//   DELETE /api/sm/fellowship/:id        staff: remove an application and all it holds
//
// The form's POST takes only the site's call. It carries the shared secret the
// booking form uses (SM_BOOKINGS_SECRET) in X-SM-Secret, and the visitor's
// address as Vercel saw it in X-SM-Visitor, which the abuse limits count by.
//
// Each new application alerts staff (ADMIN_EMAILS): a push to the TOJ app and
// an email. A failed alert never fails the application. If the database can't
// take it, the email carries it instead, so nobody's application is lost.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const { cleanUrl } = require("../utils/tools");
const F = require("../utils/sm-fellowship");

const router = express.Router();
const TABLE = "sm_fellowship_applications";
const APP_BASE = () => String(process.env.APP_BASE || "https://tojcampaign.com").replace(/\/+$/, "");

// Express 4 doesn't catch a rejected promise from an async handler, and an
// unhandled rejection stops the whole process. Every handler goes through this.
const safe = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req, res, next))
    .catch((e) => {
      console.error("[sm-fellowship] handler failed:", e && e.message);
      if (!res.headersSent) res.status(500).json({ error: "server_error" });
    });
const bodyOf = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
// Staff changes come only from the app's own fetch calls, which send JSON. A
// form on another site can't send JSON without the browser asking this server
// first, and it never says yes, so a signed-in owner can't be made to send a
// note or change an application from someone else's page.
const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ error: "json_only" }));

// ── The site's call ──────────────────────────────────────────────────────
// The same check as routes/sm-bookings.js: both sides hashed first, so the
// comparison can't throw on odd bytes and says nothing about the length.
function secretOk(req) {
  const want = String(process.env.SM_BOOKINGS_SECRET || "");
  if (want.length < 24) return false;
  const got = String(req.headers["x-sm-secret"] || "");
  const hash = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
  return crypto.timingSafeEqual(hash(got), hash(want));
}

// ── Abuse limits ─────────────────────────────────────────────────────────
// 5 tries per visitor per 10 minutes, and 60 valid applications an hour in all
// (a flood of junk from two visitors can't lock everyone else out). Staff
// alert emails go out at most 30 an hour, and approval notes at most 60, so
// nothing can use up the Gmail account the app sends from.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const MAX_TRACKED = 5000;
const HOUR = 60 * 60 * 1000;
const MAX_FORMS_PER_HOUR = 60;
const MAX_EMAILS_PER_HOUR = 30;
const MAX_NOTES_PER_HOUR = 60;
const hits = new Map();
let forms = [];
let emails = [];
let notes = [];

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
function noteAllowed(now = Date.now()) {
  const r = underHourly(notes, MAX_NOTES_PER_HOUR, now);
  notes = r.list;
  return r.ok;
}
const visitor = (req) => String(req.headers["x-sm-visitor"] || "").split(",")[0].trim().slice(0, 100) || "unknown";

// ── Alerts ───────────────────────────────────────────────────────────────
// Push and email to staff, then note on the row when they went. Never throws.
async function alertStaff(sb, row) {
  try {
    const to = [...staffEmails()];
    push.notifySoon(to, F.pushPayload(row));
    if (emailAllowed()) {
      const mail = F.emailText(row, APP_BASE());
      mailer
        .sendMail({ to, subject: mail.subject, text: mail.text, pool: "fellowship" })
        .then((r) => { if (!r.sent) console.warn(`[sm-fellowship] email not sent (${r.reason})`); })
        .catch((e) => console.warn("[sm-fellowship] email failed:", mailer.errorCode(e)));
    } else console.warn("[sm-fellowship] over the hourly email budget: push only");
    await sb.from(TABLE).update({ alerted_at: new Date().toISOString() }).eq("id", row.id);
  } catch (e) {
    console.warn("[sm-fellowship] alert failed:", e && e.message);
  }
}

// A repeat from an address that already has an open application isn't stored
// (one open application per address), so staff get a push in fixed words and,
// within the hourly budget, an email carrying the repeat to compare. Never
// throws.
function alertRepeat(row) {
  try {
    const to = [...staffEmails()];
    push.notifySoon(to, F.repeatPushPayload(row));
    if (!emailAllowed()) return console.warn("[sm-fellowship] over the hourly email budget: repeat by push only");
    const mail = F.emailText({ ...row, id: "repeat" }, APP_BASE(), { saved: false, repeat: true });
    mailer
      .sendMail({ to, subject: `Repeat ${mail.subject.replace(/^New /, "")}`, text: mail.text, pool: "fellowship" })
      .then((r) => { if (!r.sent) console.warn(`[sm-fellowship] repeat email not sent (${r.reason})`); })
      .catch((e) => console.warn("[sm-fellowship] repeat email failed:", mailer.errorCode(e)));
  } catch (e) {
    console.warn("[sm-fellowship] repeat alert failed:", e && e.message);
  }
}

// The application couldn't be stored: email it to staff whole, so it isn't
// lost. Always sent (it's the only copy), whatever the hourly budget.
async function emailUnsaved(row) {
  try {
    const mail = F.emailText({ ...row, id: "not-saved" }, APP_BASE(), { saved: false });
    emailAllowed();
    const r = await mailer.sendMail({ to: [...staffEmails()], subject: `${mail.subject} (not saved: the app's database didn't take it)`, text: mail.text, critical: true });
    return !!(r && r.sent);
  } catch (e) {
    console.error("[sm-fellowship] fallback email failed:", mailer.errorCode(e));
    return false;
  }
}

// An error the application itself caused (a value Postgres refuses, or a body
// the database's API refuses) isn't the database being down; anything else
// (unreachable, the table not there yet) means it can't be stored right now.
const inputError = (e) => !!e && /^(2[23]|PGRST1)/.test(String(e.code || ""));
// The table isn't there yet: migration 032 hasn't run.
const notSetUp = (e) => !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache/i.test(String(e.message || "")));
function storageFailed(res, e) {
  if (notSetUp(e)) return res.status(503).json({ error: "not_set_up" });
  return res.status(500).json({ error: "storage_error" });
}

// ── Public: the application form ─────────────────────────────────────────
// The answer says only whether it went in, never whose application is
// already here.
router.post("/", safe(async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  const raw = bodyOf(req);
  // Bots fill every field, including the one people never see. Its name is one
  // no browser's autofill knows, so a real applicant never trips it.
  if (raw.sm_trap) {
    console.warn("[sm-fellowship] the hidden field was filled: dropped");
    return res.json({ ok: true });
  }
  if (limited(visitor(req))) return res.status(429).json({ error: "too_many" });

  const { errors, value } = F.normalize(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!formAllowed()) return res.status(429).json({ error: "too_many" });
  const row = { ...value, status: "new" };

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from(TABLE).insert(row).select().single();
    if (!error && data) {
      res.json({ ok: true });
      setImmediate(() => alertStaff(sb, data));
      return;
    }
    // One open application per address, and this address has one. The same
    // answer as a new one; staff hear about the repeat.
    if (error && error.code === "23505") {
      res.json({ ok: true });
      setImmediate(() => alertRepeat(row));
      return;
    }
    console.error("[sm-fellowship] insert failed:", error && (error.code || "") + " " + (error.message || ""));
    if (inputError(error)) return res.status(400).json({ error: "invalid", fields: [] });
  }
  if (await emailUnsaved(row)) return res.json({ ok: true });
  return res.status(503).json({ error: "storage_unavailable" });
}));

// ── Staff ────────────────────────────────────────────────────────────────
const LIST_FIELDS = ["id", "name", "city", "state", "region", "age_group", "seat", "plan", "status", "approved_at", "emailed_at", "created_at"];
// The list never carries contact details, links or what anyone wrote.
const listRow = (a) => ({
  ...Object.fromEntries(LIST_FIELDS.map((k) => [k, a[k] === undefined ? null : a[k]])),
  links: Array.isArray(a.links) ? a.links.length : 0,
  summary: F.summary(a),
});
const planInfo = () =>
  Object.fromEntries(
    Object.entries(F.PLANS).map(([k, p]) => [k, { name: p.name, price: p.price || null, link_set: p.env ? !!cleanUrl(process.env[p.env]) : null }])
  );
const actor = (req) => String((req.session && req.session.userEmail) || "").toLowerCase().slice(0, 200) || null;

async function load(sb, id, columns = "*") {
  const { data, error } = await sb.from(TABLE).select(columns).eq("id", id).maybeSingle();
  return { a: data || null, error };
}
function detail(a) {
  return {
    application: { ...a, summary: F.summary(a) },
    note: F.approvalNote(a),
    plans: planInfo(),
    seats: F.SEATS,
    ages: F.AGES,
    statuses: F.STATUSES,
    regions: F.REGION_WORDS,
    email_ready: mailer.configured(),
  };
}

router.get("/", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let q = sb.from(TABLE).select([...LIST_FIELDS, "links"].join(",")).order("created_at", { ascending: false }).limit(200);
  if (req.query.all !== "1") q = q.in("status", [...F.OPEN]);
  const { data, error } = await q;
  if (error) return storageFailed(res, error);
  res.json({ applications: (data || []).map(listRow), statuses: F.STATUSES });
}));

router.get("/:id", requireStaff, safe(async (req, res) => {
  if (!F.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { a, error } = await load(sb, req.params.id);
  if (error) return storageFailed(res, error);
  if (!a) return res.status(404).json({ error: "not_found" });
  res.json(detail(a));
}));

router.patch("/:id", requireStaff, jsonOnly, safe(async (req, res) => {
  if (!F.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const body = bodyOf(req);
  const { a, error } = await load(sb, req.params.id, "id,status,approved_at");
  if (error) return storageFailed(res, error);
  if (!a) return res.status(404).json({ error: "not_found" });

  const patch = {};
  if (body.status !== undefined) {
    if (!F.STATUSES.includes(body.status)) return res.status(400).json({ error: "invalid_status" });
    if (body.status !== a.status) {
      patch.status = body.status;
      patch.status_by = actor(req);
      // Joined means approved first; the first approval keeps its time.
      if ((body.status === "approved" || body.status === "joined") && !a.approved_at) patch.approved_at = new Date().toISOString();
    }
  }
  if (body.staff_note !== undefined) {
    const n = F.staffNoteOf(body.staff_note);
    if (!n.ok) return res.status(400).json({ error: "note_too_long" });
    patch.staff_note = n.value;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_change" });
  patch.updated_at = new Date().toISOString();

  const { data, error: e2 } = await sb.from(TABLE).update(patch).eq("id", a.id).select().single();
  // Reopening it when the same address already has an open application.
  if (e2 && e2.code === "23505") return res.status(409).json({ error: "open_application_exists" });
  if (e2 || !data) return storageFailed(res, e2);
  res.json(detail(data));
}));

// Email the approval note, as staff edited it, to the people on the
// application. The recipients come from the application, never the request.
router.post("/:id/note", requireStaff, jsonOnly, safe(async (req, res) => {
  if (!F.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { a, error } = await load(sb, req.params.id);
  if (error) return storageFailed(res, error);
  if (!a) return res.status(404).json({ error: "not_found" });
  if (a.status !== "approved" && a.status !== "joined") return res.status(409).json({ error: "not_approved" });

  const body = bodyOf(req);
  const draft = F.approvalNote(a);
  const { errors, value } = F.noteInput({
    subject: body.subject === undefined ? draft.subject : body.subject,
    text: body.text === undefined ? draft.text : body.text,
  });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const to = F.noteRecipients(a);
  if (!to.length) return res.status(400).json({ error: "no_recipients" });
  if (!noteAllowed()) return res.status(429).json({ error: "too_many" });

  let sent;
  try {
    sent = await mailer.sendMail({ to, subject: value.subject, text: value.text, pool: "fellowship" });
  } catch (e) {
    console.warn("[sm-fellowship] note failed:", mailer.errorCode(e));
    sent = { sent: false, reason: "send_failed" };
  }
  if (!sent || !sent.sent) {
    return res.status(503).json({ error: sent && sent.reason === "email_not_configured" ? "email_not_configured" : "email_failed" });
  }
  const at = new Date().toISOString();
  await sb.from(TABLE).update({ emailed_at: at, updated_at: at }).eq("id", a.id);
  res.json({ ok: true, to, emailed_at: at });
}));

// Remove an application and everything in it, for good: what an applicant or
// their parent or guardian can ask for.
router.delete("/:id", requireStaff, safe(async (req, res) => {
  if (!F.UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { a, error } = await load(sb, req.params.id, "id");
  if (error) return storageFailed(res, error);
  if (!a) return res.status(404).json({ error: "not_found" });
  const { error: e2 } = await sb.from(TABLE).delete().eq("id", a.id);
  if (e2) return storageFailed(res, e2);
  res.json({ ok: true });
}));

router._limited = limited;
router._resetLimits = () => { hits.clear(); forms = []; emails = []; notes = []; };
module.exports = router;
