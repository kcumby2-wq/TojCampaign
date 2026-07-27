// Performance Agents API — mirrors /api/agents/ but scoped to the
// performance-os (wearable-performance-data · recruiting-fog-reducer)
// subsystem. Designed for browser use via the admin UI AND external
// automation (post-event batch runs, monthly cron, PlayerData webhooks,
// autonomous ops agents).
//
//   GET  /api/performance-agents/roles        → public metadata
//   GET  /api/performance-agents/skills       → public metadata
//   POST /api/performance-agents/run          → { role, task, client_id? } → { run_id }
//   GET  /api/performance-agents/runs/:id     → poll for status/result
//
// See agents/performance/API.md for the full external integration reference
// and performance-os/README.md for the business context.

const express = require("express");
const performance = require("../agents/performance/orchestrator");
const router = express.Router();

let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return (supabase = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabase;
  } catch {
    return (supabase = false);
  }
}

function requireAuth(req, res, next) {
  // Session auth OR API key (for external integrations + automation).
  if (req.session && req.session.userEmail) return next();
  const apiKey = req.headers["x-performance-api-key"];
  if (apiKey && apiKey === process.env.PERFORMANCE_API_KEY) {
    req._apiKeyAuth = true;
    return next();
  }
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/roles", (_req, res) => res.json({ roles: performance.listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: performance.listSkills() }));

router.post("/run", requireAuth, async (req, res) => {
  const { role, task, client_id, athlete_id } = req.body || {};
  // Accept athlete_id (performance-native alias) or client_id.
  const scopedId = client_id || athlete_id || null;

  if (!role || !performance.ROLES[role])
    return res.status(400).json({ error: "invalid_role" });
  if (!task || typeof task !== "string" || task.length < 5)
    return res.status(400).json({ error: "missing_task" });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data: runRow, error: insErr } = await sb
    .from("agent_runs")
    .insert({
      role,
      client_id: scopedId,
      task,
      status: "running",
    })
    .select()
    .single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  setImmediate(async () => {
    const startedAt = Date.now();
    try {
      const result = await performance.runAgent({ role, task, client_id: scopedId });
      const finalStatus = result.eval_status === "failed_after_retries" ? "waiting" : "completed";
      await sb
        .from("agent_runs")
        .update({
          status: finalStatus,
          output: result.output,
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
        `[performance] run ${runRow.id} ${finalStatus} · ${role} · ${Date.now() - startedAt}ms · eval=${result.eval_status} retries=${result.retry_count || 0}`
      );
    } catch (e) {
      console.error(`[performance] run ${runRow.id} failed:`, e.message);
      await sb
        .from("agent_runs")
        .update({
          status: "failed",
          error: e.message,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runRow.id);
    }
  });

  res.json({ ok: true, run_id: runRow.id, namespace: "performance" });
});

router.get("/runs/:id", requireAuth, async (req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data, error } = await sb
    .from("agent_runs")
    .select("id,role,client_id,task,status,output,trace,usage,error,created_at,completed_at,eval_status,retry_count,eval_summary,eval_biggest_miss")
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "not_found" });
  res.json(data);
});

module.exports = router;
