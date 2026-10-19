-- Agent retrieval entry point. Returns passages with enough document context
-- to cite, plus a highlighted snippet so an agent can judge relevance without
-- reading the whole chunk.
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
      when q is null or q = '' then left(c.text, 300)
      else ts_headline('english', c.text, websearch_to_tsquery('english', q),
                       'MaxFragments=2, MinWords=12, MaxWords=32, StartSel=**, StopSel=**')
    end as snippet,
    case
      when q is null or q = '' then 0::real
      else greatest(
             ts_rank(c.text_tsv, websearch_to_tsquery('english', q)),
             similarity(c.text, q)
           )
    end as relevance
  from content.chunks c
  join content.documents d on d.id = c.document_id
  where
        (q is null or q = ''
         or c.text_tsv @@ websearch_to_tsquery('english', q)
         or c.text % q)
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
  'Passage-level retrieval over Trilith''s own content. Omit q to browse by kind and date; relevance is 0 in that case.';

-- When a passage is not enough and the agent wants the whole article.
create or replace function content.get_document(doc_url text)
returns table (
  url text, title text, kind_tag text, published date, summary text,
  word_count integer, body text
)
language sql
stable
security invoker
set search_path = content, public, pg_temp
as $$
  select d.url, d.title, d.kind, d.published, d.summary, d.word_count, d.body
  from content.documents d
  where d.url = doc_url or d.url like '%' || doc_url;
$$;

-- What has been written about what, so an agent planning new content can see
-- coverage and gaps without pulling every document.
create or replace view content.document_index as
select d.kind, d.title, d.url, d.published, d.date_source, d.word_count,
       count(c.id) as chunks
from content.documents d
left join content.chunks c on c.document_id = d.id
group by d.id, d.kind, d.title, d.url, d.published, d.date_source, d.word_count;

grant execute on function content.search_content to anon, authenticated, service_role;
grant execute on function content.get_document   to anon, authenticated, service_role;
grant select  on content.document_index          to anon, authenticated, service_role;;
