create or replace function public.content_search(
  q        text    default null,
  kind     text    default null,
  since    date    default null,
  until    date    default null,
  max_rows integer default 20
)
returns table (
  url text, title text, kind_tag text, published date, date_source text,
  heading text, ordinal integer, passage text, snippet text, relevance real
)
language sql
stable
security invoker
set search_path = content, public, pg_temp
as $$
  select * from content.search_content(q, kind, since, until, max_rows);
$$;

-- Write path for the content harvest. Chunk boundaries move whenever the
-- chunker changes or a post is edited, so ordinals cannot be merged in place:
-- a document's chunks are replaced wholesale. The document row itself is
-- upserted by url so its id, and anything referencing it, survives.
create or replace function public.content_upsert_docs(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = content, public, pg_temp
as $$
declare
  rec  jsonb;
  did  bigint;
  n    integer := 0;
begin
  for rec in select * from jsonb_array_elements(payload)
  loop
    insert into content.documents
      (url, site, kind, title, summary, author, published, date_source,
       updated, word_count, body, fetched_at)
    values (
      rec->>'url',
      coalesce(rec->>'site', 'aiko-local'),
      rec->>'kind',
      rec->>'title',
      nullif(rec->>'summary', ''),
      nullif(rec->>'author', ''),
      (rec->>'published')::date,
      nullif(rec->>'date_source', ''),
      (rec->>'updated')::date,
      (rec->>'word_count')::integer,
      rec->>'body',
      now()
    )
    on conflict (url) do update set
      kind        = excluded.kind,
      title       = excluded.title,
      summary     = excluded.summary,
      author      = excluded.author,
      published   = excluded.published,
      date_source = excluded.date_source,
      updated     = excluded.updated,
      word_count  = excluded.word_count,
      body        = excluded.body,
      fetched_at  = now()
    returning id into did;

    delete from content.chunks where document_id = did;

    insert into content.chunks (document_id, ordinal, heading, text)
    select did, (c->>'ordinal')::integer, nullif(c->>'heading', ''), c->>'text'
    from jsonb_array_elements(rec->'chunks') as c;

    n := n + 1;
  end loop;

  return n;
end;
$$;

comment on function public.content_upsert_docs is
  'Write path for the content harvest. service_role only.';

grant execute on function public.content_search to anon, authenticated, service_role;

revoke execute on function public.content_upsert_docs(jsonb) from public, anon, authenticated;
grant  execute on function public.content_upsert_docs(jsonb) to service_role;;
