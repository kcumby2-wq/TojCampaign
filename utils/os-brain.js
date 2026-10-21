// The operating brain: the folder of instructions an agent runs the client's
// operating system from, in the same shape as Kyron's other brains
// (patterson-os, pylon-os): CLAUDE.md, a daily workflow, a skill per system,
// a voice skill, config, the feedback loop, and the approved transcript.
//
// Built from approved data only (the approved pillars and transcript, the
// systems list). No contact details; nothing that can name a minor.

"use strict";

const O = require("./os");

function day(iso) {
  return String(iso || new Date().toISOString()).slice(0, 10);
}
function md(s) {
  return String(s == null ? "" : s).replace(/\r/g, "").trim();
}

function transcriptMarkdown(build) {
  const v = build.vertical;
  const t = build.transcript || {};
  const sec = O.SECTIONS[v] || O.SECTIONS["personal-brand"];
  const cols = O.LINE_COLUMNS[v] || O.LINE_COLUMNS["personal-brand"];
  const p = build.pillars || {};
  const out = [];
  out.push(`# Operational Transcript — ${O.displayName(build.intake, build.name)}`, "", `Approved ${day(build.transcript_approved_at)} · ${O.VERTICALS[v].label} lane`, "");
  out.push(`## 01 · ${sec[0]}`, "", md(t.executive_summary) || "—", "");
  out.push(`## 02 · ${sec[1]}`, "", "| Pillar | Score | Band | Evidence | Gap |", "|---|---|---|---|---|");
  for (const k of O.PILLARS) {
    const x = p[k] || {};
    out.push(`| ${O.pillarName(v, k)} | ${x.score ?? "—"}/100 | ${x.score != null ? O.band(x.score).name : "—"} | ${md(x.evidence)} | ${md(x.gap)} |`);
  }
  out.push("", `Total ${O.totalScore(p)}/500. Weakest: ${O.pillarName(v, O.weakest(p) || "brand_identity")}.`, "");
  out.push(`## 03 · ${sec[2]}`, "", `| ${cols.join(" | ")} | Note |`, "|---|---|---|---|");
  for (const l of t.lines || []) out.push(`| ${md(l.name)} | ${md(l.figure) || "—"} | ${md(l.standing) || "—"} | ${md(l.note)} |`);
  out.push("", `## 04 · ${sec[3]}`, "", "| Opportunity | Value | Ease | Note |", "|---|---|---|---|");
  for (const r of t.recovery || []) out.push(`| ${md(r.title)} | ${md(r.value) || "—"} | ${md(r.ease)} | ${md(r.note)} |`);
  out.push("", `## 05 · ${sec[4]}`, "", md(t.roster) || "—", "", `## 06 · ${sec[5]}`, "");
  for (const x of t.path || []) out.push(`- **${md(x.label)}:** ${md(x.text)}`);
  out.push("", `## 07 · ${sec[6]}`, "");
  (t.actions || []).forEach((a, i) => out.push(`${i + 1}. **${md(a.title)}** — ${md(a.detail)} _(Owner: ${md(a.owner)})_`));
  out.push("");
  return out.join("\n");
}

function systemsTable(build, group) {
  const list = (build.systems || []).filter((s) => !group || s.group === group);
  if (!list.length) return "_None listed yet._";
  return ["| System | Status | Owner |", "|---|---|---|", ...list.map((s) => `| ${md(s.label)} | ${s.status} | ${md(s.owner)} |`)].join("\n");
}

function skillFile(build, group, title, steps) {
  const slug = O.slugify(O.displayName(build.intake, build.name));
  return `# Skill: ${title}

Part of ${slug}-os. The ${title.toLowerCase()} system TOJ installed for ${O.displayName(build.intake, build.name)}.

## What's installed

${systemsTable(build, group)}

## How to run it

${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Gates

- Anything that goes to a client, a parent or the public is a **draft** until Kyron approves it (or \`config.md\` is in auto mode for that channel).
- Log ids, never names, contact details or film links.
- If a step needs something the system doesn't have yet, write it in \`feedback/feedback-log.md\` instead of working around it.
`;
}

function brainFiles(build, { by = "TOJ" } = {}) {
  const v = build.vertical;
  const lane = O.VERTICALS[v];
  const name = O.displayName(build.intake, build.name);
  const slug = O.slugify(name);
  const today = day();
  const p = build.pillars || {};
  const weak = O.weakest(p);
  const t = build.transcript || {};
  const intake = build.intake || {};
  // The facts the intake gives, in its own words (no contact details, no minors' names).
  const FACT_KEYS = ["what_you_do", "mission_statement", "delivery_format", "sport_position", "methodology", "years_operating", "year_founded", "current_customers", "participants", "num_programs", "staff_fte", "ttm_revenue", "annual_budget", "current_revenue"];
  const what = FACT_KEYS.filter((k) => O.clean(intake[k])).map((k) => `${O.humanKey(k)}: ${O.clean(intake[k], 300)}.`).join(" ");
  const where = O.clean([intake.city, intake.state].filter(Boolean).join(", ") || intake.location || "", 120);
  const goal = O.clean(intake.biggest_goal || intake.year_3_vision || "", 400);
  const voice = O.clean(intake.voice || intake.known_for || "", 400);
  const minorsLane = v === "authority" || v === "nonprofit";
  const prog = O.systemsProgress(build.systems);

  const claude = `# ${name} Operating Brain (v1.0)

You are the operating brain for **${name}**${where ? `, based in ${where}` : ""}. You are operated by **Kyron Cumby** of **Trail of Joy Management Group, LLC (TOJ)**.

**Lane:** ${lane.label} (${lane.for}).
**Status:** ${build.stage === "running" ? "Running on the Trail of Joy" : "Systemized — systems being installed"} (${prog.live} of ${prog.total} systems live). Built in the TOJ app on ${today} from the approved Foundation Score and Operational Transcript.

---

## The Business — In One Paragraph

${what || "_Add what the business does here (not in the intake)._"}${goal ? `\n\n**Biggest goal (their words):** ${goal}` : ""}

---

## The Standard — Where It Stands

Scored against the five pillars and approved ${day(build.pillars_approved_at)}.

| Pillar | Score | Band |
|---|---|---|
${O.PILLARS.map((k) => `| ${O.pillarName(v, k)} | ${p[k] ? p[k].score : "—"}/100 | ${p[k] ? O.band(p[k].score).name : "—"} |`).join("\n")}

**Total:** ${O.totalScore(p)}/500. **Fix first:** ${weak ? O.pillarName(v, weak) : "—"}${weak && p[weak] && p[weak].gap ? ` — ${md(p[weak].gap)}` : ""}

The full report is \`transcript/operational-transcript.md\`.

---

## The Systems (what TOJ installed)

We install the intake, delivery, and follow-up systems the business runs on, so the work keeps moving when the owner steps away.

### Intake — \`skills/intake/SKILL.md\`
${systemsTable(build, "intake")}

### Delivery — \`skills/delivery/SKILL.md\`
${systemsTable(build, "delivery")}

### Follow-up — \`skills/follow-up/SKILL.md\`
${systemsTable(build, "follow_up")}

Every business on the Trail inherits four layers: **Automation** (agents run intake, follow-up, delivery and reporting), **Ownership** (the work and the credit provably belong to the operator), **Economy** (splits, referrals and contribution tracked, not guessed) and **Credibility** (real-world events anchored to records that can be verified).

---

## This Month's Priority List (from the transcript)

${(t.actions || []).map((a, i) => `${i + 1}. **${md(a.title)}** — ${md(a.detail)} _(Owner: ${md(a.owner)})_`).join("\n") || "_See the transcript._"}

---

## Your Operating Rules

1. Read \`workflows/daily.md\` first and run it every session.
2. Read \`feedback/feedback-log.md\` for anything new before anything else.
3. Write in the business's voice using \`skills/${slug}-voice/SKILL.md\`.
4. Run the systems through \`skills/intake/\`, \`skills/delivery/\` and \`skills/follow-up/\`.
5. Save everything to \`output/\` with today's date in the filename.
6. Never invent a result, a number, a client, a testimonial or a quote. Every claim comes from this repo or the client.
7. Never publish, send externally, or fire outreach without Kyron's explicit approval (manual mode) or the rules in \`config.md\` (auto mode).
8. Log ids, never names, contact details or film links.${minorsLane ? `
9. **Minors:** no minor's full name, face or data in anything public without a consent flag and a guardian signature on file. A parent is on every call and copied on every message to an athlete under 18.
10. NIL, amateurism, eligibility, placement, scholarship and contract questions are **draft only**, flagged for Kyron and counsel.` : ""}

---

## Hard Lines

- No promises about results, offers, scholarships, rankings or placement. "Guaranteed exposure" and "guaranteed placement" are banned phrases.
- **Banned words (TOJ-wide):** ${O.BANNED_WORDS.join(", ")}.
- AI-generated or AI-altered media never appears in a testimonial, a result or a before-and-after.
- Takedown within 72 hours of a request.

---

## The Prime Directive

Every session must leave the repo more valuable than you found it. The systems get tighter, the owner's time-saved number goes up, and nothing reaches a client without a person approving it. **The revenue outlives the tokens.**

---

*v1.0 — ${today} — generated by the TOJ app's Operating System builder from the approved transcript. See \`improvements.md\`.*
`;

  const daily = `# Daily Workflow — Run This Every Session, In Order

## STEP 1 — FEEDBACK CHECK (Always First)
Open \`feedback/feedback-log.md\`. For each new entry: find the file it affects, propose the edit to Kyron, make it on approval, and log it in \`improvements.md\`.

## STEP 2 — INTAKE
Run \`skills/intake/SKILL.md\`: new inquiries or sign-ups since last session get a record (by id) and the next-step reply, drafted for approval.

## STEP 3 — DELIVERY
Run \`skills/delivery/SKILL.md\`: anything due this week is on its checklist; anything late is flagged at the top of the session log.

## STEP 4 — FOLLOW-UP
Run \`skills/follow-up/SKILL.md\`: reviews, referrals, re-bookings and updates that are due, drafted for approval.

## STEP 5 — PRIORITY LIST
Open \`CLAUDE.md\` → This Month's Priority List. One line per item: moved forward, blocked, or untouched.

## STEP 6 — CLOSE THE LOOP
Save the session log to \`output/\` with today's date. Note what to improve in \`feedback/feedback-log.md\`.
`;

  const voiceSkill = `# Skill: ${name} Voice

Write as ${name}, not as TOJ. TOJ's fingerprint stays out of published work.

## Their voice (from the intake)
${voice || "_Not in the intake yet. Ask Kyron for three posts or messages they've written and describe the voice from those._"}

## Always
- Plain, specific, numbers over adjectives. Name the task, the hours, the dollars.
- US English.
- Say only what's delivered.

## Never
- These words, in any form: ${O.BANNED_WORDS.join(", ")}.
- Promises about results, offers, scholarships or placement.
- A name, quote or result that isn't in this repo.
`;

  const config = `# config.md — ${slug}-os

**Lane:** ${lane.label}
**Mode:** manual-review — every outbound message, post or report is a draft until Kyron approves it.

\`\`\`yaml
mode: manual_review          # switch per channel only with Kyron's written OK
channels:
  email: draft_only
  social: draft_only
  sms: draft_only
minors_rules: ${minorsLane ? "strict" : "standard"}
systems_live: ${prog.live}/${prog.total}
\`\`\`
`;

  const feedback = `# Feedback Log

Drop feedback here anytime. The agent reads this first every session (\`workflows/daily.md\` Step 1), proposes the fix, and logs the change in \`improvements.md\` after Kyron approves.

---
`;

  const improvements = `# Improvements

## ${today} — founding entry
Generated by the TOJ app's Operating System builder from the approved Foundation Score (pillars approved ${day(build.pillars_approved_at)}) and the approved Operational Transcript (${day(build.transcript_approved_at)}). ${prog.live} of ${prog.total} systems live at generation.
`;

  const readme = `# ${slug}-os

The operating brain for ${name}. Start with \`CLAUDE.md\`, then \`workflows/daily.md\`.

- \`transcript/\` — the approved Operational Transcript
- \`skills/\` — intake, delivery, follow-up, and the voice
- \`feedback/\` — the self-improving loop
- \`output/\` — everything the brain produces, dated
`;

  return {
    "CLAUDE.md": claude,
    "README.md": readme,
    "config.md": config,
    "improvements.md": improvements,
    "workflows/daily.md": daily,
    "feedback/feedback-log.md": feedback,
    "transcript/operational-transcript.md": transcriptMarkdown(build),
    [`skills/${slug}-voice/SKILL.md`]: voiceSkill,
    "skills/intake/SKILL.md": skillFile(build, "intake", "Intake", ["Capture every new inquiry or sign-up in one place, by id.", "Send the next-step reply (drafted, approved per `config.md`).", "Make sure consent is on file before anything about a person is stored or shared."]),
    "skills/delivery/SKILL.md": skillFile(build, "delivery", "Delivery", ["List what's due this week from the delivery checklist.", "Mark each item delivered with the date.", "Flag anything late at the top of the session log."]),
    "skills/follow-up/SKILL.md": skillFile(build, "follow_up", "Follow-up", ["Find who's due a review request, referral prompt, update or re-booking.", "Draft each message in the business's voice.", "Hold every draft for approval; log what was sent, by id."]),
    "output/README.md": "Everything the brain produces lands here, with the date in the filename.\n",
  };
}

module.exports = { brainFiles, transcriptMarkdown };
