-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

create or replace function public.kb_plans_recent(p_limit integer default 8)
returns table(id text, goal text, slots integer, status text, rendered integer, updated_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select s.id,
         coalesce(nullif(btrim(s.goal), ''), s.slots -> 0 ->> 'topic', 'Untitled plan'),
         jsonb_array_length(coalesce(s.slots, '[]'::jsonb)), s.status,
         (select count(distinct r.slot)::int from kb.video_renders r where r.session_id = s.id and r.status = 'rendered'),
         s.updated_at
    from kb.planning_sessions s
   where jsonb_array_length(coalesce(s.slots, '[]'::jsonb)) > 0
   order by s.updated_at desc
   limit least(greatest(coalesce(p_limit, 8), 1), 50);
$$;
revoke all on function public.kb_plans_recent(integer) from public;
grant execute on function public.kb_plans_recent(integer) to anon, service_role;;
