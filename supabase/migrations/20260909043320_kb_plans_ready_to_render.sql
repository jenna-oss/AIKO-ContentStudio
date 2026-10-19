-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Plans whose every slot is locked — the ones ready to become videos.
--
-- The render job reads briefs from here rather than from a file committed to
-- the repo. Two reasons, and the second is the one that matters: a committed
-- briefs file means someone hand-copies JSON between the planner and the
-- pipeline, which is the manual step the whole "trigger from the planning
-- phase" idea exists to remove. It also keeps next week's plan out of a public
-- git history as a side effect.
--
-- service_role only. kb_plan_load is addressable by id and safe to expose,
-- because guessing an id is the barrier; a function that ENUMERATES plans has
-- no such barrier, so anon must not reach it.
create or replace function public.kb_plans_ready(p_session_id text default null)
returns table (
    session_id   text,
    goal         text,
    target_count integer,
    slots        jsonb,
    updated_at   timestamptz
)
language sql
stable
security definer
set search_path = kb, public, extensions
as $fn$
    select s.id, s.goal, s.target_count, s.slots, s.updated_at
    from kb.planning_sessions s
    where (p_session_id is null or s.id = p_session_id)
      and s.target_count is not null
      and jsonb_array_length(s.slots) = s.target_count
      -- every slot locked, and none of them empty
      and not exists (
        select 1 from jsonb_array_elements(s.slots) e
        where coalesce(e ->> 'status', '') <> 'locked'
           or coalesce(btrim(e ->> 'topic'), '') = ''
      )
    order by s.updated_at desc
    limit 5;
$fn$;

comment on function public.kb_plans_ready is
  'Planning sessions with every slot locked, newest first. Read by the render '
  'job so briefs travel from the planner to the pipeline without anyone copying '
  'a file. service_role only: this one enumerates, and an id is the only thing '
  'protecting a plan.';

revoke execute on function public.kb_plans_ready(text) from public, anon, authenticated;
grant execute on function public.kb_plans_ready(text) to service_role;
alter function public.kb_plans_ready(text) set search_path = kb, public, extensions, pg_catalog;;
