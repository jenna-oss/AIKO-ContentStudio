-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- One row per press of Render on the Plan page. It is both the once-per-plan
-- guard and the ledger for the daily cap, so a start that failed still counts.
create table if not exists kb.plan_renders (
  id uuid primary key default gen_random_uuid(),
  session_id text not null references kb.planning_sessions(id) on delete cascade,
  video_count integer not null check (video_count between 1 and 12),
  status text not null default 'requested' check (status in ('requested', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists plan_renders_session_idx on kb.plan_renders (session_id);
create index if not exists plan_renders_created_idx on kb.plan_renders (created_at);
-- No policies: reachable only through the two functions below.
alter table kb.plan_renders enable row level security;

-- Called by the Worker when someone presses Render. The page is open, so the
-- limits live here: the plan must be complete, each plan is sent once, and no
-- more than 12 videos a day.
create or replace function public.kb_plan_request_render(p_session_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare
  v_plan kb.planning_sessions%rowtype;
  v_count integer;
  v_today integer;
  v_id uuid;
begin
  if p_session_id is null or btrim(p_session_id) = '' or length(p_session_id) > 64 then
    return jsonb_build_object('ok', false, 'error', 'That plan wasn''t found.');
  end if;

  select * into v_plan from kb.planning_sessions where id = p_session_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That plan wasn''t saved yet. Send one more message, then try again.');
  end if;

  v_count := v_plan.target_count;
  if v_count is null
     or jsonb_array_length(v_plan.slots) <> v_count
     or exists (
       select 1 from jsonb_array_elements(v_plan.slots) e
        where coalesce(e ->> 'status', '') <> 'locked'
           or coalesce(btrim(e ->> 'topic'), '') = ''
     ) then
    return jsonb_build_object('ok', false, 'error', 'Every video needs a locked topic before rendering.');
  end if;

  if exists (select 1 from kb.plan_renders where session_id = p_session_id and status = 'requested') then
    return jsonb_build_object('ok', false, 'already', true,
      'error', 'This plan was already sent to render. Start a new plan for a different set.');
  end if;

  select coalesce(sum(video_count), 0) into v_today
    from kb.plan_renders where created_at > now() - interval '24 hours';
  if v_today + v_count > 12 then
    return jsonb_build_object('ok', false,
      'error', format('That would pass the limit of 12 videos a day (%s already sent today). Try again tomorrow.', v_today));
  end if;

  insert into kb.plan_renders (session_id, video_count)
  values (p_session_id, v_count)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'count', v_count);
end;
$$;

-- When GitHub won't start the run. The plan can then be sent again, but the
-- attempt keeps counting toward the day's cap, so starting and abandoning
-- can't be used to get past it.
create or replace function public.kb_plan_render_abandon(p_request_id uuid, p_error text)
returns void
language sql
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  update kb.plan_renders
     set status = 'failed', error = left(p_error, 300)
   where id = p_request_id
     and status = 'requested'
     and created_at > now() - interval '10 minutes';
$$;

revoke all on function public.kb_plan_request_render(text) from public;
revoke all on function public.kb_plan_render_abandon(uuid, text) from public;
grant execute on function public.kb_plan_request_render(text) to anon, service_role;
grant execute on function public.kb_plan_render_abandon(uuid, text) to anon, service_role;;
