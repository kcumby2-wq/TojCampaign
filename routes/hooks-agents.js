// Hooks Agents API — mirrors /api/agents/ but scoped to the Hooks
// operator subsystem. Designed for external integration (Optimum, CRM,
// email systems).
//
//   GET  /api/hooks-agents/roles        → public metadata
//   GET  /api/hooks-agents/skills       → public metadata
//   POST /api/hooks-agents/run          → { role, task, athlete_id? } → { run_id }
//   GET  /api/hooks-agents/runs/:id     → poll for status/result
//
// See agents/hooks/API.md for the full external integration reference.

const express = require("express");
const hooks = require("../agents/hooks/orchestrator");
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
  // Session auth OR API key (for external integrations).
  if (req.session && req.session.userEmail) return next();
  const apiKey = req.headers["x-hooks-api-key"];
  if (apiKey && apiKey === process.env.HOOKS_API_KEY) {
    req._apiKeyAuth = true;
    return next();
  }
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/roles", (_req, res) => res.json({ roles: hooks.listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: hooks.listSkills() }));

router.post("/run", requireAuth, async (req, res) => {
  const { role, task, athlete_id, client_id } = req.body || {};
  // Accept either athlete_id (Hooks-native) or client_id (compat).
  const scopedId = athlete_id || client_id || null;

  if (!role || !hooks.ROLES[role])
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
      const result = await hooks.runAgent({ role, task, client_id: scopedId });
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
        `[hooks] run ${runRow.id} ${finalStatus} · ${role} · ${Date.now() - startedAt}ms · eval=${result.eval_status} retries=${result.retry_count || 0}`
      );
    } catch (e) {
      console.error(`[hooks] run ${runRow.id} failed:`, e.message);
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

  res.json({ ok: true, run_id: runRow.id, namespace: "hooks" });
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
