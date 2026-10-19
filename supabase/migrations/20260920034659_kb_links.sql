-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Links pasted on the Plan page: an article URL or a YouTube URL, read on
 * demand so the planner can use it in the same session rather than waiting for
 * the nightly ingest of kb/sources.json.
 *
 * The extracted text is kept on the row as well as ingested as a document, the
 * same shape as kb.recordings: the row is what one planning session reads in
 * full, the document is what every later session can search.
 *
 * Only the SECURITY DEFINER wrappers below reach the table; RLS is on with no
 * policies, as everywhere else in kb. */

create table if not exists kb.links (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  canonical_url text not null,
  kind          text not null default 'article' check (kind in ('article', 'video')),
  status        text not null default 'reading' check (status in ('reading', 'ready', 'failed')),
  title         text,
  site          text,
  author        text,
  published_at  timestamptz,
  words         integer,
  seconds       integer,
  /* Read, but not in full: a video whose captions YouTube would not serve, so
   * all that came back was the title, channel and description. */
  partial       boolean not null default false,
  body          text,
  error         text,
  document_id   uuid,
  added_by      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists links_created_idx on kb.links (created_at desc);
create index if not exists links_canonical_idx on kb.links (canonical_url);

alter table kb.links enable row level security;

/* Paste the same URL twice and you get the row you already have, as long as it
 * read cleanly and recently. Re-reading a news page a month later is a
 * different document; re-reading it ten minutes later is a waste. */
create or replace function public.kb_link_create(p_url text, p_canonical text, p_kind text, p_email text)
returns jsonb
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v_row kb.links; v_id uuid;
begin
  if btrim(coalesce(p_url, '')) = '' then raise exception 'a link needs a url'; end if;

  select * into v_row from kb.links
   where canonical_url = p_canonical and status = 'ready' and created_at > now() - interval '30 days'
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

create or replace function public.kb_link_ready(
  p_id uuid, p_title text, p_site text, p_author text, p_published timestamptz,
  p_words integer, p_seconds integer, p_partial boolean, p_body text, p_document_id uuid)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.links
     set status = 'ready', title = left(coalesce(p_title, ''), 400), site = left(coalesce(p_site, ''), 200),
         author = left(coalesce(p_author, ''), 200), published_at = p_published,
         words = p_words, seconds = p_seconds, partial = coalesce(p_partial, false),
         body = p_body, document_id = p_document_id, error = null, updated_at = now()
   where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_link_failed(p_id uuid, p_error text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.links
     set status = 'failed', error = left(coalesce(p_error, 'it could not be read'), 500), updated_at = now()
   where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_link_read(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(l) - 'added_by' from kb.links l where l.id = p_id;
$$;

create or replace function public.kb_links(p_limit integer default 50)
returns table (id uuid, url text, kind text, status text, title text, site text,
               words integer, seconds integer, partial boolean, error text, created_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select l.id, l.url, l.kind, l.status, l.title, l.site, l.words, l.seconds, l.partial, l.error, l.created_at
    from kb.links l
   order by l.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

grant execute on function public.kb_link_create(text, text, text, text) to anon, authenticated, service_role;
grant execute on function public.kb_link_ready(uuid, text, text, text, timestamptz, integer, integer, boolean, text, uuid) to anon, authenticated, service_role;
grant execute on function public.kb_link_failed(uuid, text) to anon, authenticated, service_role;
grant execute on function public.kb_link_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_links(integer) to anon, authenticated, service_role;;
