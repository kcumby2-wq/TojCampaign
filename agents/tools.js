// Shared toolset for the TOJ multi-agent orchestrator.
//
// Same three capabilities exposed via the MCP server, wrapped as
// betaTool() definitions so the Anthropic tool_runner can call them
// directly (no MCP round-trip for our own agents).

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const { embed } = require("../utils/embed");

let supabase = null;
function sb() {
  if (supabase) return supabase;
  const { createClient } = require("@supabase/supabase-js");
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return supabase;
}

const listClients = betaTool({
  name: "list_clients",
  description:
    "List TOJ clients (Foundation Score submitters + active concierge). Filter by vertical if needed. Returns id, email, business_name, vertical, tier, status, created_at.",
  inputSchema: {
    type: "object",
    properties: {
      vertical: {
        type: "string",
        enum: ["personal-brand", "nonprofit", "authority"],
      },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    },
  },
  run: async ({ vertical, limit }) => {
    let q = sb().from("clients").select("id,email,business_name,vertical,tier,status,created_at");
    if (vertical) q = q.eq("vertical", vertical);
    q = q.order("created_at", { ascending: false }).limit(limit || 25);
    const { data, error } = await q;
    if (error) return `Error: ${error.message}`;
    return JSON.stringify(data, null, 2);
  },
});

const getFoundationScore = betaTool({
  name: "get_foundation_score",
  description:
    "Fetch a Foundation Score record by id — includes the raw intake payload, pillar scores if scored, and transcript URL if delivered.",
  inputSchema: {
    type: "object",
    properties: { foundation_score_id: { type: "string" } },
    required: ["foundation_score_id"],
  },
  run: async ({ foundation_score_id }) => {
    const { data, error } = await sb()
      .from("foundation_scores")
      .select("*")
      .eq("id", foundation_score_id)
      .single();
    if (error) return `Error: ${error.message}`;
    return JSON.stringify(data, null, 2);
  },
});

const retrieveClientContext = betaTool({
  name: "retrieve_client_context",
  description:
    "Agentic RAG: return top-k most semantically relevant chunks from a specific client's memory (their intake, transcript, uploaded brand docs). Use this BEFORE drafting anything in the client's voice — it grounds the output in what they actually said.",
  inputSchema: {
    type: "object",
    properties: {
      client_id: { type: "string" },
      query: { type: "string", description: "Natural-language question or topic." },
      k: { type: "integer", minimum: 1, maximum: 20, default: 6 },
    },
    required: ["client_id", "query"],
  },
  run: async ({ client_id, query, k }) => {
    let vector;
    try {
      [vector] = await embed([query], { inputType: "query" });
    } catch (e) {
      return `Error: embedding failed — ${e.message}`;
    }
    const { data, error } = await sb().rpc("match_client_chunks", {
      p_client_id: client_id,
      p_query_embedding: vector,
      p_match_count: k || 6,
    });
    if (error) return `Error: ${error.message}`;
    return JSON.stringify(data, null, 2);
  },
});

module.exports = { listClients, getFoundationScore, retrieveClientContext };
