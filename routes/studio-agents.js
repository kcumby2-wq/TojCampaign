// Studio Agents API — build and refresh Milanote kits (agents/studio).
//
//   GET  /api/studio-agents/roles                 → public metadata
//   GET  /api/studio-agents/skills                → public metadata
//   POST /api/studio-agents/run                   → start a run → { run_id }
//   POST /api/studio-agents/brief                 → idea + references → three directions (Brief Writer) → { run_id }
//   GET  /api/studio-agents/runs/:id              → poll a run (and the draft or brief it made)
//   GET  /api/studio-agents/briefs/unstarted      → your briefs that came back and were neither started nor set aside
//   POST /api/studio-agents/briefs/:id/set-aside  → { aside } a brief you won't start (or bring it back)
//   GET  /api/studio-agents/kits                  → every kit version (built-in + saved)
//   GET  /api/studio-agents/kits/:id              → one kit version, its check, its changes
//   GET  /api/studio-agents/kits/:id/page         → the Milanote kit page (copy buttons)
//   POST /api/studio-agents/kits/:id/approve      → staff session only
//   POST /api/studio-agents/kits/:id/discard      → staff session only
//   GET  /api/studio-agents/assets/:set/:file     → template image (signed URL or staff)
//
// Safety model: an agent run can only save a NEW draft version. Approving is a
// person's act (staff session; an API key can't approve or allow rule
// changes). The approved kit is never edited in place, and the first approved
// Same Work kit ships read-only in the repo. See agents/studio/API.md.

const express = require("express");
const crypto = require("crypto");
const K = require("../agents/studio/kit");
const S = require("../agents/studio/service");
const { renderDocument } = require("../agents/studio/kit-render");
const T = require("../utils/team");
const P = require("../utils/push");
const isPerson = (e) => !!e && e !== "api-key" && e.includes("@");
const H = require("../utils/pylon-http");
const U = require("../utils/studio-films");
// A write that marks a brief (set aside, or started from it) is JSON from
// the app's own pages: another site can't send one through a signed-in browser.
function sameSiteJson(req, res) {
  if (!req.is("application/json")) {
    res.status(415).json({ error: "json_only" });
    return false;
  }
  if (!H.originOk(req)) {
    res.status(403).json({ error: "wrong_origin" });
    return false;
  }
  return true;
}

const router = express.Router();
const STUDIO_ROLES = ["kit-builder", "kit-refresher"];
const POLL_ROLES = [...STUDIO_ROLES, "brief-writer"];
// A run still "running" after this long died with a server restart.
const STALE_RUN_MS = 90 * 60 * 1000;

let studio = null;
function orchestrator() {
  if (!studio) studio = require("../agents/studio/orchestrator");
  return studio;
}
let runAgentImpl = null;
function runAgent(args) {
  return (runAgentImpl || orchestrator().runAgent)(args);
}
let briefPack = null;
let runBriefImpl = null;
function runBrief(args) {
  if (runBriefImpl) return runBriefImpl(args);
  if (!briefPack) briefPack = require("../agents/studio-brief/orchestrator");
  return briefPack.runAgent(args);
}

let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return (supabase = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return supabase;
  } catch {
    return (supabase = false);
  }
}

// Tests swap in a fake database and agent.
router._setDeps = ({ sb, run, brief } = {}) => {
  if (sb !== undefined) supabase = sb;
  if (run !== undefined) runAgentImpl = run;
  if (brief !== undefined) runBriefImpl = brief;
};

// Who may do what (utils/team.js): viewers open kits; members write briefs
// and start runs; approvers and the owner approve. The STUDIO_API_KEY header
// acts as a member for automation (e.g. a monthly refresh): it can start runs
// but never approve or unlock rule cards.
const viewer = T.requireTeamOrApiKey("x-studio-api-key", "STUDIO_API_KEY", "studio", "viewer");
const member = T.requireTeamOrApiKey("x-studio-api-key", "STUDIO_API_KEY", "studio", "member");
const approver = T.requireTeam("studio", "approver");

function who(req) {
  if (req.team) return req.team.email;
  return (req.session && req.session.userEmail) || null;
}

function fail(res, e, what) {
  console.error(`[studio] ${what} failed:`, e && e.message);
  return res.status(500).json({ error: `${what}_failed` });
}

router.get("/roles", (_req, res) => res.json({ roles: orchestrator().listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: orchestrator().listSkills() }));

// ── Kits ─────────────────────────────────────────────────────────────────
router.get("/kits", viewer, async (_req, res) => {
  try {
    const sb = getSupabase();
    const kits = await S.listKits(sb || null);
    res.json({ kits, storage: sb ? "ok" : "unavailable", template_sets: K.assetSets() });
  } catch (e) {
    fail(res, e, "list_kits");
  }
});

router.get("/kits/:id", viewer, async (req, res) => {
  try {
    const sb = getSupabase();
    const row = await S.getKit(sb || null, req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    const check = K.checkKit(row.kit);
    let diff = null;
    if (row.base_kit_id) {
      const base = await S.getKit(sb || null, row.base_kit_id);
      if (base) diff = K.diffKits(base.kit, row.kit);
    }
    res.json({ ...row, check: { ok: check.ok, blockers: check.blockers, warnings: check.warnings, counts: check.counts }, diff });
  } catch (e) {
    fail(res, e, "get_kit");
  }
});

router.get("/kits/:id/page", viewer, async (req, res) => {
  try {
    const sb = getSupabase();
    const row = await S.getKit(sb || null, req.params.id);
    if (!row) return res.status(404).send("Not found");
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = renderDocument(row.kit, { imgSrc: S.imgSrcFor(row.kit), banner: S.bannerFor(row), nonce });
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy": [
        "default-src 'none'",
        "img-src 'self'",
        "style-src 'unsafe-inline' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        `script-src 'nonce-${nonce}'`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    });
    res.send(html);
  } catch (e) {
    fail(res, e, "kit_page");
  }
});

router.post("/kits/:id/approve", approver, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  if (!S.isUuid(req.params.id)) return res.status(400).json({ error: "only_saved_drafts_can_be_approved" });
  try {
    const row = await S.getKit(sb, req.params.id);
    if (!row) return res.status(404).json({ error: "not_found" });
    if (row.status !== "draft") return res.status(409).json({ error: "not_a_draft", status: row.status });
    const check = K.checkKit(row.kit);
    if (!check.ok) return res.status(409).json({ error: "fix_blockers_first", blockers: check.blockers });
    // A draft made from an older approved version would quietly undo what was
    // approved since. Refuse it; a fresh refresh starts from the current one.
    const current = await S.approvedKit(sb, row.slug);
    if (current && current.id !== row.base_kit_id) {
      return res.status(409).json({
        error: "stale_draft",
        hint: `this draft started from v${row.base_version || "none"}, but v${current.version} is approved now; run a new refresh`,
        base_version: row.base_version || null,
        approved_version: current.version,
      });
    }
    const { error } = await sb.rpc("studio_kit_approve", { p_id: row.id, p_by: who(req) });
    if (error) return res.status(409).json({ error: error.message });
    console.log(`[studio] kit ${row.id} (${row.slug} v${row.version}) approved`);
    await T.logActivity(who(req), "approved_kit", `${row.slug} v${row.version}`, { kit_id: row.id });
    P.notifySoon(
      P.teamEmails("viewer").then((list) => list.filter((e) => e !== who(req))),
      { title: `${String(row.title || row.slug).replace(/ Milanote Kit$/, "")} v${row.version} is approved`, body: "It's the kit everyone uses now.", url: `/app/#kit/${row.id}`, tag: `kit-${row.slug}` }
    );
    res.json({ ok: true, id: row.id, slug: row.slug, version: row.version, status: "approved" });
  } catch (e) {
    fail(res, e, "approve_kit");
  }
});

router.post("/kits/:id/discard", approver, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  if (!S.isUuid(req.params.id)) return res.status(400).json({ error: "only_saved_drafts_can_be_discarded" });
  try {
    const { data, error } = await sb
      .from("studio_kits")
      .update({ status: "discarded", discarded_by: who(req), discarded_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("status", "draft")
      .select("id,slug,version,status");
    if (error) throw new Error(error.message);
    if (!data || !data.length) return res.status(409).json({ error: "not_a_draft" });
    await T.logActivity(who(req), "discarded_kit", `${data[0].slug} v${data[0].version}`, { kit_id: data[0].id });
    res.json({ ok: true, ...data[0] });
  } catch (e) {
    fail(res, e, "discard_kit");
  }
});

// Template images. Staff, or anyone holding the signed URL from a kit page
// (so a dragged image still loads when Milanote fetches it).
router.get("/assets/:set/:file", async (req, res) => {
  const file = S.assetPath(req.params.set, req.params.file);
  if (!file) return res.status(404).end();
  const signed = S.verifyAsset(req.params.set, req.params.file, req.query.sig);
  if (!signed && !T.can(await T.accessFor(req).catch(() => null), "studio", "viewer")) return res.status(403).end();
  res.set("Cache-Control", "private, max-age=86400");
  res.sendFile(file);
});

// ── Runs ─────────────────────────────────────────────────────────────────
router.post("/run", member, async (req, res) => {
  const body = req.body || {};
  const role = body.role;
  if (!STUDIO_ROLES.includes(role)) return res.status(400).json({ error: "invalid_role" });
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (brief.length < 10) return res.status(400).json({ error: "missing_brief" });
  if (brief.length > S.BRIEF_MAX) return res.status(400).json({ error: "brief_too_long", max: S.BRIEF_MAX });
  const source = typeof body.source_text === "string" ? body.source_text.replace(/\r\n/g, "\n").trim() : "";
  if (source.length > S.SOURCE_MAX) return res.status(400).json({ error: "source_too_long", max: S.SOURCE_MAX });
  const slug = String(body.slug || "").trim();
  if (!K.SLUG_RE.test(slug)) return res.status(400).json({ error: "invalid_slug" });
  const allowLocked = body.allow_rule_changes === true;
  // Started from a brief that came back (and which of its three directions).
  const fromBrief = S.isUuid(String(body.from_brief || "")) ? String(body.from_brief).toLowerCase() : null;
  const direction = Number.isInteger(body.direction) && body.direction >= 1 && body.direction <= 3 ? body.direction : null;
  if (allowLocked && req._apiKeyAuth) return res.status(403).json({ error: "rule_changes_need_a_person" });
  if (allowLocked && !(req.team && req.team.owner)) return res.status(403).json({ error: "rule_changes_need_the_owner" });
  if (fromBrief && !sameSiteJson(req, res)) return;

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  // Started from a brief: a Brief Writer run that came back, yours (or the
  // producer's to start). The first start is kept as it was.
  let briefMark = null;
  if (fromBrief) {
    const { data: br, error: bErr } = await sb.from("agent_runs").select("id,role,status,created_by").eq("id", fromBrief).maybeSingle();
    if (bErr) return fail(res, bErr, "start_run");
    if (!br || br.role !== "brief-writer" || !["completed", "waiting"].includes(br.status)) return res.status(400).json({ error: "not_a_brief" });
    if (br.created_by !== who(req) && !(req.team && T.can(req.team, "studio", "approver"))) return res.status(403).json({ error: "not_your_brief" });
    try {
      const { data: m } = await sb.from("studio_brief_marks").select("started_at").eq("brief_run_id", fromBrief).maybeSingle();
      briefMark = m || null;
    } catch (e) {
      briefMark = null;
    }
  }

  let scope;
  try {
    if (role === "kit-builder") {
      if (source.length < 200) return res.status(400).json({ error: "source_required", hint: "paste the playbook text (or load the PDF) for a new kit" });
      if (await S.slugExists(sb, slug)) {
        return res.status(409).json({ error: "slug_exists", hint: "use kit-refresher to update this kit, or pick a new slug" });
      }
      const assets = body.assets ? String(body.assets) : null;
      if (assets && !K.assetSets().includes(assets)) return res.status(400).json({ error: "unknown_template_set" });
      scope = { mode: "build", slug, assets, allow_locked: false };
    } else {
      const base = await S.approvedKit(sb, slug);
      if (!base) return res.status(404).json({ error: "no_approved_kit_for_slug" });
      scope = {
        mode: "refresh",
        slug,
        assets: base.kit.assets || null,
        base: { id: base.id, version: base.version, kit: base.kit },
        allow_locked: allowLocked,
      };
    }
  } catch (e) {
    return fail(res, e, "start_run");
  }

  const task = (fromBrief ? `(Started from brief ${fromBrief}${direction ? `, direction ${direction}` : ""}.)\n\n` : "") + S.buildTask({
    mode: scope.mode,
    slug,
    brief,
    source,
    base: scope.base || null,
    assets: scope.assets,
    allowLocked,
    today: S.today(),
  });
  scope.source_excerpt = source.slice(0, S.SOURCE_EXCERPT);

  const { data: runRow, error: insErr } = await sb
    .from("agent_runs")
    .insert({ role, client_id: null, task, status: "running", created_by: who(req) })
    .select("id")
    .single();
  if (insErr) return fail(res, insErr, "start_run");

  if (fromBrief && !(briefMark && briefMark.started_at)) {
    // Today stops listing the brief, before the answer goes back. A brief
    // started again keeps its first start (that run and its direction); the
    // new run's task says where it came from. Before migration 041 there's no
    // table: the brief stays on Today.
    try {
      const { error: mErr } = await sb.from("studio_brief_marks").upsert({ brief_run_id: fromBrief, started_run_id: runRow.id, direction, started_by: who(req), started_at: new Date().toISOString(), set_aside_at: null, set_aside_by: null }, { onConflict: "brief_run_id" });
      if (mErr) console.warn("[studio-agents] brief not marked started:", mErr.code || mErr.message);
    } catch (e) {
      /* no table yet */
    }
  }
  res.json({ ok: true, run_id: runRow.id, namespace: "studio", mode: scope.mode, slug });
  T.logActivity(who(req), "started_run", slug, { role, run_id: runRow.id });

  const requestedBy = who(req);
  setImmediate(async () => {
    const startedAt = Date.now();
    let stage = null;
    try {
      const result = await runAgent({ role, task, scope: { ...scope, onStage: (s) => (stage = s) } });
      const passed = ["passed", "passed_after_retry", "not_run"].includes(result.eval_status);
      let saved = { saved: false, reason: "nothing_staged" };
      try {
        saved = await S.saveDraft(sb, { stage, runId: runRow.id, role, result, slug, requestedBy });
      } catch (e) {
        console.error(`[studio] run ${runRow.id} could not save its draft:`, e.message);
        saved = { saved: false, reason: "save_failed" };
      }
      const note = saved.saved
        ? `\n\n---\nSaved as draft v${saved.version} of "${slug}" (kit ${saved.id}). Nothing is approved until a person approves it.`
        : saved.reason === "no_changes"
          ? "\n\n---\nNo changes were needed, so no new draft was saved."
          : `\n\n---\nNo draft was saved (${saved.reason}).`;
      await sb
        .from("agent_runs")
        .update({
          status: passed ? "completed" : "waiting",
          output: `${result.output || ""}${note}`,
          trace: result.trace,
          usage: result.usage,
          eval_status: result.eval_status,
          retry_count: result.retry_count || 0,
          eval_summary: result.eval_summary,
          eval_biggest_miss: result.eval_biggest_miss,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runRow.id);
      if (result.eval_history && result.eval_history.length) {
        await sb.from("eval_runs").insert(
          result.eval_history.map((h) => ({
            agent_run_id: runRow.id,
            attempt: h.attempt,
            verdict: h.verdict,
            total_score: h.total_score,
            biggest_miss: h.biggest_miss,
            auto_fail_triggered: h.auto_fail_triggered,
            evaluator_model: h.evaluator_model,
          }))
        );
      }
      console.log(
        `[studio] run ${runRow.id} ${passed ? "completed" : "waiting"} · ${role} · ${Date.now() - startedAt}ms · eval=${result.eval_status} · draft=${saved.saved ? saved.id : saved.reason}`
      );
      const kitName = (stage && stage.kit && stage.kit.title ? stage.kit.title : slug).replace(/ Milanote Kit$/, "");
      if (saved.saved) {
        P.notifySoon(
          P.teamEmails("approver").then((list) => (isPerson(requestedBy) ? list.concat(requestedBy) : list)),
          {
            title: `Draft v${saved.version} of ${kitName} is ready`,
            body: passed ? "It passed its checks. See what changed." : "It didn't pass its checks. Look closely before approving.",
            url: `/app/#review/${saved.id}`,
            tag: `draft-${saved.id}`,
          }
        );
      } else if (isPerson(requestedBy)) {
        P.notifySoon([requestedBy], {
          title: saved.reason === "no_changes" ? `${kitName}: nothing needed changing` : `${kitName}: no draft was saved`,
          body: saved.reason === "no_changes" ? "The refresh checked everything and left the kit as it is." : "Open the run to see why.",
          url: `/app/#run/${runRow.id}`,
          tag: `run-${runRow.id}`,
        });
      }
    } catch (e) {
      console.error(`[studio] run ${runRow.id} failed:`, e.message);
      if (isPerson(requestedBy)) P.notifySoon([requestedBy], { title: "Your kit run stopped", body: "Open it to see what happened.", url: `/app/#run/${runRow.id}`, tag: `run-${runRow.id}` });
      await sb
        .from("agent_runs")
        .update({ status: "failed", error: String(e.message).slice(0, 1000), completed_at: new Date().toISOString() })
        .eq("id", runRow.id);
    }
  });
});

// Recent studio runs (kit runs and briefs), newest first, for the app.
router.get("/runs", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  const { data, error } = await sb
    .from("agent_runs")
    .select("id,role,status,task,output,created_at,completed_at,created_by,eval_status")
    .in("role", POLL_ROLES)
    .order("created_at", { ascending: false })
    .limit(Math.min(50, Number(req.query.limit) || 20));
  if (error) return fail(res, error, "list_runs");
  res.json({
    runs: (data || []).map((r) => {
      let status = r.status;
      if (status === "running" && Date.now() - new Date(r.created_at).getTime() > STALE_RUN_MS) status = "failed";
      return {
        id: r.id,
        role: r.role,
        status,
        eval_status: r.eval_status,
        created_at: r.created_at,
        completed_at: r.completed_at,
        by_you: !!(req.team && r.created_by && r.created_by === req.team.email),
        label: runLabel(r),
      };
    }),
  });
});

function runLabel(r) {
  const task = String(r.task || "");
  if (r.role === "brief-writer") {
    const head = String(r.output || "").split("\n")[0];
    if (head.startsWith("# ")) return head.slice(2, 90);
    const m = task.match(/Kyron's idea:\n([^\n]+)/);
    return m ? m[1].slice(0, 90) : "A new brief";
  }
  const m = task.match(/Brief from Kyron:\n([^\n]+)/);
  return m ? m[1].replace(/^Goal:\s*/i, "").slice(0, 90) : r.role === "kit-builder" ? "A new kit" : "A kit refresh";
}

router.get("/runs/:id", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  if (!S.isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  const { data, error } = await sb
    .from("agent_runs")
    .select("id,role,status,task,output,trace,usage,error,created_at,completed_at,eval_status,retry_count,eval_summary,eval_biggest_miss")
    .eq("id", req.params.id)
    .in("role", POLL_ROLES)
    .maybeSingle();
  if (error) return fail(res, error, "poll_run");
  if (!data) return res.status(404).json({ error: "not_found" });
  const { trace, task, ...run } = data;
  run.label = runLabel({ role: run.role, task, output: run.output });
  if (run.status === "running" && Date.now() - new Date(run.created_at).getTime() > STALE_RUN_MS) {
    run.status = "failed";
    run.error = "The server restarted while this run was going, so it stopped. Start it again.";
  }
  const briefEntry = Array.isArray(trace) ? trace.find((t) => t && t.type === "studio_brief") : null;
  let mark = null;
  if (run.role === "brief-writer") {
    try {
      const { data: m } = await sb.from("studio_brief_marks").select("started_run_id,direction,started_at,started_by,set_aside_at,set_aside_by").eq("brief_run_id", run.id).maybeSingle();
      mark = m || null;
    } catch (e) {
      mark = null;
    }
  }
  let kit = null;
  if (run.role !== "brief-writer") {
    const { data: kits } = await sb.from("studio_kits").select("id,slug,version,status").eq("source_run_id", run.id).limit(1);
    kit = (kits && kits[0]) || null;
  }
  res.json({ ...run, kit, brief: briefEntry ? briefEntry.brief : null, mark });
});

// ── Briefs not started ───────────────────────────────────────────────────
// A brief that came back and was neither started nor set aside waits on
// Today for whoever asked for it (the last 60 days).
router.get("/briefs/unstarted", viewer, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  const mine = who(req);
  if (!isPerson(mine)) return res.json({ briefs: [] });
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  // Page back through the 60 days until ten unmarked briefs are found, so an
  // older one never started doesn't drop off behind newer, started ones.
  const open = [];
  for (let from = 0; from < 400 && open.length < 10; from += 40) {
    const { data, error } = await sb
      .from("agent_runs")
      .select("id,status,task,output,created_at")
      .eq("role", "brief-writer")
      .eq("created_by", mine)
      .in("status", ["completed", "waiting"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(from, from + 39);
    if (error) return fail(res, error, "unstarted_briefs");
    const page = data || [];
    const ids = page.map((r) => r.id);
    let marked = new Set();
    if (ids.length) {
      try {
        const { data: marks, error: mErr } = await sb.from("studio_brief_marks").select("brief_run_id").in("brief_run_id", ids);
        // Before migration 041, nothing is marked: every brief counts.
        if (!mErr) marked = new Set((marks || []).map((m) => m.brief_run_id));
      } catch (e) {
        marked = new Set();
      }
    }
    open.push(...page.filter((r) => !marked.has(r.id)));
    if (page.length < 40) break;
  }
  res.json({
    briefs: open.slice(0, 10).map((r) => ({ id: r.id, status: r.status, created_at: r.created_at, label: runLabel({ role: "brief-writer", task: r.task, output: r.output }) })),
  });
});

router.post("/briefs/:id/set-aside", member, async (req, res) => {
  if (!sameSiteJson(req, res)) return;
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });
  if (!S.isUuid(req.params.id)) return res.status(404).json({ error: "not_found" });
  const { data: brief, error } = await sb.from("agent_runs").select("id,created_by").eq("id", req.params.id).eq("role", "brief-writer").maybeSingle();
  if (error) return fail(res, error, "set_aside");
  if (!brief) return res.status(404).json({ error: "not_found" });
  if (brief.created_by !== who(req) && !(req.team && T.can(req.team, "studio", "approver"))) return res.status(403).json({ error: "not_your_brief" });
  const aside = !(req.body && req.body.aside === false);
  let had = null;
  try {
    ({ data: had } = await sb.from("studio_brief_marks").select("started_at").eq("brief_run_id", brief.id).maybeSingle());
  } catch (e) {
    return res.status(503).json({ error: "supabase_unavailable" });
  }
  // A brief that was started stays started: it can't be set aside or brought back.
  if (had && had.started_at) return res.status(409).json({ error: "already_started" });
  if (!aside) {
    const { error: dErr } = await sb.from("studio_brief_marks").delete().eq("brief_run_id", brief.id);
    if (dErr) return fail(res, dErr, "set_aside");
    return res.json({ ok: true, aside: false });
  }
  const { error: uErr } = await sb.from("studio_brief_marks").upsert({ brief_run_id: brief.id, set_aside_by: who(req), set_aside_at: new Date().toISOString() }, { onConflict: "brief_run_id" });
  if (uErr) return fail(res, uErr, "set_aside");
  res.json({ ok: true, aside: true });
});

// ── Brief Writer ─────────────────────────────────────────────────────────
// An idea plus references (photos, video stills, links, file text) in; one
// brief for a kit run out. Photos and stills go to the model for this run
// only and are never stored (agents/studio-brief/request.js).
router.post("/brief", member, async (req, res) => {
  const BR = require("../agents/studio-brief/request");
  const parsed = BR.parseBriefRequest(req.body || {});
  if (!parsed.ok) {
    const { ok, ...rest } = parsed;
    return res.status(400).json(rest);
  }
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const task = BR.buildBriefTask(parsed, S.today());
  const { data: runRow, error: insErr } = await sb
    .from("agent_runs")
    .insert({ role: "brief-writer", client_id: null, task, status: "running", created_by: who(req) })
    .select("id")
    .single();
  if (insErr) return fail(res, insErr, "start_brief");
  res.json({ ok: true, run_id: runRow.id, namespace: "studio-brief", references: parsed.refs.map((r) => r.ref) });
  T.logActivity(who(req), "started_brief", parsed.target.slug || parsed.target.mode, { run_id: runRow.id, references: parsed.refs.length });

  const scope = {
    idea: parsed.idea,
    target: parsed.target,
    references: parsed.refs.map(({ ref, kind, caption, url }) => ({ ref, kind, caption, url })),
    // The taste library (migration 041); before it, searching finds nothing.
    searchTaste: async (q, tag) => {
      const { data, error } = await sb.rpc("studio_taste_search", { p_q: q || null, p_tag: tag || null, p_limit: 12 });
      return error ? [] : Array.isArray(data) ? data : [];
    },
    tasteByRef: async (n) => {
      const { data, error } = await sb.from("studio_taste").select("*").eq("ref_no", n).maybeSingle();
      return error ? null : data || null;
    },
    listApproved: async () =>
      (await S.listKits(sb)).filter((k) => k.status === "approved").map((k) => ({ slug: k.slug, title: k.title, version: k.version })),
    approvedKit: (slug) => S.approvedKit(sb, slug),
    slugTaken: (slug) => S.slugExists(sb, slug),
  };
  setImmediate(async () => {
    const startedAt = Date.now();
    let stage = null;
    try {
      // Taste notes are shared by every film: read with every card's name
      // (any film's) as a code. If the cards can't be read, nor can the notes.
      let everyone = null;
      try {
        everyone = await U.everyCardRows(sb, "id,name,reviewer_name,reviewer_relation,is_minor,person_code");
      } catch (e) {
        everyone = null;
      }
      const W = require("../utils/studio-words");
      scope.maskTaste = everyone ? (x) => (x == null ? x : W.maskNames(x, everyone)) : () => "(not shown: the cards couldn't be read to screen it)";
      const result = await runBrief({
        role: "brief-writer",
        task,
        attachments: parsed.attachments,
        scope: { ...scope, onStage: (s) => (stage = s) },
      });
      const brief = stage && stage.submitted ? stage.submitted : null;
      const passed = !!brief && ["passed", "passed_after_retry", "not_run"].includes(result.eval_status);
      const { briefText } = require("../agents/studio-brief/tools");
      await sb
        .from("agent_runs")
        .update({
          status: passed ? "completed" : brief ? "waiting" : "failed",
          output: brief ? `${briefText(brief)}\n\n---\n${result.output || ""}` : result.output || "",
          error: brief ? null : "The Brief Writer didn't hand back a brief.",
          trace: [...(result.trace || []), ...(brief ? [{ type: "studio_brief", brief }] : [])],
          usage: result.usage,
          eval_status: result.eval_status,
          retry_count: result.retry_count || 0,
          eval_summary: result.eval_summary,
          eval_biggest_miss: result.eval_biggest_miss,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runRow.id);
      if (result.eval_history && result.eval_history.length) {
        await sb.from("eval_runs").insert(
          result.eval_history.map((h) => ({
            agent_run_id: runRow.id,
            attempt: h.attempt,
            verdict: h.verdict,
            total_score: h.total_score,
            biggest_miss: h.biggest_miss,
            auto_fail_triggered: h.auto_fail_triggered,
            evaluator_model: h.evaluator_model,
          }))
        );
      }
      console.log(`[studio] brief ${runRow.id} ${passed ? "completed" : "waiting"} · ${Date.now() - startedAt}ms · eval=${result.eval_status} · refs=${parsed.refs.length}`);
      const starter = who(req);
      if (isPerson(starter)) {
        P.notifySoon([starter], brief
          ? { title: "Your brief is ready", body: `${brief.title}${brief.questions && brief.questions.length ? " · it has a question for you" : ""}`, url: `/app/#brief/${runRow.id}`, tag: `brief-${runRow.id}` }
          : { title: "The Brief Writer stopped", body: "Open it to see why.", url: `/app/#brief/${runRow.id}`, tag: `brief-${runRow.id}` });
      }
    } catch (e) {
      console.error(`[studio] brief ${runRow.id} failed:`, e.message);
      await sb
        .from("agent_runs")
        .update({ status: "failed", error: String(e.message).slice(0, 1000), completed_at: new Date().toISOString() })
        .eq("id", runRow.id);
    }
  });
});

module.exports = router;
