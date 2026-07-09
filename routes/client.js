// Client portal API — endpoints for authenticated pilots.
//
// GET /api/client/me
//   Returns the signed-in client's profile, latest Foundation Score /
//   Operational Transcript, and recent deliverables. Portal (public/client.html)
//   hydrates from this.
//
// Supabase-first with JSON fallback, matching routes/waitlist.js and
// routes/intake.js.

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const DB_DIR = path.join(__dirname, "..", "db");
const CLIENTS_FILE = path.join(DB_DIR, "clients.json");
const FS_FILE = path.join(DB_DIR, "foundation_scores.json");
const DEL_FILE = path.join(DB_DIR, "deliverables.json");

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

function readJson(p) {
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
  } catch {
    return [];
  }
}

function requireSession(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/me", requireSession, async (req, res) => {
  const email = req.session.userEmail.toString().trim().toLowerCase();
  const sb = getSupabase();

  if (sb) {
    // Client
    const { data: client, error: cErr } = await sb
      .from("clients")
      .select("*")
      .eq("email", email)
      .maybeSingle();
    if (cErr) return res.status(500).json({ error: "storage_error" });
    if (!client) return res.status(404).json({ error: "no_client_record" });

    // Latest Foundation Score / Transcript
    const { data: transcripts } = await sb
      .from("foundation_scores")
      .select("*")
      .eq("client_id", client.id)
      .order("submitted_at", { ascending: false })
      .limit(1);
    const transcript = transcripts && transcripts[0] ? transcripts[0] : null;

    // Recent deliverables
    const { data: deliverables } = await sb
      .from("deliverables")
      .select("kind, title, description, file_url, delivered_at, delivered_by")
      .eq("client_id", client.id)
      .order("delivered_at", { ascending: false })
      .limit(20);

    return res.json({
      email,
      operator_name: client.operator_name,
      business_name: client.business_name,
      vertical: client.vertical,
      tier: client.tier,
      status: client.status,
      transcript: transcript
        ? {
            transcript_url: transcript.transcript_url,
            transcript_delivered_at: transcript.transcript_delivered_at,
            pillar_scores: transcript.pillar_scores,
            proposal_tier: transcript.proposal_tier,
            proposal_url: transcript.proposal_url,
          }
        : null,
      deliverables: deliverables || [],
    });
  }

  // ---- JSON fallback ----
  const clients = readJson(CLIENTS_FILE);
  const client = clients.find((c) => c.email === email);
  if (!client) return res.status(404).json({ error: "no_client_record" });

  const scores = readJson(FS_FILE)
    .filter((r) => r.client_id === client.id)
    .sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""));
  const transcript = scores[0] || null;

  const deliverables = readJson(DEL_FILE)
    .filter((r) => r.client_id === client.id)
    .sort((a, b) => (b.delivered_at || "").localeCompare(a.delivered_at || ""))
    .slice(0, 20);

  res.json({
    email,
    operator_name: client.operator_name,
    business_name: client.business_name,
    vertical: client.vertical,
    tier: client.tier,
    status: client.status,
    transcript: transcript
      ? {
          transcript_url: transcript.transcript_url,
          transcript_delivered_at: transcript.transcript_delivered_at,
          pillar_scores: transcript.pillar_scores,
          proposal_tier: transcript.proposal_tier,
          proposal_url: transcript.proposal_url,
        }
      : null,
    deliverables,
  });
});

module.exports = router;
