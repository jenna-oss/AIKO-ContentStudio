-- websearch_to_tsquery ANDs its terms, so a natural-language question like
-- 'appraisal comes in low' only matches a chunk containing every word. That is
-- the wrong default for agent retrieval: recall matters more than precision
-- when a reranker (the agent itself) reads the results.
--
-- So match on ANY term, and rank so that chunks containing ALL of them still
-- come first. Word-similarity handles misspellings — plain similarity() is
-- useless here because it compares the query against the whole 700-character
-- chunk rather than against a portion of it.
create or replace function content.search_content(
  q         text    default null,
  kind      text    default null,
  since     date    default null,
  until     date    default null,
  max_rows  integer default 20
)
returns table (
  url          text,
  title        text,
  kind_tag     text,
  published    date,
  date_source  text,
  heading      text,
  ordinal      integer,
  passage      text,
  snippet      text,
  relevance    real
)
language sql
stable
security invoker
set search_path = content, public, pg_temp
as $$
  with parsed as (
    select
      nullif(btrim(coalesce(q, '')), '') as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq_all,
      (select string_agg(lexeme, ' | ')
         from unnest(to_tsvector('english', coalesce(q, ''))) ) as or_src
  ),
  built as (
    select raw, tsq_all,
           case when or_src is null then null else to_tsquery('english', or_src) end as tsq_any
    from parsed
  )
  select
    d.url,
    d.title,
    d.kind as kind_tag,
    d.published,
    d.date_source,
    c.heading,
    c.ordinal,
    c.text as passage,
    case
      when b.raw is null then left(c.text, 300)
      else ts_headline('english', c.text, coalesce(b.tsq_any, b.tsq_all),
                       'MaxFragments=2, MinWords=12, MaxWords=32, StartSel=**, StopSel=**')
    end as snippet,
    case
      when b.raw is null then 0::real
      else ts_rank(c.text_tsv, b.tsq_any) +
           case when c.text_tsv @@ b.tsq_all then 1.0 else 0.0 end
    end as relevance
  from content.chunks c
  join content.documents d on d.id = c.document_id
  cross join built b
  where
        (b.raw is null
         or (b.tsq_any is not null and c.text_tsv @@ b.tsq_any)
         or b.raw <% c.text)
    and (search_content.kind is null or d.kind = search_content.kind)
    and (since is null or d.published >= since)
    and (until is null or d.published <= until)
  order by
    relevance desc,
    d.published desc nulls last,
    c.ordinal
  limit least(coalesce(max_rows, 20), 200);
$$;

comment on function content.search_content is
  'Passage-level retrieval over Trilith''s own content. Matches any query term for recall; chunks matching every term are ranked a full point higher. Omit q to browse by kind and date.';;
