-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

create or replace function public.kb_embedding_config()
returns jsonb language sql stable security invoker
as $fn$
    select jsonb_build_object(
        'provider', provider, 'model', model, 'dimensions', dimensions,
        'input_type_supported', input_type_supported)
    from kb.embedding_config where singleton;
$fn$;

grant execute on function public.kb_embedding_config() to anon, authenticated, service_role;

-- Documents that still need chunking. raw_content is returned so the worker
-- does not have to re-fetch the source it already stored.
create or replace function public.kb_pending_documents(p_limit integer default 25)
returns table (
    id uuid, document_type text, title text, source text, source_url text,
    published_at timestamptz, source_key text, raw_content text, metadata jsonb
)
language sql
security definer
set search_path = kb, public, extensions
as $fn$
    select d.id, d.document_type, d.title, d.source, d.source_url,
           d.published_at, d.source_key, d.raw_content, d.metadata
    from kb.documents d
    where d.status = 'pending'
    order by d.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;

-- Documents whose summary is missing or older than their content (phase 3).
create or replace function public.kb_documents_needing_summary(p_limit integer default 10)
returns table (id uuid, title text, document_type text, chunk_count integer)
language sql
security definer
set search_path = kb, public, extensions
as $fn$
    select d.id, d.title, d.document_type, d.chunk_count
    from kb.documents d
    left join kb.document_summaries s on s.document_id = d.id
    where d.status = 'ready' and s.id is null
    order by d.created_at
    limit greatest(1, least(coalesce(p_limit, 10), 100));
$fn$;

create or replace function public.kb_document_chunks(p_document_id uuid)
returns table (chunk_id uuid, chunk_index integer, heading text, content text)
language sql
security definer
set search_path = kb, public, extensions
as $fn$
    select c.id, c.chunk_index, c.heading, c.content
    from kb.document_chunks c
    where c.document_id = p_document_id
    order by c.chunk_index;
$fn$;

create or replace function public.kb_save_summary(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare v_brand uuid; v_id uuid;
begin
    select brand_id into v_brand from kb.documents where id = (payload ->> 'document_id')::uuid;
    if v_brand is null then raise exception 'no such document'; end if;

    insert into kb.document_summaries (document_id, brand_id, summary, key_points, topics, model, embedding)
    values (
        (payload ->> 'document_id')::uuid, v_brand,
        payload ->> 'summary',
        coalesce(payload -> 'key_points', '[]'::jsonb),
        coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(payload -> 'topics')), '{}'),
        payload ->> 'model',
        nullif(btrim(coalesce(payload ->> 'embedding', '')), '')::extensions.vector(1024)
    )
    on conflict (document_id) do update set
        summary = excluded.summary,
        key_points = excluded.key_points,
        topics = excluded.topics,
        model = excluded.model,
        embedding = excluded.embedding
    returning id into v_id;

    return v_id;
end;
$fn$;

-- Topic knowledge (spec section 35). An insight with no supporting sources is
-- rejected outright rather than stored and filtered at read time.
create or replace function public.kb_save_insight(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare v_brand uuid; v_topic uuid; v_id uuid;
begin
    v_brand := coalesce((payload ->> 'brand_id')::uuid,
                        (select id from kb.brands where slug = coalesce(payload ->> 'brand_slug', 'aiko')));

    if jsonb_array_length(coalesce(payload -> 'supporting_chunk_ids', '[]'::jsonb)) = 0 then
        raise exception 'insight has no supporting sources; refusing to store it';
    end if;

    insert into kb.topics (brand_id, name)
    values (v_brand, payload ->> 'topic')
    on conflict (brand_id, lower(name)) do update set updated_at = now()
    returning id into v_topic;

    insert into kb.topic_insights
        (topic_id, brand_id, insight, supporting_chunk_ids, supporting_document_ids, confidence, model, embedding)
    values (
        v_topic, v_brand, payload ->> 'insight',
        payload -> 'supporting_chunk_ids',
        coalesce(payload -> 'supporting_document_ids', '[]'::jsonb),
        (payload ->> 'confidence')::numeric,
        payload ->> 'model',
        nullif(btrim(coalesce(payload ->> 'embedding', '')), '')::extensions.vector(1024)
    )
    returning id into v_id;

    return v_id;
end;
$fn$;

revoke execute on function
    public.kb_pending_documents(integer),
    public.kb_documents_needing_summary(integer),
    public.kb_document_chunks(uuid),
    public.kb_save_summary(jsonb),
    public.kb_save_insight(jsonb)
from public, anon, authenticated;

grant execute on function
    public.kb_pending_documents(integer),
    public.kb_documents_needing_summary(integer),
    public.kb_document_chunks(uuid),
    public.kb_save_summary(jsonb),
    public.kb_save_insight(jsonb)
to service_role;;
