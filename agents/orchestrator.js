// Multi-agent orchestrator (pillar 4).
//
// One manager, three role modes. All modes share the same tool set —
// list_clients, get_foundation_score, retrieve_client_context — but the
// system prompt shapes what they DO with those tools.
//
// This is the internal orchestrator; unlike mcp/toj-server.js (which
// exposes tools to external agents), this file IS the agent, running
// server-side with the Anthropic SDK's tool_runner beta helper.
//
// Requires ANTHROPIC_API_KEY in env.

const Anthropic = require("@anthropic-ai/sdk").default;
const {
  listClients,
  getFoundationScore,
  retrieveClientContext,
} = require("./tools");

const MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 20;

const ROLES = {
  research: {
    label: "Research",
    system: `You are TOJ's Research Agent. Your job is to gather facts about clients from the database and their per-client RAG memory, then report what you found.

Rules:
- Use list_clients to survey the client base
- Use get_foundation_score to pull full intake details
- Use retrieve_client_context to pull semantically-relevant chunks in the client's own words
- Report findings as a concise, factual brief — no rewriting, no persuasion
- Cite the source (client_id + source_type) for every claim
- Do NOT invent client details. If retrieval returns nothing, say so.`,
  },
  copy: {
    label: "Copy",
    system: `You are TOJ's Copy Agent. Your job is to draft outbound copy (emails, posts, one-pagers) in each client's authentic voice.

Rules:
- BEFORE drafting anything, call retrieve_client_context with a query relevant to the topic — this pulls the client's own phrasing, tone, and priorities
- Use get_foundation_score to understand their business/offer if needed
- Match the client's voice — vocabulary, rhythm, level of formality — from the retrieved chunks
- Never write in a generic "AI marketing" voice. If retrieval is empty, ask for more brand material rather than inventing tone.
- Deliver the draft, then a one-line note on which retrieved chunks shaped the voice.`,
  },
  ops: {
    label: "Ops",
    system: `You are TOJ's Ops Agent. Your job is to run rollups, spot patterns, and surface actionable signals across the client base.

Rules:
- Use list_clients (filter by vertical if the task calls for it) to build the working set
- Use get_foundation_score on specific records for detail
- Report as a scannable brief: counts, patterns, outliers, recommended next actions
- No fluff. Numbers first, then one-line interpretation each.`,
  },
};

async function runAgent({ role, task, client_id = null }) {
  if (!ROLES[role]) throw new Error(`unknown_role:${role}`);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const client = new Anthropic();
  const cfg = ROLES[role];

  const userMessage = client_id
    ? `Client scope: ${client_id}\n\nTask:\n${task}`
    : task;

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    system: cfg.system,
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
  };
}

module.exports = { runAgent, ROLES };
