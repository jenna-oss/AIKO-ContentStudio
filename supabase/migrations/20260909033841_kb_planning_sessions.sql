-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- ---------------------------------------------------------------------------
-- Planning sessions.
--
-- Spec section 4D keeps session context out of the retrieval corpus, and it
-- stays out: nothing here is embedded, chunked, or reachable from any search
-- tool. But "not retrieved against" is not the same as "not stored", and
-- carrying the plan only in localStorage meant a week's agreed work lived in
-- one browser on one machine. A cleared cache lost it and nobody else could
-- pick it up.
--
-- Read and written by id only. anon gets no table grants — enumeration would
-- turn a guessable id into everyone's plan — so the two definer functions
-- below are the entire surface.
-- ---------------------------------------------------------------------------

create table if not exists kb.planning_sessions (
    id           text primary key,
    brand_id     uuid not null references kb.brands(id) on delete cascade,

    goal         text,
    target_count integer check (target_count between 1 and 12),
    slots        jsonb not null default '[]'::jsonb,
    rejected     jsonb not null default '[]'::jsonb,

    status       text not null default 'active'
                 check (status in ('active', 'exported', 'abandoned')),

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists planning_sessions_brand on kb.planning_sessions (brand_id, updated_at desc);

comment on table kb.planning_sessions is
  'Spec section 4D. The current weekly goal, the number of videos, what is '
  'locked and what was rejected. Never retrieved against — no embedding, no '
  'search function reads it. Addressed by id and nothing else.';

alter table kb.planning_sessions enable row level security;
-- No policy and no grant: only service_role, which bypasses RLS, and the
-- SECURITY DEFINER functions below can reach it.

drop trigger if exists planning_sessions_touch on kb.planning_sessions;
create trigger planning_sessions_touch before update on kb.planning_sessions
    for each row execute function kb.touch_updated_at();

create or replace function public.kb_plan_load(p_session_id text)
returns jsonb
language sql
stable
security definer
set search_path = kb, public, extensions
as $fn$
    select jsonb_build_object(
        'goal', s.goal,
        'target_count', s.target_count,
        'slots', s.slots,
        'rejected', s.rejected,
        'updated_at', s.updated_at)
    from kb.planning_sessions s
    where s.id = p_session_id;
$fn$;

create or replace function public.kb_plan_save(p_session_id text, payload jsonb)
returns void
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare v_brand uuid;
begin
    if p_session_id is null or btrim(p_session_id) = '' then return; end if;
    if length(p_session_id) > 64 then
        raise exception 'session id is too long';
    end if;

    v_brand := (select id from kb.brands where slug = coalesce(payload ->> 'brand_slug', 'aiko'));
    if v_brand is null then return; end if;

    insert into kb.planning_sessions (id, brand_id, goal, target_count, slots, rejected)
    values (
        p_session_id, v_brand,
        left(payload ->> 'goal', 300),
        nullif(payload ->> 'target_count', '')::integer,
        coalesce(payload -> 'slots', '[]'::jsonb),
        coalesce(payload -> 'rejected', '[]'::jsonb)
    )
    on conflict (id) do update set
        goal = excluded.goal,
        target_count = excluded.target_count,
        slots = excluded.slots,
        rejected = excluded.rejected;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Bulk retrieval logging.
--
-- Spec section 38 asks for every retrieval operation to be logged, and it was
-- not happening: the logging lived inside kb.retrieve(), which the agent never
-- calls — it uses the seven per-corpus tools directly. So a whole planning
-- session left no trace and the section 39 metrics had nothing to measure.
--
-- Written once per turn rather than once per search: a round trip per tool call
-- would add latency to the thing the user is waiting for, and the log is not
-- worth that.
-- ---------------------------------------------------------------------------
create or replace function public.kb_log_retrievals(payload jsonb)
returns integer
language plpgsql
security invoker
as $fn$
declare n integer;
begin
    insert into kb.retrieval_log (
        brand_id, session_id, tool, query, intent, filters,
        result_ids, result_count, top_score, latency_ms, degraded
    )
    select
        (e ->> 'brand_id')::uuid,
        left(e ->> 'session_id', 64),
        left(coalesce(e ->> 'tool', 'unknown'), 64),
        e ->> 'query',
        left(e ->> 'intent', 32),
        coalesce(e -> 'filters', '{}'::jsonb),
        coalesce(e -> 'result_ids', '[]'::jsonb),
        coalesce((e ->> 'result_count')::integer, 0),
        (e ->> 'top_score')::numeric,
        (e ->> 'latency_ms')::integer,
        coalesce((e ->> 'degraded')::boolean, false)
    from jsonb_array_elements(payload) e
    limit 100;

    get diagnostics n = row_count;
    return n;
end;
$fn$;

grant execute on function public.kb_plan_load(text) to anon, authenticated, service_role;
grant execute on function public.kb_plan_save(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.kb_log_retrievals(jsonb) to anon, authenticated, service_role;

alter function public.kb_plan_load(text) set search_path = kb, public, extensions, pg_catalog;
alter function public.kb_plan_save(text, jsonb) set search_path = kb, public, extensions, pg_catalog;
alter function public.kb_log_retrievals(jsonb) set search_path = kb, public, extensions, pg_catalog;;
