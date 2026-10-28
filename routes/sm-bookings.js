"use strict";
// Subject Medias bookings (migration 030; the rules are in utils/sm-bookings.js).
//
//   POST  /api/sm/bookings          public: the booking form on subjectmedias.com
//                                    (the site rewrites its /api/book here)
//   POST  /api/sm/bookings/paid     subjectmedias.com's Stripe webhook, with the
//                                    shared SM_BOOKINGS_SECRET in X-SM-Secret
//   GET   /api/sm/bookings          staff: open bookings (?all=1 for every one)
//   GET   /api/sm/bookings/:id      staff: one booking and its suggested creators
//   PATCH /api/sm/bookings/:id      staff: status, and the creator who's staffed
//
// Each new booking alerts staff (ADMIN_EMAILS): a push to the TOJ app and an
// email, each listing the creators who work that region. A failed alert never
// fails the booking. If the database can't take a form booking, the email
// carries it instead, so nobody's booking is lost.

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../utils/supabase");
const { requireStaff, staffEmails } = require("../utils/staff");
const push = require("../utils/push");
const mailer = require("../utils/mailer");
const B = require("../utils/sm-bookings");

const router = express.Router();
const APP_BASE = () => String(process.env.APP_BASE || "https://tojcampaign.com").replace(/\/+$/, "");
const CREW_COLUMNS = "id,name,home_city,region,tier,status,contract_signed_on,background_check_on,safety_training_on";

// ── Abuse limits for the public form: 8 bookings per address per 10 minutes.
// The form reaches here through subjectmedias.com's Vercel rewrite, so the
// visitor's address is in Vercel's headers, not the connection's.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const hits = new Map();
function limited(ip, now = Date.now()) {
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    return false;
  }
  h.n += 1;
  return h.n > MAX_PER_WINDOW;
}
function clientIp(req) {
  const first = (v) => String(v || "").split(",")[0].trim();
  const ip = first(req.headers["x-vercel-forwarded-for"]) || first(req.headers["x-real-ip"]) || first(req.headers["x-forwarded-for"]);
  return (ip || (req.socket && req.socket.remoteAddress) || "unknown").slice(0, 100);
}

async function findMatches(sb, booking) {
  const [crew, club] = await Promise.all([
    booking.region ? sb.from("gfs_creators").select(CREW_COLUMNS).eq("status", "active").eq("region", booking.region) : Promise.resolve({ data: [] }),
    sb.from("creators").select("slug,brand_name,location,status,page_status").eq("status", "active").eq("page_status", "live"),
  ]);
  return B.rankCreators(booking, (crew && crew.data) || [], (club && club.data) || []);
}

// Push and email to staff, then note on the row when they went and who was
// suggested. Never throws.
async function alertStaff(sb, row) {
  try {
    const matches = sb ? await findMatches(sb, row) : { crew: [], pages: [] };
    const emails = [...staffEmails()];
    push.notifySoon(emails, B.pushPayload(row, matches.crew.length));
    const mail = B.emailText(row, matches, APP_BASE());
    mailer
      .sendMail({ to: emails, subject: mail.subject, text: mail.text })
      .then((r) => { if (!r.sent) console.warn(`[sm-bookings] email not sent (${r.reason})`); })
      .catch((e) => console.warn("[sm-bookings] email failed:", e && e.message));
    if (sb) {
      const snapshot = matches.crew.map((c) => ({ id: c.id, name: c.name, home_city: c.home_city, tier: c.tier, screened: c.screened }));
      await sb.from("sm_bookings").update({ alerted_at: new Date().toISOString(), matches: snapshot }).eq("id", row.id);
    }
  } catch (e) {
    console.warn("[sm-bookings] alert failed:", e && e.message);
  }
}

// ── Public: the booking form ───────────────────────────────────────────
router.post("/", async (req, res) => {
  const raw = req.body || {};
  // Bots fill every field, including the one people never see.
  if (raw.company) return res.json({ ok: true });
  if (limited(clientIp(req))) return res.status(429).json({ error: "too_many" });

  const { errors, value } = B.normalize(raw);
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const row = { ...value, source: "form", status: "new" };

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("sm_bookings").insert(row).select().single();
    if (!error && data) {
      res.json({ ok: true, id: data.id });
      setImmediate(() => alertStaff(sb, data));
      return;
    }
    console.error("[sm-bookings] insert failed:", error && error.message);
  }
  // The database can't take it: email it to staff whole, so it isn't lost.
  try {
    const mail = B.emailText({ ...row, id: "not-saved" }, { crew: [], pages: [] }, APP_BASE());
    const extra = [row.team_jersey ? `Team and jersey: ${row.team_jersey}` : null, row.notes ? `Notes: ${row.notes}` : null].filter(Boolean).join("\n");
    const r = await mailer.sendMail({
      to: [...staffEmails()],
      subject: `${mail.subject} (not saved: the app's database was down)`,
      text: mail.text.replace(/\nOpen it in the TOJ app:[\s\S]*$/, "") + "\n\nThis booking is NOT in the app: the database didn't take it. Reply to the booker from here.\n" + extra,
    });
    if (r.sent) return res.json({ ok: true, id: null });
  } catch (e) {
    console.error("[sm-bookings] fallback email failed:", e && e.message);
  }
  return res.status(503).json({ error: "storage_unavailable" });
});

// ── The site's Stripe webhook: a paid package ─────────────────────────
function secretOk(req) {
  const want = String(process.env.SM_BOOKINGS_SECRET || "");
  const got = String(req.headers["x-sm-secret"] || "");
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

router.post("/paid", async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  const { errors, value } = B.normalizePaid(req.body || {});
  if (errors.length) return res.status(400).json({ error: "invalid", fields: errors });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data, error } = await sb.from("sm_bookings").insert({ ...value, status: "new" }).select().single();
  if (error) {
    // Stripe retries a webhook: the same checkout arrives again. Already here.
    if (error.code === "23505") return res.json({ ok: true, duplicate: true });
    console.error("[sm-bookings] paid insert failed:", error.message);
    return res.status(500).json({ error: "storage_error" });
  }
  res.json({ ok: true, id: data.id });
  setImmediate(() => alertStaff(sb, data));
});

// ── Staff: the list, one booking, its status ──────────────────────────
const LIST_FIELDS = ["id", "source", "kind", "package", "sport", "event_name", "event_date", "event_city", "event_state", "region", "athletes", "amount_cents", "status", "staffed_creator_id", "created_at"];
const LIST_COLUMNS = LIST_FIELDS.join(",");
// The list never carries contact details or notes, whatever the query returns.
const listRow = (b) => Object.fromEntries(LIST_FIELDS.map((k) => [k, b[k] === undefined ? null : b[k]]));

router.get("/", requireStaff, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  let q = sb.from("sm_bookings").select(LIST_COLUMNS).order("created_at", { ascending: false }).limit(200);
  if (req.query.all !== "1") q = q.in("status", [...B.OPEN]);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "storage_error" });
  res.json({ bookings: (data || []).map((b) => ({ ...listRow(b), summary: B.summary(b) })), statuses: B.STATUSES });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/:id", requireStaff, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const { data: b, error } = await sb.from("sm_bookings").select("*").eq("id", req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: "storage_error" });
  if (!b) return res.status(404).json({ error: "not_found" });
  const matches = await findMatches(sb, b);
  let staffed = null;
  if (b.staffed_creator_id) {
    const { data } = await sb.from("gfs_creators").select("id,name,home_city,tier").eq("id", b.staffed_creator_id).maybeSingle();
    staffed = data || null;
  }
  res.json({ booking: { ...b, summary: B.summary(b) }, matches, staffed, statuses: B.STATUSES, packages: B.PACKAGES, regions: B.REGION_WORDS });
});

router.patch("/:id", requireStaff, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: "not_found" });
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "storage_unavailable" });
  const body = req.body || {};
  const { data: b } = await sb.from("sm_bookings").select("id,status,staffed_creator_id").eq("id", req.params.id).maybeSingle();
  if (!b) return res.status(404).json({ error: "not_found" });

  const patch = {};
  if (body.staffed_creator_id !== undefined) {
    if (body.staffed_creator_id === null) patch.staffed_creator_id = null;
    else {
      const { data: c } = await sb.from("gfs_creators").select("id,status").eq("id", String(body.staffed_creator_id)).maybeSingle();
      if (!c || c.status !== "active") return res.status(400).json({ error: "creator_not_active" });
      patch.staffed_creator_id = c.id;
      if (!body.status && B.OPEN.includes(b.status)) patch.status = "staffed";
    }
  }
  if (body.status !== undefined) {
    if (!B.STATUSES.includes(body.status)) return res.status(400).json({ error: "invalid_status" });
    patch.status = body.status;
  }
  const status = patch.status || b.status;
  const creator = patch.staffed_creator_id !== undefined ? patch.staffed_creator_id : b.staffed_creator_id;
  if ((status === "staffed" || status === "delivered") && !creator) return res.status(400).json({ error: "creator_required" });
  if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_change" });

  patch.status_by = String((req.session && req.session.userEmail) || "").toLowerCase().slice(0, 200) || null;
  patch.updated_at = new Date().toISOString();
  const { data, error } = await sb.from("sm_bookings").update(patch).eq("id", b.id).select().single();
  if (error) return res.status(500).json({ error: "storage_error" });
  res.json({ booking: { ...data, summary: B.summary(data) } });
});

router._limited = limited;
router._resetLimits = () => hits.clear();
module.exports = router;
