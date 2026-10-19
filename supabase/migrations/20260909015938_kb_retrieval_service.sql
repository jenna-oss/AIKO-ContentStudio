-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Repetition detection (spec section 33)
--
-- Semantic similarity alone cannot separate "we made this exact video" from
-- "we covered this topic from the opposite side", and the spec is explicit that
-- a related topic is still recommendable when the angle differs. So topic and
-- angle are compared separately by trigram alongside the embedding, and a high
-- topic match with a low angle match is downgraded from repetitive to related.
-- ---------------------------------------------------------------------------
create or replace function kb.assess_repetition(
    p_brand_id  uuid,
    p_embedding extensions.vector(1024) default null,
    p_topic     text default null,
    p_angle     text default null,
    p_limit     integer default 5
)
returns table (
    assessment     text,
    top_similarity numeric,
    matches        jsonb
)
language plpgsql
stable
as $fn$
declare
    s_dup   numeric;
    s_rep   numeric;
    s_rel   numeric;
begin
    select repetition_duplicate_at, repetition_repetitive_at, repetition_related_at
      into s_dup, s_rep, s_rel
      from kb.retrieval_settings where singleton;

    return query
    with cand as (
        select
            p.id, p.title, p.topic, p.angle, p.platform, p.published_at,
            case when p_embedding is not null and p.embedding is not null
                 then greatest(0, 1 - (p.embedding <=> p_embedding))::numeric else 0 end as sim,
            case when p_topic is null then 0
                 else public.similarity(lower(p.topic), lower(p_topic))::numeric end as topic_sim,
            case when p_angle is null or p.angle is null then 0
                 else public.similarity(lower(p.angle), lower(p_angle))::numeric end as angle_sim
        from kb.published_content p
        where p.brand_id = p_brand_id
    ),
    judged as (
        select c.*,
            case
                when c.sim >= s_dup                          then 'duplicate'
                when c.sim >= s_rep and c.angle_sim >= 0.45   then 'repetitive'
                when c.sim >= s_rep                          then 'related'
                when c.sim >= s_rel or c.topic_sim >= 0.55    then 'related'
                else 'new'
            end as verdict
        from cand c
    ),
    top as (
        select * from judged
        where verdict <> 'new'
        order by sim desc, topic_sim desc
        limit greatest(1, least(coalesce(p_limit, 5), 25))
    )
    select
        coalesce(
            (select t.verdict from top t
             order by case t.verdict
                        when 'duplicate'  then 3
                        when 'repetitive' then 2
                        when 'related'    then 1
                        else 0 end desc, t.sim desc
             limit 1),
            'new'),
        coalesce((select round(max(t.sim), 4) from top t), 0),
        coalesce((select jsonb_agg(jsonb_build_object(
            'id', t.id, 'title', t.title, 'topic', t.topic, 'angle', t.angle,
            'platform', t.platform, 'published_at', t.published_at,
            'assessment', t.verdict,
            'similarity', round(t.sim, 4),
            'angle_similarity', round(t.angle_sim, 4)
        ) order by t.sim desc) from top t), '[]'::jsonb);
end;
$fn$;

comment on function kb.assess_repetition is 'Spec section 33. Classifies a candidate as new / related / repetitive / duplicate against published content. A strong topic match with a weak angle match stays "related" and is still recommendable.';

-- ---------------------------------------------------------------------------
-- Retrieval logging (spec section 38)
-- ---------------------------------------------------------------------------
create or replace function kb.log_retrieval(
    p_brand_id     uuid,
    p_session_id   text,
    p_tool         text,
    p_query        text,
    p_intent       text,
    p_filters      jsonb default '{}'::jsonb,
    p_result_ids   jsonb default '[]'::jsonb,
    p_top_score    numeric default null,
    p_semantic_hits integer default null,
    p_keyword_hits  integer default null,
    p_latency_ms   integer default null,
    p_degraded     boolean default false
)
returns bigint
language sql
volatile
as $fn$
    insert into kb.retrieval_log (
        brand_id, session_id, tool, query, intent, filters,
        result_ids, result_count, top_score, semantic_hits, keyword_hits,
        latency_ms, degraded
    )
    values (
        p_brand_id, p_session_id, p_tool, p_query, p_intent, coalesce(p_filters, '{}'::jsonb),
        coalesce(p_result_ids, '[]'::jsonb), jsonb_array_length(coalesce(p_result_ids, '[]'::jsonb)),
        p_top_score, p_semantic_hits, p_keyword_hits, p_latency_ms, coalesce(p_degraded, false)
    )
    returning id;
$fn$;

-- ---------------------------------------------------------------------------
-- Idea memory (spec section 34)
-- ---------------------------------------------------------------------------
create or replace function kb.save_idea(
    p_brand_id   uuid,
    p_topic      text,
    p_angle      text default null,
    p_hook       text default null,
    p_source_ids jsonb default '[]'::jsonb,
    p_source_type text default 'planning_session',
    p_status     text default 'unused',
    p_session_id text default null,
    p_embedding  extensions.vector(1024) default null,
    p_metadata   jsonb default '{}'::jsonb
)
returns uuid
language sql
volatile
as $fn$
    insert into kb.content_ideas
        (brand_id, topic, angle, hook, source_ids, source_type, status, session_id, embedding, metadata)
    values
        (p_brand_id, p_topic, p_angle, p_hook, coalesce(p_source_ids, '[]'::jsonb),
         p_source_type, p_status, p_session_id, p_embedding, coalesce(p_metadata, '{}'::jsonb))
    returning id;
$fn$;

comment on function kb.save_idea is 'Spec section 34. source_ids keeps every source the idea was built from, so the claim "you talked about this in your podcast" stays checkable later.';

-- ---------------------------------------------------------------------------
-- The retrieval service (spec sections 29, 37)
--
-- One call, several corpora, one normalised shape, and a hard token budget.
-- The planner never sees a chunk id it cannot trace, and never receives more
-- context than the budget allows regardless of the limit it asked for.
-- ---------------------------------------------------------------------------
create or replace function kb.retrieve(
    p_brand_id      uuid,
    p_query         text default null,
    p_embedding     extensions.vector(1024) default null,
    p_scope         text[] default array['transcripts','research','published'],
    p_intent        text default 'DISCOVERY',
    p_limit         integer default 5,
    p_budget_tokens integer default null,
    p_date_from     date default null,
    p_date_to       date default null,
    p_session_id    text default null
)
returns jsonb
language plpgsql
volatile
as $fn$
declare
    budget     integer;
    doc_types  text[] := '{}';
    out_rows   jsonb  := '[]'::jsonb;
    degraded   boolean := (p_embedding is null);
    started    timestamptz := clock_timestamp();
    n_sem      integer := 0;
    n_kw       integer := 0;
begin
    select coalesce(p_budget_tokens, context_budget_tokens)
      into budget from kb.retrieval_settings where singleton;

    if 'transcripts' = any (p_scope) then
        doc_types := doc_types || array['transcript','recording','interview'];
    end if;
    if 'research' = any (p_scope) then
        doc_types := doc_types || array['research','report','article'];
    end if;

    create temporary table if not exists _kb_hits (
        source_type text, source_id uuid, chunk_id uuid, title text,
        dt timestamptz, relevance numeric, content text, metadata jsonb, est_tokens integer
    ) on commit drop;
    delete from _kb_hits;

    if array_length(doc_types, 1) is not null then
        insert into _kb_hits
        select
            r.source_type, r.document_id, r.chunk_id, r.title, r.published_at,
            r.relevance, r.content,
            r.metadata || jsonb_build_object(
                'source', r.source, 'source_url', r.source_url,
                'timestamp_start', r.metadata ->> 'start_time',
                'timestamp_end',   r.metadata ->> 'end_time'),
            coalesce(r.token_count, ceil(length(r.content) / 4.0)::integer)
        from kb.search_chunks(
            p_brand_id       => p_brand_id,
            p_query          => p_query,
            p_embedding      => p_embedding,
            p_document_types => doc_types,
            p_date_from      => p_date_from,
            p_date_to        => p_date_to,
            p_intent         => p_intent,
            p_limit          => greatest(p_limit * 2, 10)
        ) r;
    end if;

    if 'published' = any (p_scope) then
        insert into _kb_hits
        select 'published', p.id, null, p.title, p.published_at, p.relevance,
               concat_ws(' — ', p.topic, p.angle, p.hook),
               jsonb_build_object('platform', p.platform, 'format', p.format,
                                  'topic', p.topic, 'angle', p.angle,
                                  'performance', p.performance),
               ceil(length(concat_ws(' ', p.topic, p.angle, p.hook)) / 4.0)::integer
        from kb.search_previous_content(
            p_brand_id => p_brand_id, p_query => p_query, p_embedding => p_embedding,
            p_date_from => p_date_from, p_date_to => p_date_to, p_limit => p_limit
        ) p;
    end if;

    if 'ideas' = any (p_scope) then
        insert into _kb_hits
        select 'idea', i.id, null, i.topic, i.created_at, i.relevance,
               concat_ws(' — ', i.topic, i.angle, i.hook),
               jsonb_build_object('status', i.status, 'source_ids', i.source_ids,
                                  'angle', i.angle, 'hook', i.hook),
               ceil(length(concat_ws(' ', i.topic, i.angle, i.hook)) / 4.0)::integer
        from kb.search_content_ideas(
            p_brand_id => p_brand_id, p_query => p_query, p_embedding => p_embedding,
            p_status => null, p_limit => p_limit
        ) i;
    end if;

    -- Spec section 37: trim to the token budget. The running total is computed
    -- over the ranked order, so what gets dropped is always the least relevant.
    with ranked as (
        select h.*,
               sum(h.est_tokens) over (order by h.relevance desc, h.dt desc nulls last
                                       rows between unbounded preceding and current row) as running
        from _kb_hits h
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'source_type', r.source_type,
               'source_id',   r.source_id,
               'chunk_id',    r.chunk_id,
               'title',       r.title,
               'date',        r.dt,
               'relevance',   r.relevance,
               'content',     r.content,
               'metadata',    r.metadata
           ) order by r.relevance desc, r.dt desc nulls last), '[]'::jsonb)
      into out_rows
    from ranked r
    where r.running <= budget
    limit p_limit;

    perform kb.log_retrieval(
        p_brand_id, p_session_id, 'retrieve', p_query, p_intent,
        jsonb_build_object('scope', to_jsonb(p_scope), 'date_from', p_date_from, 'date_to', p_date_to),
        (select coalesce(jsonb_agg(coalesce(e -> 'chunk_id', e -> 'source_id')), '[]'::jsonb)
           from jsonb_array_elements(out_rows) e),
        (select max((e ->> 'relevance')::numeric) from jsonb_array_elements(out_rows) e),
        n_sem, n_kw,
        (extract(milliseconds from clock_timestamp() - started))::integer,
        degraded
    );

    return jsonb_build_object(
        'retrieval_context', out_rows,
        'budget_tokens', budget,
        'degraded', degraded
    );
end;
$fn$;

comment on function kb.retrieve is 'Spec sections 29 and 37. The retrieval service: several corpora, one normalised context object, a hard token budget, and a log line. degraded=true means the semantic half was unavailable and this is keyword-only.';;
