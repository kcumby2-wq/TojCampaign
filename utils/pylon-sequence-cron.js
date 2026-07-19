// utils/pylon-sequence-cron.js
// Evaluates registered teams against pre/post-event sequence triggers every 15 min.
// During-event triggers fire from webhook triggers (Live Console posts → threshold check).
// Enable via `PYLON_CRON_ENABLED=true`.

const db = require("../db");

const CRON_INTERVAL_MS = 15 * 60 * 1000;

function renderTemplate(template, ctx) {
  if (!template) return null;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => ctx[key] ?? `{{${key}}}`);
}

async function evaluatePreEventSequences() {
  const now = new Date();
  // Look ahead 21 days for pre-event triggers
  const horizon = new Date(now.getTime() + 21 * 86400_000);
  const upcoming = await db.query(
    `SELECT r.id AS registration_id, r.team_id, r.event_id, e.name AS event_name, e.start_date, t.name AS team_name, t.coach_email, t.coach_phone, t.coach_name
     FROM pylon_registrations r
     JOIN pylon_events e ON e.id = r.event_id
     JOIN pylon_teams t ON t.id = r.team_id
     WHERE r.registration_status = 'confirmed' AND e.start_date >= $1 AND e.start_date <= $2`,
    [now.toISOString().slice(0, 10), horizon.toISOString().slice(0, 10)]
  );
  const sequences = await db.query(
    `SELECT * FROM pylon_sales_sequences WHERE phase = 'pre' AND active = true`
  );
  for (const seq of sequences.rows) {
    const cond = seq.trigger_condition;
    if (!cond?.offset_days || cond.from !== "event.start_date") continue;
    for (const reg of upcoming.rows) {
      const startDate = new Date(reg.start_date);
      const targetDate = new Date(startDate.getTime() + cond.offset_days * 86400_000);
      // Fire if within the last cron window
      const diffMs = Math.abs(now.getTime() - targetDate.getTime());
      if (diffMs > CRON_INTERVAL_MS) continue;
      // Already-fired guard
      const already = await db.query(
        `SELECT 1 FROM pylon_sequence_runs WHERE sequence_id=$1 AND team_id=$2 AND event_id=$3 LIMIT 1`,
        [seq.id, reg.team_id, reg.event_id]
      );
      if (already.rowCount > 0) continue;
      await fireSequence(seq, reg);
    }
  }
}

async function evaluatePostEventSequences() {
  const now = new Date();
  const lookback = new Date(now.getTime() - 30 * 86400_000);
  const recent = await db.query(
    `SELECT r.id AS registration_id, r.team_id, r.event_id, e.name AS event_name, e.end_date, e.start_date, t.name AS team_name, t.coach_email, t.coach_phone, t.coach_name
     FROM pylon_registrations r
     JOIN pylon_events e ON e.id = r.event_id
     JOIN pylon_teams t ON t.id = r.team_id
     WHERE r.registration_status = 'confirmed' AND coalesce(e.end_date, e.start_date) >= $1 AND coalesce(e.end_date, e.start_date) <= $2`,
    [lookback.toISOString().slice(0, 10), now.toISOString().slice(0, 10)]
  );
  const sequences = await db.query(
    `SELECT * FROM pylon_sales_sequences WHERE phase = 'post' AND active = true`
  );
  for (const seq of sequences.rows) {
    const cond = seq.trigger_condition;
    if (!cond?.offset_days || cond.from !== "event.end_date") continue;
    for (const reg of recent.rows) {
      const endDate = new Date(reg.end_date || reg.start_date);
      const targetDate = new Date(endDate.getTime() + cond.offset_days * 86400_000);
      const diffMs = Math.abs(now.getTime() - targetDate.getTime());
      if (diffMs > CRON_INTERVAL_MS) continue;
      const already = await db.query(
        `SELECT 1 FROM pylon_sequence_runs WHERE sequence_id=$1 AND team_id=$2 AND event_id=$3 LIMIT 1`,
        [seq.id, reg.team_id, reg.event_id]
      );
      if (already.rowCount > 0) continue;
      await fireSequence(seq, reg);
    }
  }
}

async function fireSequence(seq, reg) {
  const ctx = {
    coach_name: reg.coach_name || "Coach",
    team_name: reg.team_name,
    event_name: reg.event_name,
    team_id: reg.team_id,
    event_id: reg.event_id,
    cta_url: renderTemplate(seq.cta_url_template, {
      team_id: reg.team_id,
      event_id: reg.event_id,
      athlete_id: "", // placeholder for athlete-scoped sequences
    }),
  };
  const subject = renderTemplate(seq.subject_template, ctx);
  const body = renderTemplate(seq.body_template, ctx);
  console.log(
    `[pylon-sequence-cron] Firing ${seq.sequence_key} for team=${reg.team_name} event=${reg.event_name} channel=${seq.channel}`
  );
  // TODO: hand off to utils/email or SMS layer per channel
  // Record the run
  await db.query(
    `INSERT INTO pylon_sequence_runs (sequence_id, team_id, event_id, delivery_status, metadata)
     VALUES ($1, $2, $3, 'sent', $4)`,
    [seq.id, reg.team_id, reg.event_id, { subject, body: body ? body.slice(0, 500) : null }]
  );
}

function start() {
  console.log("[pylon-sequence-cron] Starting · 15-min interval");
  const tick = async () => {
    try {
      await evaluatePreEventSequences();
      await evaluatePostEventSequences();
    } catch (err) {
      console.error("[pylon-sequence-cron] error:", err.message);
    }
  };
  tick();
  return setInterval(tick, CRON_INTERVAL_MS);
}

module.exports = { start, evaluatePreEventSequences, evaluatePostEventSequences };
