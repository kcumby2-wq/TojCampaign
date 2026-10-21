// Push API — turn notifications on and off for this device.
//
//   GET  /api/push/key           → the public key the browser subscribes with
//   POST /api/push/subscribe     → { subscription } from PushManager.subscribe(),
//                                  or { apns: { token } } from the iPhone app
//   POST /api/push/unsubscribe   → { endpoint }  (the iPhone app sends "apns:<token>")
//   POST /api/push/test          → send yourself a test notification

"use strict";

const express = require("express");
const T = require("../utils/team");
const P = require("../utils/push");
const { getSupabase } = require("../utils/supabase");
const apns = require("../utils/apns");

const router = express.Router();
const onTeam = T.requireTeam(null, "viewer");

router.get("/key", onTeam, async (_req, res) => {
  try {
    const k = await P.vapidKeys();
    res.json({ publicKey: k.publicKey });
  } catch (e) {
    console.error("[push] key failed:", e.message);
    res.status(503).json({ error: "push_unavailable" });
  }
});

router.post("/subscribe", onTeam, async (req, res) => {
  if (req.body && req.body.apns) return subscribeApns(req, res);
  const sub = (req.body && req.body.subscription) || {};
  const endpoint = String(sub.endpoint || "");
  const p256dh = sub.keys && String(sub.keys.p256dh || "");
  const auth = sub.keys && String(sub.keys.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return res.status(400).json({ error: "invalid_subscription" });
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  const { error } = await sb.from("push_subscriptions").upsert(
    { email: req.team.email, endpoint, p256dh, auth, user_agent: String(req.headers["user-agent"] || "").slice(0, 200), fail_count: 0 },
    { onConflict: "endpoint" }
  );
  if (error) return res.status(500).json({ error: "subscribe_failed" });
  res.json({ ok: true });
});

// The iPhone app: a device token from Apple, hex.
async function subscribeApns(req, res) {
  const token = String((req.body.apns && req.body.apns.token) || "").toLowerCase();
  if (!apns.TOKEN_RE.test(token)) return res.status(400).json({ error: "invalid_subscription" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  const { error } = await sb.from("push_subscriptions").upsert(
    { email: req.team.email, endpoint: `apns:${token}`, kind: "apns", p256dh: null, auth: null, user_agent: String(req.headers["user-agent"] || "").slice(0, 200), fail_count: 0 },
    { onConflict: "endpoint" }
  );
  if (error) return res.status(500).json({ error: "subscribe_failed" });
  // ready=false: the token is kept, but the server has no Apple key yet, so
  // nothing will arrive until APNS_* is set on the server.
  res.json({ ok: true, ready: apns.configured() });
}

router.post("/unsubscribe", onTeam, async (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || "");
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  await sb.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("email", req.team.email);
  res.json({ ok: true });
});

router.post("/test", onTeam, async (req, res) => {
  const r = await P.notify([req.team.email], { title: "TOJ", body: "Notifications are on. You'll hear when a draft or a brief needs you.", url: "/app/#today", tag: "test" });
  res.json({ ok: true, sent: r.sent });
});

module.exports = router;
