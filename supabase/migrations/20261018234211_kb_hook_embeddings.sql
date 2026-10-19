-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

create index if not exists hooks_embedding on kb.hooks using hnsw (embedding vector_cosine_ops);

create or replace function public.kb_upsert_hooks(payload jsonb)
returns integer
language plpgsql
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare n integer;
begin
    insert into kb.hooks (brand_id, category, template, example, topics, origin, origin_ref, metadata, embedding)
    select
        (select id from kb.brands where slug = coalesce(e ->> 'brand_slug', 'aiko')),
        e ->> 'category',
        e ->> 'template',
        e ->> 'example',
        coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(e -> 'topics')), '{}'),
        coalesce(e ->> 'origin', 'hook_patterns'),
        e ->> 'origin_ref',
        coalesce(e -> 'metadata', '{}'::jsonb),
        nullif(btrim(coalesce(e ->> 'embedding', '')), '')::extensions.vector(1024)
    from jsonb_array_elements(payload) e
    where e ->> 'template' is not null and e ->> 'category' is not null;

    get diagnostics n = row_count;
    return n;
end;
$function$;

create or replace function public.kb_hooks_pending_embedding(p_limit integer default 200)
returns table(id uuid, category text, template text, example text, topics text[])
language sql
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
    select h.id, h.category, h.template, h.example, h.topics
    from kb.hooks h
    where h.embedding is null
    order by h.created_at
    limit greatest(1, least(coalesce(p_limit, 200), 1000));
$function$;

create or replace function public.kb_set_hook_embeddings(payload jsonb)
returns integer
language plpgsql
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare n integer;
begin
    update kb.hooks h
       set embedding = nullif(btrim(e.emb), '')::extensions.vector(1024)
      from (select (x ->> 'id')::uuid as id, x ->> 'embedding' as emb
              from jsonb_array_elements(payload) x) e
     where h.id = e.id;

    get diagnostics n = row_count;
    return n;
end;
$function$;

revoke all on function public.kb_hooks_pending_embedding(integer) from public, anon, authenticated;
revoke all on function public.kb_set_hook_embeddings(jsonb) from public, anon, authenticated;
grant execute on function public.kb_hooks_pending_embedding(integer) to service_role;
grant execute on function public.kb_set_hook_embeddings(jsonb) to service_role;

drop function if exists public.kb_search_hooks(uuid, text, text, integer);
drop function if exists kb.search_hooks(uuid, text, text, integer);

create function kb.search_hooks(
    p_brand_id uuid default null,
    p_topic text default null,
    p_category text default null,
    p_limit integer default 10,
    p_embedding extensions.vector default null)
returns table(id uuid, category text, template text, example text, topics text[], origin text, origin_ref text, relevance numeric)
language sql
stable
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
with scored as (
    select
        h.id, h.category, h.template, h.example, h.topics, h.origin, h.origin_ref, h.created_at,
        case when p_embedding is not null and h.embedding is not null
             then greatest(0, 1 - (h.embedding <=> p_embedding))::numeric else 0 end as semantic,
        (p_topic is not null
           and (h.topics && array[p_topic]
                or h.template ilike '%' || p_topic || '%'
                or h.example  ilike '%' || p_topic || '%')) as topic_hit,
        (p_topic is not null and h.topics && array[p_topic]) as tag_hit
    from kb.hooks h
    where h.is_active
      and (p_brand_id is null or h.brand_id is null or h.brand_id = p_brand_id)
      and (p_category is null or h.category = p_category)
)
select id, category, template, example, topics, origin, origin_ref,
       round(case when p_embedding is not null
                  then 0.85 * semantic + case when topic_hit then 0.15 else 0 end
                  else case when tag_hit then 1 when topic_hit then 0.5 else 0 end
             end, 4) as relevance
from scored
where p_embedding is not null or p_topic is null or topic_hit
order by relevance desc, created_at desc
limit greatest(1, least(coalesce(p_limit, 10), 100));
$function$;

create function public.kb_search_hooks(
    p_brand_id uuid default null,
    p_topic text default null,
    p_category text default null,
    p_limit integer default 10,
    p_embedding text default null)
returns table(id uuid, category text, template text, example text, topics text[], origin text, origin_ref text, relevance numeric)
language sql
stable
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
    select * from kb.search_hooks(
        p_brand_id, p_topic, p_category, p_limit,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024));
$function$;

grant execute on function public.kb_search_hooks(uuid, text, text, integer, text) to anon, authenticated, service_role;;
