-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Three reads that were pulling far more than they needed.
 *
 * 1. The Plan page polls a link every two seconds while it is being read, and
 *    kb_link_read hands back the whole row — including a body that can be
 *    200,000 characters — which the Worker then throws away before replying.
 *    kb_link_status is the same row without the text.
 *
 * 2. Naming the recordings and links picked for a planning session was done by
 *    listing 200 rows and filtering in the Worker. These take the handful of
 *    ids and return only those. */

create or replace function public.kb_link_status(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(l) - 'body' - 'added_by' from kb.links l where l.id = p_id;
$$;

create or replace function public.kb_links_by_ids(p_ids uuid[])
returns table (id uuid, url text, kind text, status text, title text, site text, partial boolean)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select l.id, l.url, l.kind, l.status, l.title, l.site, l.partial
    from kb.links l
   where l.id = any(coalesce(p_ids, '{}'::uuid[]))
   limit 20;
$$;

create or replace function public.kb_recordings_by_ids(p_ids uuid[])
returns table (id uuid, name text, status text, words integer, seconds numeric)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select r.id, r.name, r.status, r.words, r.seconds
    from kb.recordings r
   where r.id = any(coalesce(p_ids, '{}'::uuid[]))
   limit 20;
$$;

grant execute on function public.kb_link_status(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_links_by_ids(uuid[]) to anon, authenticated, service_role;
grant execute on function public.kb_recordings_by_ids(uuid[]) to anon, authenticated, service_role;;
