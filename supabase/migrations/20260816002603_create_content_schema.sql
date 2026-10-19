-- Trilith's own written content: blog posts, funded-deal writeups, product
-- pages, FAQ. Kept out of `public` for the same reason adspy is — this project
-- shares a database with unrelated work.
--
-- The unit of retrieval is the chunk, not the document. A post runs 1,000+
-- words and an agent asking "what do we say about DSCR appraisals" wants the
-- passage that answers it, with enough document context to cite the source.
create schema if not exists content;

create table if not exists content.documents (
  id           bigint generated always as identity primary key,
  url          text not null unique,
  site         text not null default 'aiko-local',
  kind         text not null,          -- blog | case-study | product | faq | page
  title        text not null,
  summary      text,
  author       text,
  published    date,
  -- 'json-ld' means the publisher stated the date. 'sitemap-lastmod' means we
  -- inferred it from a file-modified timestamp. Never conflate the two.
  date_source  text,
  updated      date,
  word_count   integer,
  body         text not null,
  fetched_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists content.chunks (
  id           bigint generated always as identity primary key,
  document_id  bigint not null references content.documents(id) on delete cascade,
  ordinal      integer not null,
  heading      text,
  text         text not null,
  text_tsv     tsvector generated always as (
                 to_tsvector('english', coalesce(heading, '') || ' ' || text)
               ) stored,
  unique (document_id, ordinal)
);

create index if not exists chunks_tsv_idx      on content.chunks using gin (text_tsv);
create index if not exists chunks_trgm_idx     on content.chunks using gin (text gin_trgm_ops);
create index if not exists chunks_doc_idx      on content.chunks (document_id, ordinal);
create index if not exists documents_kind_idx  on content.documents (kind, published desc nulls last);
create index if not exists documents_title_idx on content.documents using gin (title gin_trgm_ops);

alter table content.documents enable row level security;
alter table content.chunks    enable row level security;

drop policy if exists documents_read on content.documents;
create policy documents_read on content.documents for select to anon, authenticated using (true);

drop policy if exists chunks_read on content.chunks;
create policy chunks_read on content.chunks for select to anon, authenticated using (true);

grant usage on schema content to anon, authenticated, service_role;
grant select on content.documents, content.chunks to anon, authenticated, service_role;;
