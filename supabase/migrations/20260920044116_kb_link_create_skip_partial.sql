-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Pasting a link again should hand back the read we already have — but only if
 * it was a real one. A partial read is a video whose words we could not get:
 * caching that means the paste after the transcript service was wired up
 * returned the description again and never asked anyone for the transcript,
 * which is exactly what happened the first time this shipped. */

create or replace function public.kb_link_create(p_url text, p_canonical text, p_kind text, p_email text)
returns jsonb
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v_row kb.links; v_id uuid;
begin
  if btrim(coalesce(p_url, '')) = '' then raise exception 'a link needs a url'; end if;

  select * into v_row from kb.links
   where canonical_url = p_canonical
     and status = 'ready'
     and partial = false
     and created_at > now() - interval '30 days'
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'kind', v_row.kind,
                              'title', v_row.title, 'site', v_row.site, 'partial', v_row.partial,
                              'reused', true);
  end if;

  insert into kb.links (url, canonical_url, kind, added_by)
  values (left(btrim(p_url), 2000), left(btrim(p_canonical), 2000),
          coalesce(nullif(p_kind, ''), 'article'), left(coalesce(p_email, ''), 254))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'status', 'reading', 'kind', coalesce(nullif(p_kind, ''), 'article'),
                            'reused', false);
end;
$$;

grant execute on function public.kb_link_create(text, text, text, text) to anon, authenticated, service_role;;
