// Operating Systems API — the OS builder in the TOJ app (Tools → Operating
// Systems). A client's operating system walks the trail in the same order as
// the site and its launch video (utils/os.js STAGES):
//
//   door → Foundation Score intake → five pillars → Operational Transcript →
//   Intake / Delivery / Follow-up installed → running (and the operating brain)
//
// Team (the "os" tool; utils/team.js):
//   GET    /api/os                          list                                  viewer
//   GET    /api/os/intakes                  Foundation Score submissions to use   member
//   POST   /api/os                          new build (door, name, intake)        member
//   GET    /api/os/:id                      one build                             viewer
//   PATCH  /api/os/:id                      name, client email, intake, systems   member
//   POST   /api/os/:id/scores/draft         an agent drafts the five pillars      member
//   PUT    /api/os/:id/scores               save hand edits to the draft          member
//   POST   /api/os/:id/scores/approve       the draft becomes the scores          approver
//   POST   /api/os/:id/transcript/draft     an agent drafts the transcript        member
//   PUT    /api/os/:id/transcript           save hand edits to the draft          member
//   GET    /api/os/:id/transcript.html      ?v=draft|approved                     viewer
//   POST   /api/os/:id/transcript/approve   approve; into the client portal       approver
//   POST   /api/os/:id/install              start installing the systems          member
//   POST   /api/os/:id/brain                generate the operating brain          member
//   GET    /api/os/:id/brain                its files                             viewer
//   GET    /api/os/:id/brain.zip            download                              member
//   POST   /api/os/:id/running              every system live: hand it off        approver
//
// Client portal:
//   GET    /api/os/client/:id/transcript    the approved transcript, for the client whose email it is
//
// Agents only draft; a person approves. Authority builds can hold minors' data,
// so they're owner-only. Logs carry ids, never names or contact details.

"use strict";

const express = require("express");
const crypto = require("crypto");
const T = require("../utils/team");
const O = require("../utils/os");
const AI = require("../utils/os-ai");
const P = require("../utils/push");
const { renderTranscript } = require("../utils/os-transcript");
const { brainFiles } = require("../utils/os-brain");
const { zip } = require("../utils/zip");
const { getSupabase } = require("../utils/supabase");
const { isStaff, staffEmails, ROLES } = require("../utils/staff");

const router = express.Router();
const viewer = T.requireTeam("os", "viewer");
const member = T.requireTeam("os", "member");
const approver = T.requireTeam("os", "approver");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STALE_MS = 10 * 60 * 1000;
const BASE = () => String(process.env.CREATOR_PAGE_BASE || process.env.PUBLIC_BASE_URL || "https://tojcampaign.com").replace(/\/+$/, "");

function now() {
  return new Date().toISOString();
}
function sb503(res) {
  return res.status(503).json({ error: "supabase_unavailable" });
}
function fail(res, e, what) {
  console.error(`[os] ${what} failed:`, e && e.message);
  return res.status(500).json({ error: `${what}_failed` });
}
function rank(stage) {
  return O.STAGE_RANK[stage] ?? 0;
}
// What the activity feed and notifications may say about a build.
function subjectFor(b) {
  return b.vertical === "authority" ? "an Authority operating system" : O.displayName(b.intake, b.name);
}
function canSee(team, b) {
  return b.vertical !== "authority" || team.owner;
}
function stale(status, startedAt) {
  return status === "running" && (!startedAt || Date.now() - new Date(startedAt).getTime() > STALE_MS);
}

async function load(sb, id) {
  if (!UUID.test(String(id))) return null;
  const { data, error } = await sb.from("os_builds").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}
// Load + access check. Sends the error response itself and returns null.
async function withBuild(req, res) {
  const sb = getSupabase();
  if (!sb) {
    sb503(res);
    return null;
  }
  const b = await load(sb, req.params.id);
  if (!b || !canSee(req.team, b)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  return { sb, b };
}
async function save(sb, id, patch) {
  const { data, error } = await sb.from("os_builds").update({ ...patch, updated_at: now() }).eq("id", id).select("*").single();
  if (error) throw new Error(error.message);
  return data;
}

// The build as the app sees it. Viewers don't get the client's contact details.
function view(b, team) {
  const mem = T.can(team, "os", "member");
  const sd = b.score_draft || null;
  const td = b.transcript_draft || null;
  const prog = O.systemsProgress(b.systems);
  return {
    id: b.id,
    name: O.displayName(b.intake, b.name),
    vertical: b.vertical,
    lane: O.VERTICALS[b.vertical],
    stage: b.stage,
    stage_n: rank(b.stage) + 1,
    contact_email: mem ? b.contact_email || null : undefined,
    linked_to_portal: !!(b.client_id && b.foundation_score_id),
    intake_source: b.intake_source,
    intake: (mem ? O.intakeRows(b.intake) : O.intakeRows(b.intake, { forModel: true })).filter((r) => mem || !O.MINOR_KEYS.includes(r.key)),
    intake_raw: mem ? b.intake || {} : undefined,
    intake_at: b.intake_at,
    transcript_due: O.transcriptDue(b.intake_at),
    score: {
      status: stale(b.score_status, b.score_started_at) ? "failed" : b.score_status,
      error: stale(b.score_status, b.score_started_at) ? "stopped" : b.score_error,
      draft: sd,
      approved: b.pillars || null,
      approved_by: b.pillars_approved_by,
      approved_at: b.pillars_approved_at,
      total: b.pillars ? O.totalScore(b.pillars) : null,
      weakest: b.pillars ? O.weakest(b.pillars) : null,
    },
    transcript: {
      status: stale(b.transcript_status, b.transcript_started_at) ? "failed" : b.transcript_status,
      error: stale(b.transcript_status, b.transcript_started_at) ? "stopped" : b.transcript_error,
      draft: td,
      blockers: td ? O.transcriptBlockers(td) : [],
      approved: !!b.transcript,
      approved_by: b.transcript_approved_by,
      approved_at: b.transcript_approved_at,
      published_at: b.published_at,
      sections: O.SECTIONS[b.vertical],
    },
    systems: b.systems || [],
    systems_progress: prog,
    brain: b.brain ? { files: Object.keys(b.brain.files || {}), generated_at: b.brain_generated_at, by: b.brain.by } : null,
    running_at: b.running_at,
    created_at: b.created_at,
    updated_at: b.updated_at,
    ai: AI.configured(),
  };
}

// ── List ───────────────────────────────────────────────────────────────
router.get("/", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const { data, error } = await sb.from("os_builds").select("id,name,vertical,stage,intake,systems,score_status,transcript_status,intake_at,transcript_approved_at,updated_at").order("updated_at", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    const builds = (data || []).filter((b) => canSee(req.team, b)).map((b) => ({
      id: b.id,
      name: O.displayName(b.intake, b.name),
      vertical: b.vertical,
      stage: b.stage,
      stage_n: rank(b.stage) + 1,
      systems_progress: O.systemsProgress(b.systems),
      waiting: b.score_status === "ready" && rank(b.stage) < rank("standard") ? "scores" : b.transcript_status === "ready" && !b.transcript_approved_at ? "transcript" : null,
      transcript_due: rank(b.stage) < rank("transcript") ? O.transcriptDue(b.intake_at) : null,
      updated_at: b.updated_at,
    }));
    res.json({ builds, stages: O.STAGES, verticals: O.VERTICALS, ai: AI.configured() });
  } catch (e) {
    fail(res, e, "list");
  }
});

// Foundation Score submissions from the site that don't have a build yet.
router.get("/intakes", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  try {
    const { data: fs, error } = await sb.from("foundation_scores").select("id,client_id,vertical,submitted_at,transcript_url").order("submitted_at", { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const { data: used } = await sb.from("os_builds").select("foundation_score_id");
    const taken = new Set((used || []).map((u) => u.foundation_score_id).filter(Boolean));
    const rows = (fs || []).filter((r) => !taken.has(r.id) && (req.team.owner || r.vertical !== "authority"));
    const ids = [...new Set(rows.map((r) => r.client_id).filter(Boolean))];
    const clients = {};
    if (ids.length) {
      const { data: cs } = await sb.from("clients").select("id,business_name,operator_name").in("id", ids);
      for (const c of cs || []) clients[c.id] = c;
    }
    res.json({
      intakes: rows.map((r) => ({
        id: r.id,
        vertical: r.vertical,
        name: (clients[r.client_id] && (clients[r.client_id].business_name || clients[r.client_id].operator_name)) || "Unnamed",
        submitted_at: r.submitted_at,
        has_transcript: !!r.transcript_url,
      })),
    });
  } catch (e) {
    fail(res, e, "intakes");
  }
});

// ── Create ─────────────────────────────────────────────────────────────
router.post("/", member, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return sb503(res);
  const body = req.body || {};
  try {
    let vertical = String(body.vertical || "");
    let intake = O.cleanIntake(body.intake || {});
    let contact = String(body.contact_email || "").trim().toLowerCase();
    let clientId = null, fsId = null, intakeAt = null, source = "app";

    if (body.foundation_score_id) {
      if (!UUID.test(String(body.foundation_score_id))) return res.status(400).json({ error: "invalid_foundation_score" });
      const { data: fs } = await sb.from("foundation_scores").select("*").eq("id", body.foundation_score_id).maybeSingle();
      if (!fs) return res.status(404).json({ error: "foundation_score_not_found" });
      const { data: dup } = await sb.from("os_builds").select("id").eq("foundation_score_id", fs.id).maybeSingle();
      if (dup) return res.status(409).json({ error: "already_built", id: dup.id });
      vertical = fs.vertical;
      intake = O.cleanIntake(fs.intake_payload || {});
      clientId = fs.client_id || null;
      fsId = fs.id;
      intakeAt = fs.submitted_at || now();
      source = "foundation_score";
      if (clientId && !contact) {
        const { data: c } = await sb.from("clients").select("email,business_name,operator_name").eq("id", clientId).maybeSingle();
        if (c) {
          contact = c.email || "";
          if (!intake.business_name && c.business_name) intake.business_name = c.business_name;
          if (!intake.brand_name && c.operator_name) intake.brand_name = c.operator_name;
        }
      }
    }
    if (!O.VERTICALS[vertical]) return res.status(400).json({ error: "pick_a_door" });
    if (vertical === "authority" && !req.team.owner) return res.status(403).json({ error: "authority_owner_only" });
    if (contact && !EMAIL.test(contact)) return res.status(400).json({ error: "invalid_email" });
    const name = O.clean(body.name, 120) || (intake.business_name || intake.brand_name ? O.displayName(intake, "") : "");
    if (!name) return res.status(400).json({ error: "name_required" });
    const answered = Object.keys(intake).length >= 3;
    const row = {
      name,
      vertical,
      stage: answered ? "intake" : "raw",
      contact_email: contact || null,
      client_id: clientId,
      foundation_score_id: fsId,
      intake,
      intake_source: source,
      intake_at: answered ? intakeAt || now() : null,
      score_status: "none",
      transcript_status: "none",
      systems: [],
      created_by: req.team.email,
      created_at: now(),
      updated_at: now(),
    };
    const { data, error } = await sb.from("os_builds").insert(row).select("*").single();
    if (error) throw new Error(error.message);
    console.log(`[os] build ${data.id} created · ${vertical} · ${source}`);
    await T.logActivity(req.team.email, "started_os", subjectFor(data), { os_id: data.id });
    res.status(201).json({ build: view(data, req.team) });
  } catch (e) {
    fail(res, e, "create");
  }
});

// ── Read / edit ────────────────────────────────────────────────────────
router.get("/:id", viewer, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    res.json({ build: view(x.b, req.team), stages: O.STAGES, app_intake: O.APP_INTAKE[x.b.vertical], labels: O.INTAKE_LABELS, owners: O.OWNERS, groups: O.SYSTEM_GROUPS });
  } catch (e) {
    fail(res, e, "read");
  }
});

router.patch("/:id", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      const n = O.clean(body.name, 120);
      if (!n) return res.status(400).json({ error: "name_required" });
      patch.name = n;
    }
    if (body.contact_email !== undefined) {
      const e = String(body.contact_email || "").trim().toLowerCase();
      if (e && !EMAIL.test(e)) return res.status(400).json({ error: "invalid_email" });
      if (b.published_at && e !== (b.contact_email || "")) return res.status(409).json({ error: "already_in_portal" });
      patch.contact_email = e || null;
    }
    if (body.intake !== undefined) {
      if (rank(b.stage) >= rank("standard")) return res.status(409).json({ error: "intake_locked_after_scoring" });
      patch.intake = O.cleanIntake(body.intake, b.intake || {});
      if (b.stage === "raw" && Object.keys(patch.intake).length >= 3) {
        patch.stage = "intake";
        patch.intake_at = b.intake_at || now();
      }
    }
    if (body.systems !== undefined) {
      if (rank(b.stage) < rank("systemized")) return res.status(409).json({ error: "install_not_started" });
      if (b.stage === "running") return res.status(409).json({ error: "already_running" });
      if (!Array.isArray(body.systems)) return res.status(400).json({ error: "invalid_systems" });
      const cur = Array.isArray(b.systems) ? b.systems.map((s) => ({ ...s })) : [];
      for (const s of body.systems) {
        if (!s || typeof s !== "object") continue;
        let item = cur.find((c) => c.id === s.id);
        if (!item && s.add) {
          const group = O.SYSTEM_GROUPS.some((g) => g.key === s.group) ? s.group : null;
          const label = O.clean(s.label, 120);
          if (!group || !label) return res.status(400).json({ error: "invalid_system" });
          item = { id: `${group}-${crypto.randomBytes(3).toString("hex")}`, group, label, status: "todo", owner: "System" };
          cur.push(item);
        }
        if (!item) continue;
        if (s.remove) {
          cur.splice(cur.indexOf(item), 1);
          continue;
        }
        if (s.status !== undefined) {
          if (!O.SYSTEM_STATUS.includes(s.status)) return res.status(400).json({ error: "invalid_status" });
          item.status = s.status;
        }
        if (s.owner !== undefined && O.OWNERS.includes(s.owner)) item.owner = s.owner;
        if (s.label !== undefined && O.clean(s.label, 120)) item.label = O.clean(s.label, 120);
      }
      patch.systems = cur;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no_changes" });
    const updated = await save(sb, b.id, patch);
    if (patch.systems) await T.logActivity(req.team.email, "updated_os_systems", subjectFor(updated), { os_id: b.id, live: O.systemsProgress(updated.systems).live });
    res.json({ build: view(updated, req.team) });
  } catch (e) {
    fail(res, e, "update");
  }
});

// ── Drafts (agents) ────────────────────────────────────────────────────
function startDraft(kind, req, res, x) {
  const { sb, b } = x;
  const statusCol = kind === "scores" ? "score_status" : "transcript_status";
  const startedCol = kind === "scores" ? "score_started_at" : "transcript_started_at";
  const errorCol = kind === "scores" ? "score_error" : "transcript_error";
  if (b[statusCol] === "running" && !stale(b[statusCol], b[startedCol])) return res.status(409).json({ error: "already_drafting" });
  if (!AI.configured()) return res.status(503).json({ error: "ai_not_configured", hint: "Set ANTHROPIC_API_KEY on the server, or score by hand." });
  const requestedBy = req.team.email;
  return save(sb, b.id, { [statusCol]: "running", [startedCol]: now(), [errorCol]: null }).then((row) => {
    res.status(202).json({ build: view(row, req.team) });
    setImmediate(async () => {
      const t0 = Date.now();
      try {
        const draft = kind === "scores" ? await AI.draftScores(row) : await AI.draftTranscript(row);
        const done = await save(sb, b.id, kind === "scores" ? { score_draft: draft, score_status: "ready" } : { transcript_draft: draft, transcript_status: "ready" });
        console.log(`[os] ${kind} draft ready · build ${b.id} · ${Date.now() - t0}ms`);
        // Authority builds can hold minors' data: only the owner hears about them.
        const to = done.vertical === "authority" ? Promise.resolve([...staffEmails()]) : P.teamEmails("approver", "os").then((list) => [...new Set(list.concat(requestedBy))].filter((e) => e && e.includes("@")));
        P.notifySoon(
          to,
          {
            title: kind === "scores" ? `Five-pillar scores drafted: ${subjectFor(done)}` : `Transcript drafted: ${subjectFor(done)}`,
            body: kind === "scores" ? "Check the evidence and approve, or edit first." : "Read it before it goes to the client.",
            url: `/app/#osb/${b.id}`,
            tag: `os-${kind}-${b.id}`,
          }
        );
      } catch (e) {
        const code = (e && e.code) || "draft_error";
        console.error(`[os] ${kind} draft failed · build ${b.id}:`, e && e.message);
        try {
          await save(sb, b.id, { [statusCol]: "failed", [errorCol]: code });
        } catch {}
      }
    });
  });
}

router.post("/:id/scores/draft", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (rank(x.b.stage) < rank("intake")) return res.status(409).json({ error: "intake_first" });
    if (rank(x.b.stage) >= rank("systemized")) return res.status(409).json({ error: "scores_locked" });
    await startDraft("scores", req, res, x);
  } catch (e) {
    fail(res, e, "scores_draft");
  }
});

router.put("/:id/scores", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (rank(x.b.stage) < rank("intake")) return res.status(409).json({ error: "intake_first" });
    if (rank(x.b.stage) >= rank("systemized")) return res.status(409).json({ error: "scores_locked" });
    const { pillars, issues } = O.cleanScores(req.body || {});
    const prev = x.b.score_draft || {};
    const draft = { pillars, summary: O.clean((req.body || {}).summary ?? prev.summary, 600), issues, source: prev.source === "agent" ? "agent+edited" : "manual", model: prev.model || null, drafted_at: now(), edited_by: req.team.email };
    const row = await save(x.sb, x.b.id, { score_draft: draft, score_status: "ready", score_error: null });
    res.json({ build: view(row, req.team), issues });
  } catch (e) {
    fail(res, e, "scores_save");
  }
});

router.post("/:id/scores/approve", approver, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    if (!b.score_draft || !b.score_draft.pillars) return res.status(409).json({ error: "no_draft" });
    if (rank(b.stage) >= rank("systemized")) return res.status(409).json({ error: "scores_locked" });
    if (b.transcript && !(req.body && req.body.confirm)) return res.status(409).json({ error: "transcript_already_approved", hint: "Approving new scores sends the transcript back to draft. Send confirm: true." });
    const { pillars } = O.cleanScores(b.score_draft);
    const patch = { pillars, pillars_approved_by: req.team.email, pillars_approved_at: now(), stage: rank(b.stage) < rank("standard") || b.transcript ? "standard" : b.stage };
    if (b.transcript) Object.assign(patch, { transcript: null, transcript_approved_by: null, transcript_approved_at: null });
    const row = await save(sb, b.id, patch);
    console.log(`[os] scores approved · build ${b.id}`);
    await T.logActivity(req.team.email, "approved_os_scores", subjectFor(row), { os_id: b.id, total: O.totalScore(pillars) });
    res.json({ build: view(row, req.team) });
  } catch (e) {
    fail(res, e, "scores_approve");
  }
});

router.post("/:id/transcript/draft", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (!x.b.pillars) return res.status(409).json({ error: "approve_scores_first" });
    if (rank(x.b.stage) >= rank("systemized")) return res.status(409).json({ error: "transcript_locked" });
    await startDraft("transcript", req, res, x);
  } catch (e) {
    fail(res, e, "transcript_draft");
  }
});

router.put("/:id/transcript", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (!x.b.pillars) return res.status(409).json({ error: "approve_scores_first" });
    if (rank(x.b.stage) >= rank("systemized")) return res.status(409).json({ error: "transcript_locked" });
    const prev = x.b.transcript_draft || {};
    const t = O.cleanTranscript(req.body || {}, x.b.vertical);
    const draft = { ...t, source: prev.source === "agent" || prev.source === "agent+edited" ? "agent+edited" : "manual", model: prev.model || null, drafted_at: now(), edited_by: req.team.email };
    const row = await save(x.sb, x.b.id, { transcript_draft: draft, transcript_status: "ready", transcript_error: null });
    res.json({ build: view(row, req.team), blockers: O.transcriptBlockers(draft) });
  } catch (e) {
    fail(res, e, "transcript_save");
  }
});

// ── The transcript page ────────────────────────────────────────────────
function pageHeaders(res, n) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${n}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`);
}
function sendTranscript(res, b, which) {
  const n = crypto.randomBytes(16).toString("base64");
  pageHeaders(res, n);
  res.send(renderTranscript(b, { which, nonce: n }));
}

router.get("/:id/transcript.html", viewer, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const which = req.query.v === "draft" ? "draft" : "approved";
    if (which === "draft" && !x.b.transcript_draft) return res.status(404).json({ error: "no_draft" });
    if (which === "approved" && !x.b.transcript) return res.status(404).json({ error: "not_approved" });
    sendTranscript(res, x.b, which);
  } catch (e) {
    fail(res, e, "transcript_page");
  }
});

// Into the client portal: the transcript link and the pillar scores on their
// Foundation Score, plus a deliverable. Needs the client's email.
async function publish(sb, b, by) {
  const url = `${BASE()}/api/os/client/${b.id}/transcript`;
  const scores = Object.fromEntries(O.PILLARS.map((k) => [k, b.pillars[k].score]));
  let clientId = b.client_id, fsId = b.foundation_score_id;
  if (!clientId && b.contact_email) {
    const { data: existing } = await sb.from("clients").select("id").eq("email", b.contact_email).maybeSingle();
    if (existing) clientId = existing.id;
    else {
      const { data: made, error } = await sb.from("clients").insert({ email: b.contact_email, business_name: O.clean(b.intake.business_name, 200) || b.name, operator_name: O.clean(b.intake.brand_name, 200) || null, vertical: b.vertical, tier: "founding", status: "pilot" }).select("id").single();
      if (error) throw new Error(error.message);
      clientId = made.id;
    }
  }
  if (!clientId) return { published: false, reason: "no_client_email" };
  const delivered = now();
  if (fsId) {
    const { error } = await sb.from("foundation_scores").update({ pillar_scores: scores, transcript_url: url, transcript_delivered_at: delivered }).eq("id", fsId);
    if (error) throw new Error(error.message);
  } else {
    const { data: fs, error } = await sb.from("foundation_scores").insert({ client_id: clientId, vertical: b.vertical, intake_payload: b.intake || {}, intake_version: "os-app", pillar_scores: scores, transcript_url: url, transcript_delivered_at: delivered }).select("id").single();
    if (error) throw new Error(error.message);
    fsId = fs.id;
  }
  await sb.from("deliverables").insert({ client_id: clientId, kind: "transcript", title: "Operational Transcript", description: "Your Foundation Score, scored against the five pillars, with a ranked action plan.", file_url: url, delivered_by: by, delivered_at: delivered });
  return { published: true, client_id: clientId, foundation_score_id: fsId, published_at: delivered, url };
}

router.post("/:id/transcript/approve", approver, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    if (!b.pillars) return res.status(409).json({ error: "approve_scores_first" });
    if (!b.transcript_draft) return res.status(409).json({ error: "no_draft" });
    if (rank(b.stage) >= rank("systemized")) return res.status(409).json({ error: "transcript_locked" });
    const blockers = O.transcriptBlockers(O.cleanTranscript(b.transcript_draft, b.vertical));
    if (blockers.length) return res.status(409).json({ error: "fix_blockers_first", blockers, banned: b.transcript_draft.banned || [] });
    const approved = { ...O.cleanTranscript(b.transcript_draft, b.vertical), source: b.transcript_draft.source, model: b.transcript_draft.model || null };
    let row = await save(sb, b.id, { transcript: approved, transcript_approved_by: req.team.email, transcript_approved_at: now(), stage: "transcript" });
    let pub = { published: false, reason: "no_client_email" };
    try {
      pub = await publish(sb, row, req.team.email);
      if (pub.published) row = await save(sb, b.id, { client_id: pub.client_id, foundation_score_id: pub.foundation_score_id, published_at: pub.published_at });
    } catch (e) {
      console.error(`[os] portal publish failed · build ${b.id}:`, e.message);
      pub = { published: false, reason: "portal_error" };
    }
    console.log(`[os] transcript approved · build ${b.id} · portal=${pub.published}`);
    await T.logActivity(req.team.email, "approved_os_transcript", subjectFor(row), { os_id: b.id, portal: pub.published });
    res.json({ build: view(row, req.team), published: pub.published, reason: pub.reason || null });
  } catch (e) {
    fail(res, e, "transcript_approve");
  }
});

// ── Systemized ─────────────────────────────────────────────────────────
router.post("/:id/install", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    if (!b.transcript) return res.status(409).json({ error: "approve_transcript_first" });
    if (rank(b.stage) >= rank("systemized")) return res.json({ build: view(b, req.team) });
    const systems = Array.isArray(b.systems) && b.systems.length ? b.systems : O.defaultSystems(b.vertical);
    const row = await save(sb, b.id, { stage: "systemized", systems });
    await T.logActivity(req.team.email, "started_os_install", subjectFor(row), { os_id: b.id });
    res.json({ build: view(row, req.team) });
  } catch (e) {
    fail(res, e, "install");
  }
});

router.post("/:id/brain", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    if (rank(b.stage) < rank("systemized")) return res.status(409).json({ error: "install_first" });
    const files = brainFiles(b, { by: req.team.email });
    const row = await save(sb, b.id, { brain: { files, by: req.team.email, version: (b.brain && b.brain.version ? b.brain.version : 0) + 1 }, brain_generated_at: now() });
    await T.logActivity(req.team.email, "generated_os_brain", subjectFor(row), { os_id: b.id, files: Object.keys(files).length });
    res.json({ build: view(row, req.team), files: Object.keys(files) });
  } catch (e) {
    fail(res, e, "brain");
  }
});

router.get("/:id/brain", viewer, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (!x.b.brain) return res.status(404).json({ error: "no_brain_yet" });
    res.json({ files: x.b.brain.files, generated_at: x.b.brain_generated_at, slug: O.slugify(O.displayName(x.b.intake, x.b.name)) + "-os" });
  } catch (e) {
    fail(res, e, "brain_read");
  }
});

router.get("/:id/brain.zip", member, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    if (!x.b.brain) return res.status(404).json({ error: "no_brain_yet" });
    const slug = O.slugify(O.displayName(x.b.intake, x.b.name)) + "-os";
    const files = {};
    for (const [p, c] of Object.entries(x.b.brain.files || {})) files[`${slug}/${p}`] = c;
    const buf = zip(files);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}.zip"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buf);
  } catch (e) {
    fail(res, e, "brain_zip");
  }
});

router.post("/:id/running", approver, async (req, res) => {
  try {
    const x = await withBuild(req, res);
    if (!x) return;
    const { sb, b } = x;
    if (b.stage === "running") return res.json({ build: view(b, req.team) });
    if (b.stage !== "systemized") return res.status(409).json({ error: "install_first" });
    if (!O.systemsProgress(b.systems).all_live) return res.status(409).json({ error: "systems_not_live" });
    if (!b.brain) return res.status(409).json({ error: "brain_first" });
    let row = await save(sb, b.id, { stage: "running", running_at: now() });
    // Regenerate so the brain records the hand-off.
    row = await save(sb, b.id, { brain: { files: brainFiles(row, { by: req.team.email }), by: req.team.email, version: (b.brain.version || 1) + 1 }, brain_generated_at: now() });
    await T.logActivity(req.team.email, "os_running", subjectFor(row), { os_id: b.id });
    P.notifySoon(row.vertical === "authority" ? [] : P.teamEmails("viewer", "os").then((list) => list.filter((e) => e !== req.team.email)), { title: `${subjectFor(row)} is running`, body: "Every system is live. It's on the Trail of Joy.", url: `/app/#osb/${b.id}`, tag: `os-running-${b.id}` });
    res.json({ build: view(row, req.team) });
  } catch (e) {
    fail(res, e, "running");
  }
});

// ── The client's own transcript (portal link) ─────────────────────────
const PORTAL_ROLES = new Set([ROLES.CLIENT, ROLES.LEGACY]);
router.get("/client/:id/transcript", async (req, res) => {
  try {
    const email = String((req.session && req.session.userEmail) || "").trim().toLowerCase();
    if (!email) return res.status(401).json({ error: "not_authenticated" });
    const sb = getSupabase();
    if (!sb) return sb503(res);
    const b = await load(sb, req.params.id);
    if (!b || !b.transcript) return res.status(404).json({ error: "not_found" });
    const team = await T.accessFor(req);
    let ok = !!(team && T.can(team, "os", "viewer") && canSee(team, b)) || isStaff(req);
    if (!ok && PORTAL_ROLES.has(req.session.userRole)) {
      if (b.contact_email && b.contact_email === email) ok = true;
      else if (b.client_id) {
        const { data: c } = await sb.from("clients").select("email").eq("id", b.client_id).maybeSingle();
        ok = !!(c && String(c.email || "").toLowerCase() === email);
      }
    }
    if (!ok) return res.status(404).json({ error: "not_found" });
    sendTranscript(res, b, "approved");
  } catch (e) {
    fail(res, e, "client_transcript");
  }
});

module.exports = router;
