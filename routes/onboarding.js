// Onboarding intake router — the unified front door for the whole TOJ /
// Subject ecosystem: athletes, coaches/trainers, and branch partners.
//
// Why this exists alongside routes/intake.js:
//   routes/intake.js is the BUSINESS foundation-score pipeline (operators →
//   clients table). This router onboards PEOPLE (athletes, coaches) and BRANCH
//   partners, many of them minors, into a dedicated onboarding_intakes table
//   with the child-safety consent gate as a first-class concern.
//
// Pattern matches waitlist.js / admin.js: Supabase if SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are set, else JSON fallback under db/. Zero-
// downtime cutover. Migration: db/migrations/009_onboarding_intakes.sql.
//
// Endpoints:
//   POST /                 public submit from any intake front-end
//   GET  /list             admin — the Intake CRM table
//   GET  /stats            admin — the CRM rollup cards
//   PATCH /:id             admin — status / assigned_agent / consent updates
//
// CHILD-SAFETY (load-bearing — do not weaken without the data-handling review):
//   * A minor's intake may be STORED (Supabase is the private store, outside
//     git) but is NEVER embedded to the agent RAG (client_documents /
//     client_embeddings) unless guardian consent is c3+ (named-internal or
//     named-public). Below that, the row sits in the CRM for a human to work,
//     and nothing about the minor reaches an agent.
//   * consent_status starts 'pending' for minors, 'not_required' for adults.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { ingestClientDocument, payloadToProse } = require("../utils/embed");

const router = express.Router();

const DB_DIR = path.join(__dirname, "..", "db");
const FILE = path.join(DB_DIR, "onboarding_intakes.json");

const VALID_AUDIENCES = new Set([
  "athlete",
  "coach",
  "branch",
  "business",
  "creator",
]);
const VALID_BRANCHES = new Set([
  "subject-medias",
  "subject-report",
  "subject-skillz",
  "coached-by-hooks",
  "flippa-highlights",
  "optimum-grading",
  "pylon",
  "trail-of-joy",
]);
const VALID_STATUS = new Set([
  "new",
  "reviewing",
  "contacted",
  "onboarding",
  "active",
  "declined",
]);
const VALID_CONSENT_LEVEL = new Set(["c0", "c1", "c2", "c3", "c4"]);
const VALID_CONSENT_STATUS = new Set([
  "not_required",
  "pending",
  "granted",
  "revoked",
]);

// Consent levels at which a minor's identifying intake may be embedded to the
// agent RAG. c3 = named-internal, c4 = named-public. c0-c2 never embed.
const EMBED_OK_MINOR_LEVELS = new Set(["c3", "c4"]);

// ---- Supabase (lazy) ----
let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    supabase = false;
    return false;
  }
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    console.log("[onboarding] using Supabase backend");
    return supabase;
  } catch (e) {
    console.error("[onboarding] Supabase init failed:", e.message);
    supabase = false;
    return false;
  }
}

// ---- JSON helpers ----
function ensureFile() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "[]", "utf8");
}
function loadJson() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8") || "[]");
  } catch {
    return [];
  }
}
function saveJson(list) {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), "utf8");
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

// Decide consent_status + whether we may embed, given minor flag + level.
function resolveConsent(isMinor, level) {
  if (!isMinor) return { consent_status: "not_required", mayEmbed: true };
  // minor:
  if (!level || !EMBED_OK_MINOR_LEVELS.has(level)) {
    // c0/c1/c2/none → stored, worked by a human, never sent to an agent.
    return {
      consent_status: level === "c0" ? "pending" : "pending",
      mayEmbed: false,
    };
  }
  // c3 / c4 — guardian has granted named use.
  return { consent_status: "granted", mayEmbed: true };
}

// =====================================================================
//  POST /  — public submit
//  Body: {
//    audience, branch?, subject_name?, is_minor?,
//    contact_email, contact_phone?,
//    guardian_name?, guardian_email?, consent_level?,
//    payload{}, intake_version?, source?
//  }
// =====================================================================
router.post("/", async (req, res) => {
  const raw = req.body || {};

  const audience = (raw.audience || "").toString();
  if (!VALID_AUDIENCES.has(audience))
    return res.status(400).json({ error: "invalid_audience" });

  const branch = raw.branch ? raw.branch.toString() : null;
  if (branch && !VALID_BRANCHES.has(branch))
    return res.status(400).json({ error: "invalid_branch" });

  const is_minor = raw.is_minor === true || raw.is_minor === "true";
  const subject_name = (raw.subject_name || "").toString().slice(0, 200) || null;
  const contact_email = (raw.contact_email || raw.email || "")
    .toString()
    .trim()
    .toLowerCase();
  const contact_phone = (raw.contact_phone || "").toString().slice(0, 40) || null;
  const guardian_name =
    (raw.guardian_name || "").toString().slice(0, 200) || null;
  const guardian_email = (raw.guardian_email || "")
    .toString()
    .trim()
    .toLowerCase();
  const consent_level =
    raw.consent_level && VALID_CONSENT_LEVEL.has(raw.consent_level)
      ? raw.consent_level
      : null;
  const payload =
    raw.payload && typeof raw.payload === "object" ? raw.payload : {};
  const intake_version = (raw.intake_version || "v1").toString().slice(0, 20);
  const source = (raw.source || "").toString().slice(0, 200) || null;

  // A reachable adult email is required. For a minor that's the guardian.
  const reachable = is_minor ? guardian_email || contact_email : contact_email;
  if (!validEmail(reachable))
    return res
      .status(400)
      .json({ error: is_minor ? "invalid_guardian_email" : "invalid_email" });

  // Child-safety gate.
  if (is_minor && !guardian_email) {
    return res.status(400).json({ error: "guardian_email_required_for_minor" });
  }
  const { consent_status, mayEmbed } = resolveConsent(is_minor, consent_level);

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;
  const user_agent = (req.headers["user-agent"] || "").slice(0, 300);
  const now = new Date().toISOString();

  const record = {
    audience,
    branch,
    subject_name,
    is_minor,
    contact_email: contact_email || null,
    contact_phone,
    guardian_name,
    guardian_email: guardian_email || null,
    consent_level,
    consent_status,
    payload,
    intake_version,
    status: "new",
    assigned_agent: null,
    embedded: false,
    source,
    ip: typeof ip === "string" ? ip.slice(0, 100) : null,
    user_agent,
  };

  const sb = getSupabase();

  // Embed only when the gate allows it AND we have a Supabase to embed into.
  // For minors we additionally strip identity from the prose (belt + braces):
  // the RAG stores the intake content, not "who", unless c4 (public) named use.
  function maybeEmbed(sb, rowId, clientKey) {
    if (!mayEmbed || !sb) return;
    setImmediate(() => {
      const publicNamed = is_minor && consent_level === "c4";
      const nameLine =
        !is_minor || publicNamed
          ? `Subject: ${subject_name || "n/a"}\n`
          : ""; // minors below c4: no name into the vector store
      const prose =
        `Audience: ${audience}\n` +
        (branch ? `Branch: ${branch}\n` : "") +
        nameLine +
        payloadToProse(payload);
      ingestClientDocument(sb, {
        client_id: clientKey, // reuse client_documents.client_id as the intake key
        source_type: "onboarding_intake",
        source_ref: rowId,
        title: `Onboarding intake — ${audience}${branch ? " · " + branch : ""}`,
        content: prose,
        metadata: { audience, branch, intake_version, is_minor },
      })
        .then((r) => {
          console.log(
            `[onboarding][RAG] ${rowId} → ${
              r.ok ? `${r.chunks} chunks` : `FAIL ${r.error}`
            }`
          );
          if (r.ok && sb) {
            sb.from("onboarding_intakes")
              .update({ embedded: true })
              .eq("id", rowId)
              .then(() => {});
          }
        })
        .catch((e) => console.error("[onboarding][RAG] crashed:", e.message));
    });
  }

  if (sb) {
    const { data, error } = await sb
      .from("onboarding_intakes")
      .insert(record)
      .select()
      .single();
    if (error) {
      console.error("[onboarding] insert error", error);
      return res.status(500).json({ error: "storage_error" });
    }
    console.log(
      `[ONBOARDING] Supabase · ${audience}${branch ? "/" + branch : ""} · minor=${is_minor} · consent=${consent_status} · id=${data.id}`
    );
    maybeEmbed(sb, data.id, data.id);
    return res.json({
      ok: true,
      id: data.id,
      consent_status,
      embedded_queued: mayEmbed,
    });
  }

  // ---- JSON fallback ----
  const list = loadJson();
  const entry = { id: newId(), ...record, created_at: now, updated_at: now };
  list.push(entry);
  saveJson(list);
  console.log(
    `[ONBOARDING] JSON · ${audience}${branch ? "/" + branch : ""} · minor=${is_minor} · consent=${consent_status} · id=${entry.id}`
  );
  // No embedding without Supabase (RAG lives in Supabase). That's fine — the
  // JSON path is the dev/degraded path; embedding resumes on the Supabase path.
  return res.json({
    ok: true,
    id: entry.id,
    consent_status,
    embedded_queued: false,
  });
});

// =====================================================================
//  GET /list  (admin) — the Intake CRM
//  Query: audience?, branch?, status?, consent?, limit?
// =====================================================================
router.get("/list", requireAdmin, async (req, res) => {
  const { audience, branch, status, consent } = req.query;
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);

  const sb = getSupabase();
  if (sb) {
    let q = sb
      .from("onboarding_intakes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (audience && VALID_AUDIENCES.has(audience)) q = q.eq("audience", audience);
    if (branch && VALID_BRANCHES.has(branch)) q = q.eq("branch", branch);
    if (status && VALID_STATUS.has(status)) q = q.eq("status", status);
    if (consent && VALID_CONSENT_STATUS.has(consent))
      q = q.eq("consent_status", consent);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ entries: data, backend: "supabase" });
  }

  let list = loadJson().slice().reverse();
  if (audience) list = list.filter((r) => r.audience === audience);
  if (branch) list = list.filter((r) => r.branch === branch);
  if (status) list = list.filter((r) => r.status === status);
  if (consent) list = list.filter((r) => r.consent_status === consent);
  res.json({ entries: list.slice(0, limit), backend: "json" });
});

// =====================================================================
//  GET /stats  (admin) — rollup for the CRM cards
// =====================================================================
router.get("/stats", requireAdmin, async (_req, res) => {
  const sb = getSupabase();
  let rows = [];
  let backend = "json";
  if (sb) {
    backend = "supabase";
    const { data, error } = await sb
      .from("onboarding_intakes")
      .select("audience, branch, status, consent_status, is_minor, created_at");
    if (error) return res.status(500).json({ error: "storage_error" });
    rows = data || [];
  } else {
    rows = loadJson();
  }
  const tally = (key) =>
    rows.reduce((acc, r) => {
      const k = r[key] || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
  res.json({
    backend,
    total: rows.length,
    minors: rows.filter((r) => r.is_minor).length,
    consent_pending: rows.filter(
      (r) => r.is_minor && r.consent_status === "pending"
    ).length,
    byAudience: tally("audience"),
    byBranch: tally("branch"),
    byStatus: tally("status"),
    byConsent: tally("consent_status"),
  });
});

// =====================================================================
//  PATCH /:id  (admin) — advance the pipeline / assign an agent / consent
// =====================================================================
router.patch("/:id", requireAdmin, async (req, res) => {
  const id = req.params.id;
  const patch = {};
  const body = req.body || {};
  if ("status" in body) {
    if (!VALID_STATUS.has(body.status))
      return res.status(400).json({ error: "invalid_status" });
    patch.status = body.status;
  }
  if ("assigned_agent" in body)
    patch.assigned_agent = body.assigned_agent
      ? String(body.assigned_agent).slice(0, 120)
      : null;
  if ("consent_level" in body) {
    if (body.consent_level && !VALID_CONSENT_LEVEL.has(body.consent_level))
      return res.status(400).json({ error: "invalid_consent_level" });
    patch.consent_level = body.consent_level || null;
  }
  if ("consent_status" in body) {
    if (!VALID_CONSENT_STATUS.has(body.consent_status))
      return res.status(400).json({ error: "invalid_consent_status" });
    patch.consent_status = body.consent_status;
  }
  if (Object.keys(patch).length === 0)
    return res.status(400).json({ error: "no_changes" });

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from("onboarding_intakes")
      .update(patch)
      .eq("id", id)
      .select()
      .single();
    if (error) return res.status(500).json({ error: "storage_error" });
    return res.json({ ok: true, entry: data });
  }
  const list = loadJson();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return res.status(404).json({ error: "not_found" });
  list[i] = { ...list[i], ...patch, updated_at: new Date().toISOString() };
  saveJson(list);
  res.json({ ok: true, entry: list[i] });
});

module.exports = router;
