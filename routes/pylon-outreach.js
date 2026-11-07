"use strict";
// The Recruiting Concierge's messages to college coaches, and the family's
// approval of each one (migration 037; the family's side is
// routes/pylon-parent.js and public/parent-approval.html). Owner only, like
// the requests they belong to. Mounted inside routes/pylon.js:
//
//   GET   /api/pylon/requests/:id/outreach      the request's messages, each with its history
//   POST  /api/pylon/requests/:id/outreach      a new draft
//   PATCH /api/pylon/outreach/:oid              change a draft (never once approved)
//   POST  /api/pylon/outreach/:oid/ask          email the family a one-time link to approve it
//   POST  /api/pylon/outreach/:oid/cancel-link  stop the link that's out
//   POST  /api/pylon/outreach/:oid/withdraw     the family took their approval back
//   POST  /api/pylon/outreach/:oid/sent         staff sent it, as approved
//   POST  /api/pylon/outreach/:oid/reply        a coach replied: { note }
//
// Changes carry `seen`: the updated_at the card showed. If the message
// changed since (the family decided, someone else asked), the change is
// refused, so a stale screen can't undo what happened.
//
// The link goes to the request's contact by email and nowhere else: staff
// never see it, and the database keeps only a hash of its proof, so only the
// holder of the link can decide (migration 037). Links go out only on an open
// request whose contact staff have checked (pylon_requests.contact_verified_at).
// The email's replies don't come to staff: a reply would quote the link.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff } = require("../utils/staff");
const mailer = require("../utils/mailer");
const U = require("../utils/pylon");
const H = require("../utils/pylon-http");

const router = express.Router();
const safe = H.safe("pylon-outreach");
const env = (k) => String(process.env[k] || "").trim();
const SITE_BASE = () => (env("PYLON_SITE_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
const helpEmail = () => U.email(env("PYLON_HELP_EMAIL")) || "hello@pylonfootball.com";
const nowIso = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
const COLUMNS = "id,request_id,coach_name,coach_email,program_name,program_level,draft_subject,draft_body,created_by,changed_by,parent_approval_token_hash,parent_approval_requested_at,parent_approval_expires_at,parent_decision,parent_decided_at,parent_decided_name,parent_approved,withdrawn_at,withdrawn_by,sent_at,sent_by,created_at,updated_at";
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// What the app gets: the state, never the link's hash.
function view(o, history) {
  const { parent_approval_token_hash: _hash, ...rest } = o;
  return { ...rest, state: U.outreachState(o), ...(history ? { history } : {}) };
}
const who = (req) => String(req.session.userEmail || "").toLowerCase().slice(0, 200);
// The database refused (a trigger or a check): the change isn't allowed.
const refusedByDb = (e) => !!e && (e.code === "P0001" || /^23/.test(String(e.code || "")));
// The updated_at the card showed.
const seenOf = (req) => {
  const s = H.bodyOf(req).seen;
  return typeof s === "string" && s.length <= 64 ? s : null;
};

// Approval emails: at most 20 a day to one mailbox, so a slip can't flood a
// family's inbox (however many requests they're on). One that didn't go
// gives its place back. In memory, like the other limits.
const ASKS_PER_MAILBOX_PER_DAY = 20;
const asks = new Map();
function askAllowed(address, now = Date.now()) {
  const key = sha256(U.mailbox(address));
  const list = (asks.get(key) || []).filter((t) => now - t < DAY_MS);
  if (list.length >= ASKS_PER_MAILBOX_PER_DAY) return null;
  list.push(now);
  asks.set(key, list);
  if (asks.size > 5000) for (const [k, v] of asks) if (!v.some((t) => now - t < DAY_MS)) asks.delete(k);
  return () => {
    const i = list.lastIndexOf(now);
    if (i >= 0) list.splice(i, 1);
  };
}

async function recruitingRequest(sb, id) {
  if (!U.UUID.test(String(id))) return { status: 404 };
  const { data, error } = await sb.from("pylon_requests").select("id,kind,contact_name,contact_email,contact_role,athlete_name,status,contact_verified_at").eq("id", id).maybeSingle();
  if (error) return { status: 503 };
  if (!data) return { status: 404 };
  if (data.kind !== "recruiting") return { status: 400, error: "not_recruiting" };
  return { request: data };
}
async function outreachRow(sb, oid) {
  if (!U.UUID.test(String(oid))) return { status: 404 };
  const { data, error } = await sb.from("pylon_outreach").select(COLUMNS).eq("id", oid).maybeSingle();
  if (error) return { status: 503 };
  if (!data) return { status: 404 };
  return { row: data };
}
const fail = (res, r) => res.status(r.status).json({ error: r.error || (r.status === 503 ? "storage_unavailable" : "not_found") });
const unavailable = (res) => res.status(503).json({ error: "storage_unavailable" });
const closed = (r) => r.status === "done" || r.status === "closed";

// One message, loaded and checked against what the card showed.
async function current(req, res, sb) {
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) {
    fail(res, o);
    return null;
  }
  const seen = seenOf(req);
  if (!seen) {
    res.status(400).json({ error: "seen_required" });
    return null;
  }
  if (o.row.updated_at !== seen) {
    res.status(409).json({ error: "changed_meanwhile" });
    return null;
  }
  return o.row;
}

router.get("/requests/:id/outreach", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const r = await recruitingRequest(sb, req.params.id);
  if (!r.request) return fail(res, r);
  const { data, error } = await sb.from("pylon_outreach").select(COLUMNS).eq("request_id", r.request.id).order("created_at", { ascending: true }).limit(200);
  if (error) return unavailable(res);
  const rows = data || [];
  const byOutreach = new Map(rows.map((o) => [o.id, []]));
  if (rows.length) {
    const { data: events, error: e2 } = await sb
      .from("pylon_outreach_events")
      .select("outreach_id,event,at,by_staff,by_family,note")
      .in("outreach_id", rows.map((o) => o.id))
      .order("at", { ascending: true })
      .limit(5000);
    if (e2) return unavailable(res);
    for (const ev of events || []) if (byOutreach.has(ev.outreach_id)) byOutreach.get(ev.outreach_id).push({ event: ev.event, at: ev.at, by_staff: ev.by_staff, by_family: ev.by_family, note: ev.note });
  }
  res.set("Cache-Control", "private, no-store");
  res.json({
    outreach: rows.map((o) => view(o, byOutreach.get(o.id))),
    levels: U.LEVEL_WORDS,
    request: { checked: !!r.request.contact_verified_at, open: !closed(r.request) },
  });
}));

router.post("/requests/:id/outreach", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const r = await recruitingRequest(sb, req.params.id);
  if (!r.request) return fail(res, r);
  const { errors, value } = U.normalizeDraft(H.bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const { data, error } = await sb.from("pylon_outreach").insert({ ...value, request_id: r.request.id, created_by: who(req), changed_by: who(req) }).select(COLUMNS).single();
  if (error) {
    console.error("[pylon-outreach] draft not saved:", error.code || "", error.message || "");
    return res.status(refusedByDb(error) ? 400 : 503).json({ error: refusedByDb(error) ? "invalid" : "storage_unavailable" });
  }
  res.json({ ok: true, outreach: view(data) });
}));

// A change to anything the family is shown while a link is out cancels the
// link (the database does it), so the family approves what would go out.
router.patch("/outreach/:oid", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const row = await current(req, res, sb);
  if (!row) return;
  if (row.parent_approved || row.sent_at) return res.status(409).json({ error: "approved_locked" });
  const { errors, value } = U.normalizeDraft(H.bodyOf(req), { partial: true });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!Object.keys(value).length) return res.json({ ok: true, outreach: view(row) });
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({ ...value, changed_by: who(req), updated_at: nowIso() })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .eq("parent_approved", false)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "approved_locked" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "changed_meanwhile" });
  const cancelled = !!row.parent_approval_token_hash && !data.parent_approval_token_hash;
  res.json({ ok: true, outreach: view(data), link_cancelled: cancelled });
}));

// Where a family's reply to an approval email goes: never to staff, since a
// reply quotes the link. PYLON_APPROVAL_REPLY_TO (an address nobody reads),
// or else back to the family's own address. The email says to write to the
// help address in a new email instead.
const approvalReplyTo = (contact) => U.email(env("PYLON_APPROVAL_REPLY_TO")) || contact;

// A new one-time link, emailed to the request's contact. Asking again
// replaces the last link (and clears a decline; the history keeps it). If
// the email can't go, the link is taken back: nobody holds it.
router.post("/outreach/:oid/ask", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const row = await current(req, res, sb);
  if (!row) return;
  if (row.parent_approved || row.sent_at) return res.status(409).json({ error: "already_approved" });
  const r = await recruitingRequest(sb, row.request_id);
  if (!r.request) return fail(res, r);
  if (closed(r.request)) return res.status(409).json({ error: "request_closed" });
  if (!r.request.contact_verified_at) return res.status(409).json({ error: "contact_unchecked" });
  const giveBack = askAllowed(r.request.contact_email);
  if (!giveBack) return res.status(429).json({ error: "too_many_asks" });

  // The link carries the token; the server's proof is its hash; the table
  // keeps the proof's hash. Nobody who can read the table can decide.
  const token = crypto.randomBytes(32).toString("hex");
  const stored = sha256(sha256(token));
  const at = new Date();
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({
      parent_approval_token_hash: stored,
      parent_approval_requested_at: at.toISOString(),
      parent_approval_expires_at: new Date(at.getTime() + U.APPROVAL_TTL_MS).toISOString(),
      parent_decision: null,
      parent_decided_at: null,
      parent_decided_name: null,
      changed_by: who(req),
      updated_at: at.toISOString(),
    })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .eq("parent_approved", false)
    .is("sent_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error || !data) {
    giveBack();
    if (error && !refusedByDb(error)) return unavailable(res);
    if (error) console.warn("[pylon-outreach] ask refused by the database:", error.code || "", error.message || "");
    return res.status(409).json({ error: error ? "cannot_ask" : "changed_meanwhile" });
  }

  // A fragment (#t=), so the token never reaches a server's request log.
  const mail = U.approvalEmail(r.request, data, { link: `${SITE_BASE()}/parent-approval.html#t=${token}`, help: helpEmail() });
  let sent = null;
  try {
    sent = await mailer.sendMail({ to: r.request.contact_email, subject: mail.subject, text: mail.text, replyTo: approvalReplyTo(r.request.contact_email), pool: "pylon_approval" });
  } catch (e) {
    console.warn("[pylon-outreach] approval email failed:", mailer.errorCode(e));
  }
  if (!sent || !sent.sent) {
    giveBack();
    // Nobody got the link: take it back, unless something else replaced it meanwhile.
    const { error: e2 } = await sb
      .from("pylon_outreach")
      .update({ parent_approval_token_hash: null, parent_approval_expires_at: null, changed_by: who(req), updated_at: nowIso() })
      .eq("id", data.id)
      .eq("parent_approval_token_hash", stored);
    if (e2) console.error("[pylon-outreach] link not taken back:", e2.code || "", e2.message || "");
    const { error: e3 } = await sb.from("pylon_outreach_events").insert({ outreach_id: data.id, event: "note", by_staff: who(req), note: "The approval email didn't go, so the link was taken back." });
    if (e3) console.warn("[pylon-outreach] history note not saved:", e3.code || "");
    return res.status(502).json({ error: "email_not_sent", reason: (sent && sent.reason) || "send_failed" });
  }
  res.json({ ok: true, outreach: view(data), sent_to: r.request.contact_email });
}));

// Stop the link that's out (sent to the wrong place, or someone else saw it).
router.post("/outreach/:oid/cancel-link", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const row = await current(req, res, sb);
  if (!row) return;
  if (!row.parent_approval_token_hash) return res.status(409).json({ error: "no_link" });
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({ parent_approval_token_hash: null, parent_approval_expires_at: null, changed_by: who(req), updated_at: nowIso() })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .eq("parent_approval_token_hash", row.parent_approval_token_hash)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "no_link" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "changed_meanwhile" });
  res.json({ ok: true, outreach: view(data) });
}));

// The family told staff to stop an approved message: it's never sent.
router.post("/outreach/:oid/withdraw", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const row = await current(req, res, sb);
  if (!row) return;
  if (!row.parent_approved) return res.status(409).json({ error: "not_approved" });
  if (row.sent_at) return res.status(409).json({ error: "already_sent" });
  if (row.withdrawn_at) return res.status(409).json({ error: "already_withdrawn" });
  const at = nowIso();
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({ withdrawn_at: at, withdrawn_by: who(req), changed_by: who(req), updated_at: at })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .is("sent_at", null)
    .is("withdrawn_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "already_sent" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "changed_meanwhile" });
  res.json({ ok: true, outreach: view(data) });
}));

// Staff sent it, from their own email, exactly as approved. Only once, only
// an approved message, and never one the family took back (the database
// checks all three).
router.post("/outreach/:oid/sent", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) return fail(res, o);
  if (!o.row.parent_approved) return res.status(409).json({ error: "not_approved" });
  if (o.row.withdrawn_at) return res.status(409).json({ error: "withdrawn" });
  if (o.row.sent_at) return res.status(409).json({ error: "already_sent" });
  const at = nowIso();
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({ sent_at: at, sent_by: who(req), changed_by: who(req), updated_at: at })
    .eq("id", o.row.id)
    .eq("parent_approved", true)
    .is("sent_at", null)
    .is("withdrawn_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "not_approved" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "already_sent" });
  res.json({ ok: true, outreach: view(data) });
}));

// A coach wrote back: noted on the message's history (for the family's
// weekly update), never in place of the call when there's real interest.
router.post("/outreach/:oid/reply", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return unavailable(res);
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) return fail(res, o);
  if (!o.row.sent_at) return res.status(409).json({ error: "not_sent" });
  const note = U.cleanNotes(H.bodyOf(req).note, 500);
  if (!note) return res.status(400).json({ error: "invalid", fields: ["note"] });
  const { error } = await sb.from("pylon_outreach_events").insert({ outreach_id: o.row.id, event: "reply", by_staff: who(req), note });
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "not_sent" : "storage_unavailable" });
  res.json({ ok: true });
}));

module.exports = router;
module.exports._reset = () => asks.clear();
