-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

drop function if exists public.kb_clip_edit_done(uuid, jsonb, text, bigint);
create or replace function public.kb_clip_edit_done(p_id uuid, p_words jsonb, p_url text, p_bytes bigint, p_hook text default null)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  update kb.clips
     set start_s = (edit ->> 'start_s')::numeric,
         end_s = (edit ->> 'end_s')::numeric,
         cuts = coalesce(edit -> 'cuts', '[]'::jsonb),
         fixes = coalesce(edit -> 'fixes', '[]'::jsonb),
         words = coalesce(p_words, words),
         hook = coalesce(nullif(btrim(p_hook), ''), hook),
         url = coalesce(p_url, url), bytes = coalesce(p_bytes, bytes),
         edit_status = 'done', edit_error = null, edits = edits + 1, updated_at = now()
   where id = p_id and edit is not null;
  return found;
end $$;
revoke all on function public.kb_clip_edit_done(uuid, jsonb, text, bigint, text) from public;
grant execute on function public.kb_clip_edit_done(uuid, jsonb, text, bigint, text) to service_role;;
