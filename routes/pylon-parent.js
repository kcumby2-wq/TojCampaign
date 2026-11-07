"use strict";
// PUBLIC, link-gated: the family approves or declines one Recruiting
// Concierge message to a college coach (migration 037). No staff session is
// involved; the one-time link is the only key.
//
//   GET  /api/pylon-parent/approval/:token   the message as it will be sent
//   POST /api/pylon-parent/approval/:token   { decision: "approved" | "declined",
//                                              parent_name, confirm: true }
//
// The link comes from POST /api/pylon/outreach/:oid/ask, by email to the
// request's contact. Only the token's hash is stored; links work once and for
// 14 days. Nothing about the athlete beyond a first name is returned, and
// nothing that identifies the athlete or the family goes to the logs.

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
// Guessing at links: 30 tries per visitor per 10 minutes.
const limited = H.windowLimiter(30, 10 * 60 * 1000);
const hashOf = (token) => crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
const wellFormed = (t) => typeof t === "string" && /^[0-9a-f]{64}$/.test(t);
const firstRow = (data) => (Array.isArray(data) ? data[0] || null : data || null);

router.use((req, res, next) => {
  // Nothing here is for caches or other sites.
  res.set("Cache-Control", "no-store");
  if (limited(H.visitorKey(H.visitor(req)))) return res.status(429).json({ error: "too_many" });
  next();
});

router.get("/approval/:token", safe(async (req, res) => {
  const token = String(req.params.token || "");
  if (!wellFormed(token)) return res.status(400).json({ error: "bad_link" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb.rpc("pylon_outreach_for_family", { token_hash: hashOf(token) });
  if (error) return res.status(503).json({ error: "storage_unavailable" });
  const r = firstRow(data);
  if (!r) return res.status(404).json({ error: "link_not_active" });
  res.json({
    ok: true,
    approver: r.approver === "athlete" ? "athlete" : "family",
    athlete_first_name: r.athlete_first_name || null,
    program_name: r.program_name,
    program_level: r.program_level ? U.LEVEL_WORDS[r.program_level] || r.program_level : null,
    coach_name: r.coach_name,
    coach_email: r.coach_email,
    draft_subject: r.draft_subject,
    draft_body: r.draft_body,
    expires_at: r.expires_at,
  });
}));

router.post("/approval/:token", safe(async (req, res) => {
  const token = String(req.params.token || "");
  if (!wellFormed(token)) return res.status(400).json({ error: "bad_link" });
  const body = H.bodyOf(req);
  const decision = body.decision;
  if (decision !== "approved" && decision !== "declined") return res.status(400).json({ error: "bad_decision" });
  if (body.confirm !== true) return res.status(400).json({ error: "confirm_required" });
  const name = U.clean(body.parent_name, 200);
  if (Array.from(name).length < 2) return res.status(400).json({ error: "name_required" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  // One statement: the link is checked, burned and the decision recorded together.
  const { data, error } = await sb.rpc("pylon_outreach_decide", { token_hash: hashOf(token), decision, decided_name: name });
  if (error) {
    console.error("[pylon-parent] decision not recorded:", error.code || "");
    return res.status(503).json({ error: "storage_unavailable" });
  }
  const row = firstRow(data);
  const id = row && row.outreach_id;
  if (!id) return res.status(404).json({ error: "link_not_active" });
  console.log(`[pylon-parent] outreach ${id} ${decision} through the family's link`);
  res.json({ ok: true, decision });

  // Staff hear which message was decided (never the athlete). Never throws.
  setImmediate(async () => {
    try {
      const { data: o } = await sb.from("pylon_outreach").select("id,request_id,coach_name,program_name").eq("id", id).maybeSingle();
      if (!o) return;
      const a = U.decisionAlert(o, decision, APP_BASE());
      const to = [...staffEmails()];
      push.notifySoon(to, a.push);
      const r = await mailer.sendMail({ to, subject: a.email.subject, text: a.email.text, pool: "pylon" });
      if (!r.sent) console.warn(`[pylon-parent] staff email not sent (${r.reason})`);
    } catch (e) {
      console.warn("[pylon-parent] staff alert failed:", mailer.errorCode(e));
    }
  });
}));

module.exports = router;
module.exports._reset = () => limited.reset();
