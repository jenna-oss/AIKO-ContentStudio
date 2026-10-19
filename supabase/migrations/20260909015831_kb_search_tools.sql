-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- search_transcripts (spec section 16)
create or replace function kb.search_transcripts(
    p_brand_id     uuid,
    p_query        text default null,
    p_embedding    extensions.vector(1024) default null,
    p_date_from    date default null,
    p_date_to      date default null,
    p_content_type text default null,
    p_intent       text default 'SUPPORT',
    p_limit        integer default 5
)
returns table (
    chunk_id     uuid,
    document_id  uuid,
    source_type  text,
    title        text,
    source       text,
    source_url   text,
    published_at timestamptz,
    speaker      text,
    timestamp_start integer,
    timestamp_end   integer,
    content      text,
    relevance    numeric,
    metadata     jsonb
)
language sql
stable
as $fn$
    select
        r.chunk_id, r.document_id, r.source_type, r.title, r.source, r.source_url,
        r.published_at,
        r.metadata ->> 'speaker',
        nullif(r.metadata ->> 'start_time', '')::integer,
        nullif(r.metadata ->> 'end_time', '')::integer,
        r.content,
        r.relevance,
        r.metadata
    from kb.search_chunks(
        p_brand_id       => p_brand_id,
        p_query          => p_query,
        p_embedding      => p_embedding,
        p_document_types => array['transcript','recording','interview'],
        p_date_from      => p_date_from,
        p_date_to        => p_date_to,
        p_content_type   => p_content_type,
        p_intent         => p_intent,
        p_limit          => p_limit
    ) r;
$fn$;

comment on function kb.search_transcripts is 'Spec section 16. Transcript, recording and interview chunks, with the speaker and timestamp preserved so an agent can cite the exact moment rather than the episode.';

-- search_research (spec section 17)
create or replace function kb.search_research(
    p_brand_id  uuid,
    p_query     text default null,
    p_embedding extensions.vector(1024) default null,
    p_date_from date default null,
    p_date_to   date default null,
    p_source    text default null,
    p_intent    text default 'SUPPORT',
    p_limit     integer default 5
)
returns table (
    chunk_id      uuid,
    document_id   uuid,
    source_type   text,
    title         text,
    source        text,
    source_url    text,
    published_at  timestamptz,
    research_type text,
    excerpt       text,
    relevance     numeric,
    metadata      jsonb
)
language sql
stable
as $fn$
    select
        r.chunk_id, r.document_id, r.source_type, r.title,
        r.source, r.source_url, r.published_at,
        r.metadata ->> 'research_type',
        r.content,
        r.relevance,
        r.metadata
    from kb.search_chunks(
        p_brand_id       => p_brand_id,
        p_query          => p_query,
        p_embedding      => p_embedding,
        p_document_types => array['research','report','article'],
        p_date_from      => p_date_from,
        p_date_to        => p_date_to,
        p_source         => p_source,
        p_intent         => p_intent,
        p_limit          => p_limit
    ) r;
$fn$;

comment on function kb.search_research is 'Spec section 17. Research, reports and articles. Source and date are returned for traceability and are NOT ranking factors (spec section 9).';

-- search_previous_content (spec section 18)
create or replace function kb.search_previous_content(
    p_brand_id  uuid,
    p_query     text default null,
    p_embedding extensions.vector(1024) default null,
    p_date_from date default null,
    p_date_to   date default null,
    p_platform  text default null,
    p_intent    text default 'REPETITION',
    p_limit     integer default 10
)
returns table (
    id           uuid,
    title        text,
    topic        text,
    angle        text,
    hook         text,
    format       text,
    platform     text,
    published_at timestamptz,
    performance  jsonb,
    relevance    numeric,
    semantic     numeric,
    keyword      numeric,
    source_key   text
)
language sql
stable
as $fn$
with w as (
    select * from kb.ranking_weights
    where intent = coalesce(
        (select rw.intent from kb.ranking_weights rw where rw.intent = upper(coalesce(p_intent, 'REPETITION'))),
        'DEFAULT')
),
tsq as (
    select case when p_query is null or btrim(p_query) = '' then null
                else websearch_to_tsquery('english', p_query) end as q
),
scored as (
    select
        p.id, p.title, p.topic, p.angle, p.hook, p.format, p.platform,
        p.published_at, p.performance, p.source_key,
        case when p_embedding is not null and p.embedding is not null
             then greatest(0, 1 - (p.embedding <=> p_embedding))::numeric else 0 end as semantic,
        case when (select q from tsq) is not null
             then ts_rank_cd(p.tsv, (select q from tsq), 32)::numeric else 0 end as keyword,
        kb.recency_score(p.published_at, 'published') as recency
    from kb.published_content p
    where p.brand_id = p_brand_id
      and (p_platform is null or p.platform = p_platform)
      and (p_date_from is null or p.published_at >= p_date_from::timestamptz)
      and (p_date_to   is null or p.published_at <  (p_date_to::timestamptz + interval '1 day'))
      and (
            p_query is null and p_embedding is null
            or (p_embedding is not null and p.embedding is not null)
            or ((select q from tsq) is not null and p.tsv @@ (select q from tsq))
          )
)
select
    s.id, s.title, s.topic, s.angle, s.hook, s.format, s.platform,
    s.published_at, s.performance,
    round((w.semantic * s.semantic + w.keyword * s.keyword + w.recency * s.recency)::numeric, 4),
    round(s.semantic, 4),
    round(s.keyword, 4),
    s.source_key
from scored s, w
order by (w.semantic * s.semantic + w.keyword * s.keyword + w.recency * s.recency) desc,
         s.published_at desc nulls last
limit greatest(1, least(coalesce(p_limit, 10), 100));
$fn$;

comment on function kb.search_previous_content is 'Spec section 18. Has this topic or angle been used before. Ranked for recall, not variety.';

-- search_content_ideas (spec section 19)
create or replace function kb.search_content_ideas(
    p_brand_id  uuid,
    p_query     text default null,
    p_embedding extensions.vector(1024) default null,
    p_status    text default 'unused',
    p_limit     integer default 10
)
returns table (
    id          uuid,
    topic       text,
    angle       text,
    hook        text,
    status      text,
    source_ids  jsonb,
    created_at  timestamptz,
    relevance   numeric
)
language sql
stable
as $fn$
with tsq as (
    select case when p_query is null or btrim(p_query) = '' then null
                else websearch_to_tsquery('english', p_query) end as q
),
scored as (
    select
        i.id, i.topic, i.angle, i.hook, i.status, i.source_ids, i.created_at,
        case when p_embedding is not null and i.embedding is not null
             then greatest(0, 1 - (i.embedding <=> p_embedding))::numeric else 0 end as semantic,
        case when (select q from tsq) is not null
             then ts_rank_cd(i.tsv, (select q from tsq), 32)::numeric else 0 end as keyword
    from kb.content_ideas i
    where i.brand_id = p_brand_id
      and (p_status is null or i.status = p_status)
)
select id, topic, angle, hook, status, source_ids, created_at,
       round((0.75 * semantic + 0.25 * keyword)::numeric, 4)
from scored
order by (0.75 * semantic + 0.25 * keyword) desc, created_at desc
limit greatest(1, least(coalesce(p_limit, 10), 100));
$fn$;

comment on function kb.search_content_ideas is 'Spec section 19. Recover an idea already generated rather than generating a near-duplicate of it.';

-- Hook retrieval (spec section 20) — structured filtering, no embedding needed yet
create or replace function kb.search_hooks(
    p_brand_id uuid default null,
    p_topic    text default null,
    p_category text default null,
    p_limit    integer default 10
)
returns table (
    id         uuid,
    category   text,
    template   text,
    example    text,
    topics     text[],
    origin     text,
    origin_ref text
)
language sql
stable
as $fn$
    select h.id, h.category, h.template, h.example, h.topics, h.origin, h.origin_ref
    from kb.hooks h
    where h.is_active
      and (p_brand_id is null or h.brand_id is null or h.brand_id = p_brand_id)
      and (p_category is null or h.category = p_category)
      and (p_topic is null
           or h.topics && array[p_topic]
           or h.template ilike '%' || p_topic || '%'
           or h.example  ilike '%' || p_topic || '%')
    order by (p_topic is not null and h.topics && array[p_topic]) desc, h.created_at desc
    limit greatest(1, least(coalesce(p_limit, 10), 100));
$fn$;

comment on function kb.search_hooks is 'Spec section 20. Structured filtering over the hook library. The embedding column exists but is unused: filtering a few hundred rows by category does not need a vector.';;
