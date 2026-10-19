-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

create or replace function kb.recency_score(
    p_published      timestamptz,
    p_document_type  text default 'other'
)
returns numeric
language plpgsql
stable
as $fn$
declare
    tau  numeric := 1.0;
    d    numeric;
    lo_d integer;
    lo_f numeric;
    hi_d integer;
    hi_f numeric;
begin
    if p_published is null then
        return 0.50;
    end if;

    select rp.tau into tau from kb.recency_profile rp
    where rp.document_type = p_document_type;
    tau := coalesce(tau, 1.0);

    d := greatest(0, extract(epoch from (now() - p_published)) / 86400.0) / tau;

    select c.age_days, c.factor into lo_d, lo_f
    from kb.recency_curve c where c.age_days <= d
    order by c.age_days desc limit 1;

    select c.age_days, c.factor into hi_d, hi_f
    from kb.recency_curve c where c.age_days > d
    order by c.age_days asc limit 1;

    if lo_d is null then
        return (select factor from kb.recency_curve order by age_days asc limit 1);
    end if;
    if hi_d is null then
        return lo_f;
    end if;

    return round(lo_f + (hi_f - lo_f) * ((d - lo_d) / nullif(hi_d - lo_d, 0)), 4);
end;
$fn$;

comment on function kb.recency_score(timestamptz, text) is 'Spec section 22. Interpolates kb.recency_curve, with age divided by the document type tau first. Undated content returns 0.50 rather than 0 or 1.';

alter table kb.content_pillars add column if not exists embedding extensions.vector(1024);

drop trigger if exists content_pillars_dimension_guard on kb.content_pillars;
create trigger content_pillars_dimension_guard
    before insert or update of embedding on kb.content_pillars
    for each row execute function kb.assert_embedding_dimension();

create or replace function kb.strategic_score(
    p_brand_id  uuid,
    p_embedding extensions.vector(1024),
    p_text      text default null
)
returns numeric
language plpgsql
stable
as $fn$
declare
    best numeric;
begin
    if p_embedding is null then
        return 0;
    end if;

    select max(greatest(0, 1 - (p.embedding <=> p_embedding)))::numeric
    into best
    from kb.content_pillars p
    where p.brand_id = p_brand_id
      and p.is_active
      and p.embedding is not null;

    return coalesce(best, 0);
end;
$fn$;

comment on function kb.strategic_score(uuid, extensions.vector, text) is 'Spec section 23. Similarity to the nearest active content pillar. Returns 0 while no pillars exist or none are embedded, which is the state today.';

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
    select case
             when p_query is null or btrim(p_query) = '' then null
             else websearch_to_tsquery('english', p_query)
           end as q
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
    select c.id, ts_rank_cd(c.tsv, (select q from tsq), 32)::numeric as score
    from kb.document_chunks c
    join kb.documents d on d.id = c.document_id
    where (select q from tsq) is not null
      and c.tsv @@ (select q from tsq)
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

comment on function kb.search_chunks is 'Hybrid retrieval over document chunks: semantic pool + keyword pool, unioned, scored by the configured weights for the intent, diversity-penalised per document, then cut to limit. Every named search tool is a thin wrapper on this.';;
