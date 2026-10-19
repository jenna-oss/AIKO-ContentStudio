-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Keyword recall.
--
-- websearch_to_tsquery ANDs every term, so "DSCR loans for new investors"
-- demands the word "new" and returns nothing. That is wrong in both halves of
-- hybrid retrieval: when embeddings are present the semantic side is already
-- handling paraphrase, and the keyword side should be widening recall, not
-- narrowing it; when embeddings are absent it is the only side there is.
--
-- Matching is therefore OR across terms, with a multiplier for rows that carry
-- every term — the same rule adspy.search_ads and content.search_content
-- already use, so all four corpora now behave alike.
-- ---------------------------------------------------------------------------

create or replace function kb.search_chunks(
    p_brand_id       uuid,
    p_query          text default null,
    p_embedding      extensions.vector(1024) default null,
    p_document_types text[] default null,
    p_date_from      date default null,
    p_date_to        date default null,
    p_content_type   text default null,
    p_source         text default null,
    p_topics         text[] default null,
    p_intent         text default 'DEFAULT',
    p_limit          integer default 5,
    p_pool           integer default 120
)
returns table (
    chunk_id     uuid,
    document_id  uuid,
    source_type  text,
    title        text,
    source       text,
    source_url   text,
    published_at timestamptz,
    heading      text,
    content      text,
    token_count  integer,
    relevance    numeric,
    semantic     numeric,
    keyword      numeric,
    recency      numeric,
    strategic    numeric,
    metadata     jsonb
)
language sql
stable
as $fn$
with w as (
    select * from kb.ranking_weights
    where intent = coalesce(
        (select rw.intent from kb.ranking_weights rw where rw.intent = upper(coalesce(p_intent, 'DEFAULT'))),
        'DEFAULT')
),
tsq as (
    select
        nullif(replace(plainto_tsquery('english', coalesce(p_query, ''))::text, ' & ', ' | '), '')::tsquery as q_or,
        nullif(plainto_tsquery('english', coalesce(p_query, ''))::text, '')::tsquery                        as q_and
),
sem as (
    select c.id, greatest(0, 1 - (c.embedding <=> p_embedding))::numeric as score
    from kb.document_chunks c
    join kb.documents d on d.id = c.document_id
    where p_embedding is not null
      and c.embedding is not null
      and c.brand_id = p_brand_id
      and d.status = 'ready'
      and (p_document_types is null or d.document_type = any (p_document_types))
      and (p_date_from is null or d.published_at >= p_date_from::timestamptz)
      and (p_date_to   is null or d.published_at <  (p_date_to::timestamptz + interval '1 day'))
      and (p_content_type is null
           or coalesce(c.metadata ->> 'content_type', d.metadata ->> 'content_type') = p_content_type)
      and (p_source is null or d.source ilike '%' || p_source || '%')
      and (p_topics is null or (c.metadata -> 'topics') ?| p_topics or (d.metadata -> 'topics') ?| p_topics)
    order by c.embedding <=> p_embedding
    limit p_pool
),
kw as (
    select c.id,
           least(1.0, ts_rank_cd(c.tsv, (select q_or from tsq), 32)
                      * case when c.tsv @@ (select q_and from tsq) then 1.6 else 1.0 end)::numeric as score
    from kb.document_chunks c
    join kb.documents d on d.id = c.document_id
    where (select q_or from tsq) is not null
      and c.tsv @@ (select q_or from tsq)
      and c.brand_id = p_brand_id
      and d.status = 'ready'
      and (p_document_types is null or d.document_type = any (p_document_types))
      and (p_date_from is null or d.published_at >= p_date_from::timestamptz)
      and (p_date_to   is null or d.published_at <  (p_date_to::timestamptz + interval '1 day'))
      and (p_content_type is null
           or coalesce(c.metadata ->> 'content_type', d.metadata ->> 'content_type') = p_content_type)
      and (p_source is null or d.source ilike '%' || p_source || '%')
      and (p_topics is null or (c.metadata -> 'topics') ?| p_topics or (d.metadata -> 'topics') ?| p_topics)
    order by 2 desc
    limit p_pool
),
cand as (
    select id from sem
    union
    select id from kw
),
scored as (
    select
        c.id                              as chunk_id,
        c.document_id,
        d.document_type                   as source_type,
        d.title,
        d.source,
        d.source_url,
        d.published_at,
        c.heading,
        c.content,
        c.token_count,
        coalesce(s.score, 0)              as semantic,
        coalesce(k.score, 0)              as keyword,
        kb.recency_score(d.published_at, d.document_type) as recency,
        kb.strategic_score(p_brand_id, c.embedding)       as strategic,
        c.metadata || jsonb_build_object('chunk_index', c.chunk_index) as metadata
    from cand
    join kb.document_chunks c on c.id = cand.id
    join kb.documents d       on d.id = c.document_id
    left join sem s on s.id = c.id
    left join kw  k on k.id = c.id
),
weighted as (
    select
        scored.*,
        (w.semantic  * scored.semantic
       + w.keyword   * scored.keyword
       + w.recency   * scored.recency
       + w.strategic * scored.strategic)::numeric as raw_score,
        row_number() over (
            partition by scored.document_id
            order by (w.semantic  * scored.semantic
                    + w.keyword   * scored.keyword
                    + w.recency   * scored.recency
                    + w.strategic * scored.strategic) desc
        ) as rank_in_doc
    from scored, w
),
diversified as (
    select
        weighted.*,
        greatest(0, weighted.raw_score - (w.diversity_penalty * (weighted.rank_in_doc - 1)))::numeric as final_score
    from weighted, w
    where weighted.rank_in_doc <= w.max_per_document
)
select
    chunk_id, document_id, source_type, title, source, source_url, published_at,
    heading, content, token_count,
    round(final_score, 4) as relevance,
    round(semantic,  4)   as semantic,
    round(keyword,   4)   as keyword,
    round(recency,   4)   as recency,
    round(strategic, 4)   as strategic,
    metadata
from diversified
order by final_score desc, published_at desc nulls last
limit greatest(1, least(coalesce(p_limit, 5), 50));
$fn$;

-- Same recall rule for the two row-level corpora.
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
    id uuid, title text, topic text, angle text, hook text, format text,
    platform text, published_at timestamptz, performance jsonb,
    relevance numeric, semantic numeric, keyword numeric, source_key text
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
    select
        nullif(replace(plainto_tsquery('english', coalesce(p_query, ''))::text, ' & ', ' | '), '')::tsquery as q_or,
        nullif(plainto_tsquery('english', coalesce(p_query, ''))::text, '')::tsquery                        as q_and
),
scored as (
    select
        p.id, p.title, p.topic, p.angle, p.hook, p.format, p.platform,
        p.published_at, p.performance, p.source_key,
        case when p_embedding is not null and p.embedding is not null
             then greatest(0, 1 - (p.embedding <=> p_embedding))::numeric else 0 end as semantic,
        case when (select q_or from tsq) is not null
             then least(1.0, ts_rank_cd(p.tsv, (select q_or from tsq), 32)
                             * case when p.tsv @@ (select q_and from tsq) then 1.6 else 1.0 end)::numeric
             else 0 end as keyword,
        kb.recency_score(p.published_at, 'published') as recency
    from kb.published_content p
    where p.brand_id = p_brand_id
      and (p_platform is null or p.platform = p_platform)
      and (p_date_from is null or p.published_at >= p_date_from::timestamptz)
      and (p_date_to   is null or p.published_at <  (p_date_to::timestamptz + interval '1 day'))
      and (
            (p_query is null or btrim(p_query) = '') and p_embedding is null
            or (p_embedding is not null and p.embedding is not null)
            or ((select q_or from tsq) is not null and p.tsv @@ (select q_or from tsq))
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

create or replace function kb.search_content_ideas(
    p_brand_id  uuid,
    p_query     text default null,
    p_embedding extensions.vector(1024) default null,
    p_status    text default 'unused',
    p_limit     integer default 10
)
returns table (
    id uuid, topic text, angle text, hook text, status text,
    source_ids jsonb, created_at timestamptz, relevance numeric
)
language sql
stable
as $fn$
with tsq as (
    select
        nullif(replace(plainto_tsquery('english', coalesce(p_query, ''))::text, ' & ', ' | '), '')::tsquery as q_or,
        nullif(plainto_tsquery('english', coalesce(p_query, ''))::text, '')::tsquery                        as q_and
),
scored as (
    select
        i.id, i.topic, i.angle, i.hook, i.status, i.source_ids, i.created_at,
        case when p_embedding is not null and i.embedding is not null
             then greatest(0, 1 - (i.embedding <=> p_embedding))::numeric else 0 end as semantic,
        case when (select q_or from tsq) is not null
             then least(1.0, ts_rank_cd(i.tsv, (select q_or from tsq), 32)
                             * case when i.tsv @@ (select q_and from tsq) then 1.6 else 1.0 end)::numeric
             else 0 end as keyword
    from kb.content_ideas i
    where i.brand_id = p_brand_id
      and (p_status is null or i.status = p_status)
)
select id, topic, angle, hook, status, source_ids, created_at,
       round((0.75 * semantic + 0.25 * keyword)::numeric, 4)
from scored
order by (0.75 * semantic + 0.25 * keyword) desc, created_at desc
limit greatest(1, least(coalesce(p_limit, 10), 100));
$fn$;;
