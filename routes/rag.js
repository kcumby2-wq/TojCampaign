// RAG router — retrieval + ingest endpoints for the client memory layer.
//
// Admin-only for now (session auth). Later the MCP server calls these too.
//
//   POST /api/rag/retrieve  { client_id, query, k? } → { chunks: [...] }
//   POST /api/rag/ingest    { client_id, source_type, title, content }
//                                                    → { ok, document_id, chunks }

const express = require("express");
const { embed, ingestClientDocument, chunkText } = require("../utils/embed");
const router = express.Router();

let supabase = null;
function getSupabase() {
  if (supabase !== null) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return (supabase = false);
  try {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return supabase;
  } catch {
    return (supabase = false);
  }
}

router.post("/retrieve", async (req, res) => {
  const { client_id, query } = req.body || {};
  const k = Math.min(Math.max(parseInt(req.body?.k, 10) || 6, 1), 20);
  if (!client_id) return res.status(400).json({ error: "missing_client_id" });
  if (!query || typeof query !== "string")
    return res.status(400).json({ error: "missing_query" });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  let vector;
  try {
    [vector] = await embed([query], { inputType: "query" });
  } catch (e) {
    console.error("[rag] embed failed:", e.message);
    return res.status(502).json({ error: "embed_failed" });
  }

  const { data, error } = await sb.rpc("match_client_chunks", {
    p_client_id: client_id,
    p_query_embedding: vector,
    p_match_count: k,
  });
  if (error) {
    console.error("[rag] rpc error:", error);
    return res.status(500).json({ error: "retrieval_failed" });
  }
  res.json({ ok: true, chunks: data || [] });
});

router.post("/ingest", async (req, res) => {
  const { client_id, source_type, source_ref, title, content, metadata } =
    req.body || {};
  if (!client_id || !content)
    return res.status(400).json({ error: "missing_fields" });

  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const result = await ingestClientDocument(sb, {
    client_id,
    source_type: source_type || "upload",
    source_ref,
    title,
    content,
    metadata,
  });
  if (!result.ok) return res.status(500).json(result);
  res.json(result);
});

// Backfill: chunk + embed any client_documents that don't yet have
// client_embeddings rows. Use after inserting documents via SQL or MCP
// (e.g. seeding premium clients from external material).
router.post("/backfill", async (_req, res) => {
  const sb = getSupabase();
  if (!sb) return res.status(503).json({ error: "supabase_unavailable" });

  const { data: docs, error } = await sb
    .from("client_documents")
    .select("id,client_id,content")
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const results = [];
  for (const d of docs) {
    const { count } = await sb
      .from("client_embeddings")
      .select("*", { count: "exact", head: true })
      .eq("document_id", d.id);
    if (count && count > 0) {
      results.push({ document_id: d.id, skipped: true, chunks: count });
      continue;
    }
    const chunks = chunkText(d.content);
    if (chunks.length === 0) {
      results.push({ document_id: d.id, skipped: true, chunks: 0 });
      continue;
    }
    try {
      const vectors = await embed(chunks);
      const rows = chunks.map((chunk_text, i) => ({
        client_id: d.client_id,
        document_id: d.id,
        chunk_index: i,
        chunk_text,
        embedding: vectors[i],
      }));
      const { error: iErr } = await sb.from("client_embeddings").insert(rows);
      if (iErr) throw new Error(iErr.message);
      results.push({ document_id: d.id, embedded: chunks.length });
    } catch (e) {
      results.push({ document_id: d.id, error: e.message });
    }
  }
  res.json({ ok: true, processed: results.length, results });
});

module.exports = router;
