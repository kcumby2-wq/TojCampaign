-- 004: Switch embeddings provider from OpenAI (1536) to Voyage AI (1024).
--
-- voyage-3 is Anthropic's recommended embeddings model. 1024 dims, higher
-- retrieval quality than OpenAI text-embedding-3-small, and covered by
-- Voyage's 50M-token free tier (no card required).
--
-- Table is currently empty, so we drop dependent objects and recreate
-- with the new dimension. If we ever swap again later, do it the same way
-- (or with a re-embed batch job).

drop function if exists match_client_chunks(uuid, vector, int);
drop index if exists client_embeddings_vec_idx;

alter table client_embeddings
  alter column embedding type vector(1024) using null;

create index client_embeddings_vec_idx
  on client_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create or replace function match_client_chunks(
  p_client_id uuid,
  p_query_embedding vector(1024),
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
