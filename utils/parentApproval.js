// Parent-approval links for Recruiting Concierge outreach (migration 013).
//
// A link carries a random 256-bit token. Only its SHA-256 hash is stored, so a
// database read never reveals a working link. Links are one-time and expire.

const crypto = require("crypto");

const LINK_TTL_DAYS = 14;

function newToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

// Tokens are exactly 64 lowercase hex characters; anything else is rejected
// before it reaches the database.
function isWellFormed(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

function expiresAt(now = new Date()) {
  return new Date(now.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function siteBase(req) {
  const env = process.env.PUBLIC_SITE_URL || process.env.BASE_URL;
  if (env) return env.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function approvalUrl(req, token) {
  return `${siteBase(req)}/parent-approval.html?token=${token}`;
}

module.exports = { LINK_TTL_DAYS, newToken, hashToken, isWellFormed, expiresAt, approvalUrl };
