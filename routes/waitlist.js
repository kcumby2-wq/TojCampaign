// TOJ SaaS waitlist capture.
//
// POST /api/waitlist  { email, vertical, source?, meta? }
// GET  /api/waitlist/stats
// GET  /api/waitlist/list   (admin-only — requires session)
//
// Two storage backends, selected at boot:
//   - Supabase (Postgres) if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
//   - JSON file (db/waitlists.json) otherwise
// The dual mode lets us cut over to Supabase without downtime.

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const FILE = path.join(__dirname, "..", "db", "waitlists.json");
const VALID_VERTICALS = new Set([
  "personal-brand",
  "nonprofit",
  "authority",
  "unknown",
]);

// ---- Supabase adapter (lazy-loaded so the JSON path works without the SDK)
let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    supabase = false;
    return false;
  }
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("[waitlist] using Supabase backend");
    return supabase;
  } catch (e) {
    console.warn(
      "[waitlist] SUPABASE_URL set but @supabase/supabase-js missing — falling back to JSON. `npm install @supabase/supabase-js` on the server."
    );
    supabase = false;
    return false;
  }
}

// ---- JSON adapter
function loadJson() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveJson(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// ---- Validation
function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// ---- Routes

router.post("/", async (req, res) => {
  const raw = req.body || {};
  const email = (raw.email || "").toString().trim().toLowerCase();
  const vertical = VALID_VERTICALS.has(raw.vertical) ? raw.vertical : "unknown";
  const source = (raw.source || "").toString().slice(0, 200);
  const meta =
    typeof raw.meta === "object" && raw.meta !== null
      ? JSON.parse(JSON.stringify(raw.meta).slice(0, 2000))
      : {};

  if (!validEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const ip = req.ip || req.headers["x-forwarded-for"] || null;
  const userAgent = (req.headers["user-agent"] || "").slice(0, 300);

  const sb = getSupabase();
  if (sb) {
    // Supabase path
    const { data, error } = await sb
      .from("waitlist")
      .insert({
        email,
        vertical,
        source,
        meta,
        ip,
        user_agent: userAgent,
      })
      .select()
      .single();

    if (error) {
      // Postgres unique constraint on (email, vertical) → dedup
      if (error.code === "23505") {
        return res.json({ ok: true, duplicate: true });
      }
      console.error("[waitlist] supabase insert error", error);
      return res.status(500).json({ error: "storage_error" });
    }
    return res.json({ ok: true, duplicate: false, id: data.id });
  }

  // JSON fallback
  const list = loadJson();
  if (list.find((r) => r.email === email && r.vertical === vertical)) {
    return res.json({ ok: true, duplicate: true });
  }
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    email,
    vertical,
    source,
    meta,
    ip,
    userAgent,
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  saveJson(list);
  res.json({ ok: true, duplicate: false, id: entry.id });
});

router.get("/stats", async (_req, res) => {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("waitlist")
      .select("vertical, created_at");
    if (error) return res.status(500).json({ error: "storage_error" });
    const byVertical = data.reduce((acc, r) => {
      acc[r.vertical] = (acc[r.vertical] || 0) + 1;
      return acc;
    }, {});
    const sorted = data.map((r) => r.created_at).sort();
    return res.json({
      total: data.length,
      byVertical,
      firstAt: sorted[0] || null,
      lastAt: sorted[sorted.length - 1] || null,
      backend: "supabase",
    });
  }
  const list = loadJson();
  const byVertical = list.reduce((acc, r) => {
    acc[r.vertical] = (acc[r.vertical] || 0) + 1;
    return acc;
  }, {});
  res.json({
    total: list.length,
    byVertical,
    firstAt: list[0]?.createdAt || null,
    lastAt: list[list.length - 1]?.createdAt || null,
    backend: "json",
  });
});

// Admin listing — auth-gated. Uses the same session middleware other admin
// routes use. Returns full entries for the admin dashboard.
function requireAdmin(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/list", requireAdmin, async (req, res) => {
  const vertical = req.query.vertical;
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);
  const sb = getSupabase();
  if (sb) {
    let q = sb.from("waitlist").select("*").order("created_at", { ascending: false }).limit(limit);
    if (vertical && VALID_VERTICALS.has(vertical)) q = q.eq("vertical", vertical);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ entries: data, backend: "supabase" });
  }
  const list = loadJson()
    .slice()
    .reverse()
    .filter((r) => !vertical || r.vertical === vertical)
    .slice(0, limit);
  res.json({ entries: list, backend: "json" });
});

module.exports = router;
