"use strict";
// PUBLIC, link-gated: the family approves or declines one Recruiting
// Concierge message to a college coach (migration 037). No staff session is
// involved; the one-time link is the only key.
//
//   POST /api/pylon-parent/approval/view    { token }   the message as it will be sent
//   POST /api/pylon-parent/approval/decide  { token, decision: "approved" | "declined",
//                                             parent_name, confirm: true }
//
// The link (from POST /api/pylon/outreach/:oid/ask, by email to the
// request's contact) carries the token in its fragment, and the page posts
// it: it never appears in a URL a server logs. The server sends the
// database the token's hash (the proof); the table keeps the proof's hash.
// Links work once, for 14 days, on an open request whose contact staff have
// checked. Nothing about the athlete beyond a first name is returned, and
// nothing that identifies the athlete or the family goes to the logs.
//
// After a decision, staff hear which message it was, and the family gets a
// receipt: if someone else used their link, they find out at once.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const U = require("../utils/pylon");
const H = require("../utils/pylon-http");

const router = express.Router();
const safe = H.safe("pylon-parent");
const env = (k) => String(process.env[k] || "").trim();
const APP_BASE = () => (env("APP_BASE") || "https://tojcampaign.com").replace(/\/+$/, "");
const helpEmail = () => U.email(env("PYLON_HELP_EMAIL")) || "hello@pylonfootball.com";
// Guessing at links: 30 tries per visitor per 10 minutes; the 256-bit token
// is what stops a guess. Per connection (the hop Render saw, which made-up
// X-Forwarded-For headers can't change; through Vercel, shared by every
// family), 600 per 10 minutes: a breaker for floods only, and the page says
// "try again in a minute" if it trips.
const perVisitor = H.windowLimiter(30, 10 * 60 * 1000);
const perPeer = H.windowLimiter(600, 10 * 60 * 1000);
const proofOf = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
const wellFormed = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
// The function's one column comes back as rows of { outreach_id }; a bare
// value is taken too.
function idOf(data) {
  const first = Array.isArray(data) ? data[0] : data;
  if (typeof first === "string") return U.UUID.test(first) ? first : null;
  return first && typeof first.outreach_id === "string" ? first.outreach_id : null;
}
const firstRow = (data) => (Array.isArray(data) ? data[0] || null : data && typeof data === "object" ? data : null);
// A name with at least two letters (any alphabet), and nothing that reads as
// a link or an address.
function decidedName(v) {
  const name = U.personName(v);
  return name && (name.match(/\p{L}/gu) || []).length >= 2 ? name : null;
}

router.use((req, res, next) => {
  // Nothing here is for caches or other sites.
  res.set("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "post_only" });
  if (!req.is("application/json")) return res.status(415).json({ error: "json_only" });
  if (!H.originOk(req)) return res.status(403).json({ error: "wrong_origin" });
  if (perVisitor(H.visitorKey(H.visitor(req))) || perPeer(H.peer(req))) return res.status(429).json({ error: "too_many" });
  next();
});

router.post("/approval/view", safe(async (req, res) => {
  const token = H.bodyOf(req).token;
  if (!wellFormed(token)) return res.status(400).json({ error: "bad_link" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb.rpc("pylon_outreach_for_family", { token_hash: proofOf(token) });
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  const r = firstRow(data);
  if (!r || !r.draft_body) return res.status(404).json({ error: "link_not_active" });
  res.json({
    ok: true,
    approver: r.approver === "athlete" ? "athlete" : "family",
    athlete_first_name: U.personName(r.athlete_first_name) || null,
    program_name: r.program_name,
    program_level: r.program_level ? U.LEVEL_WORDS[r.program_level] || r.program_level : null,
    coach_name: r.coach_name,
    coach_email: r.coach_email,
    draft_subject: r.draft_subject,
    draft_body: r.draft_body,
    expires_at: r.expires_at,
  });
}));

router.post("/approval/decide", safe(async (req, res) => {
  const body = H.bodyOf(req);
  if (!wellFormed(body.token)) return res.status(400).json({ error: "bad_link" });
  const decision = body.decision;
  if (decision !== "approved" && decision !== "declined") return res.status(400).json({ error: "bad_decision" });
  if (body.confirm !== true) return res.status(400).json({ error: "confirm_required" });
  const name = decidedName(body.parent_name);
  if (!name) return res.status(400).json({ error: "name_required" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // One statement: the link is checked, burned and the decision recorded together.
  const { data, error } = await sb.rpc("pylon_outreach_decide", { token_hash: proofOf(body.token), decision, decided_name: name });
  if (error) {
    console.error("[pylon-parent] decision not recorded:", error.code || "");
    return res.status(503).json({ error: "storage_unavailable" });
  }
  const id = idOf(data);
  if (!id) return res.status(404).json({ error: "link_not_active" });
  console.log(`[pylon-parent] outreach ${id} ${decision} through the family's link`);
  res.json({ ok: true, decision });

  // Staff hear which message was decided (never the athlete); the family
  // gets a receipt. Never throws.
  setImmediate(async () => {
    try {
      const { data: o } = await sb.from("pylon_outreach").select("id,request_id,coach_name,program_name,parent_decided_at").eq("id", id).maybeSingle();
      if (!o) return;
      const a = U.decisionAlert(o, decision, APP_BASE());
      const to = [...staffEmails()];
      push.notifySoon(to, a.push);
      const r = await mailer.sendMail({ to, subject: a.email.subject, text: a.email.text, pool: "pylon_approval" });
      if (!r.sent) console.warn(`[pylon-parent] staff email not sent (${r.reason})`);
      const { data: rq } = await sb.from("pylon_requests").select("contact_name,contact_email,contact_role,athlete_name").eq("id", o.request_id).maybeSingle();
      if (!rq || !rq.contact_email) return;
      const receipt = U.decisionReceipt(rq, o, decision, { help: helpEmail() });
      const replyTo = U.email(env("PYLON_APPROVAL_REPLY_TO")) || rq.contact_email;
      const r2 = await mailer.sendMail({ to: rq.contact_email, subject: receipt.subject, text: receipt.text, replyTo, pool: "pylon_approval" });
      if (!r2.sent) console.warn(`[pylon-parent] receipt not sent (${r2.reason})`);
    } catch (e) {
      console.warn("[pylon-parent] after-decision emails failed:", mailer.errorCode(e));
    }
  });
}));

router.use((req, res) => res.status(404).json({ error: "not_found" }));

module.exports = router;
module.exports._reset = () => {
  perVisitor.reset();
  perPeer.reset();
};
