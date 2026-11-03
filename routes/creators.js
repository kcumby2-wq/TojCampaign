// Creators API — the Creator Club's first tool (phase 1).
//
// Team (the "creators" tool in the TOJ app; utils/team.js):
//   GET    /api/creators                         list, with sales totals          viewer
//   POST   /api/creators                         new creator from intake          member
//   GET    /api/creators/:id                     profile, checks, ladder, events  viewer
//   PATCH  /api/creators/:id                     edit (owner-only fields below)   member
//   GET    /api/creators/:id/page/preview        the page, before it's live       viewer
//   POST   /api/creators/:id/page/request        ask for the page to go live      member
//   POST   /api/creators/:id/page/approve        put it live                      owner
//   POST   /api/creators/:id/page/off            take it down                     owner
//   POST   /api/creators/:id/events              add an event (gets a QR code)    member
//   PATCH  /api/creators/:id/events/:eid         mark done or cancelled           member
//   GET    /api/creators/:id/events/:eid/qr.svg  the QR (?crew=CODE credits them) viewer
//   GET    /api/creators/:id/events/:eid/card    a printable QR card              viewer
//   POST   /api/creators/:id/crew                add crew (gets a code)           member
//   PATCH  /api/creators/:id/crew/:cid           { active }                       member
//   GET    /api/creators/:id/orders              orders (buyer details)           member
//   PATCH  /api/creators/:id/orders/:oid         { status }                       member
//   GET    /api/creators/:id/orders.csv          ?event=&columns=a,b              member
//   POST   /api/creators/:id/stripe/connect      onboarding link for the account  owner
//   POST   /api/creators/:id/stripe/refresh      re-check the account             member
//
// Public:
//   GET    /c/:slug                              the live landing page (pageRouter)
//   POST   /api/creators/public/:slug/checkout   start Stripe Checkout
//   POST   /api/creators/stripe/webhook          Stripe → orders
//
// Logs carry ids and slugs, never a buyer's or athlete's name or contact.

"use strict";

const express = require("express");
const crypto = require("crypto");
const QRCode = require("qrcode");
const T = require("../utils/team");
const C = require("../utils/creators");
const S = require("../utils/creator-stripe");
const P = require("../utils/push");
const { getSupabase } = require("../utils/supabase");
const { renderPage, renderCard } = require("../utils/creator-page");

const router = express.Router();
const pageRouter = express.Router();

const viewer = T.requireTeam("creators", "viewer");
const member = T.requireTeam("creators", "member");
const owner = T.requireTeam("creators", "owner");

const BASE = () => String(process.env.CREATOR_PAGE_BASE || "https://tojcampaign.com").replace(/\/+$/, "");
// The TOJ app itself, for links back into it (Stripe onboarding returns). Kept
// apart from BASE so the public pages can move to subjectmedias.com/c/<slug>
// (CREATOR_PAGE_BASE) while the app stays on tojcampaign.com.
const APP_BASE = () => String(process.env.APP_BASE || "https://tojcampaign.com").replace(/\/+$/, "");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_FIELDS = ["brand_name", "handle", "location", "tagline", "hero_lines", "theme", "packages", "team_tier", "footer_note"];
const MEMBER_FIELDS = [...PUBLIC_FIELDS, "creator_email", "under_18", "guardian_email", "camera", "slug"];
const OWNER_FIELDS = ["split_percent", "rung", "status", "club_status", "camera_approved"];
const CREATOR_COLS = "id,slug,brand_name,handle,location,tagline,hero_lines,theme,packages,team_tier,footer_note,creator_email,under_18,guardian_email,split_percent,rung,status,club_status,page_status,page_requested_by,page_requested_at,page_approved_by,page_approved_at,camera,camera_approved,camera_approved_by,stripe_account_id,stripe_mode,stripe_ready,checks,created_by,created_at,updated_at";

function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
function fail(res, e, what) {
  console.error(`[creators] ${what} failed:`, e && e.message);
  return res.status(500).json({ error: `${what}_failed` });
}
function stripeError(res, e) {
  const code = e && e.code && S.HINTS[e.code] ? e.code : null;
  if (code) return res.status(503).json({ error: code, hint: S.HINTS[code] });
  console.error("[creators] stripe:", e && (e.type || e.code), e && e.message);
  return res.status(502).json({ error: "stripe_error", message: "Stripe didn't accept that. Try again, or check the Stripe dashboard." });
}
function stripeMode() {
  const m = S.mode();
  return m.ok ? m.mode : null;
}

async function loadCreator(sb, id) {
  if (!UUID.test(String(id))) return null;
  const { data, error } = await sb.from("creators").select(CREATOR_COLS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}
async function withCreator(req, res) {
  const sb = getSupabase();
  if (!sb) {
    sb503(res);
    return null;
  }
  const c = await loadCreator(sb, req.params.id);
  if (!c) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return { sb, c };
}

// Prices on a profile are dollars; normalize what a client sends.
function normalizePackages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 6).map((k, i) => ({
    id: C.slugify(k.id || k.name || `pkg-${i + 1}`).slice(0, 24) || `pkg-${i + 1}`,
    name: C.clean(k.name, 40),
    price: Math.round(Number(k.price) * 100) / 100,
    desc: C.clean(k.desc, 160),
    features: (Array.isArray(k.features) ? k.features : []).slice(0, 8).map((f) => C.clean(f, 80)).filter(Boolean),
    featured: !!k.featured,
  }));
}
function normalizeTheme(t, prev = {}) {
  const out = { ...prev };
  for (const k of ["primary", "accent", "bg", "bgCard", "text", "gold"]) if (t && t[k] !== undefined) out[k] = String(t[k]).trim().toLowerCase();
  for (const k of ["displayFont", "bodyFont"]) if (t && t[k] !== undefined) out[k] = C.clean(t[k], 40);
  if (t && t.mode !== undefined) out.mode = t.mode === "light" ? "light" : "dark";
  return out;
}
function applyEdits(c, body, allowed) {
  const next = { ...c };
  for (const k of allowed) {
    if (!(k in body)) continue;
    const v = body[k];
    if (k === "packages") next.packages = normalizePackages(v);
    else if (k === "theme") next.theme = normalizeTheme(v, c.theme || {});
    else if (k === "hero_lines") next.hero_lines = (Array.isArray(v) ? v : []).slice(0, 3).map((l) => C.clean(l, 24).toUpperCase());
    else if (k === "team_tier") next.team_tier = v ? { show: !!v.show, name: C.clean(v.name, 40), price: Math.round(Number(v.price) * 100) / 100, desc: C.clean(v.desc, 160) } : null;
    else if (k === "under_18" || k === "camera_approved") next[k] = !!v;
    else if (k === "split_percent" || k === "rung") next[k] = Math.round(Number(v));
    else if (k === "creator_email" || k === "guardian_email") next[k] = v ? String(v).trim().toLowerCase().slice(0, 120) : null;
    else if (k === "slug") next.slug = C.slugify(v);
    else if (k === "handle") next.handle = v ? (String(v).trim().startsWith("@") ? "" : "@") + String(v).trim().slice(0, 31) : null;
    else next[k] = v == null ? null : C.clean(v, k === "tagline" ? 160 : 120);
  }
  return next;
}

async function uniqueSlug(sb, base) {
  let slug = base || "creator";
  for (let i = 2; i < 50; i++) {
    const { data } = await sb.from("creators").select("id").eq("slug", slug).maybeSingle();
    if (!data) return slug;
    slug = `${base.slice(0, 46)}-${i}`;
  }
  return `${base.slice(0, 40)}-${C.code(4).toLowerCase()}`;
}

function rungsView(c) {
  return C.RUNGS.map((r) => ({ ...r, state: r.n < c.rung ? "done" : r.n === c.rung ? "current" : "ahead" }));
}
function pageUrl(c, ev, crewCode) {
  const q = [ev ? `e=${ev.code}` : "", crewCode ? `r=${crewCode}` : ""].filter(Boolean).join("&");
  return `${BASE()}/c/${c.slug}${q ? "?" + q : ""}`;
}
function publicView(c) {
  // What the team sees: everything except nothing secret lives here; the
  // Stripe account id is shown as connected or not.
  const { stripe_account_id, ...rest } = c;
  return { ...rest, stripe_connected: !!stripe_account_id };
}

// ── List and create ──────────────────────────────────────────────────────
router.get("/", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const { data, error } = await sb.from("creators").select(CREATOR_COLS).order("created_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    const { data: orders } = await sb.from("creator_orders").select("creator_id,amount_cents,creator_cents,status").limit(10000);
    const tot = new Map();
    for (const o of orders || []) {
      if (o.status === "Refunded") continue;
      const t = tot.get(o.creator_id) || { orders: 0, sales_cents: 0, creator_cents: 0 };
      t.orders++;
      t.sales_cents += o.amount_cents;
      t.creator_cents += o.creator_cents;
      tot.set(o.creator_id, t);
    }
    res.json({
      creators: (data || []).map((c) => ({ ...publicView(c), blockers: C.blockers(c.checks).length, totals: tot.get(c.id) || { orders: 0, sales_cents: 0, creator_cents: 0 } })),
      stripe_mode: stripeMode(),
    });
  } catch (e) {
    fail(res, e, "list");
  }
});

router.post("/", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const body = req.body || {};
    const answers = body.answers ? C.flattenJotform(body.answers) : body.intake || {};
    const p = C.buildProfile(answers);
    if (!p.slug) return res.status(400).json({ error: "brand_name_required" });
    p.slug = await uniqueSlug(sb, p.slug);
    const checks = C.checkProfile(p);
    // The table requires a guardian email for under-18 creators; until there
    // is one, the draft is saved as not-under-18 with the block kept visible.
    const row = { ...p, under_18: p.under_18 && !!p.guardian_email, checks, rung: 1, split_percent: 80, status: "draft", club_status: "pending", page_status: "none", camera_approved: false, stripe_ready: false, created_by: req.team.email };
    const { data, error } = await sb.from("creators").insert(row).select(CREATOR_COLS).single();
    if (error) throw new Error(error.message);
    await T.logActivity(req.team.email, "added_creator", data.slug);
    res.json({ creator: publicView(data), checks, under_18_needs_guardian: p.under_18 && !p.guardian_email });
  } catch (e) {
    fail(res, e, "create");
  }
});

// ── One creator ──────────────────────────────────────────────────────────
router.get("/:id", viewer, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { sb, c } = x;
    const [{ data: events }, { data: crew }, { data: orders }] = await Promise.all([
      sb.from("creator_events").select("id,code,name,venue,event_date,sport,status,created_at").eq("creator_id", c.id).order("event_date", { ascending: false }).limit(200),
      sb.from("creator_crew").select("id,name,role,code,active,created_at").eq("creator_id", c.id).order("created_at", { ascending: true }),
      sb.from("creator_orders").select("event_id,amount_cents,creator_cents,status,mode").eq("creator_id", c.id).limit(10000),
    ]);
    const byEvent = {};
    let sales = 0, creatorShare = 0, count = 0;
    for (const o of orders || []) {
      if (o.status === "Refunded") continue;
      count++;
      sales += o.amount_cents;
      creatorShare += o.creator_cents;
      const k = o.event_id || "none";
      byEvent[k] = byEvent[k] || { orders: 0, sales_cents: 0 };
      byEvent[k].orders++;
      byEvent[k].sales_cents += o.amount_cents;
    }
    res.json({
      creator: publicView(c),
      checks: c.checks || [],
      rungs: rungsView(c),
      page_url: pageUrl(c),
      events: (events || []).map((e) => ({ ...e, page_url: pageUrl(c, e), totals: byEvent[e.id] || { orders: 0, sales_cents: 0 } })),
      crew: crew || [],
      totals: { orders: count, sales_cents: sales, creator_cents: creatorShare },
      stripe_mode: stripeMode(),
      can: { edit_live: req.team.owner, owner: req.team.owner, see_orders: T.can(req.team, "creators", "member") },
    });
  } catch (e) {
    fail(res, e, "read");
  }
});

router.patch("/:id", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { sb, c } = x;
    const body = req.body || {};
    const ownerTried = OWNER_FIELDS.filter((k) => k in body);
    if (ownerTried.length && !req.team.owner) return res.status(403).json({ error: "owner_only", fields: ownerTried });
    if (c.page_status === "live" && !req.team.owner && PUBLIC_FIELDS.some((k) => k in body)) return res.status(403).json({ error: "page_live_owner_edits" });
    if ("slug" in body && c.page_status !== "none") return res.status(409).json({ error: "slug_locked", hint: "The page address is fixed once a page has been requested; QR codes point at it." });
    const next = applyEdits(c, body, req.team.owner ? [...MEMBER_FIELDS, ...OWNER_FIELDS] : MEMBER_FIELDS);
    if (next.slug !== c.slug) {
      if (!next.slug) return res.status(400).json({ error: "invalid_slug" });
      const { data: taken } = await sb.from("creators").select("id").eq("slug", next.slug).maybeSingle();
      if (taken && taken.id !== c.id) return res.status(409).json({ error: "slug_taken" });
    }
    if (next.split_percent < 50 || next.split_percent > 95) return res.status(400).json({ error: "split_out_of_range", min: 50, max: 95 });
    if (next.rung < 1 || next.rung > 6) return res.status(400).json({ error: "rung_out_of_range" });
    if (!["draft", "active", "paused"].includes(next.status)) return res.status(400).json({ error: "invalid_status" });
    if (!["pending", "active", "lapsed"].includes(next.club_status)) return res.status(400).json({ error: "invalid_club_status" });
    const checks = C.checkProfile(next);
    if (next.under_18 && !next.guardian_email) return res.status(400).json({ error: "guardian_required", checks });
    if (c.page_status === "live" && C.blockers(checks).length) return res.status(400).json({ error: "would_break_live_page", checks });
    const patch = { updated_at: new Date().toISOString(), checks };
    for (const k of [...MEMBER_FIELDS, ...OWNER_FIELDS]) if (JSON.stringify(next[k]) !== JSON.stringify(c[k])) patch[k] = next[k];
    if ("camera_approved" in patch) patch.camera_approved_by = patch.camera_approved ? req.team.email : null;
    const { data, error } = await sb.from("creators").update(patch).eq("id", c.id).select(CREATOR_COLS).single();
    if (error) throw new Error(error.message);
    const changed = Object.keys(patch).filter((k) => k !== "updated_at" && k !== "checks");
    if (changed.some((k) => OWNER_FIELDS.includes(k))) await T.logActivity(req.team.email, "changed_creator", data.slug, { fields: changed.filter((k) => OWNER_FIELDS.includes(k)) });
    res.json({ creator: publicView(data), checks });
  } catch (e) {
    fail(res, e, "update");
  }
});

// ── The landing page ─────────────────────────────────────────────────────
function nonce() {
  return crypto.randomBytes(16).toString("base64");
}
function pageHeaders(res, n) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'nonce-${n}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'`);
}
async function crewFor(sb, creatorId) {
  const { data } = await sb.from("creator_crew").select("name,code,active").eq("creator_id", creatorId).eq("active", true);
  // First names only on a public page.
  return (data || []).map((m) => ({ name: String(m.name).split(/\s+/)[0], code: m.code }));
}

router.get("/:id/page/preview", viewer, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const n = nonce();
    pageHeaders(res, n);
    res.send(renderPage(x.c, { nonce: n, preview: true, crew: await crewFor(x.sb, x.c.id), stripeMode: stripeMode() }));
  } catch (e) {
    fail(res, e, "preview");
  }
});

router.post("/:id/page/request", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { sb, c } = x;
    const checks = C.checkProfile(c);
    if (C.blockers(checks).length) return res.status(400).json({ error: "fix_blockers_first", checks });
    if (c.page_status === "live") return res.status(409).json({ error: "already_live" });
    const { data, error } = await sb.from("creators").update({ page_status: "requested", page_requested_by: req.team.email, page_requested_at: new Date().toISOString(), checks, updated_at: new Date().toISOString() }).eq("id", c.id).select(CREATOR_COLS).single();
    if (error) throw new Error(error.message);
    await T.logActivity(req.team.email, "requested_page", c.slug);
    P.notifySoon(P.teamEmails("owner", null), { title: `${c.brand_name} asks for a landing page`, body: "Preview it and approve or leave it.", url: `/app/#creator/${c.id}`, tag: `page-${c.id}` });
    res.json({ creator: publicView(data) });
  } catch (e) {
    fail(res, e, "request_page");
  }
});

router.post("/:id/page/approve", owner, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { sb, c } = x;
    const checks = C.checkProfile(c);
    if (C.blockers(checks).length) return res.status(400).json({ error: "fix_blockers_first", checks });
    const { data, error } = await sb
      .from("creators")
      .update({ page_status: "live", status: "active", rung: Math.max(c.rung, 2), page_approved_by: req.team.email, page_approved_at: new Date().toISOString(), checks, updated_at: new Date().toISOString() })
      .eq("id", c.id)
      .select(CREATOR_COLS)
      .single();
    if (error) throw new Error(error.message);
    await T.logActivity(req.team.email, "approved_page", c.slug);
    res.json({ creator: publicView(data), page_url: pageUrl(data) });
  } catch (e) {
    fail(res, e, "approve_page");
  }
});

router.post("/:id/page/off", owner, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { data, error } = await x.sb.from("creators").update({ page_status: "off", updated_at: new Date().toISOString() }).eq("id", x.c.id).select(CREATOR_COLS).single();
    if (error) throw new Error(error.message);
    await T.logActivity(req.team.email, "page_off", x.c.slug);
    res.json({ creator: publicView(data) });
  } catch (e) {
    fail(res, e, "page_off");
  }
});

// ── Events and QR codes ──────────────────────────────────────────────────
router.post("/:id/events", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const b = req.body || {};
    const name = C.clean(b.name, 80);
    if (!name) return res.status(400).json({ error: "name_required" });
    const date = b.event_date && /^\d{4}-\d{2}-\d{2}$/.test(b.event_date) ? b.event_date : null;
    let row = null;
    for (let i = 0; i < 5 && !row; i++) {
      const { data, error } = await x.sb
        .from("creator_events")
        .insert({ creator_id: x.c.id, code: C.code(6), name, venue: C.clean(b.venue, 80) || null, event_date: date, sport: C.clean(b.sport, 40) || null, status: "upcoming", created_by: req.team.email })
        .select("id,code,name,venue,event_date,sport,status,created_at")
        .single();
      if (!error) row = data;
      else if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    }
    if (!row) throw new Error("no_unique_code");
    await T.logActivity(req.team.email, "added_event", x.c.slug, { code: row.code });
    res.json({ event: { ...row, page_url: pageUrl(x.c, row) } });
  } catch (e) {
    fail(res, e, "add_event");
  }
});

router.patch("/:id/events/:eid", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const status = String((req.body || {}).status || "");
    if (!["upcoming", "done", "cancelled"].includes(status)) return res.status(400).json({ error: "invalid_status" });
    const { data, error } = await x.sb.from("creator_events").update({ status }).eq("id", req.params.eid).eq("creator_id", x.c.id).select("id,code,status");
    if (error) throw new Error(error.message);
    if (!data || !data.length) return res.status(404).json({ error: "not_found" });
    res.json({ event: data[0] });
  } catch (e) {
    fail(res, e, "update_event");
  }
});

async function eventFor(x, eid) {
  if (!UUID.test(String(eid))) return null;
  const { data } = await x.sb.from("creator_events").select("id,code,name,venue,event_date,sport,status").eq("id", eid).eq("creator_id", x.c.id).maybeSingle();
  return data || null;
}
async function crewCodeFor(x, raw) {
  const code = String(raw || "").toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) return null;
  const { data } = await x.sb.from("creator_crew").select("name,code").eq("creator_id", x.c.id).eq("code", code).maybeSingle();
  return data || null;
}

router.get("/:id/events/:eid/qr.svg", viewer, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const ev = await eventFor(x, req.params.eid);
    if (!ev) return res.status(404).json({ error: "not_found" });
    const crew = await crewCodeFor(x, req.query.crew);
    const svg = await QRCode.toString(pageUrl(x.c, ev, crew && crew.code), { type: "svg", margin: 2, errorCorrectionLevel: "M" });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Disposition", `inline; filename="${x.c.slug}-${ev.code}${crew ? "-" + crew.code : ""}.svg"`);
    res.send(svg);
  } catch (e) {
    fail(res, e, "qr");
  }
});

router.get("/:id/events/:eid/card", viewer, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const ev = await eventFor(x, req.params.eid);
    if (!ev) return res.status(404).json({ error: "not_found" });
    const crew = await crewCodeFor(x, req.query.crew);
    const url = pageUrl(x.c, ev, crew && crew.code);
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    const n = nonce();
    pageHeaders(res, n);
    res.send(renderCard(x.c, { event: ev, qrSvg: svg, pageUrl: url, crewName: crew ? String(crew.name).split(/\s+/)[0] : null, nonce: n }));
  } catch (e) {
    fail(res, e, "card");
  }
});

// ── Crew ─────────────────────────────────────────────────────────────────
router.post("/:id/crew", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const name = C.clean((req.body || {}).name, 60);
    const role = String((req.body || {}).role || "");
    if (!name) return res.status(400).json({ error: "name_required" });
    if (!C.CREW_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role", allowed: C.CREW_ROLES });
    let row = null;
    for (let i = 0; i < 8 && !row; i++) {
      const { data, error } = await x.sb.from("creator_crew").insert({ creator_id: x.c.id, name, role, code: C.code(4), active: true }).select("id,name,role,code,active,created_at").single();
      if (!error) row = data;
      else if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
    }
    if (!row) throw new Error("no_unique_code");
    res.json({ crew: row });
  } catch (e) {
    fail(res, e, "add_crew");
  }
});

router.patch("/:id/crew/:cid", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { data, error } = await x.sb.from("creator_crew").update({ active: !!(req.body || {}).active }).eq("id", req.params.cid).eq("creator_id", x.c.id).select("id,active");
    if (error) throw new Error(error.message);
    if (!data || !data.length) return res.status(404).json({ error: "not_found" });
    res.json({ crew: data[0] });
  } catch (e) {
    fail(res, e, "update_crew");
  }
});

// ── Orders and the CSV ───────────────────────────────────────────────────
const ORDER_COLS = "id,event_id,crew_code,package_id,package_name,amount_cents,creator_cents,platform_cents,buyer_name,buyer_email,buyer_phone,team_jersey,instagram,consent_delivery,consent_public,status,mode,created_at";

async function ordersFor(x, eventId) {
  let q = x.sb.from("creator_orders").select(ORDER_COLS).eq("creator_id", x.c.id);
  if (eventId) q = q.eq("event_id", eventId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(5000);
  if (error) throw new Error(error.message);
  return data || [];
}

router.get("/:id/orders", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const eid = req.query.event && UUID.test(String(req.query.event)) ? String(req.query.event) : null;
    res.json({ orders: await ordersFor(x, eid), stages: C.ORDER_STAGES });
  } catch (e) {
    fail(res, e, "orders");
  }
});

router.patch("/:id/orders/:oid", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const status = String((req.body || {}).status || "");
    if (!C.ORDER_STAGES.includes(status) || status === "Refunded") return res.status(400).json({ error: "invalid_status", allowed: C.ORDER_STAGES.filter((s) => s !== "Refunded") });
    const { data, error } = await x.sb.from("creator_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", req.params.oid).eq("creator_id", x.c.id).select("id,status");
    if (error) throw new Error(error.message);
    if (!data || !data.length) return res.status(404).json({ error: "not_found" });
    res.json({ order: data[0] });
  } catch (e) {
    fail(res, e, "update_order");
  }
});

router.get("/:id/orders.csv", member, async (req, res) => {
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const eid = req.query.event && UUID.test(String(req.query.event)) ? String(req.query.event) : null;
    const columns = String(req.query.columns || "").split(",").map((s) => s.trim()).filter(Boolean);
    const [orders, { data: events }, { data: crew }] = await Promise.all([
      ordersFor(x, eid),
      x.sb.from("creator_events").select("id,code,name").eq("creator_id", x.c.id),
      x.sb.from("creator_crew").select("name,code").eq("creator_id", x.c.id),
    ]);
    const ev = eid ? (events || []).find((e) => e.id === eid) : null;
    const name = `${x.c.slug}${ev ? "-" + ev.code : ""}-sales-${new Date().toISOString().slice(0, 10)}.csv`;
    await T.logActivity(req.team.email, "exported_sales", x.c.slug, { event: ev ? ev.code : null, rows: orders.length });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send("﻿" + C.toCsv(orders, { columns, events: events || [], crew: crew || [] }));
  } catch (e) {
    fail(res, e, "csv");
  }
});

// ── Stripe: the creator's connected account ──────────────────────────────
router.post("/:id/stripe/connect", owner, async (req, res) => {
  let s;
  try {
    s = S.stripe();
  } catch (e) {
    return stripeError(res, e);
  }
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    const { sb, c } = x;
    if (c.under_18 && !c.guardian_email) return res.status(400).json({ error: "guardian_required" });
    // Under 18: the parent or guardian is the account holder (Stripe requires an adult).
    const holderEmail = c.under_18 ? c.guardian_email : c.creator_email;
    let acct = c.stripe_account_id;
    if (acct && c.stripe_mode && c.stripe_mode !== s.mode) acct = null; // a test account can't take live payments
    if (!acct) {
      const a = await s.stripe.accounts.create({
        type: "express",
        country: "US",
        email: holderEmail || undefined,
        business_type: "individual",
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: c.brand_name, product_description: "Sports photo and video coverage" },
        metadata: { creator_id: c.id, slug: c.slug, holder: c.under_18 ? "parent_or_guardian" : "creator" },
      });
      acct = a.id;
      await sb.from("creators").update({ stripe_account_id: acct, stripe_mode: s.mode, stripe_ready: false, updated_at: new Date().toISOString() }).eq("id", c.id);
    }
    const link = await s.stripe.accountLinks.create({
      account: acct,
      type: "account_onboarding",
      refresh_url: `${APP_BASE()}/app/#creator/${c.id}`,
      return_url: `${APP_BASE()}/app/#creator/${c.id}`,
    });
    await T.logActivity(req.team.email, "started_stripe", c.slug, { mode: s.mode });
    res.json({ url: link.url, mode: s.mode, holder: c.under_18 ? "parent_or_guardian" : "creator", holder_email: holderEmail });
  } catch (e) {
    stripeError(res, e);
  }
});

router.post("/:id/stripe/refresh", member, async (req, res) => {
  let s;
  try {
    s = S.stripe();
  } catch (e) {
    return stripeError(res, e);
  }
  try {
    const x = await withCreator(req, res);
    if (!x) return;
    if (!x.c.stripe_account_id) return res.json({ ready: false, connected: false });
    const a = await s.stripe.accounts.retrieve(x.c.stripe_account_id);
    const ready = !!(a.charges_enabled && a.payouts_enabled);
    await x.sb.from("creators").update({ stripe_ready: ready, updated_at: new Date().toISOString() }).eq("id", x.c.id);
    res.json({ ready, connected: true, details_submitted: !!a.details_submitted, mode: s.mode });
  } catch (e) {
    stripeError(res, e);
  }
});

// ── Public: checkout and the webhook ─────────────────────────────────────
const tries = new Map();
function throttled(req, max = 20, windowMs = 10 * 60 * 1000) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const list = (tries.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  tries.set(ip, list);
  if (tries.size > 5000) tries.clear();
  return list.length > max;
}

async function liveCreatorBySlug(sb, slug) {
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(String(slug))) return null;
  const { data } = await sb.from("creators").select(CREATOR_COLS).eq("slug", slug).maybeSingle();
  if (!data || data.page_status !== "live" || data.status === "paused") return null;
  return data;
}

router.post("/public/:slug/checkout", async (req, res) => {
  if (throttled(req)) return res.status(429).json({ error: "too_many_tries", message: "Too many tries. Wait a few minutes." });
  const sb = getSupabase();
  if (!sb) return sb503(res);
  let s;
  try {
    s = S.stripe();
  } catch (e) {
    return res.status(503).json({ error: e.code || "stripe_not_configured", message: "Checkout isn't switched on yet." });
  }
  try {
    const c = await liveCreatorBySlug(sb, req.params.slug);
    if (!c) return res.status(404).json({ error: "not_found", message: "This page isn't taking orders." });
    if (!c.stripe_account_id || !c.stripe_ready || c.stripe_mode !== s.mode) return res.status(409).json({ error: "payouts_not_ready", message: `${c.brand_name} can't take payments yet.` });
    const b = req.body || {};
    if (b.consent_delivery !== true) return res.status(400).json({ error: "consent_required", message: "Please confirm you're the parent or guardian, or the athlete is 18 or older." });
    const teamJersey = C.clean(b.team_jersey, 80);
    if (!teamJersey) return res.status(400).json({ error: "team_jersey_required", message: "Add the athlete's team and jersey number." });
    const pkg = b.package_id === "team" && c.team_tier && c.team_tier.show ? { id: "team", name: c.team_tier.name, price: c.team_tier.price } : (c.packages || []).find((k) => k.id === b.package_id);
    if (!pkg) return res.status(400).json({ error: "unknown_package", message: "That package isn't available." });
    const amount = Math.round(Number(pkg.price) * 100);
    if (!(amount >= 500)) return res.status(400).json({ error: "bad_price" });
    const sp = C.split(amount, c.split_percent);
    let ev = null;
    if (b.event_code && /^[A-Z0-9]{6}$/.test(String(b.event_code))) {
      const { data } = await sb.from("creator_events").select("id,code,name,status").eq("code", b.event_code).eq("creator_id", c.id).maybeSingle();
      if (data && data.status !== "cancelled") ev = data;
    }
    let crewCode = null;
    if (b.crew_code && /^[A-Z0-9]{4}$/.test(String(b.crew_code))) {
      const { data } = await sb.from("creator_crew").select("code,active").eq("creator_id", c.id).eq("code", b.crew_code).maybeSingle();
      if (data && data.active) crewCode = data.code;
    }
    const md = {
      kind: "creator_lane",
      creator_id: c.id,
      slug: c.slug,
      event_id: ev ? ev.id : "",
      crew_code: crewCode || "",
      package_id: pkg.id,
      package_name: C.clean(pkg.name, 60),
      team_jersey: teamJersey,
      instagram: C.clean(b.instagram, 31).replace(/^@/, ""),
      consent_delivery: "yes",
      consent_public: b.consent_public === true ? "yes" : "no",
      split_percent: String(sp.percent),
      creator_cents: String(sp.creator),
      platform_cents: String(sp.platform),
    };
    const back = `${BASE()}/c/${c.slug}`;
    const session = await s.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amount, product_data: { name: `${c.brand_name} · ${pkg.name}` } } }],
      payment_intent_data: { application_fee_amount: sp.platform, transfer_data: { destination: c.stripe_account_id }, metadata: md },
      metadata: md,
      phone_number_collection: { enabled: true },
      success_url: `${back}?paid=1${ev ? "&e=" + ev.code : ""}`,
      cancel_url: `${back}${ev ? "?e=" + ev.code : ""}`,
    });
    res.json({ url: session.url, mode: s.mode });
  } catch (e) {
    stripeError(res, e);
  }
});

router.post("/stripe/webhook", async (req, res) => {
  const secret = process.env.CREATOR_STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: "webhook_not_configured" });
  let s, event;
  try {
    s = S.stripe();
    event = s.stripe.webhooks.constructEvent(req.rawBody || Buffer.from(""), req.headers["stripe-signature"], secret);
  } catch (e) {
    return res.status(400).json({ error: "bad_signature" });
  }
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const { error: dup } = await sb.from("creator_webhook_events").insert({ event_id: event.id, type: event.type });
    if (dup) {
      if (/duplicate|unique/i.test(dup.message)) return res.json({ received: true, duplicate: true });
      throw new Error(dup.message);
    }
    if (event.type === "checkout.session.completed") {
      const ses = event.data.object;
      const md = ses.metadata || {};
      if (md.kind === "creator_lane" && UUID.test(String(md.creator_id)) && ses.payment_status === "paid") {
        const cd = ses.customer_details || {};
        const amount = Number(ses.amount_total) || 0;
        const creatorCents = Math.min(amount, Number(md.creator_cents) || 0);
        const row = {
          creator_id: md.creator_id,
          event_id: UUID.test(String(md.event_id)) ? md.event_id : null,
          crew_code: /^[A-Z0-9]{4}$/.test(String(md.crew_code)) ? md.crew_code : null,
          package_id: C.clean(md.package_id, 24) || "unknown",
          package_name: C.clean(md.package_name, 60) || "Package",
          amount_cents: amount,
          creator_cents: creatorCents,
          platform_cents: amount - creatorCents,
          buyer_name: C.clean(cd.name, 120) || null,
          buyer_email: cd.email ? String(cd.email).toLowerCase().slice(0, 200) : null,
          buyer_phone: C.clean(cd.phone, 40) || null,
          team_jersey: C.clean(md.team_jersey, 80) || null,
          instagram: C.clean(md.instagram, 31) || null,
          consent_delivery: md.consent_delivery === "yes",
          consent_public: md.consent_public === "yes",
          stripe_session_id: ses.id,
          status: "Paid",
          mode: event.livemode ? "live" : "test",
        };
        const { error } = await sb.from("creator_orders").insert(row);
        if (error && !/duplicate|unique/i.test(error.message)) throw new Error(error.message);
        if (!error) {
          const { data: c } = await sb.from("creators").select("id,brand_name").eq("id", md.creator_id).maybeSingle();
          if (c) P.notifySoon(P.teamEmails("member", "creators"), { title: `New sale for ${c.brand_name}`, body: `${row.package_name} · $${(amount / 100).toFixed(2)}${row.mode === "test" ? " (test)" : ""}`, url: `/app/#creator/${c.id}`, tag: `sale-${c.id}` });
        }
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error("[creators] webhook failed:", event && event.type, e.message);
    // Let Stripe retry: remove the marker so the retry isn't treated as a duplicate.
    try {
      await sb.from("creator_webhook_events").delete().eq("event_id", event.id);
    } catch {}
    res.status(500).json({ error: "webhook_failed" });
  }
});

// ── The page itself (/c/:slug) ───────────────────────────────────────────
pageRouter.get("/:slug", async (req, res) => {
  const sb = getSupabase();
  const notLive = () => {
    res.status(404).setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send("<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='robots' content='noindex'><title>Not live</title><body style='font-family:system-ui,sans-serif;background:#0a0a0a;color:#f5f5f5;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px'><div><h1 style='font-size:22px'>This page isn't live</h1><p style='color:#aaa;margin-top:8px'>Check the link, or ask the creator for a new one.</p></div></body>");
  };
  if (!sb) return notLive();
  try {
    const c = await liveCreatorBySlug(sb, req.params.slug);
    if (!c) return notLive();
    let ev = null;
    const e = String(req.query.e || "").toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(e)) {
      const { data } = await sb.from("creator_events").select("id,code,name,venue,event_date,status").eq("code", e).eq("creator_id", c.id).maybeSingle();
      if (data && data.status !== "cancelled") ev = data;
    }
    const r = String(req.query.r || "").toUpperCase();
    const mode = c.stripe_ready && stripeMode() === c.stripe_mode ? c.stripe_mode : null;
    const n = nonce();
    pageHeaders(res, n);
    res.send(
      renderPage(c, {
        nonce: n,
        event: ev,
        crew: await crewFor(sb, c.id),
        crewCode: /^[A-Z0-9]{4}$/.test(r) ? r : null,
        stripeMode: mode,
        paid: req.query.paid === "1",
        checkoutUrl: `/api/creators/public/${c.slug}/checkout`,
      })
    );
  } catch (err) {
    console.error("[creators] page failed:", err.message);
    notLive();
  }
});

module.exports = router;
module.exports.pageRouter = pageRouter;
