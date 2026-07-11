-- 003: pgvector + per-tenant client memory (Agentic RAG foundation).
--
-- client_documents = raw source material (transcript, brand doc, uploaded file).
-- client_embeddings = chunked + embedded rows queried by cosine similarity.
--
-- Embedding dim = 1536 (OpenAI text-embedding-3-small default; also matches
-- most open-source 1536-dim models so we can swap providers without a re-migration).

create extension if not exists vector;

create table if not exists client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  source_type text not null,           -- 'foundation_score' | 'transcript' | 'upload' | 'brand_doc'
  source_ref text,                     -- e.g. foundation_score id, filename
  title text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists client_documents_client_idx
  on client_documents(client_id, created_at desc);

create table if not exists client_embeddings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  document_id uuid not null references client_documents(id) on delete cascade,
  chunk_index int not null,
  chunk_text text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

-- IVFFlat index for cosine similarity; lists=100 is fine up to ~1M rows.
create index if not exists client_embeddings_vec_idx
  on client_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists client_embeddings_client_idx
  on client_embeddings(client_id);

-- RLS: only service role touches these tables directly; API layer enforces
-- per-client scoping. Enable RLS with no policies = deny all to anon/authed.
alter table client_documents enable row level security;
alter table client_embeddings enable row level security;

-- Retrieval helper: top-k chunks for a client by cosine distance.
create or replace function match_client_chunks(
  p_client_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 6
)
returns table (
  chunk_text text,
  document_id uuid,
  source_type text,
  similarity float
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.chunk_text,
    e.document_id,
    d.source_type,
    1 - (e.embedding <=> p_query_embedding) as similarity
  from client_embeddings e
  join client_documents d on d.id = e.document_id
  where e.client_id = p_client_id
  order by e.embedding <=> p_query_embedding
  limit p_match_count;
$$;
