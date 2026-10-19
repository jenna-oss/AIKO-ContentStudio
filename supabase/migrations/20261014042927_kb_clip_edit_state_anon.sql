-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

grant execute on function public.kb_clip_edit_state(uuid, text, text) to anon;;
