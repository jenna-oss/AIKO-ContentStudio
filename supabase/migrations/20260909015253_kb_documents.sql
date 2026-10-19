create table if not exists kb.documents (
    id            uuid primary key default gen_random_uuid(),
    brand_id      uuid not null references kb.brands(id) on delete cascade,
    document_type text not null check (document_type in
        ('transcript', 'research', 'article', 'report', 'recording', 'interview', 'other')),
    title         text not null,
    source        text,
    source_url    text,
    published_at  timestamptz,
    source_key    text not null,
    content_hash  text,
    raw_content   text,
    metadata      jsonb not null default '{}'::jsonb,
    status        text not null default 'pending'
                  check (status in ('pending', 'processing', 'ready', 'failed')),
    status_detail text,
    chunk_count   integer not null default 0,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    processed_at  timestamptz
);

create unique index if not exists documents_brand_source_key on kb.documents (brand_id, source_key);
create index if not exists documents_brand_type on kb.documents (brand_id, document_type);
create index if not exists documents_published on kb.documents (published_at desc nulls last);
create index if not exists documents_status on kb.documents (status) where status <> 'ready';

comment on table kb.documents is 'Spec section 6. Common abstraction over every ingestible source. raw_content is kept so a document can be re-chunked without re-fetching it.';
comment on column kb.documents.source_key is 'Stable identity for the upstream thing — file path, canonical URL, YouTube id. The upsert key: re-ingesting the same source updates it rather than forking it.';
comment on column kb.documents.content_hash is 'sha256 of raw_content. Unchanged hash means the re-chunk and re-embed are skipped, which is what keeps a daily re-crawl from re-billing the whole corpus.';
comment on column kb.documents.status is 'pending -> processing -> ready. The retrieval functions read only ready rows, so a half-embedded document is never partially retrievable.';

create table if not exists kb.document_chunks (
    id           uuid primary key default gen_random_uuid(),
    document_id  uuid not null references kb.documents(id) on delete cascade,
    brand_id     uuid not null references kb.brands(id) on delete cascade,
    chunk_index  integer not null,
    heading      text,
    content      text not null,
    token_count  integer,
    embedding    extensions.vector(1024),
    metadata     jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default now(),
    tsv tsvector generated always as (
        to_tsvector('english', coalesce(heading, '') || ' ' || content)
    ) stored
);

create unique index if not exists document_chunks_doc_ordinal on kb.document_chunks (document_id, chunk_index);
create index if not exists document_chunks_brand on kb.document_chunks (brand_id);
create index if not exists document_chunks_tsv on kb.document_chunks using gin (tsv);
create index if not exists document_chunks_meta on kb.document_chunks using gin (metadata jsonb_path_ops);
create index if not exists document_chunks_embedding on kb.document_chunks using hnsw (embedding extensions.vector_cosine_ops);

comment on table kb.document_chunks is 'Spec section 7. The unit of retrieval. Chunks are replaced wholesale when a document is reprocessed — boundaries move, so ordinals cannot be merged.';
comment on column kb.document_chunks.embedding is 'Width must equal kb.embedding_config.dimensions; enforced by trigger. Null until the async embedding pass reaches this row.';
comment on column kb.document_chunks.metadata is 'Per-type chunk metadata. Transcripts carry speaker/start_time/end_time/topics (spec section 8); research carries source/published_date/topics/research_type (section 9).';

create or replace function kb.assert_embedding_dimension()
returns trigger
language plpgsql
as $$
declare
    expected integer;
    actual   integer;
begin
    if new.embedding is null then
        return new;
    end if;

    select dimensions into expected from kb.embedding_config where singleton;
    actual := extensions.vector_dims(new.embedding);

    if actual <> expected then
        raise exception
            'embedding is % dimensions, but kb.embedding_config says % (model %). Re-embed with the configured model, or update the config and alter the column.',
            actual, expected, (select model from kb.embedding_config where singleton);
    end if;

    return new;
end;
$$;

drop trigger if exists document_chunks_dimension_guard on kb.document_chunks;
create trigger document_chunks_dimension_guard
    before insert or update of embedding on kb.document_chunks
    for each row execute function kb.assert_embedding_dimension();

create table if not exists kb.ingest_jobs (
    id           uuid primary key default gen_random_uuid(),
    brand_id     uuid not null references kb.brands(id) on delete cascade,
    document_id  uuid references kb.documents(id) on delete cascade,
    kind         text not null check (kind in ('parse', 'chunk', 'embed', 'summarise', 'backfill')),
    payload      jsonb not null default '{}'::jsonb,
    status       text not null default 'queued'
                 check (status in ('queued', 'running', 'done', 'failed')),
    attempts     integer not null default 0,
    last_error   text,
    created_at   timestamptz not null default now(),
    started_at   timestamptz,
    finished_at  timestamptz
);

create index if not exists ingest_jobs_pending on kb.ingest_jobs (created_at) where status in ('queued', 'running');

comment on table kb.ingest_jobs is 'Spec section 40. Async ingestion: an upload returns as soon as the row lands, and the worker pass does the parsing, chunking and embedding.';

create or replace function kb.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists documents_touch on kb.documents;
create trigger documents_touch before update on kb.documents
    for each row execute function kb.touch_updated_at();

drop trigger if exists brands_touch on kb.brands;
create trigger brands_touch before update on kb.brands
    for each row execute function kb.touch_updated_at();

drop trigger if exists strategies_touch on kb.content_strategies;
create trigger strategies_touch before update on kb.content_strategies
    for each row execute function kb.touch_updated_at();;
