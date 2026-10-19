create table if not exists kb.document_summaries (
    id          uuid primary key default gen_random_uuid(),
    document_id uuid not null references kb.documents(id) on delete cascade,
    brand_id    uuid not null references kb.brands(id) on delete cascade,
    summary     text not null,
    key_points  jsonb not null default '[]'::jsonb,
    topics      text[] not null default '{}',
    model       text,
    embedding   extensions.vector(1024),
    created_at  timestamptz not null default now(),
    tsv tsvector generated always as (to_tsvector('english', summary)) stored
);

create unique index if not exists document_summaries_document on kb.document_summaries (document_id);
create index if not exists document_summaries_tsv on kb.document_summaries using gin (tsv);
create index if not exists document_summaries_topics on kb.document_summaries using gin (topics);
create index if not exists document_summaries_embedding on kb.document_summaries using hnsw (embedding extensions.vector_cosine_ops);

comment on table kb.document_summaries is 'Spec section 35. One summary per document, the first rung of the hierarchical ladder. An additional retrieval layer, never a replacement for the chunks.';

create table if not exists kb.topics (
    id          uuid primary key default gen_random_uuid(),
    brand_id    uuid not null references kb.brands(id) on delete cascade,
    name        text not null,
    description text,
    embedding   extensions.vector(1024),
    updated_at  timestamptz not null default now(),
    created_at  timestamptz not null default now()
);

create unique index if not exists topics_brand_name on kb.topics (brand_id, lower(name));
create index if not exists topics_embedding on kb.topics using hnsw (embedding extensions.vector_cosine_ops);

create table if not exists kb.topic_insights (
    id           uuid primary key default gen_random_uuid(),
    topic_id     uuid not null references kb.topics(id) on delete cascade,
    brand_id     uuid not null references kb.brands(id) on delete cascade,
    insight      text not null,
    supporting_chunk_ids jsonb not null default '[]'::jsonb,
    supporting_document_ids jsonb not null default '[]'::jsonb,
    confidence   numeric(3,2) check (confidence between 0 and 1),
    model        text,
    superseded_by uuid references kb.topic_insights(id) on delete set null,
    embedding    extensions.vector(1024),
    created_at   timestamptz not null default now(),
    tsv tsvector generated always as (to_tsvector('english', insight)) stored
);

create index if not exists topic_insights_topic on kb.topic_insights (topic_id) where superseded_by is null;
create index if not exists topic_insights_tsv on kb.topic_insights using gin (tsv);
create index if not exists topic_insights_sources on kb.topic_insights using gin (supporting_chunk_ids jsonb_path_ops);
create index if not exists topic_insights_embedding on kb.topic_insights using hnsw (embedding extensions.vector_cosine_ops);

comment on table kb.topic_insights is 'Spec section 35. One insight per row, each traceable to the chunks it came from. Superseded insights are kept and linked forward rather than deleted, so a plan written against an older reading stays explicable.';

drop trigger if exists document_summaries_dimension_guard on kb.document_summaries;
create trigger document_summaries_dimension_guard
    before insert or update of embedding on kb.document_summaries
    for each row execute function kb.assert_embedding_dimension();

drop trigger if exists topics_dimension_guard on kb.topics;
create trigger topics_dimension_guard
    before insert or update of embedding on kb.topics
    for each row execute function kb.assert_embedding_dimension();

drop trigger if exists topic_insights_dimension_guard on kb.topic_insights;
create trigger topic_insights_dimension_guard
    before insert or update of embedding on kb.topic_insights
    for each row execute function kb.assert_embedding_dimension();

create table if not exists kb.retrieval_settings (
    singleton                boolean primary key default true check (singleton),
    hierarchical_enabled     boolean not null default false,
    hierarchical_min_chunks  integer not null default 25000,
    performance_ranking_enabled boolean not null default false,
    context_budget_tokens    integer not null default 6000,
    max_chunk_tokens         integer not null default 900,
    repetition_duplicate_at  numeric(3,2) not null default 0.92,
    repetition_repetitive_at numeric(3,2) not null default 0.82,
    repetition_related_at    numeric(3,2) not null default 0.68,
    updated_at               timestamptz not null default now()
);

insert into kb.retrieval_settings (singleton) values (true) on conflict (singleton) do nothing;

comment on column kb.retrieval_settings.hierarchical_enabled is 'Off by default. Spec section 36: do not use hierarchical retrieval until the dataset warrants it. hierarchical_min_chunks records the size at which it is worth revisiting; nothing turns it on automatically.';
comment on column kb.retrieval_settings.performance_ranking_enabled is 'Off by default because kb.published_content.performance is empty. Turning it on with no performance data would rank every row identically while looking like it was doing something.';;
