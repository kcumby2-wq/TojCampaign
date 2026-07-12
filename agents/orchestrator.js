// Multi-agent orchestrator (pillar 4).
//
// Loads role personas from agents/roles/*.js and skills from
// agents/skills/*.md. Each role's system prompt is composed as:
//   role.persona + "\n\n---\n\n" + skills[role.skills[]].join("\n\n---\n\n")
//
// This is the internal orchestrator (server-side, uses ANTHROPIC_API_KEY).
// The external MCP server (mcp/toj-server.js) exposes the same tools to
// any client that wires it in.

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const {
  listClients,
  getFoundationScore,
  retrieveClientContext,
} = require("./tools");

const MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 20;

// ---- Load roles + skills at boot ----
const ROLES = {};
const SKILLS = {};

const rolesDir = path.join(__dirname, "roles");
if (fs.existsSync(rolesDir)) {
  for (const file of fs.readdirSync(rolesDir)) {
    if (!file.endsWith(".js")) continue;
    const role = require(path.join(rolesDir, file));
    if (role && role.id) ROLES[role.id] = role;
  }
}

const skillsDir = path.join(__dirname, "skills");
if (fs.existsSync(skillsDir)) {
  for (const file of fs.readdirSync(skillsDir)) {
    if (!file.endsWith(".md")) continue;
    const id = path.basename(file, ".md");
    SKILLS[id] = fs.readFileSync(path.join(skillsDir, file), "utf8");
  }
}

console.log(
  `[agents] loaded ${Object.keys(ROLES).length} roles, ${Object.keys(SKILLS).length} skills`
);

function buildSystemPrompt(role) {
  const skillBlocks = (role.skills || [])
    .map((id) => SKILLS[id])
    .filter(Boolean);
  if (skillBlocks.length === 0) return role.persona;
  return (
    role.persona +
    "\n\n---\n\n# Available skills\n\n" +
    skillBlocks.join("\n\n---\n\n")
  );
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
    model: cfg.model || MODEL,
    max_tokens: 8000,
    system: buildSystemPrompt(cfg),
    tools: [listClients, getFoundationScore, retrieveClientContext],
    messages: [{ role: "user", content: userMessage }],
    thinking: { type: "adaptive" },
    max_iterations: MAX_ITERATIONS,
  });

  const trace = [];
  let final = null;
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "text") {
        trace.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        trace.push({ type: "tool_use", name: block.name, input: block.input });
      }
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

module.exports = { runAgent, listRoles, listSkills, ROLES, SKILLS };
