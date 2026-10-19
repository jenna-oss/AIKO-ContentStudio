-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Write RPCs. kb is not exposed over PostgREST, so these are the only way in,
-- and they are SECURITY DEFINER with EXECUTE revoked from public/anon — a
-- definer function anon could call would let anyone rewrite the corpus.
--
-- The merge rules live here rather than in the pipeline, so that two different
-- callers cannot disagree about what "already ingested" means.
-- ---------------------------------------------------------------------------

create or replace function public.kb_brand_id(p_slug text default 'aiko')
returns uuid language sql stable security invoker
as $fn$ select id from kb.brands where slug = p_slug; $fn$;

grant execute on function public.kb_brand_id(text) to anon, authenticated, service_role;

-- Upsert a document by (brand_id, source_key).
-- Returns the id plus whether the content actually changed: an unchanged hash
-- means the caller can skip re-chunking and re-embedding, which is what stops a
-- daily re-crawl from re-billing the whole corpus.
create or replace function public.kb_upsert_document(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare
    v_brand uuid;
    v_hash  text;
    v_id    uuid;
    v_old   text;
    v_changed boolean;
begin
    v_brand := coalesce((payload ->> 'brand_id')::uuid,
                        (select id from kb.brands where slug = coalesce(payload ->> 'brand_slug', 'aiko')));
    if v_brand is null then
        raise exception 'unknown brand: %', coalesce(payload ->> 'brand_slug', payload ->> 'brand_id');
    end if;

    v_hash := encode(extensions.digest(coalesce(payload ->> 'raw_content', ''), 'sha256'), 'hex');

    select id, content_hash into v_id, v_old
    from kb.documents
    where brand_id = v_brand and source_key = payload ->> 'source_key';

    v_changed := (v_id is null or v_old is distinct from v_hash);

    insert into kb.documents (
        brand_id, document_type, title, source, source_url, published_at,
        source_key, content_hash, raw_content, metadata, status
    )
    values (
        v_brand,
        payload ->> 'document_type',
        payload ->> 'title',
        payload ->> 'source',
        payload ->> 'source_url',
        (payload ->> 'published_at')::timestamptz,
        payload ->> 'source_key',
        v_hash,
        payload ->> 'raw_content',
        coalesce(payload -> 'metadata', '{}'::jsonb),
        'pending'
    )
    on conflict (brand_id, source_key) do update set
        document_type = excluded.document_type,
        title         = excluded.title,
        source        = excluded.source,
        source_url    = excluded.source_url,
        published_at  = excluded.published_at,
        metadata      = excluded.metadata,
        /* Only touch the body and the status when the content really moved.
         * Rewriting status to 'pending' on an unchanged document would queue
         * the entire corpus for re-embedding on every crawl. */
        raw_content   = case when kb.documents.content_hash is distinct from excluded.content_hash
                             then excluded.raw_content else kb.documents.raw_content end,
        content_hash  = excluded.content_hash,
        status        = case when kb.documents.content_hash is distinct from excluded.content_hash
                             then 'pending' else kb.documents.status end
    returning id into v_id;

    /* Spec section 41: an updated document must not keep stale chunks. They are
     * dropped here, so a crash between upsert and re-chunk leaves the document
     * pending with no chunks rather than pending with obsolete ones. */
    if v_changed then
        delete from kb.document_chunks where document_id = v_id;
        update kb.documents set chunk_count = 0 where id = v_id;
    end if;

    return jsonb_build_object('id', v_id, 'changed', v_changed, 'brand_id', v_brand);
end;
$fn$;

-- Replace a document's chunks wholesale. Chunk boundaries move whenever the
-- chunker changes, so ordinals cannot be merged in place.
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
       set chunk_count = n,
           status = case when exists (
                      select 1 from kb.document_chunks
                      where document_id = p_document_id and embedding is null)
                    then 'processing' else 'ready' end,
           processed_at = now(),
           status_detail = null
     where id = p_document_id;

    return n;
end;
$fn$;

-- Backfill embeddings for chunks that were stored without them.
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

    /* A document is only 'ready' — and therefore only retrievable — once every
     * one of its chunks has an embedding. */
    update kb.documents d
       set status = 'ready', processed_at = now()
     where d.status = 'processing'
       and not exists (select 1 from kb.document_chunks c
                       where c.document_id = d.id and c.embedding is null);

    return n;
end;
$fn$;

create or replace function public.kb_pending_embeddings(p_limit integer default 200)
returns table (chunk_id uuid, content text, heading text)
language sql
security definer
set search_path = kb, public, extensions
as $fn$
    select c.id, c.content, c.heading
    from kb.document_chunks c
    join kb.documents d on d.id = c.document_id
    where c.embedding is null
    order by d.created_at, c.chunk_index
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
$fn$;

create or replace function public.kb_mark_document(p_id uuid, p_status text, p_detail text default null)
returns void
language sql
security definer
set search_path = kb, public, extensions
as $fn$
    update kb.documents set status = p_status, status_detail = p_detail where id = p_id;
$fn$;

-- Published content upsert, used by the mirror from the existing content schema
-- and by any future feed of real published videos.
create or replace function public.kb_upsert_published(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare n integer;
begin
    insert into kb.published_content (
        brand_id, title, topic, angle, hook, format, platform,
        published_at, transcript, performance, metadata, source_key, embedding
    )
    select
        coalesce((e ->> 'brand_id')::uuid,
                 (select id from kb.brands where slug = coalesce(e ->> 'brand_slug', 'aiko'))),
        e ->> 'title',
        e ->> 'topic',
        e ->> 'angle',
        e ->> 'hook',
        e ->> 'format',
        e ->> 'platform',
        (e ->> 'published_at')::timestamptz,
        e ->> 'transcript',
        coalesce(e -> 'performance', '{}'::jsonb),
        coalesce(e -> 'metadata', '{}'::jsonb),
        e ->> 'source_key',
        nullif(btrim(coalesce(e ->> 'embedding', '')), '')::extensions.vector(1024)
    from jsonb_array_elements(payload) e
    on conflict (brand_id, source_key) do update set
        title = excluded.title,
        topic = excluded.topic,
        angle = excluded.angle,
        hook = excluded.hook,
        format = excluded.format,
        platform = excluded.platform,
        published_at = excluded.published_at,
        transcript = excluded.transcript,
        performance = excluded.performance,
        metadata = excluded.metadata,
        embedding = coalesce(excluded.embedding, kb.published_content.embedding);

    get diagnostics n = row_count;
    return n;
end;
$fn$;

revoke execute on function
    public.kb_upsert_document(jsonb),
    public.kb_replace_chunks(uuid, jsonb),
    public.kb_set_embeddings(jsonb),
    public.kb_pending_embeddings(integer),
    public.kb_mark_document(uuid, text, text),
    public.kb_upsert_published(jsonb)
from public, anon, authenticated;

grant execute on function
    public.kb_upsert_document(jsonb),
    public.kb_replace_chunks(uuid, jsonb),
    public.kb_set_embeddings(jsonb),
    public.kb_pending_embeddings(integer),
    public.kb_mark_document(uuid, text, text),
    public.kb_upsert_published(jsonb)
to service_role;;
