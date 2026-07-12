// Agent orchestrator API.
//   GET  /api/agents/roles   → list role definitions (public — metadata only)
//   GET  /api/agents/skills  → list skill IDs (public)
//   POST /api/agents/run     → run a role on a task (auth-gated)

const express = require("express");
const { runAgent, listRoles, listSkills, ROLES } = require("../agents/orchestrator");
const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session && req.session.userEmail) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

router.get("/roles", (_req, res) => res.json({ roles: listRoles() }));
router.get("/skills", (_req, res) => res.json({ skills: listSkills() }));

router.post("/run", requireAuth, async (req, res) => {
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
