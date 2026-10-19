-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- The finished-video library for the Output page, reached by the Worker with
-- the anon key. Only renders marked 'rendered' with a stored file, and only the
-- newest per (session, slot), so a re-render replaces a card rather than adding
-- one. Failed rows, error text and run URLs stay out: this is a viewing surface,
-- not a log.
--
-- The title and opening line come from the plan slot where there is one. Early
-- render rows stored the whole flattened brief as `topic`; the first line of it
-- is the fallback.
create or replace function public.kb_video_library(p_limit integer default 60)
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
  rendered_at timestamptz
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
      r.rendered_at
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
grant execute on function public.kb_video_library(integer) to anon, authenticated;;
