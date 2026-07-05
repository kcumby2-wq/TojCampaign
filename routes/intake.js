const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();

// File-based intake log — writes every submission to db/intake_submissions.json
// so nothing gets lost while the real CRM/webhook is being wired up.
const LOG_PATH = path.join(__dirname, "..", "db", "intake_submissions.json");

function ensureDb() {
  const dbDir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, "[]", "utf8");
}

router.post("/", (req, res) => {
  try {
    const payload = req.body || {};

    // Server-side sanity — reject if avenue is missing
    if (!payload.avenue || !payload.avenue.primary) {
      return res.status(400).json({ error: "Malformed payload: missing avenue.primary" });
    }

    // Enrich with server-side context
    const record = {
      ...payload,
      received_at: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
      user_agent: req.headers["user-agent"] || "",
    };

    // Persist to the file log
    ensureDb();
    const raw = fs.readFileSync(LOG_PATH, "utf8");
    const list = JSON.parse(raw || "[]");
    list.push(record);
    fs.writeFileSync(LOG_PATH, JSON.stringify(list, null, 2), "utf8");

    // Also print to console so it shows in server logs / Render logs
    console.log(
      `[INTAKE] ${record.received_at} · ${payload.avenue.primary} (${Math.round((payload.avenue.confidence || 0) * 100)}%) · ${payload.brand?.email || "no-email"} · tags=${(payload.tags || []).join(",")}`
    );

    // TODO: Wire outbound webhook to your CRM / GHL / Zapier here.
    // Example:
    //   fetch(process.env.GHL_WEBHOOK_URL, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify(record),
    //   }).catch(err => console.error("GHL forward failed:", err.message));

    res.json({ ok: true, id: list.length });
  } catch (err) {
    console.error("[INTAKE] error:", err);
    res.status(500).json({ error: "Server error, please try again" });
  }
});

// Simple admin viewer — protect this in production
router.get("/", (req, res) => {
  try {
    ensureDb();
    const raw = fs.readFileSync(LOG_PATH, "utf8");
    const list = JSON.parse(raw || "[]");
    res.json({ count: list.length, submissions: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
