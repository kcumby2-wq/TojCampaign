# TOJ MCP Server

Exposes TOJ's owned data + Skills as callable tools for any MCP client
(Claude Desktop, Claude Code, Anthropic API `tool_runner`, custom agents).

This is what turns "Claude that knows TOJ" into "any agent, anywhere, that
can query TOJ's clients, retrieve their brand voice from RAG, and act on
their behalf."

## Tools

| Tool | Purpose |
|---|---|
| `list_clients` | List Foundation Score submitters + active clients, filter by vertical |
| `get_foundation_score` | Fetch full intake payload + pillar scores + transcript URL |
| `retrieve_client_context` | Agentic RAG — top-k semantic chunks from a client's memory |

More tools land as the product grows (`create_deliverable`, `draft_section`,
`score_pillar`, `send_transcript`).

## Run it

```
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
OPENAI_API_KEY=... \
node mcp/toj-server.js
```

Server logs `[toj-mcp] ready` on stderr and speaks MCP over stdio.

## Wire into Claude Code / Desktop

Add to your Claude client config (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`
on Mac, or via `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "toj": {
      "command": "node",
      "args": ["/absolute/path/to/TojCampaign/mcp/toj-server.js"],
      "env": {
        "SUPABASE_URL": "https://ckaocyldpvypegwbyahh.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "...",
        "OPENAI_API_KEY": "..."
      }
    }
  }
}
```

Restart Claude, then in any conversation you can say:

> "Pull the last five personal-brand clients and retrieve their brand-voice
> chunks for a monthly report."

Claude will call `list_clients` → `retrieve_client_context` on each, and
draft the report grounded in each client's actual intake language.

## Security note

The server uses the Supabase **service role key** — full DB access. Only
run it on your own machine or a trusted server. Do NOT expose the stdio
process to the public internet without wrapping it in auth.
