-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

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
    n_total    integer := 0;
    n_kept     integer := 0;
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

    select count(*) into n_total from _kb_hits;

    /* Spec section 37. Two ceilings, both applied to the ranked order so what
     * falls off is always the least relevant: p_limit on count, and the token
     * budget on size. The running total is inclusive of the current row, so a
     * single oversized chunk cannot slip through by starting under budget. */
    with ranked as (
        select h.*,
               row_number() over (order by h.relevance desc, h.dt desc nulls last) as rn,
               sum(h.est_tokens) over (order by h.relevance desc, h.dt desc nulls last,
                                                h.source_id, h.chunk_id
                                       rows between unbounded preceding and current row) as running
        from _kb_hits h
    ),
    kept as (
        select * from ranked
        where rn <= greatest(1, coalesce(p_limit, 5))
          and running <= budget
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'source_type', k.source_type,
               'source_id',   k.source_id,
               'chunk_id',    k.chunk_id,
               'title',       k.title,
               'date',        k.dt,
               'relevance',   k.relevance,
               'content',     k.content,
               'metadata',    k.metadata
           ) order by k.relevance desc, k.dt desc nulls last), '[]'::jsonb),
           count(*)
      into out_rows, n_kept
    from kept k;

    perform kb.log_retrieval(
        p_brand_id, p_session_id, 'retrieve', p_query, p_intent,
        jsonb_build_object('scope', to_jsonb(p_scope), 'date_from', p_date_from,
                           'date_to', p_date_to, 'candidates', n_total),
        (select coalesce(jsonb_agg(coalesce(e -> 'chunk_id', e -> 'source_id')), '[]'::jsonb)
           from jsonb_array_elements(out_rows) e),
        (select max((e ->> 'relevance')::numeric) from jsonb_array_elements(out_rows) e),
        null, null,
        (extract(milliseconds from clock_timestamp() - started))::integer,
        degraded
    );

    return jsonb_build_object(
        'retrieval_context', out_rows,
        'budget_tokens', budget,
        'candidates_considered', n_total,
        'returned', coalesce(n_kept, 0),
        'degraded', degraded
    );
end;
$fn$;

comment on function kb.retrieve is 'Spec sections 29 and 37. The retrieval service: several corpora, one normalised context object, a hard token budget, and a log line. degraded=true means the semantic half was unavailable and this is keyword-only.';;
