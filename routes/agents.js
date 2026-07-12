// Agent orchestrator API.
//   GET  /api/agents/roles   → list role definitions
//   GET  /api/agents/skills  → list skill IDs
//   POST /api/agents/run     → run a role on a task

const express = require("express");
const { runAgent, listRoles, listSkills, ROLES } = require("../agents/orchestrator");
const router = express.Router();

router.get("/roles", (_req, res) => res.json({ roles: listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: listSkills() }));

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
