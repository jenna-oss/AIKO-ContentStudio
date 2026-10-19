-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- RLS on every kb table, matching the convention already used by adspy and
-- content: the schema is never exposed over PostgREST, reads go through
-- SECURITY INVOKER wrappers in public so the policies stay in the path, and
-- the corpus itself is writable only by service_role.
--
-- Two deliberate exceptions to "anon reads, service_role writes":
--   * retrieval_log — anon may INSERT (every search logs itself) but may not
--     SELECT. A log anon could read back is a log of everyone's planning.
--   * content_ideas — anon may INSERT and UPDATE. Idea memory is written during
--     a planning session by the Worker, which holds the anon key. The harvested
--     corpus stays read-only; the scratchpad does not need to be.
-- ---------------------------------------------------------------------------

alter table kb.brands             enable row level security;
alter table kb.content_strategies enable row level security;
alter table kb.content_pillars    enable row level security;
alter table kb.documents          enable row level security;
alter table kb.document_chunks    enable row level security;
alter table kb.published_content  enable row level security;
alter table kb.content_ideas      enable row level security;
alter table kb.hooks              enable row level security;
alter table kb.document_summaries enable row level security;
alter table kb.topics             enable row level security;
alter table kb.topic_insights     enable row level security;
alter table kb.retrieval_log      enable row level security;
alter table kb.ingest_jobs        enable row level security;
alter table kb.embedding_config   enable row level security;
alter table kb.ranking_weights    enable row level security;
alter table kb.recency_curve      enable row level security;
alter table kb.recency_profile    enable row level security;
alter table kb.retrieval_settings enable row level security;

do $do$
declare t text;
begin
  foreach t in array array[
    'brands','content_strategies','content_pillars','documents','document_chunks',
    'published_content','content_ideas','hooks','document_summaries','topics',
    'topic_insights','embedding_config','ranking_weights','recency_curve',
    'recency_profile','retrieval_settings'
  ] loop
    execute format('drop policy if exists %I on kb.%I', t || '_read', t);
    execute format(
      'create policy %I on kb.%I for select to anon, authenticated using (true)',
      t || '_read', t);
  end loop;
end
$do$;

drop policy if exists retrieval_log_insert on kb.retrieval_log;
create policy retrieval_log_insert on kb.retrieval_log
    for insert to anon, authenticated with check (true);

drop policy if exists content_ideas_insert on kb.content_ideas;
create policy content_ideas_insert on kb.content_ideas
    for insert to anon, authenticated with check (true);

drop policy if exists content_ideas_update on kb.content_ideas;
create policy content_ideas_update on kb.content_ideas
    for update to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- Privileges. kb is NOT added to PostgREST's exposed schemas; USAGE is granted
-- only so the SECURITY INVOKER wrappers in public can reach through it.
-- ---------------------------------------------------------------------------

grant usage on schema kb to anon, authenticated, service_role;

grant select on
    kb.brands, kb.content_strategies, kb.content_pillars,
    kb.documents, kb.document_chunks, kb.published_content,
    kb.content_ideas, kb.hooks, kb.document_summaries,
    kb.topics, kb.topic_insights, kb.embedding_config,
    kb.ranking_weights, kb.recency_curve, kb.recency_profile,
    kb.retrieval_settings
to anon, authenticated;

grant insert on kb.retrieval_log to anon, authenticated;
grant usage, select on sequence kb.retrieval_log_id_seq to anon, authenticated;
grant insert, update on kb.content_ideas to anon, authenticated;

grant all on all tables in schema kb to service_role;
grant all on all sequences in schema kb to service_role;

-- ---------------------------------------------------------------------------
-- Public wrappers — the only doors into kb.
--
-- Every wrapper takes the query embedding as TEXT and casts it here rather than
-- declaring a vector parameter. PostgREST serialises arguments as JSON, and a
-- 1024-float vector round-trips reliably as the string '[0.1,0.2,...]' where a
-- custom-type parameter does not.
-- ---------------------------------------------------------------------------

create or replace function public.kb_search_transcripts(
    p_brand_id uuid, p_query text default null, p_embedding text default null,
    p_date_from date default null, p_date_to date default null,
    p_content_type text default null, p_intent text default 'SUPPORT',
    p_limit integer default 5
)
returns table (
    chunk_id uuid, document_id uuid, source_type text, title text, source text,
    source_url text, published_at timestamptz, speaker text,
    timestamp_start integer, timestamp_end integer, content text,
    relevance numeric, metadata jsonb
)
language sql stable security invoker
as $fn$
    select * from kb.search_transcripts(
        p_brand_id, p_query,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_date_from, p_date_to, p_content_type, p_intent, p_limit);
$fn$;

create or replace function public.kb_search_research(
    p_brand_id uuid, p_query text default null, p_embedding text default null,
    p_date_from date default null, p_date_to date default null,
    p_source text default null, p_intent text default 'SUPPORT',
    p_limit integer default 5
)
returns table (
    chunk_id uuid, document_id uuid, source_type text, title text, source text,
    source_url text, published_at timestamptz, research_type text,
    excerpt text, relevance numeric, metadata jsonb
)
language sql stable security invoker
as $fn$
    select * from kb.search_research(
        p_brand_id, p_query,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_date_from, p_date_to, p_source, p_intent, p_limit);
$fn$;

create or replace function public.kb_search_previous_content(
    p_brand_id uuid, p_query text default null, p_embedding text default null,
    p_date_from date default null, p_date_to date default null,
    p_platform text default null, p_intent text default 'REPETITION',
    p_limit integer default 10
)
returns table (
    id uuid, title text, topic text, angle text, hook text, format text,
    platform text, published_at timestamptz, performance jsonb,
    relevance numeric, semantic numeric, keyword numeric, source_key text
)
language sql stable security invoker
as $fn$
    select * from kb.search_previous_content(
        p_brand_id, p_query,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_date_from, p_date_to, p_platform, p_intent, p_limit);
$fn$;

create or replace function public.kb_search_content_ideas(
    p_brand_id uuid, p_query text default null, p_embedding text default null,
    p_status text default 'unused', p_limit integer default 10
)
returns table (
    id uuid, topic text, angle text, hook text, status text,
    source_ids jsonb, created_at timestamptz, relevance numeric
)
language sql stable security invoker
as $fn$
    select * from kb.search_content_ideas(
        p_brand_id, p_query,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_status, p_limit);
$fn$;

create or replace function public.kb_search_hooks(
    p_brand_id uuid default null, p_topic text default null,
    p_category text default null, p_limit integer default 10
)
returns table (
    id uuid, category text, template text, example text,
    topics text[], origin text, origin_ref text
)
language sql stable security invoker
as $fn$
    select * from kb.search_hooks(p_brand_id, p_topic, p_category, p_limit);
$fn$;

create or replace function public.kb_assess_repetition(
    p_brand_id uuid, p_embedding text default null,
    p_topic text default null, p_angle text default null,
    p_limit integer default 5
)
returns table (assessment text, top_similarity numeric, matches jsonb)
language sql stable security invoker
as $fn$
    select * from kb.assess_repetition(
        p_brand_id,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_topic, p_angle, p_limit);
$fn$;

create or replace function public.kb_retrieve(
    p_brand_id uuid, p_query text default null, p_embedding text default null,
    p_scope text[] default array['transcripts','research','published'],
    p_intent text default 'DISCOVERY', p_limit integer default 5,
    p_budget_tokens integer default null,
    p_date_from date default null, p_date_to date default null,
    p_session_id text default null
)
returns jsonb
language sql volatile security invoker
as $fn$
    select kb.retrieve(
        p_brand_id, p_query,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_scope, p_intent, p_limit, p_budget_tokens, p_date_from, p_date_to, p_session_id);
$fn$;

create or replace function public.kb_save_idea(
    p_brand_id uuid, p_topic text, p_angle text default null,
    p_hook text default null, p_source_ids jsonb default '[]'::jsonb,
    p_source_type text default 'planning_session',
    p_status text default 'unused', p_session_id text default null,
    p_embedding text default null, p_metadata jsonb default '{}'::jsonb
)
returns uuid
language sql volatile security invoker
as $fn$
    select kb.save_idea(
        p_brand_id, p_topic, p_angle, p_hook, p_source_ids, p_source_type,
        p_status, p_session_id,
        nullif(btrim(coalesce(p_embedding, '')), '')::extensions.vector(1024),
        p_metadata);
$fn$;

create or replace function public.kb_strategy(p_brand_slug text default 'aiko')
returns jsonb
language sql stable security invoker
as $fn$
    select jsonb_build_object(
        'brand', to_jsonb(b) - 'id',
        'brand_id', b.id,
        'strategy', coalesce((
            select to_jsonb(s) - 'id' - 'brand_id'
            from kb.content_strategies s
            where s.brand_id = b.id and s.is_current), 'null'::jsonb),
        'pillars', coalesce((
            select jsonb_agg(jsonb_build_object(
                     'name', p.name, 'description', p.description, 'priority', p.priority)
                   order by p.priority)
            from kb.content_pillars p
            where p.brand_id = b.id and p.is_active), '[]'::jsonb)
    )
    from kb.brands b
    where b.slug = p_brand_slug;
$fn$;

comment on function public.kb_strategy is 'Spec section 4A. Stable structured context, returned whole rather than retrieved. Strategy and pillars are empty today; the shape is stable so the planner can read it either way.';

grant execute on function
    public.kb_search_transcripts(uuid, text, text, date, date, text, text, integer),
    public.kb_search_research(uuid, text, text, date, date, text, text, integer),
    public.kb_search_previous_content(uuid, text, text, date, date, text, text, integer),
    public.kb_search_content_ideas(uuid, text, text, text, integer),
    public.kb_search_hooks(uuid, text, text, integer),
    public.kb_assess_repetition(uuid, text, text, text, integer),
    public.kb_retrieve(uuid, text, text, text[], text, integer, integer, date, date, text),
    public.kb_save_idea(uuid, text, text, text, jsonb, text, text, text, text, jsonb),
    public.kb_strategy(text)
to anon, authenticated, service_role;;
