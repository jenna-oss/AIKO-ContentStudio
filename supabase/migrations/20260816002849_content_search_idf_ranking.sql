-- Ranking by ts_rank alone let a product page win 'appraisal comes in low' on
-- the strength of 'low' and 'comes', beating the post actually about low
-- appraisals. Term frequency is the wrong signal — term *rarity* is the right
-- one. Weight each matched query term by its inverse document frequency across
-- the corpus, so 'appraisal' counts for far more than 'low'.
--
-- The corpus is a few hundred chunks, so computing IDF per query is cheap and
-- always current. This would need precomputing at a much larger scale.
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
      nullif(btrim(coalesce(q, '')), '')                 as raw,
      websearch_to_tsquery('english', coalesce(q, ''))   as tsq_all,
      (select array_agg(lexeme)
         from unnest(to_tsvector('english', coalesce(q, '')))) as lex
  ),
  built as (
    select p.raw, p.tsq_all, p.lex,
           case when p.lex is null then null
                else to_tsquery('english', array_to_string(p.lex, ' | ')) end as tsq_any,
           (select count(*) from content.chunks)::numeric as n_chunks
    from parsed p
  ),
  -- One row per query term, weighted by how rare it is across the corpus.
  weights as (
    select l.lexeme,
           ln(b.n_chunks / greatest(
             (select count(*) from content.chunks cc
               where cc.text_tsv @@ to_tsquery('english', l.lexeme)), 1))::real as w
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
             where c.text_tsv @@ to_tsquery('english', w.lexeme)
           ), 0)::real
           -- A chunk carrying every term is a better answer than one carrying
           -- the rarest term alone, so break near-ties in its favour.
           + case when c.text_tsv @@ b.tsq_all then 1.0 else 0.0 end
           -- The heading is the author's own statement of what the passage
           -- argues; a hit there is worth more than one buried in the body.
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
  'Passage-level retrieval over Trilith''s own content. Matches any query term for recall, ranks by inverse document frequency so rare terms dominate, with bonuses for matching every term and for a heading hit. Omit q to browse by kind and date.';;
