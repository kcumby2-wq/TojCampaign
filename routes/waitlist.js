// TOJ SaaS waitlist capture.
// POST /api/waitlist  { email, vertical, source?, meta? }
// Stores in db/waitlists.json; dedupes by (email, vertical).

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

function load() {
  if (!fs.existsSync(FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}
function save(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

router.post("/", (req, res) => {
  const raw = req.body || {};
  const email = (raw.email || "").toString().trim().toLowerCase();
  const vertical = VALID_VERTICALS.has(raw.vertical)
    ? raw.vertical
    : "unknown";
  const source = (raw.source || "").toString().slice(0, 200);
  const meta =
    typeof raw.meta === "object" && raw.meta !== null
      ? JSON.parse(JSON.stringify(raw.meta).slice(0, 2000))
      : {};

  if (!validEmail(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const list = load();
  const already = list.find(
    (r) => r.email === email && r.vertical === vertical
  );
  if (already) {
    return res.json({ ok: true, duplicate: true });
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    email,
    vertical,
    source,
    meta,
    ip: req.ip || req.headers["x-forwarded-for"] || null,
    userAgent: (req.headers["user-agent"] || "").slice(0, 300),
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  save(list);

  res.json({ ok: true, duplicate: false });
});

// GET /api/waitlist/stats — private-ish snapshot (no PII); useful for the founders.
router.get("/stats", (_req, res) => {
  const list = load();
  const byVertical = list.reduce((acc, r) => {
    acc[r.vertical] = (acc[r.vertical] || 0) + 1;
    return acc;
  }, {});
  res.json({
    total: list.length,
    byVertical,
    firstAt: list[0]?.createdAt || null,
    lastAt: list[list.length - 1]?.createdAt || null,
  });
});

module.exports = router;
