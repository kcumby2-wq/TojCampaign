// Hooks-namespaced tools for the Hooks Agents subsystem.
//
// Reuses the shared clients + client_documents + client_embeddings
// tables from TOJ's RAG stack. Athletes and trainers are stored as
// clients with vertical='athlete' or vertical='trainer'; their brand
// material, film notes, and roster context go in client_documents.
//
// This keeps one RAG infrastructure while giving Hooks its own tool
// surface and terminology.

const { betaTool } = require("@anthropic-ai/sdk/helpers/beta/json-schema");
const { embed } = require("../../utils/embed");

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

const listAthletes = betaTool({
  name: "list_athletes",
  description:
    "List athletes and trainers in the Hooks roster. Filter by role (athlete | trainer | signed_nil) or by bucket (prospect | active | on_the_board | committed | signed). Returns id, name, position, grad_year, bucket, status.",
  inputSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["athlete", "trainer", "signed_nil"],
        description: "Filter by which Hooks funnel the person is in.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
  },
  run: async ({ role, limit }) => {
    let q = sb()
      .from("clients")
      .select("id,email,business_name,operator_name,vertical,tier,status,metadata,created_at");
    if (role === "athlete") q = q.eq("vertical", "athlete");
    else if (role === "trainer") q = q.eq("vertical", "trainer");
    else if (role === "signed_nil") q = q.eq("vertical", "athlete").eq("tier", "nil");
    else q = q.in("vertical", ["athlete", "trainer"]);
    q = q.order("created_at", { ascending: false }).limit(limit || 50);
    const { data, error } = await q;
    if (error) return `Error: ${error.message}`;
    return JSON.stringify(data, null, 2);
  },
});

const getAthlete = betaTool({
  name: "get_athlete",
  description:
    "Fetch a single athlete or trainer record by id, including all metadata (position, grad year, school, measurables, target colleges, bucket, etc.). Use this before writing about a specific person.",
  inputSchema: {
    type: "object",
    properties: { athlete_id: { type: "string" } },
    required: ["athlete_id"],
  },
  run: async ({ athlete_id }) => {
    const { data, error } = await sb()
      .from("clients")
      .select("*")
      .eq("id", athlete_id)
      .maybeSingle();
    if (error) return `Error: ${error.message}`;
    if (!data) return `Athlete not found: ${athlete_id}`;
    return JSON.stringify(data, null, 2);
  },
});

const retrieveClientContext = betaTool({
  name: "retrieve_client_context",
  description:
    "Agentic RAG: pull the top-k most semantically relevant chunks from an athlete's or trainer's memory (uploaded film notes, evaluations, communication history, brand docs). Use this BEFORE drafting anything specific — grade, outreach, parent update — so it's grounded in the actual person, not a template.",
  inputSchema: {
    type: "object",
    properties: {
      client_id: { type: "string", description: "The athlete's or trainer's id (same as their client id)." },
      query: { type: "string", description: "Natural-language question or topic to retrieve about." },
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

module.exports = { listAthletes, getAthlete, retrieveClientContext };
