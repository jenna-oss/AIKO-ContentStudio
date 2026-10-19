-- "What have we already written about?" is the first question a content agent
-- should ask, and answering it by pulling every passage would be wasteful. This
-- returns one row per document so a gap is visible at a glance.
create or replace function public.content_coverage(kind text default null)
returns table (
  kind_tag    text,
  title       text,
  url         text,
  published   date,
  date_source text,
  word_count  integer,
  chunks      bigint
)
language sql
stable
security invoker
set search_path = content, public, pg_temp
as $$
  select i.kind, i.title, i.url, i.published, i.date_source, i.word_count, i.chunks
  from content.document_index i
  where content_coverage.kind is null or i.kind = content_coverage.kind
  order by i.published desc nulls last, i.title;
$$;

grant execute on function public.content_coverage to anon, authenticated, service_role;;
