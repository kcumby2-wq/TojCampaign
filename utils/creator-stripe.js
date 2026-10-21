// Stripe for the Creator Club — test mode until counsel picks the company
// that holds the platform account (Kyron, Oct 21, 2026).
//
//   CREATOR_STRIPE_SECRET_KEY       the platform account's secret key (sk_test_…)
//   CREATOR_STRIPE_WEBHOOK_SECRET   the signing secret for /api/creators/stripe/webhook
//   CREATOR_STRIPE_LIVE=yes         the only way a live key (sk_live_…) is used;
//                                   set it after counsel signs off, not before
//
// The creator lane uses Stripe Connect: each creator (or, under 18, their
// parent or guardian) has an Express connected account; a sale is a
// destination charge on the platform with the platform's share as the
// application fee, so the creator's share reaches them automatically.

"use strict";

const Stripe = require("stripe");

let client = null;
let clientKey = null;
let override = null; // tests

function mode() {
  if (override) return { ok: true, mode: override.mode };
  const key = String(process.env.CREATOR_STRIPE_SECRET_KEY || "").trim();
  if (!key) return { ok: false, error: "stripe_not_configured" };
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
    if (process.env.CREATOR_STRIPE_LIVE !== "yes") return { ok: false, error: "live_key_refused" };
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
    client = new Stripe(m.key, { appInfo: { name: "TOJ Creator Club" } });
    clientKey = m.key;
  }
  return { stripe: client, mode: m.mode };
}

const HINTS = {
  stripe_not_configured: "Set CREATOR_STRIPE_SECRET_KEY to a Stripe test key on the server.",
  live_key_refused: "A live Stripe key is set, but live payments stay off until counsel picks the company (CREATOR_STRIPE_LIVE=yes).",
  stripe_key_unrecognized: "CREATOR_STRIPE_SECRET_KEY isn't a Stripe secret key.",
};

function _set(s) {
  override = s;
}

module.exports = { mode, stripe, HINTS, _set };
