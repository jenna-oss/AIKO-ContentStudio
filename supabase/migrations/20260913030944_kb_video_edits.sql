-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Edits to finished videos, typed on the Output page.
--
-- A request is queued here, then the Worker starts the render workflow with
-- its id. The workflow marks it running, and its store job marks it done (with
-- the new version's render id) or failed. The edited video is a new
-- video_renders row for the same session and slot, so it replaces the card and
-- goes back to Ready to review.
--
-- The request endpoint is open by the user's choice (no token), so the limits
-- live here: 3 to 600 characters, one edit at a time per video, ten a day.
create table if not exists kb.video_edits (
  id uuid primary key default gen_random_uuid(),
  render_id uuid not null references kb.video_renders (id) on delete cascade,
  session_id text,
  slot integer,
  instruction text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  run_url text,
  result_render_id uuid references kb.video_renders (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists video_edits_slot_idx on kb.video_edits (session_id, slot, created_at desc);
create index if not exists video_edits_created_idx on kb.video_edits (created_at desc);

-- Reached only through the functions below.
alter table kb.video_edits enable row level security;
revoke all on kb.video_edits from anon, authenticated;

-- Everything needed to re-render a video (scenes, narration, clips, captions),
-- packed after each render by video/pack-source.sh. Private: nothing here is
-- for viewing, and only the workflow's service role reads or writes it.
insert into storage.buckets (id, name, public, file_size_limit)
values ('video-sources', 'video-sources', false, 524288000)
on conflict (id) do nothing;

-- Queue an edit. Business-rule failures come back as {ok:false, error} rather
-- than exceptions, so the page can show the reason as written.
create or replace function public.kb_video_request_edit(p_render_id uuid, p_instruction text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_text text := btrim(coalesce(p_instruction, ''));
  v_render kb.video_renders%rowtype;
  v_id uuid;
begin
  if char_length(v_text) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Say what should change.');
  end if;
  if char_length(v_text) > 600 then
    return jsonb_build_object('ok', false, 'error', 'Keep the change request under 600 characters.');
  end if;

  select * into v_render from kb.video_renders where id = p_render_id and status = 'rendered';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That video isn''t finished, so it can''t be edited.');
  end if;

  -- An edit older than three hours that never finished is treated as dead.
  if exists (
    select 1 from kb.video_edits e
     where e.session_id is not distinct from v_render.session_id
       and e.slot is not distinct from v_render.slot
       and e.status in ('queued', 'running')
       and e.created_at > now() - interval '3 hours'
  ) then
    return jsonb_build_object('ok', false, 'error', 'This video already has an edit in progress. Wait for it to finish.');
  end if;

  if (select count(*) from kb.video_edits where created_at > now() - interval '24 hours') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'The limit of 10 edits a day has been reached. Try again tomorrow.');
  end if;

  insert into kb.video_edits (render_id, session_id, slot, instruction)
  values (v_render.id, v_render.session_id, v_render.slot, v_text)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;

-- The Worker could not start the workflow. Only a fresh queued edit can be
-- abandoned, so this cannot be used to fail someone else's running edit.
create or replace function public.kb_video_edit_abandon(p_edit_id uuid, p_error text)
returns void
language sql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  update kb.video_edits
     set status = 'failed',
         error = left(coalesce(p_error, 'the edit could not start'), 300),
         updated_at = now()
   where id = p_edit_id
     and status = 'queued'
     and created_at > now() - interval '10 minutes';
$function$;

-- Workflow only: claim a queued edit and get what the run needs.
create or replace function public.kb_video_edit_start(p_edit_id uuid, p_run_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_edit kb.video_edits%rowtype;
  v_render kb.video_renders%rowtype;
  v_slot jsonb;
  v_goal text;
begin
  update kb.video_edits
     set status = 'running', run_url = left(p_run_url, 300), updated_at = now()
   where id = p_edit_id
     and status = 'queued'
  returning * into v_edit;
  if not found then
    raise exception 'edit % is not waiting to start', p_edit_id;
  end if;

  select * into v_render from kb.video_renders where id = v_edit.render_id;
  select s.slots -> (v_render.slot - 1), s.goal
    into v_slot, v_goal
    from kb.planning_sessions s
   where s.id = v_render.session_id;

  return jsonb_build_object(
    'edit_id', v_edit.id,
    'instruction', v_edit.instruction,
    'render_id', v_render.id,
    'session_id', v_render.session_id,
    'slot', v_render.slot,
    'topic', coalesce(nullif(v_slot ->> 'topic', ''), split_part(v_render.topic, E'\n', 1)),
    'source_path', v_render.metadata ->> 'source_path',
    'goal', v_goal,
    'plan_slot', coalesce(v_slot, '{}'::jsonb)
  );
end;
$function$;

-- Workflow only: record how an edit ended.
create or replace function public.kb_video_edit_finish(
  p_edit_id uuid, p_status text, p_error text default null, p_result_render_id uuid default null
)
returns void
language sql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  update kb.video_edits
     set status = case when p_status in ('done', 'failed') then p_status else 'failed' end,
         error = left(p_error, 500),
         result_render_id = p_result_render_id,
         updated_at = now()
   where id = p_edit_id;
$function$;

-- The library grows two columns: whether the video's source was kept (an exact
-- edit is possible) and how the latest edit of that slot went.
drop function if exists public.kb_video_library(integer);

create function public.kb_video_library(p_limit integer default 60)
returns table (
  id uuid,
  session_id text,
  slot integer,
  topic text,
  hook text,
  angle text,
  product text,
  audience text,
  storage_path text,
  duration_seconds numeric,
  rendered_at timestamptz,
  review_status text,
  reviewed_at timestamptz,
  has_source boolean,
  last_edit jsonb
)
language sql
stable
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select latest.*,
    (select jsonb_build_object(
              'status', e.status,
              'instruction', e.instruction,
              'error', e.error,
              'created_at', e.created_at,
              'in_progress', e.status in ('queued', 'running') and e.created_at > now() - interval '3 hours')
       from kb.video_edits e
      where e.session_id is not distinct from latest.session_id
        and e.slot is not distinct from latest.slot
      order by e.created_at desc
      limit 1)
  from (
    select distinct on (r.session_id, r.slot)
      r.id,
      r.session_id,
      r.slot,
      coalesce(nullif(s.slots -> (r.slot - 1) ->> 'topic', ''), split_part(r.topic, E'\n', 1)),
      coalesce(s.slots -> (r.slot - 1) ->> 'hook', s.slots -> (r.slot - 1) ->> 'opening_line'),
      s.slots -> (r.slot - 1) ->> 'angle',
      s.slots -> (r.slot - 1) ->> 'product',
      s.slots -> (r.slot - 1) ->> 'audience',
      r.storage_path,
      r.duration_seconds,
      r.rendered_at,
      r.review_status,
      r.reviewed_at,
      (r.metadata ? 'source_path')
    from kb.video_renders r
    left join kb.planning_sessions s on s.id = r.session_id
    where r.status = 'rendered'
      and r.storage_path is not null
    order by r.session_id, r.slot, r.rendered_at desc
  ) latest
  order by latest.rendered_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
$function$;

-- Supabase grants new public functions to anon by default, so every one is set
-- explicitly: the page-facing three to anon, the workflow's two to the service
-- role only.
revoke all on function public.kb_video_library(integer) from public, anon, authenticated;
grant execute on function public.kb_video_library(integer) to anon, authenticated, service_role;
revoke all on function public.kb_video_request_edit(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_video_request_edit(uuid, text) to anon, authenticated, service_role;
revoke all on function public.kb_video_edit_abandon(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_video_edit_abandon(uuid, text) to anon, authenticated, service_role;
revoke all on function public.kb_video_edit_start(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_video_edit_start(uuid, text) to service_role;
revoke all on function public.kb_video_edit_finish(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.kb_video_edit_finish(uuid, text, text, uuid) to service_role;;
