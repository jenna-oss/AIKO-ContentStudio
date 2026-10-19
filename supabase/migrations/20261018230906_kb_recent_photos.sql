-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- The library photos the newest videos used, newest video first, for
-- render-videos.yml: a new render leaves out the photos used recently. Each
-- row is one video's metadata.photos (opening photo first), recorded by the
-- store job since 2026-10-18; videos from before then have none and are skipped.
create or replace function public.kb_recent_photos(p_videos integer default 12)
returns table(rendered_at timestamptz, photos jsonb)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select r.rendered_at, r.metadata -> 'photos'
    from kb.video_renders r
   where r.status = 'rendered'
     and jsonb_typeof(r.metadata -> 'photos') = 'array'
   order by r.rendered_at desc
   limit least(greatest(coalesce(p_videos, 12), 1), 50);
$$;
revoke all on function public.kb_recent_photos(integer) from public, anon, authenticated;
grant execute on function public.kb_recent_photos(integer) to service_role;;
