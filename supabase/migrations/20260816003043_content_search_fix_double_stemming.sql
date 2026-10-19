-- Two fixes.
--
-- 1. Double stemming. The IDF weights are computed per lexeme, and those
--    lexemes come out of to_tsvector already stemmed ('appraisal' -> 'apprais').
--    Feeding them back through to_tsquery('english', ...) stems them a second
--    time ('apprais' -> 'apprai'), which matches nothing: every such term
--    silently scored zero and got a maximal rarity weight for being absent.
--    Already-normalised lexemes must be looked up with the 'simple' config.
--
-- 2. Proximity. In a corpus this topically narrow, IDF alone is weak — a
--    lending corpus makes 'appraisal' (df 34) look more common than 'low'
--    (df 12). Cover density separates 'low appraisal' sitting together from
--    'low' and 'comes' scattered across a paragraph.
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
      nullif(btrim(coalesce(q, '')), '')               as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq_all,
      (select array_agg(lexeme)
         from unnest(to_tsvector('english', coalesce(q, '')))) as lex
  ),
  built as (
    select p.raw, p.tsq_all, p.lex,
           case when p.lex is null then null
                else to_tsquery('simple', array_to_string(p.lex, ' | ')) end as tsq_any,
           (select count(*) from content.chunks)::numeric as n_chunks
    from parsed p
  ),
  weights as (
    select l.lexeme,
           ln(b.n_chunks / greatest(
             (select count(*) from content.chunks cc
               where cc.text_tsv @@ to_tsquery('simple', l.lexeme)), 1))::real as w
    from built b, unnest(coalesce(b.lex, '{}')) as l(lexeme)
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
      else coalesce((
             select sum(w.w) from weights w
             where c.text_tsv @@ to_tsquery('simple', w.lexeme)
           ), 0)::real
           + 3.0 * ts_rank_cd(c.text_tsv, b.tsq_any)
           + case when c.text_tsv @@ b.tsq_all then 1.0 else 0.0 end
           + case when c.heading is not null
                   and to_tsvector('english', c.heading) @@ coalesce(b.tsq_any, b.tsq_all)
                  then 0.5 else 0.0 end
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
  'Passage-level retrieval over Trilith''s own content. Matches any query term for recall; ranks by inverse document frequency, term proximity, full-query coverage and heading hits. Omit q to browse by kind and date.';;
