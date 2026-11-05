// Stripe for the Subject Medias marketplace. Subject Medias' own Stripe
// account takes the sales (Kyron, Nov 5, 2026), apart from the Creator Club's.
//
//   SM_STRIPE_SECRET_KEY       Subject Medias' secret key (sk_test_… until it goes live)
//   SM_STRIPE_WEBHOOK_SECRET   the signing secret for /api/sm/stripe/webhook
//   SM_STRIPE_LIVE=yes         the only way a live key (sk_live_…) is used
//
// Restricted keys (rk_…) work too. Nothing here falls back to the Creator
// Club's account: without Subject Medias' key, checkout says it isn't open.

"use strict";

const Stripe = require("stripe");

let client = null;
let clientKey = null;
let override = null; // tests

function mode() {
  if (override) return { ok: true, mode: override.mode };
  const key = String(process.env.SM_STRIPE_SECRET_KEY || "").trim();
  if (!key) return { ok: false, error: "stripe_not_configured" };
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
    if (process.env.SM_STRIPE_LIVE !== "yes") return { ok: false, error: "live_key_refused" };
    return { ok: true, key, mode: "live" };
  }
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return { ok: true, key, mode: "test" };
  return { ok: false, error: "stripe_key_unrecognized" };
}

// { stripe, mode } or throws an Error whose .code is the reason.
function stripe() {
  if (override) return override;
  const m = mode();
  if (!m.ok) {
    const e = new Error(m.error);
    e.code = m.error;
    throw e;
  }
  if (!client || clientKey !== m.key) {
    client = new Stripe(m.key, { appInfo: { name: "Subject Medias marketplace" } });
    clientKey = m.key;
  }
  return { stripe: client, mode: m.mode };
}

const HINTS = {
  stripe_not_configured: "Set SM_STRIPE_SECRET_KEY to Subject Medias' Stripe test key on the server.",
  live_key_refused: "A live Stripe key is set, but live payments stay off until SM_STRIPE_LIVE=yes.",
  stripe_key_unrecognized: "SM_STRIPE_SECRET_KEY isn't a Stripe secret key.",
};

function _set(s) {
  override = s;
}

module.exports = { mode, stripe, HINTS, _set };
