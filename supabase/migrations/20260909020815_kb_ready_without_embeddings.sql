-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- A document becomes retrievable as soon as it is chunked. Embeddings improve
-- retrieval; their absence must not remove the document from it.
--
-- The earlier rule held a document at 'processing' until every chunk had a
-- vector, which meant that without an embedding key the whole corpus was
-- invisible rather than keyword-only — the opposite of the degradation the
-- `degraded` flag was built to describe.
create or replace function public.kb_replace_chunks(p_document_id uuid, payload jsonb)
returns integer
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare
    v_brand uuid;
    n integer;
begin
    select brand_id into v_brand from kb.documents where id = p_document_id;
    if v_brand is null then
        raise exception 'no such document: %', p_document_id;
    end if;

    delete from kb.document_chunks where document_id = p_document_id;

    insert into kb.document_chunks
        (document_id, brand_id, chunk_index, heading, content, token_count, metadata, embedding)
    select
        p_document_id,
        v_brand,
        (e ->> 'chunk_index')::integer,
        e ->> 'heading',
        e ->> 'content',
        (e ->> 'token_count')::integer,
        coalesce(e -> 'metadata', '{}'::jsonb),
        nullif(btrim(coalesce(e ->> 'embedding', '')), '')::extensions.vector(1024)
    from jsonb_array_elements(payload) e;

    get diagnostics n = row_count;

    update kb.documents
       set chunk_count   = n,
           status        = case when n > 0 then 'ready' else 'failed' end,
           status_detail = case when n > 0 then null else 'chunker produced no chunks' end,
           processed_at  = now()
     where id = p_document_id;

    return n;
end;
$fn$;

create or replace function public.kb_set_embeddings(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare n integer;
begin
    update kb.document_chunks c
       set embedding = nullif(btrim(e.emb), '')::extensions.vector(1024)
      from (select (x ->> 'chunk_id')::uuid as id, x ->> 'embedding' as emb
              from jsonb_array_elements(payload) x) e
     where c.id = e.id;

    get diagnostics n = row_count;
    return n;
end;
$fn$;

comment on column kb.documents.status is
  'pending -> ready once chunked. Retrieval reads ready rows whether or not '
  'their chunks carry embeddings; an unembedded chunk is reachable by keyword '
  'and is reported through kb.retrieval_log.degraded, not hidden.';

revoke execute on function
    public.kb_replace_chunks(uuid, jsonb),
    public.kb_set_embeddings(jsonb)
from public, anon, authenticated;

grant execute on function
    public.kb_replace_chunks(uuid, jsonb),
    public.kb_set_embeddings(jsonb)
to service_role;;
