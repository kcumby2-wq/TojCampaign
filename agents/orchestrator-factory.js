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

const DEFAULT_MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 20;

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

  console.log(
    `[${namespace}] loaded ${Object.keys(ROLES).length} roles, ${Object.keys(SKILLS).length} skills`
  );

  function buildSystemPrompt(role) {
    const skillBlocks = (role.skills || []).map((id) => SKILLS[id]).filter(Boolean);
    if (skillBlocks.length === 0) return role.persona;
    return role.persona + "\n\n---\n\n# Available skills\n\n" + skillBlocks.join("\n\n---\n\n");
  }

  async function runAgent({ role, task, client_id = null }) {
    const cfg = ROLES[role];
    if (!cfg) throw new Error(`unknown_role:${role}`);
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

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
      namespace,
      role,
      label: cfg.label,
      output: finalText,
      trace,
      stop_reason: final.stop_reason,
      usage: final.usage,
      skills_loaded: cfg.skills || [],
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
