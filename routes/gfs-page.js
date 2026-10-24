// Ground Floor Sports · Pylon events: the public stop page its QR codes open
// (rendered by utils/gfs-page.js; links and counts from migration 025).
//
//   GET /e/:code                        the page; ?s=<placement> or ?c=<creator code> says which code was scanned
//   GET /e/:code/go/footage             counted, then on to the stop's SportsClippers page
//   GET /e/:code/go/creator/:creator    counted, then on to that creator's SportsClippers page
//
// The page shows nothing about an athlete. A creator appears only when the
// code is theirs, and only if they're an active adult confirmed on the stop's
// crew with their own SportsClippers page. Counts are per code per day;
// nothing about a visitor is stored, and redirects go only to links stored on
// the event or creator (which must be on sportsclippers.com).

"use strict";

const crypto = require("crypto");
const express = require("express");
const { getSupabase } = require("../utils/supabase");
const GP = require("../utils/gfs-page");

const router = express.Router();
const EVENT_CODE = /^[A-Za-z0-9]{2,24}$/;
const CREATOR_CODE = /^[A-Z0-9]{4,8}$/;
const EVENT_COLS = "id,code,name,series,city,state,venue,starts_on,ends_on,status,sportsclippers_url,help_phone,qr_sources";

function nonce() {
  return crypto.randomBytes(16).toString("base64");
}
function pageHeaders(res, n) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${n}'; img-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
}
function missing(res) {
  const n = nonce();
  pageHeaders(res, n);
  res.status(404).send(GP.renderMissingPage(n));
}

// Counting is capped, so a refresh loop can't run up the numbers or the
// writes: 300 a minute from one address (a venue's shared Wi-Fi stays well
// under that), and 2,000 a minute for one stop. The address is used only
// here: keyed through an HMAC with a key made fresh each time the server
// starts, held in memory for a minute, never stored or logged. Behind Vercel
// the first X-Forwarded-For entry is the visitor; someone calling the server
// directly can set it themselves, so counts are a guide, not an audit.
const SALT = crypto.randomBytes(32);
const PER_ADDRESS = 300;
const PER_STOP = 2000;
const buckets = new Map();
let sweptAt = 0;
function sweep(nowMs) {
  if (nowMs - sweptAt < 60000) return;
  sweptAt = nowMs;
  for (const [k, b] of buckets) if (nowMs > b.reset) buckets.delete(k);
}
function hit(key, limit, nowMs) {
  const b = buckets.get(key);
  if (!b || nowMs > b.reset) {
    if (buckets.size > 50000) buckets.clear();
    buckets.set(key, { n: 1, reset: nowMs + 60000 });
    return true;
  }
  b.n++;
  return b.n <= limit;
}
function mayCount(req, ev) {
  const nowMs = Date.now();
  sweep(nowMs);
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  const key = "a:" + crypto.createHmac("sha256", SALT).update(ip).digest("base64").slice(0, 22);
  return hit("e:" + ev.id, PER_STOP, nowMs) && hit(key, PER_ADDRESS, nowMs);
}
function count(sb, req, ev, source, kind) {
  if (!mayCount(req, ev)) return;
  Promise.resolve(sb.rpc("gfs_count_hit", { p_event: ev.id, p_source: source, p_kind: kind }))
    .then((r) => { if (r && r.error) console.error("[gfs-page] count failed:", r.error.message); })
    .catch((e) => console.error("[gfs-page] count failed:", e.message));
}

async function stopFor(sb, code) {
  if (!EVENT_CODE.test(String(code || ""))) return null;
  const { data, error } = await sb.from("gfs_events").select(EVENT_COLS).eq("code", code).maybeSingle();
  if (error) throw error;
  return data || null;
}
// The creator a code belongs to, if they can appear on this stop's page: an
// active adult, confirmed on its crew, with their own page.
async function creatorFor(sb, ev, code) {
  if (!CREATOR_CODE.test(String(code || ""))) return null;
  const { data: c, error } = await sb.from("gfs_creators").select("id,code,name,tier,status,sportsclippers_url").eq("code", code).maybeSingle();
  if (error) throw error;
  if (!c || c.tier !== "adult" || c.status !== "active" || !c.sportsclippers_url || !GP.SC_URL.test(c.sportsclippers_url)) return null;
  const { data: rows, error: e2 } = await sb.from("gfs_crew").select("id,status").eq("event_id", ev.id).eq("creator_id", c.id);
  if (e2) throw e2;
  if (!(rows || []).some((r) => r.status === "confirmed")) return null;
  return c;
}
const live = (ev) => ev.status !== "cancelled";
const footageOk = (ev) => live(ev) && !!ev.sportsclippers_url && GP.SC_URL.test(ev.sportsclippers_url);

// The bare /e/, where media.groundfloorsports.com sends anything that isn't
// a stop (vercel.json): the same Pylon page as an unknown code.
router.get("/", (req, res) => missing(res));

router.get("/:code", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return missing(res);
  try {
    const ev = await stopFor(sb, req.params.code);
    if (!ev) return missing(res);
    let src = GP.sourceFromQuery(req.query, ev);
    let creator = null;
    if (src.kind === "creator") {
      creator = live(ev) ? await creatorFor(sb, ev, src.creator) : null;
      if (!creator) src = { kind: "stop", source: "stop" };
    }
    const q = src.kind === "placement" ? `?s=${encodeURIComponent(src.placement)}` : src.kind === "creator" ? `?c=${encodeURIComponent(src.creator)}` : "";
    const base = `/e/${encodeURIComponent(ev.code)}`;
    count(sb, req, ev, src.source, "scan");
    const n = nonce();
    pageHeaders(res, n);
    res.send(
      GP.renderStopPage(ev, {
        nonce: n,
        creator: creator ? { first: GP.firstName(creator.name), code: creator.code } : null,
        footageHref: footageOk(ev) ? `${base}/go/footage${q}` : null,
        creatorHref: creator ? `${base}/go/creator/${encodeURIComponent(creator.code)}` : null,
        email: GP.helpEmail(),
        phone: live(ev) ? ev.help_phone || null : null,
      })
    );
  } catch (e) {
    console.error("[gfs-page] page failed:", e.message);
    missing(res);
  }
});

router.get("/:code/go/footage", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return missing(res);
  try {
    const ev = await stopFor(sb, req.params.code);
    if (!ev) return missing(res);
    res.setHeader("Cache-Control", "no-store");
    if (!footageOk(ev)) return res.redirect(302, `/e/${encodeURIComponent(ev.code)}`);
    let src = GP.sourceFromQuery(req.query, ev);
    if (src.kind === "creator" && !(await creatorFor(sb, ev, src.creator))) src = { kind: "stop", source: "stop" };
    count(sb, req, ev, src.source, "footage");
    res.redirect(302, GP.tagged(ev.sportsclippers_url, ev, src));
  } catch (e) {
    console.error("[gfs-page] footage link failed:", e.message);
    missing(res);
  }
});

router.get("/:code/go/creator/:creator", async (req, res) => {
  const sb = getSupabase();
  if (!sb) return missing(res);
  try {
    const ev = await stopFor(sb, req.params.code);
    if (!ev) return missing(res);
    res.setHeader("Cache-Control", "no-store");
    const code = String(req.params.creator || "").toUpperCase();
    const c = live(ev) ? await creatorFor(sb, ev, code) : null;
    if (!c) return res.redirect(302, `/e/${encodeURIComponent(ev.code)}`);
    const src = { kind: "creator", creator: c.code, source: "c:" + c.code };
    count(sb, req, ev, src.source, "creator");
    res.redirect(302, GP.tagged(c.sportsclippers_url, ev, src));
  } catch (e) {
    console.error("[gfs-page] creator link failed:", e.message);
    missing(res);
  }
});

module.exports = router;
