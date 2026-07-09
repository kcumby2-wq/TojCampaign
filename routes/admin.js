// Admin API — dashboard endpoints. Session-authed like the other admin routes.
// Pilots table: uses Supabase if configured, else db/pilots.json fallback.
//
// Endpoints:
//   GET  /api/admin/pilots
//   POST /api/admin/pilots        create
//   PATCH /api/admin/pilots/:id   update
//   GET  /api/admin/dashboard     rollup: waitlist + pilots + verticals

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const PILOTS_FILE = path.join(__dirname, "..", "db", "pilots.json");
const WAITLIST_FILE = path.join(__dirname, "..", "db", "waitlists.json");
const VALID_VERTICALS = new Set(["personal-brand", "nonprofit", "authority"]);
const VALID_TIERS = new Set(["founding", "core", "premium"]);
const VALID_STATUS = new Set([
  "prospect",
  "committed",
  "signed",
  "onboarded",
  "declined",
  "sunset",
]);

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
    return supabase;
  } catch {
    supabase = false;
    return false;
  }
}

function loadJson(f) {
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return [];
  }
}
function saveJson(f, list) {
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// All admin routes require an authenticated session.
router.use((req, res, next) => {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
});

// ---- Pilots

router.get("/pilots", async (req, res) => {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("pilots")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ pilots: data, backend: "supabase" });
  }
  res.json({ pilots: loadJson(PILOTS_FILE).slice().reverse(), backend: "json" });
});

router.post("/pilots", async (req, res) => {
  const {
    operator_name,
    business_name,
    contact_email,
    vertical,
    intended_tier,
    status,
    notes,
  } = req.body || {};
  if (!contact_email) return res.status(400).json({ error: "email_required" });
  if (vertical && !VALID_VERTICALS.has(vertical))
    return res.status(400).json({ error: "invalid_vertical" });
  if (intended_tier && !VALID_TIERS.has(intended_tier))
    return res.status(400).json({ error: "invalid_tier" });
  const st = status || "prospect";
  if (!VALID_STATUS.has(st)) return res.status(400).json({ error: "invalid_status" });

  const entry = {
    operator_name: operator_name || null,
    business_name: business_name || null,
    contact_email,
    vertical: vertical || null,
    intended_tier: intended_tier || null,
    status: st,
    notes: notes || null,
  };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from("pilots").insert(entry).select().single();
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ pilot: data });
  }
  const list = loadJson(PILOTS_FILE);
  const withMeta = {
    id: newId(),
    ...entry,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  list.push(withMeta);
  saveJson(PILOTS_FILE, list);
  res.json({ pilot: withMeta });
});

router.patch("/pilots/:id", async (req, res) => {
  const id = req.params.id;
  const patch = {};
  const allowed = [
    "operator_name",
    "business_name",
    "contact_email",
    "vertical",
    "intended_tier",
    "status",
    "notes",
    "commit_signed_at",
    "onboarded_at",
  ];
  for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
  if (patch.vertical && !VALID_VERTICALS.has(patch.vertical))
    return res.status(400).json({ error: "invalid_vertical" });
  if (patch.intended_tier && !VALID_TIERS.has(patch.intended_tier))
    return res.status(400).json({ error: "invalid_tier" });
  if (patch.status && !VALID_STATUS.has(patch.status))
    return res.status(400).json({ error: "invalid_status" });

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("pilots")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ pilot: data });
  }
  const list = loadJson(PILOTS_FILE);
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return res.status(404).json({ error: "not_found" });
  list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() };
  saveJson(PILOTS_FILE, list);
  res.json({ pilot: list[i] });
});

// ---- Combined dashboard rollup

router.get("/dashboard", async (_req, res) => {
  const sb = getSupabase();
  let waitlist = [];
  let pilots = [];
  let backend = "json";
  if (sb) {
    backend = "supabase";
    const [wRes, pRes] = await Promise.all([
      sb.from("waitlist").select("vertical, created_at"),
      sb.from("pilots").select("*"),
    ]);
    waitlist = wRes.data || [];
    pilots = pRes.data || [];
  } else {
    waitlist = loadJson(WAITLIST_FILE).map((r) => ({
      vertical: r.vertical,
      created_at: r.createdAt,
    }));
    pilots = loadJson(PILOTS_FILE);
  }
  const waitlistByVertical = waitlist.reduce((acc, r) => {
    acc[r.vertical] = (acc[r.vertical] || 0) + 1;
    return acc;
  }, {});
  const pilotsByStatus = pilots.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  const pilotsByVertical = pilots.reduce((acc, r) => {
    if (r.vertical) acc[r.vertical] = (acc[r.vertical] || 0) + 1;
    return acc;
  }, {});
  res.json({
    backend,
    waitlist: {
      total: waitlist.length,
      byVertical: waitlistByVertical,
    },
    pilots: {
      total: pilots.length,
      byStatus: pilotsByStatus,
      byVertical: pilotsByVertical,
    },
  });
});

module.exports = router;
