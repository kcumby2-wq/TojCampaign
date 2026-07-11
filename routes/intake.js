// Intake router.
//
// Two eras coexist here:
//   1. LEGACY avenue-classifier intake at POST /  (pre-v2, kept alive so any
//      lingering integrations don't 404).
//   2. FOUNDATION SCORE pipeline (v2, Supabase-first with JSON fallback):
//        POST /foundation-score  — public submit from the intake pages
//        POST /transcript        — admin-only: upload the finished report
//
// The v2 pipeline follows the same pattern as routes/waitlist.js:
// Supabase if SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set, otherwise
// JSON files under db/. Zero-downtime cutover.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { ingestClientDocument, payloadToProse } = require("../utils/embed");
const router = express.Router();

const DB_DIR = path.join(__dirname, "..", "db");
const LEGACY_LOG = path.join(DB_DIR, "intake_submissions.json");
const CLIENTS_FILE = path.join(DB_DIR, "clients.json");
const FS_FILE = path.join(DB_DIR, "foundation_scores.json");

const VALID_VERTICALS = new Set(["personal-brand", "nonprofit", "authority"]);
const VALID_TIERS = new Set(["founding", "core", "premium"]);
const PILLAR_KEYS = [
  "brand_identity",
  "operational_health",
  "revenue_architecture",
  "content_credibility",
  "growth_readiness",
];

// ---- Supabase (lazy) ----
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
    console.log("[intake] using Supabase backend");
    return supabase;
  } catch {
    supabase = false;
    return false;
  }
}

// ---- JSON helpers ----
function ensureFile(p) {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "[]", "utf8");
}
function readJson(p) {
  ensureFile(p);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}
function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function validEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

// =====================================================================
//  LEGACY: POST /  (avenue classifier intake, pre-v2)
// =====================================================================
router.post("/", (req, res) => {
  try {
    const payload = req.body || {};
    if (!payload.avenue || !payload.avenue.primary) {
      return res.status(400).json({ error: "Malformed payload: missing avenue.primary" });
    }
    const record = {
      ...payload,
      received_at: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
      user_agent: req.headers["user-agent"] || "",
    };
    ensureFile(LEGACY_LOG);
    const list = readJson(LEGACY_LOG);
    list.push(record);
    writeJson(LEGACY_LOG, list);
    console.log(
      `[LEGACY INTAKE] ${record.received_at} · ${payload.avenue.primary} · ${payload.brand?.email || "no-email"}`
    );
    res.json({ ok: true, id: list.length });
  } catch (err) {
    console.error("[LEGACY INTAKE] error:", err);
    res.status(500).json({ error: "Server error, please try again" });
  }
});

router.get("/", (_req, res) => {
  res.json({ count: readJson(LEGACY_LOG).length, submissions: readJson(LEGACY_LOG) });
});

// =====================================================================
//  V2: POST /foundation-score
//  Body: { vertical, intake_version, payload, contact_email,
//          operator_name, business_name }
// =====================================================================
router.post("/foundation-score", async (req, res) => {
  const raw = req.body || {};
  const vertical = raw.vertical;
  const intake_version = (raw.intake_version || "v1").toString().slice(0, 20);
  const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : null;
  const contact_email = (raw.contact_email || raw.email || "").toString().trim().toLowerCase();
  const operator_name = (raw.operator_name || raw.brand_name || "").toString().slice(0, 200);
  const business_name = (raw.business_name || "").toString().slice(0, 200);

  if (!VALID_VERTICALS.has(vertical))
    return res.status(400).json({ error: "invalid_vertical" });
  if (!validEmail(contact_email))
    return res.status(400).json({ error: "invalid_email" });
  if (!payload)
    return res.status(400).json({ error: "missing_payload" });

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const user_agent = (req.headers["user-agent"] || "").slice(0, 300);
  const sb = getSupabase();

  if (sb) {
    // Upsert client
    const { data: clientRow, error: cErr } = await sb
      .from("clients")
      .upsert(
        {
          email: contact_email,
          operator_name: operator_name || null,
          business_name: business_name || null,
          vertical,
          tier: "founding",
          monthly_price_usd: 99,
          status: "pilot",
        },
        { onConflict: "email" }
      )
      .select()
      .single();
    if (cErr) {
      console.error("[intake] client upsert error", cErr);
      return res.status(500).json({ error: "storage_error" });
    }

    // Insert foundation_score
    const { data: fsRow, error: fErr } = await sb
      .from("foundation_scores")
      .insert({
        client_id: clientRow.id,
        vertical,
        intake_payload: payload,
        intake_version,
      })
      .select()
      .single();
    if (fErr) {
      console.error("[intake] foundation_score insert error", fErr);
      return res.status(500).json({ error: "storage_error" });
    }

    console.log(
      `[INTAKE v2] Supabase · ${vertical} · ${contact_email} · fs=${fsRow.id}`
    );

    // Fire-and-forget: embed the intake so agents can retrieve it later.
    // Failure logs but does not affect the intake response.
    setImmediate(() => {
      const prose =
        `Vertical: ${vertical}\n` +
        `Operator: ${operator_name || "n/a"}\n` +
        `Business: ${business_name || "n/a"}\n\n` +
        payloadToProse(payload);
      ingestClientDocument(sb, {
        client_id: clientRow.id,
        source_type: "foundation_score",
        source_ref: fsRow.id,
        title: `Foundation Score intake — ${business_name || operator_name || contact_email}`,
        content: prose,
        metadata: { vertical, intake_version },
      })
        .then((r) =>
          console.log(
            `[RAG] ingest fs=${fsRow.id} → ${r.ok ? `${r.chunks} chunks` : `FAIL ${r.error}`}`
          )
        )
        .catch((e) => console.error("[RAG] ingest crashed:", e.message));
    });

    return res.json({
      ok: true,
      foundation_score_id: fsRow.id,
      client_id: clientRow.id,
    });
  }

  // ---- JSON fallback ----
  const clients = readJson(CLIENTS_FILE);
  let client = clients.find((c) => c.email === contact_email);
  const now = new Date().toISOString();
  if (client) {
    if (operator_name) client.operator_name = operator_name;
    if (business_name) client.business_name = business_name;
    client.updated_at = now;
  } else {
    client = {
      id: newId(),
      email: contact_email,
      operator_name: operator_name || null,
      business_name: business_name || null,
      vertical,
      tier: "founding",
      monthly_price_usd: 99,
      status: "pilot",
      created_at: now,
      updated_at: now,
    };
    clients.push(client);
  }
  writeJson(CLIENTS_FILE, clients);

  const scores = readJson(FS_FILE);
  const fs_entry = {
    id: newId(),
    client_id: client.id,
    vertical,
    intake_payload: payload,
    intake_version,
    submitted_at: now,
    pillar_scores: null,
    transcript_url: null,
    transcript_delivered_at: null,
    proposal_tier: null,
    proposal_url: null,
    ip,
    user_agent,
  };
  scores.push(fs_entry);
  writeJson(FS_FILE, scores);

  console.log(
    `[INTAKE v2] JSON · ${vertical} · ${contact_email} · fs=${fs_entry.id}`
  );
  res.json({
    ok: true,
    foundation_score_id: fs_entry.id,
    client_id: client.id,
  });
});

// =====================================================================
//  V2: POST /transcript  (admin-only)
//  Body: { foundation_score_id, transcript_url, pillar_scores,
//          proposal_tier, proposal_url }
// =====================================================================
router.post("/transcript", requireAdmin, async (req, res) => {
  const {
    foundation_score_id,
    transcript_url,
    pillar_scores,
    proposal_tier,
    proposal_url,
  } = req.body || {};

  if (!foundation_score_id)
    return res.status(400).json({ error: "missing_foundation_score_id" });
  if (transcript_url && typeof transcript_url !== "string")
    return res.status(400).json({ error: "invalid_transcript_url" });
  if (proposal_tier && !VALID_TIERS.has(proposal_tier))
    return res.status(400).json({ error: "invalid_proposal_tier" });

  const cleanedScores = {};
  if (pillar_scores && typeof pillar_scores === "object") {
    for (const k of PILLAR_KEYS) {
      const v = Number(pillar_scores[k]);
      if (Number.isFinite(v) && v >= 0 && v <= 100) cleanedScores[k] = v;
    }
  }

  const patch = {};
  if (transcript_url) {
    patch.transcript_url = transcript_url;
    patch.transcript_delivered_at = new Date().toISOString();
  }
  if (Object.keys(cleanedScores).length) patch.pillar_scores = cleanedScores;
  if (proposal_tier) patch.proposal_tier = proposal_tier;
  if (proposal_url) patch.proposal_url = proposal_url;

  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: "no_changes" });

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("foundation_scores")
      .update(patch)
      .eq("id", foundation_score_id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ ok: true, foundation_score: data });
  }
  const scores = readJson(FS_FILE);
  const i = scores.findIndex((r) => r.id === foundation_score_id);
  if (i < 0) return res.status(404).json({ error: "not_found" });
  scores[i] = { ...scores[i], ...patch };
  writeJson(FS_FILE, scores);
  res.json({ ok: true, foundation_score: scores[i] });
});

module.exports = router;
