// Subject Medias' own Stripe account for the marketplace (utils/sm-stripe.js):
// which keys it takes, and that it never borrows the Creator Club's.
//
//   node --test tests/sm-stripe.test.js

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const S = require("../utils/sm-stripe");

const saved = { key: process.env.SM_STRIPE_SECRET_KEY, live: process.env.SM_STRIPE_LIVE, creator: process.env.CREATOR_STRIPE_SECRET_KEY };
afterEach(() => {
  for (const [k, v] of [["SM_STRIPE_SECRET_KEY", saved.key], ["SM_STRIPE_LIVE", saved.live], ["CREATOR_STRIPE_SECRET_KEY", saved.creator]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  S._set(null);
});

test("no key: not configured, even with the Creator Club's key set", () => {
  delete process.env.SM_STRIPE_SECRET_KEY;
  process.env.CREATOR_STRIPE_SECRET_KEY = "sk_test_creatorclub";
  assert.deepEqual(S.mode(), { ok: false, error: "stripe_not_configured" });
  assert.throws(() => S.stripe(), (e) => e.code === "stripe_not_configured");
});

test("test keys work; a live key needs SM_STRIPE_LIVE=yes", () => {
  process.env.SM_STRIPE_SECRET_KEY = "sk_test_subjectmedias";
  assert.equal(S.mode().mode, "test");
  process.env.SM_STRIPE_SECRET_KEY = "rk_test_subjectmedias";
  assert.equal(S.mode().mode, "test");
  process.env.SM_STRIPE_SECRET_KEY = "sk_live_subjectmedias";
  delete process.env.SM_STRIPE_LIVE;
  assert.deepEqual(S.mode(), { ok: false, error: "live_key_refused" });
  process.env.SM_STRIPE_LIVE = "true";
  assert.equal(S.mode().error, "live_key_refused", "only the exact word yes");
  process.env.SM_STRIPE_LIVE = "yes";
  assert.equal(S.mode().mode, "live");
});

test("anything else isn't a Stripe secret key", () => {
  process.env.SM_STRIPE_SECRET_KEY = "pk_test_publishable";
  assert.equal(S.mode().error, "stripe_key_unrecognized");
  assert.ok(S.HINTS.stripe_key_unrecognized.includes("SM_STRIPE_SECRET_KEY"));
});

test("a test key makes a client for Subject Medias' account", () => {
  process.env.SM_STRIPE_SECRET_KEY = "sk_test_subjectmedias";
  const s = S.stripe();
  assert.equal(s.mode, "test");
  assert.equal(typeof s.stripe.checkout.sessions.create, "function");
  assert.equal(typeof s.stripe.webhooks.constructEvent, "function");
  assert.equal(S.stripe().stripe, s.stripe, "one client per key");
});
