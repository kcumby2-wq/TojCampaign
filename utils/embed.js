// Embeddings + ingest pipeline (Agentic RAG).
//
// Uses OpenAI text-embedding-3-small (1536 dims — matches the pgvector column
// in migration 003). Requires OPENAI_API_KEY in env.
//
// Public API:
//   embed(texts)                 → Promise<number[][]>
//   chunkText(str, wordsPerChunk?, overlapWords?) → string[]
//   ingestClientDocument(sb, {   → Promise<{ok, document_id, chunks}>
//     client_id, source_type, source_ref, title, content, metadata
//   })
//
// Ingest is fire-and-forget from the caller's perspective: intake responds
// to the client immediately, embedding happens on the request that follows.
// Failures are logged, never thrown — the intake save is the source of truth.

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const EMBED_DIM = 1536;

async function embed(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const input = Array.isArray(texts) ? texts : [texts];
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: MODEL, input }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI embed ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

function chunkText(str, wordsPerChunk = 400, overlapWords = 50) {
  const words = String(str || "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks = [];
  const stride = Math.max(1, wordsPerChunk - overlapWords);
  for (let i = 0; i < words.length; i += stride) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
    if (i + wordsPerChunk >= words.length) break;
  }
  return chunks;
}

// Flatten an intake payload into searchable prose so the transcript agent
// can retrieve "what did they say about pricing?" without knowing the schema.
function payloadToProse(payload) {
  if (!payload || typeof payload !== "object") return "";
  const lines = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v === null || v === undefined || v === "") continue;
    const label = k.replace(/_/g, " ");
    if (typeof v === "object") {
      lines.push(`${label}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${label}: ${v}`);
    }
  }
  return lines.join("\n");
}

async function ingestClientDocument(sb, doc) {
  if (!sb) return { ok: false, error: "no_supabase" };
  const { client_id, source_type, source_ref, title, content, metadata } = doc;
  if (!client_id || !content) return { ok: false, error: "missing_fields" };

  const { data: docRow, error: dErr } = await sb
    .from("client_documents")
    .insert({
      client_id,
      source_type,
      source_ref: source_ref || null,
      title: title || null,
      content,
      metadata: metadata || {},
    })
    .select()
    .single();
  if (dErr) return { ok: false, error: dErr.message };

  const chunks = chunkText(content);
  if (chunks.length === 0) {
    return { ok: true, document_id: docRow.id, chunks: 0 };
  }

  let vectors;
  try {
    vectors = await embed(chunks);
  } catch (e) {
    console.error("[embed] OpenAI call failed:", e.message);
    return { ok: false, error: "embed_failed", document_id: docRow.id };
  }

  const rows = chunks.map((chunk_text, i) => ({
    client_id,
    document_id: docRow.id,
    chunk_index: i,
    chunk_text,
    embedding: vectors[i],
  }));
  const { error: eErr } = await sb.from("client_embeddings").insert(rows);
  if (eErr) {
    console.error("[embed] chunk insert failed:", eErr.message);
    return { ok: false, error: eErr.message, document_id: docRow.id };
  }
  return { ok: true, document_id: docRow.id, chunks: chunks.length };
}

module.exports = {
  embed,
  chunkText,
  payloadToProse,
  ingestClientDocument,
  EMBED_DIM,
  MODEL,
};
