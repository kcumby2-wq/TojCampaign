// POST /api/agents/run { role, task, client_id? }
//
// Admin-only. Fires the multi-agent orchestrator and returns the final
// output plus a compact trace of tool calls the agent made.

const express = require("express");
const { runAgent, ROLES } = require("../agents/orchestrator");
const router = express.Router();

router.get("/roles", (_req, res) => {
  res.json({
    roles: Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label })),
  });
});

router.post("/run", async (req, res) => {
  const { role, task, client_id } = req.body || {};
  if (!role || !ROLES[role])
    return res.status(400).json({ error: "invalid_role" });
  if (!task || typeof task !== "string" || task.length < 5)
    return res.status(400).json({ error: "missing_task" });

  try {
    const result = await runAgent({ role, task, client_id });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[agents] run failed:", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
