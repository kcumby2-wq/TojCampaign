// routes/pylon-parent.js
// PUBLIC, token-gated: the parent or guardian approves or declines one
// Recruiting Concierge outreach draft. No staff session is involved.
//
//   GET  /api/pylon-parent/approval/:token  → the draft as it will be sent
//   POST /api/pylon-parent/approval/:token  → { decision: "approved" | "declined",
//                                                parent_name, confirm: true }
//
// The link comes from POST /api/pylon/recruiting/request-approval/:id.
// Only the token's hash is stored; links are one-time and expire after 14 days.
// Nothing about the athlete beyond a first name is returned, and nothing that
// identifies the athlete or parent is written to the logs.

const express = require("express");
const db = require("../db");
const parentApproval = require("../utils/parentApproval");

const router = express.Router();

function firstName(full) {
  return (String(full || "").trim().split(/\s+/)[0] || "your athlete").slice(0, 60);
}

router.get("/approval/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!parentApproval.isWellFormed(token)) return res.status(400).json({ error: "bad_link" });

  const result = await db.query(
    `SELECT o.program_name, o.program_level, o.coach_name, o.coach_email, o.outreach_type,
            o.draft_subject, o.draft_body, o.parent_approval_expires_at, a.canonical_name
       FROM pylon_recruiting_outreach o
       JOIN pylon_athletes a ON a.id = o.athlete_id
      WHERE o.parent_approval_token_hash = $1
        AND o.parent_approval_expires_at > now()
        AND o.parent_decision IS NULL`,
    [parentApproval.hashToken(token)]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "link_not_active" });

  const r = result.rows[0];
  res.json({
    ok: true,
    athlete_first_name: firstName(r.canonical_name),
    program_name: r.program_name,
    program_level: r.program_level,
    coach_name: r.coach_name,
    coach_email: r.coach_email,
    outreach_type: r.outreach_type,
    draft_subject: r.draft_subject,
    draft_body: r.draft_body,
    expires_at: r.parent_approval_expires_at,
  });
});

router.post("/approval/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!parentApproval.isWellFormed(token)) return res.status(400).json({ error: "bad_link" });

  const body = req.body || {};
  const decision = body.decision;
  if (!["approved", "declined"].includes(decision))
    return res.status(400).json({ error: "decision must be approved or declined" });
  if (body.confirm !== true)
    return res.status(400).json({ error: "please confirm you are the parent or legal guardian" });
  const parentName = String(body.parent_name || "").trim().slice(0, 200);
  if (parentName.length < 2) return res.status(400).json({ error: "please enter your name" });

  const approve = decision === "approved";
  // One statement: the token is checked, burned and the decision recorded
  // together, so a link can never be used twice.
  const result = await db.query(
    `UPDATE pylon_recruiting_outreach
        SET parent_decision            = $2,
            parent_decided_at          = now(),
            parent_decided_name        = $3,
            parent_approved            = $4,
            parent_approved_at         = CASE WHEN $4 THEN now() ELSE NULL END,
            approved_text_sha256       = CASE WHEN $4 THEN encode(sha256(convert_to(
                                           coalesce(draft_subject, '') || E'\\n' || coalesce(draft_body, ''),
                                           'UTF8')), 'hex') ELSE NULL END,
            parent_approval_token_hash = NULL,
            parent_approval_expires_at = NULL
      WHERE parent_approval_token_hash = $1
        AND parent_approval_expires_at > now()
        AND parent_decision IS NULL
      RETURNING id`,
    [parentApproval.hashToken(token), decision, parentName, approve]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "link_not_active" });

  console.log(`[pylon-parent] outreach ${result.rows[0].id} ${decision} by parent link`);
  res.json({ ok: true, decision });
});

module.exports = router;
