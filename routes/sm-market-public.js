"use strict";
// The Subject Medias marketplace, the families' side, on subjectmedias.com/m/
// (the site's vercel.json rewrites /m/* here). Pages, not an API, and they
// work without JavaScript. The rules of who sees what are utils/sm-market.js.
//
//   GET  /m/confirm/:token          the confirm button (a mail scanner's visit changes nothing)
//   POST /m/confirm/:token          confirms a choice; shows and emails the family link
//   GET  /m/f/:token                a family's page: their athlete's clips and photos
//   POST /m/f/:token/checkout       the ones they picked, to Stripe Checkout
//   GET  /m/o/:token                an order: downloads once paid (?session_id= asks Stripe straight away)
//   GET  /m/:code                   the event page, with ?k=<access code> (otherwise how to get
//                                   in); &team=<id>&jersey=<n> shows that athlete's
//   POST /m/:code/checkout          the ones picked there (with the code), to Stripe Checkout
//   GET  /m/:code/consent           the QR form: a parent or guardian's choice
//   POST /m/:code/consent           saves it and emails a link to confirm (a keep-out counts at once)
//   GET  /m/:code/consent/sent      what happens next
//   POST /api/sm/stripe/webhook     Subject Medias' Stripe → orders (stripeWebhook, below)
//
// Payments go to Subject Medias' own Stripe account (utils/sm-stripe.js), in
// test mode until SM_STRIPE_LIVE=yes. Its webhook hands checkouts whose
// metadata.kind is "sm_market" to paid() and expired(), and refunds to
// refunded().

const crypto = require("crypto");
const express = require("express");
const M = require("../utils/sm-market");
const P = require("../utils/sm-market-page");
const S = require("../utils/sm-stripe");
const mailer = require("../utils/mailer");
const push = require("../utils/push");
const { isEmail } = require("../utils/sm-bookings");
const { getSupabase } = require("../utils/supabase");

const router = express.Router();
const idOk = (id) => M.UUID.test(String(id || ""));
const now = () => new Date().toISOString();
const MAX_ITEMS = 50;
const MAX_ROSTER = 600; // athletes a form can add to one event, so a bot can't fill it

// ── Plumbing ─────────────────────────────────────────────────────────────
function nonce() {
  return crypto.randomBytes(16).toString("base64");
}
function storageHost() {
  try {
    return new URL(String(process.env.SUPABASE_URL || "")).origin;
  } catch (e) {
    return "";
  }
}
function headers(res, n) {
  const store = storageHost();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  // Links here carry tokens: no address leaves the page in a Referer.
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:${store ? " " + store : ""}; media-src${store ? " " + store : " 'none'"}; script-src 'nonce-${n}'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'`
  );
}
function send(res, status, render) {
  const n = nonce();
  headers(res, n);
  res.status(status).send(render(n));
}
const message = (res, status, title, text, link, linkText) => send(res, status, (nonce) => P.messagePage({ nonce, title, text, link, linkText }));
const notFound = (res) => message(res, 404, "Not found", "This link doesn't go anywhere. Check it against the QR code or the email you were sent.");

const page = (fn) => async (req, res) => {
  const sb = getSupabase();
  if (!sb) return message(res, 503, "Back soon", "This page can't load right now. Try again in a few minutes.");
  try {
    await fn(req, res, sb);
  } catch (e) {
    const code = e && e.db && e.db.code;
    if (code === "42P01" || code === "PGRST205") return message(res, 503, "Not open yet", "Clips and photos from our events aren't open here yet.");
    console.error("[sm-market-public] failed:", e && e.message);
    if (!res.headersSent) message(res, 500, "Something went wrong", "Try again in a minute. If it keeps happening, email us.");
  }
};
async function run(q) {
  const { data, error } = await q;
  if (error) throw Object.assign(new Error(error.message || "storage_error"), { db: error });
  return data;
}

// Tries, kept in memory for a while: [how many, minutes]. Whatever they're
// keyed on goes through an HMAC with a key made fresh each start, and is never
// stored or logged. Behind Vercel the first X-Forwarded-For entry is the
// visitor, but someone calling the server directly can set it themselves, so
// the QR form is also capped per address it emails, per athlete, and in all.
// A venue's shared Wi-Fi stays well under the per-visitor limits.
const SALT = crypto.randomBytes(32);
const buckets = new Map(); // per visitor: cleared if it grows huge
const caps = new Map(); // per address, athlete, and in all: never cleared early
const CAPS = new Set(["to", "toDay", "athlete", "mail", "writes"]);
// Per visitor, per 10 minutes. Families on one venue's Wi-Fi count as one
// visitor, so these leave room for a busy check-in or a crowd after the
// game; the caps per mailbox, athlete and event are what bound abuse.
const LIMITS = {
  view: [2000, 10],
  consent: [200, 10],
  confirm: [300, 10],
  checkout: [100, 10],
  to: [3, 60], // emails from the form to one mailbox, an hour
  toDay: [8, 1440], // and a day
  athlete: [12, 60], // emails about one athlete, an hour
  mail: [200, 60], // emails from one event's form, an hour
  writes: [3000, 60], // answers saved for one event, an hour: a flood breaker
};
// A visitor is their whole X-Forwarded-For chain. Through the site's rewrite
// it holds the visitor's own address and the hop to Render; Render adds the
// address that reached it. A caller who goes to Render directly can write
// anything in the header, but Render still adds their real address, so they
// can't pass for someone else and use up that person's tries (a venue's
// Wi-Fi, say). They can dodge these limits by changing it, which is why the
// form's emails are also capped per mailbox, per athlete and per event.
const visitor = (req) => String(req.headers["x-forwarded-for"] || "").replace(/\s+/g, "").toLowerCase().slice(0, 512) || req.socket.remoteAddress || "";
const allowed = (req, kind) => hit(kind, visitor(req));
function hit(kind, id) {
  const [max, minutes] = LIMITS[kind];
  const map = CAPS.has(kind) ? caps : buckets;
  const key = kind + ":" + crypto.createHmac("sha256", SALT).update(String(id)).digest("base64").slice(0, 22);
  const t = Date.now();
  const b = map.get(key);
  if (!b || t > b.reset) {
    if (map.size > 50000) {
      for (const [k, v] of map) if (t > v.reset) map.delete(k);
      if (map === buckets && map.size > 50000) map.clear();
    }
    map.set(key, { n: 1, reset: t + minutes * 60000 });
    return true;
  }
  b.n++;
  return b.n <= max;
}
// Whether every one of these is under its limit, without counting anything;
// then count them all (only once it's decided).
function within(list) {
  const t = Date.now();
  return list.every(([kind, id]) => {
    const map = CAPS.has(kind) ? caps : buckets;
    const b = map.get(kind + ":" + crypto.createHmac("sha256", SALT).update(String(id)).digest("base64").slice(0, 22));
    return !b || t > b.reset || b.n < LIMITS[kind][0];
  });
}
const count = (list) => list.forEach(([kind, id]) => hit(kind, id));
const slowDown = (res) => message(res, 429, "Too many tries", "Wait a few minutes, then try again.");

const field = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ── What may be shown ────────────────────────────────────────────────────
async function eventByCode(sb, code) {
  const c = M.codeOf(code);
  if (!c) return null;
  return run(sb.from("sm_market_events").select("*").eq("code", c).maybeSingle());
}

// Each athlete's level, from their roster row and every consent for them.
async function levelsOf(sb, ids) {
  if (!ids.length) return new Map();
  const [athletes, consents] = await Promise.all([
    run(sb.from("sm_market_athletes").select("id,keep_out").in("id", ids)),
    run(sb.from("sm_market_consents").select("athlete_id,level,under_13,confirmed_at").in("athlete_id", ids)),
  ]);
  const levels = new Map(ids.map((id) => [id, "none"]));
  for (const a of athletes || []) levels.set(a.id, M.effectiveLevel(a, consents || []));
  return levels;
}

// The approved clips and photos an athlete is confirmed in, that this way in
// may show: "event" (team and number) or "family" (their own link).
async function itemsFor(sb, ev, athleteId, access) {
  const mine = await run(sb.from("sm_market_tags").select("media_id").eq("athlete_id", athleteId).eq("confirmed", true));
  const ids = [...new Set((mine || []).map((t) => t.media_id))];
  if (!ids.length) return [];
  const media = ((await run(sb.from("sm_market_media").select("*").in("id", ids).eq("status", "approved"))) || []).filter((m) => m.event_id === ev.id);
  if (!media.length) return [];
  const tags = (await run(sb.from("sm_market_tags").select("media_id,athlete_id,confirmed").in("media_id", media.map((m) => m.id)).eq("confirmed", true))) || [];
  const levels = await levelsOf(sb, [...new Set(tags.map((t) => t.athlete_id))]);
  return media
    .filter((m) => M.itemAllowed(m, { access, forAthlete: athleteId, tags, levels }))
    .sort((a, b) => String(a.approved_at || a.created_at).localeCompare(String(b.approved_at || b.created_at)));
}

// Short-lived links to the watermarked previews and posters.
async function withPreviews(sb, items) {
  const keys = items.flatMap((m) => [m.preview_key, m.poster_key]).filter(Boolean);
  const signed = new Map();
  if (keys.length) {
    const { data } = await sb.storage.from(M.BUCKET).createSignedUrls(keys, 3600);
    for (const s of data || []) if (s && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  return items.map((m) => ({ id: m.id, kind: m.kind, duration_ms: m.duration_ms, preview_url: signed.get(m.preview_key) || null, poster_url: signed.get(m.poster_key) || null }));
}

// ── Checkout ─────────────────────────────────────────────────────────────
// back: where "Back" goes on our pages. A family's page carries its token, so
// Stripe's cancel link goes to the order instead: Stripe keeps that address.
async function checkout(req, res, sb, { ev, athleteId, access, back, cancelToOrder = false }) {
  if (!allowed(req, "checkout")) return slowDown(res);
  const want = [...new Set([].concat((req.body && req.body.item) || []).map(String))].filter(idOk).slice(0, 200);
  const pick = (await itemsFor(sb, ev, athleteId, access)).filter((m) => want.includes(m.id)).slice(0, MAX_ITEMS);
  if (!pick.length) return res.redirect(303, back);
  let s;
  try {
    s = S.stripe();
  } catch (e) {
    return message(res, 503, "Checkout isn't open yet", "We're still switching payments on. Try again soon, or email us and we'll sort it out.");
  }
  const price = (m) => M.priceOf(ev, m.kind);
  const amount = pick.reduce((sum, m) => sum + price(m), 0);
  const tok = M.newToken();
  const order = await run(sb.from("sm_market_orders").insert({ event_id: ev.id, status: "pending", amount_cents: amount, token_hash: tok.hash, mode: s.mode }).select().single());
  await run(sb.from("sm_market_order_items").insert(pick.map((m) => ({ order_id: order.id, media_id: m.id, price_cents: price(m) }))));
  const clips = pick.filter((m) => m.kind === "clip").length;
  const photos = pick.length - clips;
  const line = (n, kind) => ({ quantity: n, price_data: { currency: "usd", unit_amount: M.priceOf(ev, kind), product_data: { name: `${kind === "clip" ? "Clip" : "Photo"} from ${ev.name}`.slice(0, 120) } } });
  let session;
  try {
    session = await s.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [clips ? line(clips, "clip") : null, photos ? line(photos, "photo") : null].filter(Boolean),
      client_reference_id: order.id,
      // The order link's token rides along so the webhook can email it; only its hash is in our database.
      metadata: { kind: "sm_market", order_id: order.id, order_token: tok.token },
      payment_intent_data: { metadata: { kind: "sm_market", order_id: order.id } },
      success_url: `${M.linkTo.order(tok.token)}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelToOrder ? `${M.linkTo.order(tok.token)}?cancelled=1` : M.siteBase() + back,
      // Cards (and the wallets that use them) only, so paid means paid at once.
      payment_method_types: ["card"],
      // Short-lived: a checkout left open doesn't hold its clips for a day.
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    });
  } catch (e) {
    console.error("[sm-market-public] checkout didn't start:", e && (e.code || e.type), e && e.message);
    await sb.from("sm_market_orders").update({ status: "expired", updated_at: now() }).eq("id", order.id);
    return message(res, 502, "Checkout didn't start", "Nothing was charged. Try again in a minute.", back, "Back to the clips");
  }
  await run(sb.from("sm_market_orders").update({ stripe_session_id: session.id, updated_at: now() }).eq("id", order.id));
  res.redirect(303, session.url);
}

// The order link, by email, once: whoever claims emailed_at first sends it.
// A failed send gives the claim back, so the next try (Stripe's retry, or the
// buyer opening the order) sends it.
async function sendOrderLink(sb, order, ev, token) {
  if (!order.email || !ev || !token) return { sent: false, reason: "no_email" };
  const claimed = await run(sb.from("sm_market_orders").update({ emailed_at: now() }).eq("id", order.id).is("emailed_at", null).select("id"));
  if (!(claimed || []).length) return { sent: true, reason: "already" };
  let r;
  try {
    // Someone paid for these: their link goes even when the day's mail budget is nearly spent.
    r = await mailer.sendMail({ to: order.email, ...M.orderEmail(ev, order, M.linkTo.order(token)), critical: true, pool: "market" });
  } catch (e) {
    console.warn("[sm-market-public] order email failed:", mailer.errorCode(e));
    r = { sent: false, reason: "send_failed" };
  }
  if (!r || !r.sent) await sb.from("sm_market_orders").update({ emailed_at: null }).eq("id", order.id);
  return r || { sent: false, reason: "send_failed" };
}

// A paid checkout: the order is paid, the buyer gets their link (once), staff
// get a push. From the webhook, or from the order page asking Stripe.
async function markPaid(sb, ses, { token = null } = {}) {
  const md = ses.metadata || {};
  if (md.kind !== "sm_market" || !idOk(md.order_id) || ses.payment_status !== "paid") return { ok: false, reason: "not_ours" };
  const order = await run(sb.from("sm_market_orders").select("*").eq("id", md.order_id).maybeSingle());
  if (!order) return { ok: false, reason: "no_order" };
  if (order.stripe_session_id && order.stripe_session_id !== ses.id) return { ok: false, reason: "other_session" };
  if (Number(ses.amount_total) !== order.amount_cents) {
    console.error(`[sm-market-public] order ${order.id}: Stripe took ${ses.amount_total}, the order says ${order.amount_cents}`);
    return { ok: false, reason: "amount_mismatch" };
  }
  const cd = ses.customer_details || {};
  const email = cd.email && isEmail(String(cd.email).trim().toLowerCase()) ? String(cd.email).trim().toLowerCase().slice(0, 200) : order.email || null;
  const pi = typeof ses.payment_intent === "string" && /^pi_[A-Za-z0-9_]{8,200}$/.test(ses.payment_intent) ? ses.payment_intent : null;
  const at = now();
  const flipped = await run(
    sb
      .from("sm_market_orders")
      .update({ status: "paid", paid_at: at, stripe_session_id: ses.id, stripe_payment_intent: pi, email, mode: ses.livemode ? "live" : "test", updated_at: at })
      .eq("id", order.id)
      .eq("status", "pending")
      .select("id")
  );
  const ev = await run(sb.from("sm_market_events").select("id,name,code").eq("id", order.event_id).maybeSingle());
  const t = token || (M.tokenOk(md.order_token) && M.hashToken(md.order_token) === order.token_hash ? md.order_token : null);
  const mail = await sendOrderLink(sb, { ...order, email }, ev, t);
  if ((flipped || []).length && ev) {
    const n = (await run(sb.from("sm_market_order_items").select("media_id").eq("order_id", order.id))) || [];
    push.notifySoon(push.teamEmails("member", "market"), {
      title: "New marketplace sale",
      body: `${ev.name}: ${n.length} item${n.length === 1 ? "" : "s"}, ${M.money(order.amount_cents)}${ses.livemode ? "" : " (test)"}`,
      url: `/app/#market/${ev.id}`,
      tag: `market-sale-${ev.id}`,
    });
  }
  return { ok: true, flipped: (flipped || []).length > 0, mail };
}

// From the Stripe webhook. If the order email didn't go for a reason a retry
// can fix, it fails, so Stripe sends the event again (the rest is idempotent).
async function paid(ses) {
  const sb = getSupabase();
  if (!sb) throw new Error("storage_unavailable");
  const r = await markPaid(sb, ses);
  if (r.ok && r.mail && !r.mail.sent && r.mail.reason === "send_failed") throw new Error("order_email_failed");
  return r;
}

// A refund in Stripe: once the whole payment is back, the order's downloads close.
async function refunded(charge) {
  const sb = getSupabase();
  if (!sb || !charge) return { ok: false };
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent && charge.payment_intent.id;
  if (!pi || !/^pi_[A-Za-z0-9_]{8,200}$/.test(pi)) return { ok: false, reason: "no_payment" };
  if (!(charge.refunded === true || Number(charge.amount_refunded) >= Number(charge.amount))) return { ok: false, reason: "partial" };
  const done = await run(sb.from("sm_market_orders").update({ status: "refunded", updated_at: now() }).eq("stripe_payment_intent", pi).eq("status", "paid").select("id"));
  return { ok: true, refunded: (done || []).length };
}
async function expired(ses) {
  const sb = getSupabase();
  const md = (ses && ses.metadata) || {};
  if (!sb || md.kind !== "sm_market" || !idOk(md.order_id)) return { ok: false };
  await run(sb.from("sm_market_orders").update({ status: "expired", updated_at: now() }).eq("id", md.order_id).eq("status", "pending"));
  return { ok: true };
}

// ── Confirming a choice ──────────────────────────────────────────────────
async function consentByConfirm(sb, token) {
  if (!M.tokenOk(token)) return null;
  const c = await run(sb.from("sm_market_consents").select("*").eq("confirm_hash", M.hashToken(token)).maybeSingle());
  if (!c) return null;
  const a = await run(sb.from("sm_market_athletes").select("id,event_id,team_id,jersey").eq("id", c.athlete_id).maybeSingle());
  if (!a) return null;
  const [ev, team] = await Promise.all([
    run(sb.from("sm_market_events").select("*").eq("id", a.event_id).maybeSingle()),
    run(sb.from("sm_market_teams").select("id,name").eq("id", a.team_id).maybeSingle()),
  ]);
  return ev && team ? { c, a, ev, team } : null;
}
const usedLink = (res) => message(res, 404, "Link already used", "This confirm link has been used, or a newer choice replaced it. Your family link is in the email we sent when you confirmed.");

// What a confirm link confirms: the pending change if there is one, or the answer itself.
const asked = (c) =>
  c.pending_level
    ? { level: c.pending_level, age_band: M.AGE_BANDS.includes(c.pending_age_band) ? c.pending_age_band : c.pending_under_13 === false ? "13_15" : "u13" }
    : { level: c.level, age_band: M.bandOf(c) };

router.get("/confirm/:token", page(async (req, res, sb) => {
  if (!allowed(req, "confirm")) return slowDown(res);
  const found = await consentByConfirm(sb, req.params.token);
  if (!found) return usedLink(res);
  const want = asked(found.c);
  send(res, 200, (nonce) => P.confirmPage({ nonce, event: found.ev, team: found.team.name, jersey: found.a.jersey, level: want.level, ageBand: want.age_band, token: req.params.token }));
}));

// Confirming applies the answer, and gives the family a fresh family link
// (the old one stops working), by email and on the page.
router.post("/confirm/:token", page(async (req, res, sb) => {
  if (!allowed(req, "confirm")) return slowDown(res);
  const found = await consentByConfirm(sb, req.params.token);
  if (!found) return usedLink(res);
  const want = asked(found.c);
  const fam = want.level === "out" ? null : M.newToken();
  const at = now();
  const done = await run(
    sb
      .from("sm_market_consents")
      .update({ level: want.level, under_13: want.age_band === "u13", age_band: want.age_band, pending_level: null, pending_under_13: null, pending_age_band: null, confirmed_at: at, confirm_hash: null, family_hash: fam ? fam.hash : null, source: "qr", recorded_by: null, updated_at: at })
      .eq("id", found.c.id)
      .eq("confirm_hash", M.hashToken(req.params.token))
      .select("id")
  );
  if (!(done || []).length) return usedLink(res);
  let mailed = false;
  const link = fam ? M.linkTo.family(fam.token) : null;
  if (link) {
    try {
      mailed = !!(await mailer.sendMail({ to: found.c.email, ...M.familyEmail(found.ev, found.team.name, found.a.jersey, want.level, link), pool: "market" })).sent;
    } catch (e) {
      console.warn("[sm-market-public] family link email failed:", mailer.errorCode(e));
    }
  }
  send(res, 200, (nonce) => P.confirmPage({ nonce, event: found.ev, team: found.team.name, jersey: found.a.jersey, level: want.level, ageBand: want.age_band, done: true, familyLink: link, mailed }));
}));

// ── A family's page ──────────────────────────────────────────────────────
async function family(sb, token) {
  if (!M.tokenOk(token)) return null;
  const c = await run(sb.from("sm_market_consents").select("id,athlete_id,level,confirmed_at").eq("family_hash", M.hashToken(token)).maybeSingle());
  if (!c || !c.confirmed_at) return null;
  const a = await run(sb.from("sm_market_athletes").select("id,event_id,team_id,jersey,keep_out").eq("id", c.athlete_id).maybeSingle());
  if (!a) return null;
  const [ev, team, levels] = await Promise.all([
    run(sb.from("sm_market_events").select("*").eq("id", a.event_id).maybeSingle()),
    run(sb.from("sm_market_teams").select("id,name").eq("id", a.team_id).maybeSingle()),
    levelsOf(sb, [a.id]),
  ]);
  return ev && team ? { a, ev, team, level: levels.get(a.id) || "none" } : null;
}

router.get("/f/:token", page(async (req, res, sb) => {
  if (!allowed(req, "view")) return slowDown(res);
  const f = await family(sb, req.params.token);
  if (!f) return notFound(res);
  const open = f.ev.status !== "draft" && M.levelAtLeast(f.level, "family");
  const items = open ? await withPreviews(sb, await itemsFor(sb, f.ev, f.a.id, "family")) : [];
  // The clips page's way in, without its access code: anyone can get a family
  // link (by answering the form for a number), so it mustn't hand the code out.
  const eventLink = open ? gatePath(f.ev) : "";
  send(res, 200, (nonce) => P.familyPage({ nonce, event: f.ev, team: f.team.name, jersey: f.a.jersey, level: f.level, items, token: req.params.token, eventLink }));
}));

router.post("/f/:token/checkout", page(async (req, res, sb) => {
  const f = await family(sb, req.params.token);
  if (!f || f.ev.status === "draft" || !M.levelAtLeast(f.level, "family")) return notFound(res);
  await checkout(req, res, sb, { ev: f.ev, athleteId: f.a.id, access: "family", back: `/m/f/${req.params.token}`, cancelToOrder: true });
}));

// ── An order ─────────────────────────────────────────────────────────────
router.get("/o/:token", page(async (req, res, sb) => {
  if (!allowed(req, "view")) return slowDown(res);
  const token = req.params.token;
  if (!M.tokenOk(token)) return notFound(res);
  let order = await run(sb.from("sm_market_orders").select("*").eq("token_hash", M.hashToken(token)).maybeSingle());
  if (!order) return notFound(res);
  const ev = await run(sb.from("sm_market_events").select("*").eq("id", order.event_id).maybeSingle());
  if (!ev) return notFound(res);
  // Back from Stripe before the webhook: ask Stripe ourselves.
  const sid = typeof req.query.session_id === "string" ? req.query.session_id : "";
  if (order.status === "pending" && order.stripe_session_id && sid === order.stripe_session_id) {
    try {
      const ses = await S.stripe().stripe.checkout.sessions.retrieve(order.stripe_session_id);
      if (ses && ses.payment_status === "paid") await markPaid(sb, ses, { token });
      else if (ses && ses.status === "expired") await run(sb.from("sm_market_orders").update({ status: "expired", updated_at: now() }).eq("id", order.id).eq("status", "pending"));
    } catch (e) {
      console.warn("[sm-market-public] Stripe check failed:", e && e.message);
    }
    order = await run(sb.from("sm_market_orders").select("*").eq("id", order.id).single());
  }
  // Back to the clips page's way in. Never with the access code: an order can
  // start from a family link, and anyone can get one of those.
  const back = gatePath(ev);
  if (order.status === "pending") {
    // Back from Stripe's "back" link: nothing was paid.
    if (req.query.cancelled === "1") return send(res, 200, (nonce) => P.orderPage({ nonce, event: ev, order, state: "cancelled", backTo: back }));
    const fresh = Date.now() - Date.parse(order.created_at || 0) < 30 * 60 * 1000;
    if (!fresh) return message(res, 200, "Payment not seen", "We haven't seen a payment for this order. If you were charged, email us and we'll send your downloads.", back, "Back to the clips");
    return send(res, 200, (nonce) => P.orderPage({ nonce, event: ev, order, state: "pending" }));
  }
  if (order.status !== "paid") return send(res, 200, (nonce) => P.orderPage({ nonce, event: ev, order, state: order.status, backTo: back }));
  // Paid, but the link never reached them (email was down): try again now.
  if (!order.emailed_at && order.email) {
    const r = await sendOrderLink(sb, order, ev, token);
    if (r.sent) order = { ...order, emailed_at: order.emailed_at || now() };
  }
  const lines = (await run(sb.from("sm_market_order_items").select("media_id,price_cents").eq("order_id", order.id))) || [];
  const ids = lines.map((l) => l.media_id);
  const media = ids.length ? (await run(sb.from("sm_market_media").select("*").in("id", ids))) || [] : [];
  const tags = ids.length ? (await run(sb.from("sm_market_tags").select("media_id,athlete_id,confirmed").in("media_id", ids).eq("confirmed", true))) || [] : [];
  const levels = await levelsOf(sb, [...new Set(tags.map((t) => t.athlete_id))]);
  const posters = await withPreviews(sb, media);
  const items = [];
  for (const id of ids) {
    const m = media.find((x) => x.id === id);
    if (!m) continue;
    // A family's keep-out beats a sale: that file's download closes.
    const takenDown = M.itemAthletes(m, tags).some((a) => levels.get(a) === "out");
    let download_url = null;
    if (!takenDown) {
      const { data } = await sb.storage.from(M.BUCKET).createSignedUrl(m.object_key, 3600, { download: M.downloadName(ev, m) });
      download_url = data && data.signedUrl ? data.signedUrl : null;
    }
    const p = posters.find((x) => x.id === id) || {};
    items.push({ id, kind: m.kind, taken_down: takenDown || !download_url, download_url, poster_url: p.poster_url || null });
  }
  send(res, 200, (nonce) => P.orderPage({ nonce, event: ev, order, items, state: "paid" }));
}));

// ── The event page ───────────────────────────────────────────────────────
// An access code tried on the clips page or its checkout: "ok", "wrong" or
// "none" (no code given). A code is 8 characters from 32, about a trillion
// codes, so it can't be guessed in practice, and a right code always opens the
// page. There's no limit on wrong ones: a limit tied to an address could be
// filled by someone else, or by families scanning an old QR after the code
// changed, and then lock a venue's families out, right code and all.
function keyCheck(given, ev) {
  if (M.viewKeyMatches(given, ev)) return "ok";
  return typeof given === "string" && given.trim() !== "" ? "wrong" : "none";
}

// The clips page with its access code: only for someone who just used it.
const clipsPath = (ev, extra = "") => `/m/${ev.code}${M.VIEW_KEY.test(String(ev.view_key || "")) ? `?k=${ev.view_key}${extra ? "&" + extra : ""}` : extra ? "?" + extra : ""}`;
// The clips page's way in, where it asks for the code.
const gatePath = (ev) => `/m/${ev.code}`;

async function teamsOf(sb, ev) {
  return (await run(sb.from("sm_market_teams").select("id,name").eq("event_id", ev.id).order("name", { ascending: true }))) || [];
}
async function athleteAt(sb, ev, teamId, jersey) {
  const rows = await run(sb.from("sm_market_athletes").select("id,event_id,team_id,jersey").eq("team_id", teamId).eq("jersey", jersey).limit(1));
  const a = (rows || [])[0];
  return a && a.event_id === ev.id ? a : null;
}

router.get("/:code", page(async (req, res, sb) => {
  if (!allowed(req, "view")) return slowDown(res);
  const ev = await eventByCode(sb, req.params.code);
  if (!ev) return notFound(res);
  const q = req.query || {};
  // The clips are for the families who were there: the access code from
  // check-in (in the clips link, or typed in) opens the page.
  const k = keyCheck(q.k, ev);
  if (k !== "ok") {
    return send(res, k === "wrong" ? 403 : 200, (nonce) => P.eventGatePage({ nonce, event: ev, error: k === "wrong" ? "That code doesn't match this event. Check it and try again." : "" }));
  }
  const key = ev.view_key;
  const teams = await teamsOf(sb, ev);
  if (!q.team && !q.jersey) return send(res, 200, (nonce) => P.eventPage({ nonce, event: ev, teams, key }));
  const team = teams.find((t) => t.id === q.team) || null;
  const jersey = M.jerseyOf(q.jersey);
  if (ev.status === "draft") return send(res, 200, (nonce) => P.eventPage({ nonce, event: ev, teams, key }));
  if (!team || !jersey) {
    const error = !team ? "Pick a team." : "Use the jersey number only, like 7 or 23.";
    return send(res, 400, (nonce) => P.eventPage({ nonce, event: ev, teams, key, team, jersey: field(q.jersey, 4), error }));
  }
  const a = await athleteAt(sb, ev, team.id, jersey);
  const items = a ? await withPreviews(sb, await itemsFor(sb, ev, a.id, "event")) : [];
  send(res, 200, (nonce) => P.eventPage({ nonce, event: ev, teams, key, team, jersey, items }));
}));

router.post("/:code/checkout", page(async (req, res, sb) => {
  if (!allowed(req, "view")) return slowDown(res);
  const ev = await eventByCode(sb, req.params.code);
  if (!ev || ev.status === "draft") return notFound(res);
  const b = req.body || {};
  // The same code as the page it came from, or back to the way in.
  if (keyCheck(b.k, ev) !== "ok") return res.redirect(303, gatePath(ev));
  const teams = await teamsOf(sb, ev);
  const team = teams.find((t) => t.id === b.team);
  const jersey = M.jerseyOf(b.jersey);
  const a = team && jersey ? await athleteAt(sb, ev, team.id, jersey) : null;
  if (!a) return res.redirect(303, clipsPath(ev));
  await checkout(req, res, sb, { ev, athleteId: a.id, access: "event", back: clipsPath(ev, `team=${encodeURIComponent(team.id)}&jersey=${jersey}`) });
}));

// ── The QR form ──────────────────────────────────────────────────────────
router.get("/:code/consent", page(async (req, res, sb) => {
  if (!allowed(req, "view")) return slowDown(res);
  const ev = await eventByCode(sb, req.params.code);
  if (!ev) return notFound(res);
  const teams = await teamsOf(sb, ev);
  send(res, 200, (nonce) => P.consentPage({ nonce, event: ev, teams }));
}));

router.get("/:code/consent/sent", page(async (req, res, sb) => {
  const ev = await eventByCode(sb, req.params.code);
  if (!ev) return notFound(res);
  const k = req.query.k === "out" || req.query.k === "now" ? req.query.k : "";
  send(res, 200, (nonce) => P.consentSentPage({ nonce, event: ev, kept: k === "out", now: k === "now", mailed: req.query.m === "1" }));
}));

router.post("/:code/consent", page(async (req, res, sb) => {
  const ev = await eventByCode(sb, req.params.code);
  if (!ev) return notFound(res);
  const b = req.body && typeof req.body === "object" ? req.body : {};
  // The field people can't see: a bot filled it. It gets the usual answer.
  if (field(b.sm_trap)) return res.redirect(303, `/m/${ev.code}/consent/sent?m=1`);
  const teams = await teamsOf(sb, ev);
  const values = { team_id: field(b.team_id, 40), jersey: field(b.jersey, 4), email: field(b.email, 200), level: field(b.level, 10), age: field(b.age, 8), who: field(b.who, 10) };
  const { errors, value } = M.consentInput(values);
  if (value.team_id && !teams.some((t) => t.id === value.team_id)) errors.push("team_id");
  const form = (status, formError = "") => send(res, status, (nonce) => P.consentPage({ nonce, event: ev, teams, values, errors, formError }));
  if (errors.length) {
    const u13Level = errors.includes("level") && values.age === "u13" && (values.level === "sell" || values.level === "public");
    const minorSelf = errors.includes("who") && values.who === "self";
    const formError = u13Level
      ? "For an athlete 12 or younger, choose Family only or Keep them out."
      : minorSelf
        ? "An athlete under 18 can't answer for themselves. Ask a parent or guardian to fill this in, or choose Keep them out."
        : errors.length === 1 && errors[0] === "who"
          ? "Say who's answering: a parent or legal guardian, or the athlete as an adult."
          : "";
    return form(400, formError);
  }
  // Only a flood stops the form outright; a keep-out gets through every other limit.
  if (!within([["writes", ev.id]])) return message(res, 429, "Too many tries", "The form is very busy right now. Ask our crew to record your choice, or try again later.");
  if (value.level !== "out" && !allowed(req, "consent")) return slowDown(res);

  // The number may not be on the roster yet: the guardian's answer adds it.
  let a = await athleteAt(sb, ev, value.team_id, value.jersey);
  if (!a) {
    const count0 = (await run(sb.from("sm_market_athletes").select("id").eq("event_id", ev.id).limit(MAX_ROSTER + 1))) || [];
    if (count0.length > MAX_ROSTER) return form(409, "We can't add more numbers to this event online. Ask our crew, or email us.");
    const { error } = await sb.from("sm_market_athletes").insert({ event_id: ev.id, team_id: value.team_id, jersey: value.jersey });
    if (error && error.code !== "23505") throw Object.assign(new Error(error.message), { db: error });
    a = await athleteAt(sb, ev, value.team_id, value.jersey);
    if (!a) throw new Error("athlete_not_saved");
  }

  // The form emails whatever address is typed in, so its emails are capped
  // per mailbox, per athlete and per event, whatever the visitor's address
  // says. An answer that counts now (more careful, or a keep-out) is saved
  // even past the caps, just without its note. One that needs its email to
  // count isn't saved when the email can't go.
  const capList = [["to", M.mailboxOf(value.email)], ["toDay", M.mailboxOf(value.email)], ["athlete", a.id], ["mail", ev.id]];
  const mayEmail = within(capList);

  // Saved only if their answer is still as it was read, so two answers at
  // once can't undo each other (a keep-out landing mid-way is never lost).
  const at = now();
  let plan = null;
  for (let i = 0; i < 4 && !plan; i++) {
    const was = await run(sb.from("sm_market_consents").select("*").eq("athlete_id", a.id).eq("email", value.email).maybeSingle());
    const p = M.answerPlan(was, value, at);
    if (p.tok && !mayEmail) return message(res, 429, "Too many tries", "That's a lot of answers for this athlete or this email. Try again later, or ask our crew to record your choice.");
    if (!was) {
      const { error } = await sb.from("sm_market_consents").insert({ athlete_id: a.id, email: value.email, ...p.write, updated_at: at });
      if (!error) plan = p;
      else if (error.code !== "23505") throw Object.assign(new Error(error.message), { db: error });
      continue;
    }
    let q = sb.from("sm_market_consents").update({ ...p.write, updated_at: at }).eq("id", was.id).eq("level", was.level).eq("under_13", was.under_13);
    q = was.age_band ? q.eq("age_band", was.age_band) : q.is("age_band", null);
    q = was.confirm_hash ? q.eq("confirm_hash", was.confirm_hash) : q.is("confirm_hash", null);
    q = was.confirmed_at ? q.eq("confirmed_at", was.confirmed_at) : q.is("confirmed_at", null);
    if (((await run(q.select("id"))) || []).length) plan = p;
  }
  if (!plan && value.level === "out") {
    // Still changing under us: a keep-out lands regardless.
    const p = M.answerPlan({ level: "out", under_13: value.under_13, age_band: value.age_band, confirmed_at: null }, value, at);
    const { level, pending_level, pending_under_13, pending_age_band, confirm_hash, confirm_sent_at } = p.write;
    await run(sb.from("sm_market_consents").update({ level, pending_level, pending_under_13, pending_age_band, confirm_hash, confirm_sent_at, updated_at: at }).eq("athlete_id", a.id).eq("email", value.email));
    plan = p;
  }
  if (!plan) return message(res, 409, "Try again", "Your answer changed while we were saving it. Send the form again.");
  count([["writes", ev.id]]);

  const team = teams.find((t) => t.id === value.team_id);
  const level = plan.write.level;
  let mailed = false;
  if (mayEmail) {
    count(capList);
    try {
      const mail = plan.tok
        ? M.consentEmail(ev, team.name, value.jersey, value.level, M.linkTo.confirm(plan.tok.token), values.who)
        : level === "out"
          ? M.keptOutEmail(ev, team.name, value.jersey)
          : M.changedEmail(ev, team.name, value.jersey, level, plan.write.age_band);
      mailed = !!(await mailer.sendMail({ to: value.email, ...mail, pool: "market" })).sent;
    } catch (e) {
      console.warn("[sm-market-public] consent email failed:", mailer.errorCode(e));
    }
  }
  const k = plan.now ? (level === "out" ? "out" : "now") : "";
  res.redirect(303, `/m/${ev.code}/consent/sent?${k ? "k=" + k + "&" : ""}m=${mailed ? 1 : 0}`);
}));

router.use((req, res) => notFound(res));

// ── Subject Medias' Stripe webhook ───────────────────────────────────────
// POST /api/sm/stripe/webhook, from Subject Medias' own Stripe account
// (server.js keeps the raw body for the signature). paid(), expired() and
// refunded() change nothing on a resent event; a failure answers 500 so
// Stripe sends it again.
const stripeWebhook = express.Router();
stripeWebhook.post("/webhook", async (req, res) => {
  const secret = process.env.SM_STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: "webhook_not_configured" });
  let s;
  try {
    s = S.stripe();
  } catch (e) {
    return res.status(503).json({ error: e.code || "stripe_not_configured" });
  }
  let event;
  try {
    event = s.stripe.webhooks.constructEvent(req.rawBody || Buffer.from(""), req.headers["stripe-signature"], secret);
  } catch (e) {
    return res.status(400).json({ error: "bad_signature" });
  }
  if (!getSupabase()) return res.status(503).json({ error: "storage_unavailable" });
  const obj = (event.data && event.data.object) || {};
  const ours = (obj.metadata || {}).kind === "sm_market";
  try {
    if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && ours) await paid(obj);
    else if (event.type === "checkout.session.expired" && ours) await expired(obj);
    // A refund finds its order by the payment; any other charge on the account matches none.
    else if (event.type === "charge.refunded") await refunded(obj);
    res.json({ received: true });
  } catch (e) {
    console.error("[sm-market-public] webhook failed:", event.type, e && e.message);
    res.status(500).json({ error: "webhook_failed" });
  }
});

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
module.exports.paid = paid;
module.exports.expired = expired;
module.exports.refunded = refunded;
module.exports.markPaid = markPaid;
module.exports.itemsFor = itemsFor;
module.exports._reset = () => {
  buckets.clear();
  caps.clear();
};
