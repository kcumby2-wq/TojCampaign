"use strict";
// The Recruiting Concierge's messages to college coaches, and the family's
// approval of each one (migration 037; the family's side is
// routes/pylon-parent.js and public/parent-approval.html). Owner only, like
// the requests they belong to. Mounted inside routes/pylon.js:
//
//   GET   /api/pylon/requests/:id/outreach   the request's messages
//   POST  /api/pylon/requests/:id/outreach   a new draft
//   PATCH /api/pylon/outreach/:oid           change a draft (never once approved)
//   POST  /api/pylon/outreach/:oid/ask       email the family a one-time link to approve it
//   POST  /api/pylon/outreach/:oid/sent      staff sent it, as approved
//
// The link goes to the request's contact by email and nowhere else: staff
// never see it, so only the family can approve. The database holds the line
// too (migration 037): no decision without burning a link, no change after
// approval, no send without approval.

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
const COLUMNS = "id,request_id,coach_name,coach_email,program_name,program_level,draft_subject,draft_body,created_by,parent_approval_token_hash,parent_approval_requested_at,parent_approval_expires_at,parent_decision,parent_decided_at,parent_decided_name,parent_approved,sent_at,sent_by,created_at,updated_at";

// What the app gets: the state, never the link's hash.
function view(o) {
  const { parent_approval_token_hash: _hash, ...rest } = o;
  return { ...rest, state: U.outreachState(o) };
}
const who = (req) => String(req.session.userEmail || "").toLowerCase().slice(0, 200);
// The database refused (a trigger or a check): the change isn't allowed.
const refusedByDb = (e) => !!e && (e.code === "P0001" || /^23/.test(String(e.code || "")));

// At most 20 approval emails a day for one request, so a slip can't flood a
// family's inbox. In memory, like the other limits.
const ASKS_PER_REQUEST_PER_DAY = 20;
const asks = new Map();
function askAllowed(requestId, now = Date.now()) {
  const list = (asks.get(requestId) || []).filter((t) => now - t < 24 * 60 * 60 * 1000);
  if (list.length >= ASKS_PER_REQUEST_PER_DAY) return false;
  list.push(now);
  asks.set(requestId, list);
  if (asks.size > 5000) for (const [k, v] of asks) if (!v.some((t) => now - t < 24 * 60 * 60 * 1000)) asks.delete(k);
  return true;
}

async function recruitingRequest(sb, id) {
  if (!U.UUID.test(String(id))) return { status: 404 };
  const { data, error } = await sb.from("pylon_requests").select("id,kind,contact_name,contact_email,contact_role,athlete_name,status").eq("id", id).maybeSingle();
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

router.get("/requests/:id/outreach", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const r = await recruitingRequest(sb, req.params.id);
  if (!r.request) return fail(res, r);
  const { data, error } = await sb.from("pylon_outreach").select(COLUMNS).eq("request_id", r.request.id).order("created_at", { ascending: true }).limit(200);
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  res.json({ outreach: (data || []).map(view), levels: U.LEVEL_WORDS });
}));

router.post("/requests/:id/outreach", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const r = await recruitingRequest(sb, req.params.id);
  if (!r.request) return fail(res, r);
  const { errors, value } = U.normalizeDraft(H.bodyOf(req));
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const { data, error } = await sb.from("pylon_outreach").insert({ ...value, request_id: r.request.id, created_by: who(req) }).select(COLUMNS).single();
  if (error) {
    console.error("[pylon-outreach] draft not saved:", error.code || "", error.message || "");
    return res.status(refusedByDb(error) ? 400 : 503).json({ error: refusedByDb(error) ? "invalid" : "storage_unavailable" });
  }
  res.json({ ok: true, outreach: view(data) });
}));

// A change to the words or the coach while a link is out cancels the link
// (the database does it), so the family approves what would go out.
router.patch("/outreach/:oid", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) return fail(res, o);
  if (o.row.parent_approved || o.row.sent_at) return res.status(409).json({ error: "approved_locked" });
  const { errors, value } = U.normalizeDraft(H.bodyOf(req), { partial: true });
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  if (!Object.keys(value).length) return res.json({ ok: true, outreach: view(o.row) });
  const { data, error } = await sb.from("pylon_outreach").update({ ...value, updated_at: nowIso() }).eq("id", o.row.id).eq("parent_approved", false).select(COLUMNS).maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "approved_locked" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "approved_locked" });
  const cancelled = !!o.row.parent_approval_token_hash && !data.parent_approval_token_hash;
  res.json({ ok: true, outreach: view(data), link_cancelled: cancelled });
}));

// A new one-time link, emailed to the request's contact. Asking again
// replaces the last link (and clears a decline). If the email can't go, the
// link is taken back: nobody holds it.
router.post("/outreach/:oid/ask", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) return fail(res, o);
  if (o.row.parent_approved || o.row.sent_at) return res.status(409).json({ error: "already_approved" });
  const r = await recruitingRequest(sb, o.row.request_id);
  if (!r.request) return fail(res, r);
  if (!askAllowed(r.request.id)) return res.status(429).json({ error: "too_many_asks" });

  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const at = new Date();
  const expires = new Date(at.getTime() + U.APPROVAL_TTL_MS).toISOString();
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({
      parent_approval_token_hash: hash,
      parent_approval_requested_at: at.toISOString(),
      parent_approval_expires_at: expires,
      parent_decision: null,
      parent_decided_at: null,
      parent_decided_name: null,
      updated_at: at.toISOString(),
    })
    .eq("id", o.row.id)
    .eq("parent_approved", false)
    .is("sent_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "already_approved" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "already_approved" });

  const mail = U.approvalEmail(r.request, data, { link: `${SITE_BASE()}/parent-approval.html?token=${token}`, help: helpEmail() });
  let sent = null;
  try {
    sent = await mailer.sendMail({ to: r.request.contact_email, subject: mail.subject, text: mail.text, replyTo: helpEmail(), pool: "pylon" });
  } catch (e) {
    console.warn("[pylon-outreach] approval email failed:", mailer.errorCode(e));
  }
  if (!sent || !sent.sent) {
    // Nobody got the link: take it back, unless something else replaced it meanwhile.
    await sb.from("pylon_outreach").update({ parent_approval_token_hash: null, parent_approval_expires_at: null, updated_at: nowIso() }).eq("id", data.id).eq("parent_approval_token_hash", hash);
    return res.status(502).json({ error: "email_not_sent", reason: (sent && sent.reason) || "send_failed" });
  }
  res.json({ ok: true, outreach: view(data), sent_to: r.request.contact_email });
}));

// Staff sent it, from their own email, exactly as approved. Only once, and
// only an approved message (the database checks both).
router.post("/outreach/:oid/sent", requireStaff, safe(async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const o = await outreachRow(sb, req.params.oid);
  if (!o.row) return fail(res, o);
  if (!o.row.parent_approved) return res.status(409).json({ error: "not_approved" });
  if (o.row.sent_at) return res.status(409).json({ error: "already_sent" });
  const { data, error } = await sb
    .from("pylon_outreach")
    .update({ sent_at: nowIso(), sent_by: who(req), updated_at: nowIso() })
    .eq("id", o.row.id)
    .eq("parent_approved", true)
    .is("sent_at", null)
    .select(COLUMNS)
    .maybeSingle();
  if (error) return res.status(refusedByDb(error) ? 409 : 503).json({ error: refusedByDb(error) ? "not_approved" : "storage_unavailable" });
  if (!data) return res.status(409).json({ error: "already_sent" });
  res.json({ ok: true, outreach: view(data) });
}));

module.exports = router;
module.exports._reset = () => asks.clear();
