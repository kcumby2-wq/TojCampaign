#!/usr/bin/env node
// TOJ MCP Server — exposes TOJ's Skills as callable tools for any MCP client
// (Claude Desktop, Claude Code, Anthropic API tool_runner, etc.).
//
// Transport: stdio (the standard for local MCP servers).
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — the same values Render uses
//   VOYAGE_API_KEY                            — for the retrieve embedding
//
// Wire it into Claude Code / Desktop by adding to the client config:
//   {
//     "mcpServers": {
//       "toj": {
//         "command": "node",
//         "args": ["/absolute/path/to/TojCampaign/mcp/toj-server.js"],
//         "env": {
//           "SUPABASE_URL": "...",
//           "SUPABASE_SERVICE_ROLE_KEY": "...",
//           "VOYAGE_API_KEY": "..."
//         }
//       }
//     }
//   }

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const { createClient } = require("@supabase/supabase-js");
const { embed } = require("../utils/embed");

function sb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

const TOOLS = [
  {
    name: "list_clients",
    description:
      "List TOJ clients (Foundation Score intake submitters and active concierge clients). Returns id, email, business, vertical, tier, status.",
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
  },
  {
    name: "get_foundation_score",
    description:
      "Fetch a Foundation Score record by id — includes the raw intake payload, pillar scores if scored, and transcript URL if delivered.",
    inputSchema: {
      type: "object",
      properties: { foundation_score_id: { type: "string" } },
      required: ["foundation_score_id"],
    },
  },
  {
    name: "retrieve_client_context",
    description:
      "Agentic RAG: return the top-k most semantically relevant chunks from a specific client's memory (their intake, transcript, uploaded brand docs). Use this before drafting anything in the client's voice.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        query: {
          type: "string",
          description: "Natural-language question or topic to search for.",
        },
        k: { type: "integer", minimum: 1, maximum: 20, default: 6 },
      },
      required: ["client_id", "query"],
    },
  },
];

async function handle(name, args) {
  const s = sb();
  if (name === "list_clients") {
    let q = s.from("clients").select("id,email,business_name,vertical,tier,status,created_at");
    if (args.vertical) q = q.eq("vertical", args.vertical);
    q = q.order("created_at", { ascending: false }).limit(args.limit || 25);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  }
  if (name === "get_foundation_score") {
    const { data, error } = await s
      .from("foundation_scores")
      .select("*")
      .eq("id", args.foundation_score_id)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  if (name === "retrieve_client_context") {
    const [vector] = await embed([args.query]);
    const { data, error } = await s.rpc("match_client_chunks", {
      p_client_id: args.client_id,
      p_query_embedding: vector,
      p_match_count: args.k || 6,
    });
    if (error) throw new Error(error.message);
    return data;
  }
  throw new Error(`unknown_tool:${name}`);
}

async function main() {
  const server = new Server(
    { name: "toj", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const result = await handle(req.params.name, req.params.arguments || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${e.message}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[toj-mcp] ready");
}

main().catch((e) => {
  console.error("[toj-mcp] fatal:", e);
  process.exit(1);
});
