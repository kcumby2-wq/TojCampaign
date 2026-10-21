// APNs — notifications to the TOJ iPhone app (the App Store version).
//
// Web push (utils/push.js) covers the Home Screen web app. The native app
// registers with Apple instead and hands the server a device token; this file
// sends to Apple's HTTP/2 API with a token-based key (.p8), so there's no
// certificate to renew.
//
// Settings (Render → Environment):
//   APNS_KEY_ID      the Key ID shown next to the key in Apple's developer site
//   APNS_TEAM_ID     the 10-character Team ID (APPLE_TEAM_ID also works)
//   APNS_KEY_P8      the .p8 file's text (or that text in base64)
//   APNS_BUNDLE_ID   the app's bundle ID (default com.tojcampaign.app)
//
// Payloads carry a title, a line of text and an app link only: never an
// athlete's name, contact or film link (same rule as web push).

"use strict";

const http2 = require("http2");
const crypto = require("crypto");

const ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
const TOKEN_RE = /^[0-9a-f]{64,200}$/;

let origins = { ...ORIGINS }; // tests point these at a local server
let jwtCache = null;
const sessions = new Map();

function config() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID || process.env.APPLE_TEAM_ID;
  let key = process.env.APNS_KEY_P8;
  if (!keyId || !teamId || !key) return null;
  key = String(key).trim();
  if (!/BEGIN PRIVATE KEY/.test(key)) {
    try {
      key = Buffer.from(key, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  key = key.replace(/\\n/g, "\n");
  return { keyId, teamId, key, topic: process.env.APNS_BUNDLE_ID || process.env.IOS_BUNDLE_ID || "com.tojcampaign.app" };
}

function configured() {
  return !!config();
}

// Apple wants a fresh provider token at least hourly and no more than every
// 20 minutes; 50 minutes sits inside both.
function providerToken(cfg, force = false) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && jwtCache && jwtCache.keyId === cfg.keyId && now - jwtCache.iat < 50 * 60) return jwtCache.jwt;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "ES256", kid: cfg.keyId });
  const claims = enc({ iss: cfg.teamId, iat: now });
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key: cfg.key, dsaEncoding: "ieee-p1363" });
  jwtCache = { keyId: cfg.keyId, iat: now, jwt: `${head}.${claims}.${sig.toString("base64url")}` };
  return jwtCache.jwt;
}

function session(origin) {
  let s = sessions.get(origin);
  if (s && !s.closed && !s.destroyed) return s;
  s = http2.connect(origin);
  s.on("error", () => sessions.delete(origin));
  s.on("close", () => sessions.delete(origin));
  s.on("goaway", () => sessions.delete(origin));
  // Don't hold the process open for an idle connection.
  if (typeof s.unref === "function") s.unref();
  sessions.set(origin, s);
  return s;
}

function post(origin, path, headers, body) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = session(origin).request({ ":method": "POST", ":path": path, ...headers });
    } catch (e) {
      sessions.delete(origin);
      return reject(e);
    }
    let status = 0;
    let data = "";
    req.setEncoding("utf8");
    req.setTimeout(15000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => (status = h[":status"]));
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let reason = null;
      try {
        reason = data ? JSON.parse(data).reason || null : null;
      } catch {}
      resolve({ status, reason });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function apsBody(payload) {
  const p = payload || {};
  const aps = { alert: { title: String(p.title || "TOJ").slice(0, 120), body: String(p.body || "").slice(0, 400) }, sound: "default" };
  if (p.tag) aps["thread-id"] = String(p.tag).slice(0, 64);
  if (Number.isInteger(p.badge) && p.badge >= 0) aps.badge = p.badge;
  const url = typeof p.url === "string" && p.url.startsWith("/app/") ? p.url : "/app/#today";
  return JSON.stringify({ aps, url });
}

async function sendOnce(cfg, token, payload, env, forceJwt = false) {
  const origin = origins[env] || origins.production;
  const headers = {
    authorization: `bearer ${providerToken(cfg, forceJwt)}`,
    "apns-topic": cfg.topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
    "content-type": "application/json",
  };
  if (payload && payload.tag) headers["apns-collapse-id"] = String(payload.tag).slice(0, 64);
  return post(origin, `/3/device/${token}`, headers, apsBody(payload));
}

// Send to one device. Tries the environment that last worked (production by
// default), then the other one if Apple says the token belongs there.
// Resolves { env } on success. Throws with statusCode 410 when the token is
// dead (the caller drops it), or the HTTP status otherwise.
async function deliver(sub, payload) {
  const cfg = config();
  if (!cfg) {
    const e = new Error("apns_not_configured");
    e.statusCode = 503;
    throw e;
  }
  const token = String(sub.endpoint || "").replace(/^apns:/, "");
  if (!TOKEN_RE.test(token)) {
    const e = new Error("bad_token");
    e.statusCode = 410;
    throw e;
  }
  const first = sub.apns_env === "sandbox" ? "sandbox" : "production";
  let env = first;
  let r = await sendOnce(cfg, token, payload, env);
  if (r.status === 403 && r.reason === "ExpiredProviderToken") r = await sendOnce(cfg, token, payload, env, true);
  if (r.status === 400 && r.reason === "BadDeviceToken") {
    env = first === "production" ? "sandbox" : "production";
    r = await sendOnce(cfg, token, payload, env);
  }
  if (r.status === 200) return { env };
  const e = new Error(`apns ${r.status} ${r.reason || ""}`.trim());
  e.statusCode = r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered" || r.reason === "DeviceTokenNotForTopic" ? 410 : r.status || 502;
  e.reason = r.reason;
  throw e;
}

function _setOrigins(o) {
  origins = o ? { ...ORIGINS, ...o } : { ...ORIGINS };
  for (const s of sessions.values()) s.close();
  sessions.clear();
  jwtCache = null;
}

module.exports = { deliver, configured, TOKEN_RE, _setOrigins, _apsBody: apsBody };
