-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Only an edit that is still waiting or running can be given an outcome.
-- Re-running an edit's workflow from GitHub fails at the start (the edit is no
-- longer queued), and that failure used to overwrite a finished edit's "done".
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
   where id = p_edit_id
     and status in ('queued', 'running');
$function$;

revoke all on function public.kb_video_edit_finish(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.kb_video_edit_finish(uuid, text, text, uuid) to service_role;;
