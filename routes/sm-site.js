"use strict";
// Subject Medias site counts (migration 034): how often subjectmedias.com's
// pages are opened, and how often people open the booking form, tap Buy or
// see the 10% offer, as totals per day. No cookie, no address kept, nothing
// about who.
//
//   POST /api/sm/site/count?e=<name>   the site's pages (navigator.sendBeacon),
//                                       through subjectmedias.com's rewrite
//   GET  /api/sm/site/counts           staff: the last 7 and 30 days, with the
//                                       requests, 10% claims and payments from
//                                       sm_bookings
//
// A count is a hint, not a record: anyone can send one. So a visitor (their
// X-Forwarded-For chain, through an HMAC with a key made fresh each start and
// never kept) counts at most 40 times in 10 minutes, a day's count stops at a
// million in the database, and only browsers count: every browser's user
// agent starts "Mozilla/", and crawlers that say what they are don't count.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff } = require("../utils/staff");

const router = express.Router();

const NAMES = Object.freeze(["visit_home", "visit_fellowship", "book_open", "buy_tap", "offer_shown"]);
const BROWSER = /^Mozilla\/\d/;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly/i;
const TZ = "America/New_York";

const PER_VISITOR = 40;
const WINDOW_MS = 10 * 60 * 1000;
const SALT = crypto.randomBytes(32);
const buckets = new Map();
function allowed(req, now = Date.now()) {
  const who = String(req.headers["x-forwarded-for"] || "").replace(/\s+/g, "").toLowerCase().slice(0, 512) || (req.socket && req.socket.remoteAddress) || "";
  const key = crypto.createHmac("sha256", SALT).update(who).digest("base64").slice(0, 22);
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    if (buckets.size > 50000) {
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
      if (buckets.size > 50000) buckets.clear();
    }
    buckets.set(key, { n: 1, reset: now + WINDOW_MS });
    return true;
  }
  b.n++;
  return b.n <= PER_VISITOR;
}

// Answered at once and the same way whatever happens: nothing to learn from it.
router.post("/count", (req, res) => {
  res.status(204).end();
  const name = typeof req.query.e === "string" ? req.query.e : "";
  if (!NAMES.includes(name)) return;
  const ua = String(req.headers["user-agent"] || "");
  if (!BROWSER.test(ua) || BOT.test(ua)) return;
  if (!allowed(req)) return;
  const sb = getSupabase();
  if (!sb) return;
  Promise.resolve(sb.rpc("sm_site_count", { p_name: name }))
    .then((r) => { if (r && r.error) console.error("[sm-site] count failed:", r.error.message); })
    .catch((e) => console.error("[sm-site] count failed:", e && e.message));
});

// 'YYYY-MM-DD' in New York, the day the database counts in.
const DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const nyDay = (d) => DAY_FMT.format(d);
function minusDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
// Before the site sent the claim as a field, it led the request's notes.
const OLD_CLAIM = /^Claimed the 10% first-package offer\./;

router.get("/counts", requireStaff, async (req, res) => {
  try {
    const sb = getSupabase();
    if (!sb) return res.status(503).json({ error: "storage_unavailable" });
    const today = nyDay(new Date());
    const from30 = minusDays(today, 29), from7 = minusDays(today, 6);
    const [counts, books] = await Promise.all([
      sb.from("sm_site_counts").select("day,name,n").gte("day", from30).limit(1000),
      // A day's margin either side of New York's midnight; days are sorted out below.
      sb.from("sm_bookings").select("created_at,source,offer,stripe_session_id,notes").gte("created_at", new Date(Date.now() - 32 * 864e5).toISOString()).limit(5000),
    ]);
    if (counts.error || books.error) return res.status(500).json({ error: "storage_error" });
    const zero = () => ({ visit_home: 0, visit_fellowship: 0, book_open: 0, offer_shown: 0, buy_tap: 0, requests: 0, claims: 0, paid: 0 });
    const week = zero(), month = zero();
    const add = (day, k, n = 1) => {
      if (day < from30 || day > today) return;
      month[k] += n;
      if (day >= from7) week[k] += n;
    };
    for (const r of counts.data || []) if (NAMES.includes(r.name)) add(String(r.day).slice(0, 10), r.name, Number(r.n) || 0);
    for (const b of books.data || []) {
      const day = nyDay(new Date(b.created_at));
      if (b.source === "form") {
        add(day, "requests");
        if (b.offer === "first10" || OLD_CLAIM.test(String(b.notes || ""))) add(day, "claims");
      }
      if (b.stripe_session_id) add(day, "paid");
    }
    res.json({ today, week, month });
  } catch (e) {
    console.error("[sm-site] counts failed:", e && e.message);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  }
});

router._reset = () => buckets.clear();
router.NAMES = NAMES;
module.exports = router;
