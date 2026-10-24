// Ground Floor Sports · Pylon events: the public stop page its QR codes open
// (rendered by utils/gfs-page.js; links and counts from migration 025).
//
//   GET /e/:code                        the page; ?s=<placement> or ?c=<creator code> says which code was scanned
//   GET /e/:code/go/footage             counted, then on to the stop's SportsClippers page
//   GET /e/:code/go/creator/:creator    counted, then on to that creator's SportsClippers page
//
// The page shows nothing about an athlete. A creator appears only when the
// code is theirs, and only if they're an active adult on the stop's crew with
// their own SportsClippers page. Counts are per code per day; nothing about a
// visitor is stored, and redirects go only to links stored on the event or
// creator (which must be on sportsclippers.com).

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
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
}
function missing(res) {
  const n = nonce();
  pageHeaders(res, n);
  res.status(404).send(GP.renderMissingPage(n));
}

// Counting is capped per visitor address (60 a minute), in memory only and
// keyed by a hash, so a refresh loop can't run up the numbers or the writes.
const buckets = new Map();
function mayCount(req) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
  const key = crypto.createHash("sha256").update(ip).digest("base64").slice(0, 16);
  const nowMs = Date.now();
  const b = buckets.get(key);
  if (!b || nowMs > b.reset) {
    if (buckets.size > 20000) buckets.clear();
    buckets.set(key, { n: 1, reset: nowMs + 60000 });
    return true;
  }
  b.n++;
  return b.n <= 60;
}
function count(sb, req, ev, source, kind) {
  if (!mayCount(req)) return;
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
// active adult, invited or confirmed on its crew, with their own page.
async function creatorFor(sb, ev, code) {
  if (!CREATOR_CODE.test(String(code || ""))) return null;
  const { data: c, error } = await sb.from("gfs_creators").select("id,code,name,tier,status,sportsclippers_url").eq("code", code).maybeSingle();
  if (error) throw error;
  if (!c || c.tier !== "adult" || c.status !== "active" || !c.sportsclippers_url || !GP.SC_URL.test(c.sportsclippers_url)) return null;
  const { data: rows, error: e2 } = await sb.from("gfs_crew").select("id,status").eq("event_id", ev.id).eq("creator_id", c.id);
  if (e2) throw e2;
  if (!(rows || []).some((r) => r.status === "invited" || r.status === "confirmed")) return null;
  return c;
}
const live = (ev) => ev.status !== "cancelled";
const footageOk = (ev) => live(ev) && !!ev.sportsclippers_url && GP.SC_URL.test(ev.sportsclippers_url);

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
