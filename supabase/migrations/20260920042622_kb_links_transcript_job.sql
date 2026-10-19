-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* A transcript that has to be generated rather than fetched comes back as a
 * job, and can take minutes. The Worker cannot sit and wait for it — so the
 * job id is parked on the row, along with everything already known about the
 * video, and the page's own polling is what finishes it off.
 *
 * The body stored at this point is the fallback: the video's title, channel
 * and description, used if the job fails or is abandoned. */

alter table kb.links add column if not exists job_id text;

create or replace function public.kb_link_job(
  p_id uuid, p_job_id text, p_title text, p_site text,
  p_seconds integer, p_published timestamptz, p_body text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.links
     set job_id = left(coalesce(p_job_id, ''), 200),
         title = left(coalesce(p_title, ''), 400),
         site = left(coalesce(p_site, ''), 200),
         seconds = p_seconds,
         published_at = p_published,
         body = p_body,
         status = 'reading',
         updated_at = now()
   where id = p_id;
  return found;
end;
$$;

grant execute on function public.kb_link_job(uuid, text, text, text, integer, timestamptz, text) to anon, authenticated, service_role;;
