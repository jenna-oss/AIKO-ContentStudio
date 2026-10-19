-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Review decisions replace "posted". A finished video is ready to review until
-- someone decides: to_post or rejected. Either decision can be changed later,
-- in either direction, so rejected videos stay visible rather than being
-- deleted. There is no separate "posted" state any more.
alter table kb.video_renders
  add column if not exists review_status text,
  add column if not exists reviewed_at timestamptz;

alter table kb.video_renders drop constraint if exists video_renders_review_status_check;
alter table kb.video_renders add constraint video_renders_review_status_check
  check (review_status is null or review_status in ('to_post', 'rejected'));

-- Anything already marked posted was approved; carry it over before the column goes.
update kb.video_renders
   set review_status = 'to_post', reviewed_at = posted_at
 where posted_at is not null
   and review_status is null;

drop function if exists public.kb_video_set_posted(uuid, boolean);
drop function if exists public.kb_video_library(integer);
alter table kb.video_renders drop column if exists posted_at;

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
  reviewed_at timestamptz
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
      r.review_status,
      r.reviewed_at
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

-- Record a decision on a finished video. Anon-callable like the kb_upload_*
-- functions: the Worker gates it behind the team token, and the most it can do
-- is set one of two values on a row that already rendered. reviewed_at moves
-- only when the decision actually changes.
create function public.kb_video_set_review(p_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_status text;
  v_at timestamptz;
  v_found boolean;
begin
  if p_status is null or p_status not in ('to_post', 'rejected') then
    raise exception 'status must be to_post or rejected';
  end if;

  update kb.video_renders
     set review_status = p_status,
         reviewed_at = case when review_status is distinct from p_status then now() else reviewed_at end
   where id = p_id
     and status = 'rendered'
  returning review_status, reviewed_at into v_status, v_at;
  v_found := found;

  return jsonb_build_object('found', v_found, 'review_status', v_status, 'reviewed_at', v_at);
end;
$function$;

revoke all on function public.kb_video_set_review(uuid, text) from public;
grant execute on function public.kb_video_set_review(uuid, text) to anon, authenticated;;
