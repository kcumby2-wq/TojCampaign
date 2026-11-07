// Stripe for the Pylon pages' checkouts (routes/pylon.js). The account that
// takes Pylon's payments is whichever one these settings name; nothing here
// falls back to the Creator Club's or Subject Medias' account.
//
//   PYLON_STRIPE_SECRET_KEY      that account's secret key, or a restricted key
//                                with Checkout Sessions: write (and Promotion
//                                codes: read, so a creator code can be applied
//                                for the buyer). sk_test_/rk_test_ until live.
//   PYLON_STRIPE_WEBHOOK_SECRET  the signing secret of the webhook endpoint
//                                https://tojcampaign.com/api/pylon/stripe/webhook
//                                (events: checkout.session.completed,
//                                checkout.session.async_payment_succeeded,
//                                customer.subscription.updated and .deleted)
//   PYLON_STRIPE_LIVE=yes        the only way a live key is used
//
// Without a usable key the pages still take requests: people get "we'll send
// a secure payment link", and staff send one. A test key opens checkouts to
// staff signed in on the site only (routes/pylon.js).

"use strict";

const Stripe = require("stripe");

let client = null;
let clientKey = null;
let override = null; // tests

function mode() {
  if (override) return { ok: true, mode: override.mode };
  const key = String(process.env.PYLON_STRIPE_SECRET_KEY || "").trim();
  if (!key) return { ok: false, error: "stripe_not_configured" };
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) {
    if (process.env.PYLON_STRIPE_LIVE !== "yes") return { ok: false, error: "live_key_refused" };
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
    client = new Stripe(m.key, { appInfo: { name: "Pylon pages" }, maxNetworkRetries: 1, timeout: 10000 });
    clientKey = m.key;
  }
  return { stripe: client, mode: m.mode };
}

// The webhook's signature check needs no key of its own: Stripe's library
// does it locally with the signing secret.
function verify(rawBody, signature, secret) {
  return Stripe.webhooks.constructEvent(rawBody, signature, secret);
}

const HINTS = {
  stripe_not_configured: "Set PYLON_STRIPE_SECRET_KEY on the server to start Pylon checkouts. Until then the pages take requests and staff send payment links.",
  live_key_refused: "A live Stripe key is set for Pylon, but live payments stay off until PYLON_STRIPE_LIVE=yes.",
  stripe_key_unrecognized: "PYLON_STRIPE_SECRET_KEY isn't a Stripe secret or restricted key.",
};

function _set(s) {
  override = s;
}

module.exports = { mode, stripe, verify, HINTS, _set };
