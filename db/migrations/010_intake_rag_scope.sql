-- 010_intake_rag_scope.sql
-- ---------------------------------------------------------------------------
-- Make the RAG memory usable by onboarding intakes (athletes/coaches/business),
-- not just business `clients`.
--
-- THE BUG: client_documents.client_id / client_embeddings.client_id were
-- `not null references clients(id)`. Onboarding intakes have no clients row, so
-- ingestClientDocument() failed the FK and NOTHING embedded — agents could not
-- retrieve a single intake. (See routes/onboarding.js maybeEmbed → embedded=false.)
--
-- THE FIX: treat client_id as a generic "scope id" that can hold EITHER a
-- clients.id OR an onboarding_intakes.id. Drop the FK + NOT NULL. Retrieval
-- (match_client_chunks(scope_id, ...)) is unchanged and now works for intakes:
-- the operator opens an agent with the intake id as the scope and gets its chunks.
--
-- Trade-off: without the FK, deleting a client no longer cascade-deletes its
-- docs/embeddings. Acceptable — cleanup is rare and can be a scheduled sweep.
-- Idempotent. Apply after 009.
-- ---------------------------------------------------------------------------

alter table public.client_documents  drop constraint if exists client_documents_client_id_fkey;
alter table public.client_documents  alter column client_id drop not null;

alter table public.client_embeddings drop constraint if exists client_embeddings_client_id_fkey;
alter table public.client_embeddings alter column client_id drop not null;

-- Helpful comments so the next reader knows client_id is now polymorphic.
comment on column public.client_documents.client_id  is
  'Scope id: a clients.id OR an onboarding_intakes.id (no FK — polymorphic).';
comment on column public.client_embeddings.client_id is
  'Scope id: a clients.id OR an onboarding_intakes.id (no FK — polymorphic).';
