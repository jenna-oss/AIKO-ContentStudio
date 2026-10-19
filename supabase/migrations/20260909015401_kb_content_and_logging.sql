create table if not exists kb.published_content (
    id                uuid primary key default gen_random_uuid(),
    brand_id          uuid not null references kb.brands(id) on delete cascade,
    title             text,
    topic             text not null,
    angle             text,
    hook              text,
    content_pillar_id uuid references kb.content_pillars(id) on delete set null,
    format            text,
    platform          text,
    published_at      timestamptz,
    transcript        text,
    performance       jsonb not null default '{}'::jsonb,
    embedding         extensions.vector(1024),
    metadata          jsonb not null default '{}'::jsonb,
    source_key        text not null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    tsv tsvector generated always as (
        to_tsvector('english',
            coalesce(title, '') || ' ' || topic || ' ' ||
            coalesce(angle, '') || ' ' || coalesce(hook, ''))
    ) stored
);

create unique index if not exists published_content_brand_source on kb.published_content (brand_id, source_key);
create index if not exists published_content_published on kb.published_content (brand_id, published_at desc nulls last);
create index if not exists published_content_platform on kb.published_content (brand_id, platform);
create index if not exists published_content_tsv on kb.published_content using gin (tsv);
create index if not exists published_content_embedding on kb.published_content using hnsw (embedding extensions.vector_cosine_ops);

comment on table kb.published_content is 'Spec section 10. What the brand has already put out. Retrieved for repetition detection, topic and angle history, and performance context — not as source material to quote.';
comment on column kb.published_content.performance is 'Free-form per platform. Empty for every row today; performance-aware ranking reads it and no-ops while it stays empty.';
comment on column kb.published_content.embedding is 'Embeds title + topic + angle + hook, not the transcript. Repetition detection asks whether the same argument was made, and the argument lives in the angle.';

create table if not exists kb.content_ideas (
    id           uuid primary key default gen_random_uuid(),
    brand_id     uuid not null references kb.brands(id) on delete cascade,
    topic        text not null,
    angle        text,
    hook         text,
    pillar_id    uuid references kb.content_pillars(id) on delete set null,
    source_type  text,
    source_id    uuid,
    source_ids   jsonb not null default '[]'::jsonb,
    status       text not null default 'unused'
                 check (status in ('unused', 'proposed', 'approved', 'used', 'rejected', 'archived')),
    session_id   text,
    embedding    extensions.vector(1024),
    metadata     jsonb not null default '{}'::jsonb,
    created_at   timestamptz not null default now(),
    used_at      timestamptz,
    tsv tsvector generated always as (
        to_tsvector('english', topic || ' ' || coalesce(angle, '') || ' ' || coalesce(hook, ''))
    ) stored
);

create index if not exists content_ideas_brand_status on kb.content_ideas (brand_id, status);
create index if not exists content_ideas_created on kb.content_ideas (brand_id, created_at desc);
create index if not exists content_ideas_tsv on kb.content_ideas using gin (tsv);
create index if not exists content_ideas_embedding on kb.content_ideas using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists content_ideas_sources on kb.content_ideas using gin (source_ids jsonb_path_ops);

comment on table kb.content_ideas is 'Spec sections 11 and 34. Idea memory, so a good idea raised in March is recoverable in September instead of being regenerated or lost.';

create table if not exists kb.hooks (
    id         uuid primary key default gen_random_uuid(),
    brand_id   uuid references kb.brands(id) on delete cascade,
    category   text not null,
    template   text not null,
    example    text,
    topics     text[] not null default '{}',
    origin     text not null default 'authored'
               check (origin in ('authored', 'hook_patterns', 'published', 'external')),
    origin_ref text,
    is_active  boolean not null default true,
    embedding  extensions.vector(1024),
    metadata   jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists hooks_category on kb.hooks (category) where is_active;
create index if not exists hooks_topics on kb.hooks using gin (topics);

comment on column kb.hooks.origin is 'authored = written for this brand. hook_patterns = adapted from the out-of-category Spyglass library, and must be described to the user as an adapted form, never as something a competitor ran.';

drop trigger if exists published_content_dimension_guard on kb.published_content;
create trigger published_content_dimension_guard
    before insert or update of embedding on kb.published_content
    for each row execute function kb.assert_embedding_dimension();

drop trigger if exists content_ideas_dimension_guard on kb.content_ideas;
create trigger content_ideas_dimension_guard
    before insert or update of embedding on kb.content_ideas
    for each row execute function kb.assert_embedding_dimension();

drop trigger if exists hooks_dimension_guard on kb.hooks;
create trigger hooks_dimension_guard
    before insert or update of embedding on kb.hooks
    for each row execute function kb.assert_embedding_dimension();

drop trigger if exists published_content_touch on kb.published_content;
create trigger published_content_touch before update on kb.published_content
    for each row execute function kb.touch_updated_at();

create table if not exists kb.retrieval_log (
    id           bigint generated always as identity primary key,
    brand_id     uuid references kb.brands(id) on delete cascade,
    session_id   text,
    tool         text not null,
    query        text,
    intent       text,
    filters      jsonb not null default '{}'::jsonb,
    result_ids   jsonb not null default '[]'::jsonb,
    result_count integer not null default 0,
    top_score    numeric(6,4),
    semantic_hits integer,
    keyword_hits  integer,
    latency_ms    integer,
    degraded     boolean not null default false,
    created_at   timestamptz not null default now()
);

create index if not exists retrieval_log_session on kb.retrieval_log (session_id, created_at desc);
create index if not exists retrieval_log_created on kb.retrieval_log (created_at desc);
create index if not exists retrieval_log_results on kb.retrieval_log using gin (result_ids jsonb_path_ops);

comment on table kb.retrieval_log is 'Spec section 38. Every retrieval operation. The point is debugging and the section 39 metrics, not analytics on the user.';
comment on column kb.retrieval_log.degraded is 'True when the semantic half was unavailable — no embedding key, or the provider failed — and the result is keyword-only. Without this flag a quietly halved retrieval looks identical to a working one.';;
