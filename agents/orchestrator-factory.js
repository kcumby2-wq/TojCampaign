// Orchestrator factory — one engine, many namespaces.
//
// Every "agent pack" (TOJ, Hooks, and future Certified Operator packs)
// gets its own orchestrator instance by passing its baseDir + tools:
//
//   const factory = require("./orchestrator-factory");
//   module.exports = factory.createOrchestrator({
//     namespace: "toj",
//     baseDir: __dirname,        // scans roles/ and skills/ under this dir
//     tools: [...],              // Anthropic betaTool() definitions
//   });
//
// Roles live in <baseDir>/roles/*.js; skills in <baseDir>/skills/*.md.
// Each role: { id, label, tagline, skills: [], persona, model? }
// System prompt = persona + "\n\n---\n\n" + skill contents joined.

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const { evaluate } = require("../utils/evaluator");

const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 20;
const MAX_EVAL_RETRIES = 3;

function loadDir(dir, matcher, mapper) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const file of fs.readdirSync(dir)) {
    if (!matcher(file)) continue;
    const [id, value] = mapper(file, dir);
    if (id) out[id] = value;
  }
  return out;
}

function createOrchestrator({ namespace, baseDir, tools, defaultModel = DEFAULT_MODEL }) {
  const ROLES = loadDir(
    path.join(baseDir, "roles"),
    (f) => f.endsWith(".js"),
    (f, d) => {
      const role = require(path.join(d, f));
      return [role && role.id, role];
    }
  );
  const SKILLS = loadDir(
    path.join(baseDir, "skills"),
    (f) => f.endsWith(".md"),
    (f, d) => [path.basename(f, ".md"), fs.readFileSync(path.join(d, f), "utf8")]
  );

  // Load the eval spec for this namespace (if present)
  let EVAL_SPEC = null;
  const evalsDir = path.join(baseDir, "evals");
  if (fs.existsSync(evalsDir)) {
    for (const f of fs.readdirSync(evalsDir)) {
      if (!f.endsWith(".js")) continue;
      const spec = require(path.join(evalsDir, f));
      if (spec && spec.namespace === namespace) {
        EVAL_SPEC = spec;
        break;
      }
    }
  }

  console.log(
    `[${namespace}] loaded ${Object.keys(ROLES).length} roles, ${Object.keys(SKILLS).length} skills${EVAL_SPEC ? `, eval spec "${EVAL_SPEC.id}"` : ", no eval spec"}`
  );

  function buildSystemPrompt(role) {
    const skillBlocks = (role.skills || []).map((id) => SKILLS[id]).filter(Boolean);
    if (skillBlocks.length === 0) return role.persona;
    return role.persona + "\n\n---\n\n# Available skills\n\n" + skillBlocks.join("\n\n---\n\n");
  }

  // Single agent invocation (no eval loop) — internal.
  async function _invokeAgentOnce({ role, task, client_id }) {
    const cfg = ROLES[role];
    const client = new Anthropic();
    const userMessage = client_id
      ? `Client scope: ${client_id}\n\nTask:\n${task}`
      : task;

    const runner = client.beta.messages.toolRunner({
      model: cfg.model || defaultModel,
      max_tokens: 8000,
      system: buildSystemPrompt(cfg),
      tools,
      messages: [{ role: "user", content: userMessage }],
      thinking: { type: "adaptive" },
      max_iterations: MAX_ITERATIONS,
    });

    const trace = [];
    let final = null;
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "text") trace.push({ type: "text", text: block.text });
        else if (block.type === "tool_use")
          trace.push({ type: "tool_use", name: block.name, input: block.input });
      }
      if (message.stop_reason === "end_turn") final = message;
    }
    if (!final) final = await runner.done();

    const finalText = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    return {
      role,
      label: cfg.label,
      output: finalText,
      trace,
      stop_reason: final.stop_reason,
      usage: final.usage,
    };
  }

  // Public runAgent — wraps _invokeAgentOnce with the eval retry loop.
  async function runAgent({ role, task, client_id = null }) {
    const cfg = ROLES[role];
    if (!cfg) throw new Error(`unknown_role:${role}`);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

    const evalHistory = [];
    let currentTask = task;
    let attempt = 0;
    let lastResult = null;
    let lastEval = null;

    while (attempt < MAX_EVAL_RETRIES) {
      attempt++;
      lastResult = await _invokeAgentOnce({ role, task: currentTask, client_id });

      // If no eval spec, ship immediately
      if (!EVAL_SPEC) {
        return {
          namespace,
          ...lastResult,
          skills_loaded: cfg.skills || [],
          eval_status: "not_run",
          retry_count: 0,
          eval_history: [],
        };
      }

      lastEval = await evaluate(EVAL_SPEC, lastResult, {
        client_id_present: !!client_id,
      });
      evalHistory.push({
        attempt,
        verdict: lastEval.verdict,
        total_score: lastEval.total_score,
        biggest_miss: lastEval.biggest_miss,
        auto_fail_triggered: lastEval.auto_fail_triggered,
        evaluator_model: lastEval.evaluator_model,
      });

      console.log(
        `[${namespace}] eval attempt ${attempt}: ${lastEval.verdict} score=${lastEval.total_score}${lastEval.auto_fail_triggered ? ` autofail=${lastEval.auto_fail_triggered}` : ""}`
      );

      if (lastEval.verdict === "PASS") {
        return {
          namespace,
          ...lastResult,
          skills_loaded: cfg.skills || [],
          eval_status: attempt === 1 ? "passed" : "passed_after_retry",
          retry_count: attempt - 1,
          eval_history: evalHistory,
          eval_summary: `Score ${lastEval.total_score}, passed on attempt ${attempt}`,
          eval_biggest_miss: null,
        };
      }

      // Failed — append retry guidance for next attempt
      currentTask = `${task}\n\n---\n\nPRIOR ATTEMPT FAILED EVAL. Retry guidance from the judge:\n"${lastEval.retry_guidance}"\n\nBiggest miss: "${lastEval.biggest_miss}"\n\nProduce a new attempt that fixes these specific issues.`;
    }

    // Exhausted retries — return the last attempt with eval history so the
    // human can see what happened. Option B: land in Waiting with the story.
    return {
      namespace,
      ...lastResult,
      skills_loaded: cfg.skills || [],
      eval_status: "failed_after_retries",
      retry_count: MAX_EVAL_RETRIES,
      eval_history: evalHistory,
      eval_summary: `Failed after ${MAX_EVAL_RETRIES} attempts. Best score: ${Math.max(...evalHistory.map((h) => h.total_score || 0))}. Landed in Waiting for human review.`,
      eval_biggest_miss: lastEval?.biggest_miss || "unknown",
    };
  }

  function listRoles() {
    return Object.values(ROLES).map((r) => ({
      id: r.id,
      label: r.label,
      tagline: r.tagline || "",
      skills: r.skills || [],
    }));
  }

  function listSkills() {
    return Object.keys(SKILLS).map((id) => ({ id }));
  }

  return { namespace, runAgent, listRoles, listSkills, ROLES, SKILLS };
}

module.exports = { createOrchestrator };
