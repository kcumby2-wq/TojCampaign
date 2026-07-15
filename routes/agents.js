// Agent orchestrator API — async pattern.
//
//   GET  /api/agents/roles          → list role definitions (public)
//   GET  /api/agents/skills         → list skill IDs (public)
//   POST /api/agents/run            → { role, task, client_id? } → { run_id }
//                                     Agent runs in background; store row in agent_runs
//   GET  /api/agents/runs/:id       → poll for status/result
//
// Why async: Opus 4.8 + tool_runner + RAG can take 60–120s per run, and
// Vercel's rewrite proxy times out around ~30s. Submitting synchronously
// meant the browser saw "Unexpected token '<'" (Vercel's HTML timeout page)
// even though the backend was still working. Now the browser gets a run_id
// immediately and polls until done.

const express = require("express");
const { runAgent, listRoles, listSkills, ROLES } = require("../agents/orchestrator");
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
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/roles", (_req, res) => res.json({ roles: listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: listSkills() }));

// Submit a task — returns immediately with run_id
router.post("/run", requireAuth, async (req, res) => {
  const { role, task, client_id } = req.body || {};
  if (!role || !ROLES[role])
    return res.status(400).json({ error: "invalid_role" });
  if (!task || typeof task !== "string" || task.length < 5)
    return res.status(400).json({ error: "missing_task" });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data: runRow, error: insErr } = await sb
    .from("agent_runs")
    .insert({
      role,
      client_id: client_id || null,
      task,
      status: "running",
    })
    .select()
    .single();
  if (insErr) return res.status(500).json({ error: insErr.message });

  // Fire the agent in the background; do NOT await
  setImmediate(async () => {
    const startedAt = Date.now();
    try {
      const result = await runAgent({ role, task, client_id: client_id || null });
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

      // Persist per-attempt eval history
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
        `[agents] run ${runRow.id} ${finalStatus} · ${role} · ${Date.now() - startedAt}ms · eval=${result.eval_status} retries=${result.retry_count || 0}`
      );
    } catch (e) {
      console.error(`[agents] run ${runRow.id} failed:`, e.message);
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

  res.json({ ok: true, run_id: runRow.id });
});

// Poll for run result
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
