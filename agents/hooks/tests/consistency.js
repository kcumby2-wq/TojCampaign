#!/usr/bin/env node
//
// Hooks agent consistency test.
//
// Boot every role in the Hooks namespace and assert cross-role uniformity.
// Runs as a standalone script — no test framework dependency, exits 0 on
// pass, 1 on any failure. Wire into CI (or a pre-push hook) so a persona
// edit that silently breaks the shape another role expects gets caught
// before deploy.
//
//   node agents/hooks/tests/consistency.js
//
// Enforces the 7-gap-consistency contract established in
// agents/hooks/CONSISTENCY-REVIEW.md.

const fs = require("fs");
const path = require("path");

const ROLES_DIR = path.join(__dirname, "..", "roles");
const SKILLS_DIR = path.join(__dirname, "..", "skills");
const EVALS_DIR = path.join(__dirname, "..", "evals");
const METHODOLOGY_PATH = path.join(SKILLS_DIR, "hooks-methodology.md");

const failures = [];
const notes = [];

function fail(role, msg) {
  failures.push(`  ✗ [${role}] ${msg}`);
}
function ok(role, msg) {
  notes.push(`  ✓ [${role}] ${msg}`);
}

// -------- Load everything --------

const roleFiles = fs
  .readdirSync(ROLES_DIR)
  .filter((f) => f.endsWith(".js"));

const roles = roleFiles.map((f) => {
  const full = path.join(ROLES_DIR, f);
  return { file: f, role: require(full) };
});

const methodology = fs.readFileSync(METHODOLOGY_PATH, "utf8");

// Confirm the shared preamble + missing-data exit exist in the methodology
// skill — if they don't, none of the roles can inherit them.
if (!/canonical output preamble/i.test(methodology)) {
  failures.push("  ✗ [hooks-methodology] shared output preamble section missing");
} else {
  notes.push("  ✓ [hooks-methodology] shared output preamble present");
}
if (!/canonical missing-data exit/i.test(methodology)) {
  failures.push("  ✗ [hooks-methodology] shared missing-data exit section missing");
} else {
  notes.push("  ✓ [hooks-methodology] shared missing-data exit present");
}

// Confirm the namespace eval spec exists + has the expected shape
const evalFiles = fs.readdirSync(EVALS_DIR).filter((f) => f.endsWith(".js"));
const evalSpec = evalFiles
  .map((f) => require(path.join(EVALS_DIR, f)))
  .find((s) => s && s.namespace === "hooks");
if (!evalSpec) {
  failures.push("  ✗ [evals] hooks-namespaced eval spec not found");
} else {
  if (!Array.isArray(evalSpec.questions) || evalSpec.questions.length < 5)
    failures.push(`  ✗ [evals] questions[] missing or < 5 (got ${evalSpec.questions?.length})`);
  else ok("evals", `${evalSpec.questions.length} scored questions`);

  // The 7-gap review added 3 autofails to reach parity with performance-principles
  const expectedAutofailIds = [
    "fabricated_measurables",
    "head_coach_draft",
    "llm_vocabulary",
    "hype_triples",
    "exclamation_marks",
    "pro_comparison_without_evidence",
    "invented_athlete_facts",
  ];
  const actualAutofailIds = (evalSpec.auto_fails || []).map((a) => a.id);
  const missing = expectedAutofailIds.filter((id) => !actualAutofailIds.includes(id));
  if (missing.length)
    failures.push(`  ✗ [evals] auto_fails missing: ${missing.join(", ")}`);
  else ok("evals", `all 7 expected auto_fails present`);
}

// -------- Per-role assertions --------

for (const { file, role } of roles) {
  const rid = role.id || file;

  // Required fields
  if (!role.id) fail(rid, "missing `id`");
  if (!role.label) fail(rid, "missing `label`");
  if (!role.tagline) fail(rid, "missing `tagline`");
  if (!Array.isArray(role.skills)) fail(rid, "`skills` must be an array");
  if (typeof role.persona !== "string") fail(rid, "`persona` must be a string");
  if (role.persona && role.persona.length < 200)
    fail(rid, `persona too thin (${role.persona.length} chars, need >= 200)`);

  // Every Hooks role must load the shared skills so it inherits preamble + exit
  if (!role.skills?.includes("hooks-methodology"))
    fail(rid, "does not load `hooks-methodology` skill (misses shared preamble + exit format)");
  if (!role.skills?.includes("hooks-voice"))
    fail(rid, "does not load `hooks-voice` skill (voice guardrails)");

  // Persona must instruct retrieval-first discipline
  if (!/retrieve_client_context/.test(role.persona))
    fail(rid, "persona doesn't reference `retrieve_client_context` (retrieval-first discipline missing)");

  // Persona must name an output format (fenced ===== template, or explicit
  // reference to a skill's output format)
  const hasFencedTemplate = /=====\s+[A-Z]/.test(role.persona);
  const hasReferencedFormat = /output format/i.test(role.persona);
  if (!hasFencedTemplate && !hasReferencedFormat)
    fail(rid, "persona doesn't name an output shape (no fenced template AND no 'output format' reference)");

  // Persona must handle at least 3 edge cases. Detected by locating the
  // "Edge cases:" section and counting `- ` list items that follow it, up
  // to the next blank-line-terminated block or the end of the persona.
  let edgeCount = 0;
  const edgeHeaderMatch = role.persona.match(/Edge cases:\s*\n([\s\S]*)/i);
  if (edgeHeaderMatch) {
    const after = edgeHeaderMatch[1];
    edgeCount = (after.match(/^\s*-\s+/gm) || []).length;
  }
  if (edgeCount < 3)
    fail(rid, `persona covers only ${edgeCount} edge cases in the "Edge cases:" section (need >= 3)`);

  // Persona must reference the shared insufficient-data pattern or the
  // canonical exit label. The 4 role-fenced templates reference it directly;
  // Trainer Blueprint / Roster Pulse handle missing-data via the shared
  // methodology skill they load.
  const referencesExit =
    /INSUFFICIENT DATA/i.test(role.persona) ||
    /insufficient data/i.test(role.persona) ||
    /schedule data not on file/i.test(role.persona) ||  // Roster Pulse's variant
    /confirm status before proceeding/i.test(role.persona); // NIL variant (legacy)
  if (!referencesExit)
    fail(rid, "persona doesn't handle the missing-data case (no INSUFFICIENT DATA reference)");

  // If eval_additions present, validate their shape
  if (role.eval_additions) {
    if (!Array.isArray(role.eval_additions))
      fail(rid, "`eval_additions` must be an array");
    else {
      for (const [i, q] of role.eval_additions.entries()) {
        if (!q.id || !q.prompt || !q.pass_signal || !q.fail_signal)
          fail(rid, `eval_additions[${i}] missing required field (id/prompt/pass_signal/fail_signal)`);
      }
      ok(rid, `${role.eval_additions.length} role-specific eval question(s)`);
    }
  }

  if (!failures.some((f) => f.startsWith(`  ✗ [${rid}]`)))
    ok(rid, `contract satisfied`);
}

// -------- Report --------

console.log("\n=== HOOKS CONSISTENCY TEST ===\n");
console.log(`Roles loaded: ${roles.length}`);
console.log(`Autofails on namespace spec: ${evalSpec?.auto_fails?.length || 0}`);
console.log(`Scored questions on namespace spec: ${evalSpec?.questions?.length || 0}\n`);

if (notes.length) {
  console.log("PASSED:");
  notes.forEach((n) => console.log(n));
  console.log("");
}
if (failures.length) {
  console.log("FAILED:");
  failures.forEach((f) => console.log(f));
  console.log("");
  console.log(`✗ ${failures.length} failure(s). Fix before shipping.\n`);
  process.exit(1);
}
console.log(`✓ All ${roles.length} roles satisfy the consistency contract.\n`);
process.exit(0);
