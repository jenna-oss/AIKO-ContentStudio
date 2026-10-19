-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Review state for finished videos, for the Output page's two tabs. A video is
-- "ready to review" until someone marks it posted; posted_at is when they did.
-- One nullable column rather than a status enum: there are two states, and the
-- date is the thing worth keeping.
alter table kb.video_renders add column if not exists posted_at timestamptz;

-- The return type grows a column, which create or replace cannot do.
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
  posted_at timestamptz
)
language sql
stable
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select latest.*
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
      r.posted_at
    from kb.video_renders r
    left join kb.planning_sessions s on s.id = r.session_id
    where r.status = 'rendered'
      and r.storage_path is not null
    order by r.session_id, r.slot, r.rendered_at desc
  ) latest
  order by latest.rendered_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
$function$;

revoke all on function public.kb_video_library(integer) from public;
grant execute on function public.kb_video_library(integer) to anon, authenticated;

-- Mark a finished video posted, or move it back to review. Anon-callable like
-- the kb_upload_* functions: the Worker gates it behind the team token, and the
-- most this can do is flip the date on a row that already rendered. Marking an
-- already-posted video keeps its original date.
create or replace function public.kb_video_set_posted(p_id uuid, p_posted boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_posted timestamptz;
  v_found boolean;
begin
  update kb.video_renders
     set posted_at = case when p_posted then coalesce(posted_at, now()) else null end
   where id = p_id
     and status = 'rendered'
  returning posted_at into v_posted;
  v_found := found;
  return jsonb_build_object('found', v_found, 'posted_at', v_posted);
end;
$function$;

revoke all on function public.kb_video_set_posted(uuid, boolean) from public;
grant execute on function public.kb_video_set_posted(uuid, boolean) to anon, authenticated;;
