-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Raw footage: the long take you film, before it is cut into shorts.
 *
 * These files are gigabytes, so they do not pass through the Worker —
 * Cloudflare caps a request body at 100MB. The browser uploads straight to
 * storage with the Supabase session it already holds, which is why this is the
 * one bucket with policies for `authenticated` rather than for the Worker's
 * anon key. The policies are scoped to this bucket and to emails on the app's
 * own list, because the project is shared with other AIKO tools and
 * `authenticated` there means more people than it does here.
 *
 * The bucket is private and named kb-footage, not footage: `recordings` was
 * once taken by another tool and private audio nearly went into a public
 * bucket because of it.
 *
 * The transcript is kept twice over: as plain text for reading and searching,
 * and as word timings, which is what makes cutting on a sentence possible. */

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kb-footage', 'kb-footage', false, 5368709120,
        array['video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm', 'audio/mpeg', 'audio/mp4'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = false;

create or replace function kb.is_app_user()
returns boolean
language sql stable security definer
set search_path to 'kb', 'public', 'pg_catalog'
as $$
  select exists (
    select 1 from kb.app_users u
     where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "app users put footage" on storage.objects;
drop policy if exists "app users read footage" on storage.objects;
drop policy if exists "app users remove footage" on storage.objects;

create policy "app users put footage" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'kb-footage' and kb.is_app_user());

create policy "app users read footage" on storage.objects
  for select to authenticated
  using (bucket_id = 'kb-footage' and kb.is_app_user());

create policy "app users remove footage" on storage.objects
  for delete to authenticated
  using (bucket_id = 'kb-footage' and kb.is_app_user());

create table if not exists kb.footage (
  id           uuid primary key default gen_random_uuid(),
  name         text,
  storage_path text not null,
  bytes        bigint,
  seconds      numeric,
  status       text not null default 'uploading'
               check (status in ('uploading', 'uploaded', 'transcribing', 'ready', 'failed')),
  transcript   text,
  /* [{ t: word, s: start seconds, e: end seconds }] — what lets a cut land
   * between sentences rather than mid-word. */
  words        jsonb not null default '[]'::jsonb,
  word_count   integer,
  error        text,
  added_by     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists footage_created_idx on kb.footage (created_at desc);
alter table kb.footage enable row level security;

create or replace function public.kb_footage_create(p_name text, p_path text, p_bytes bigint, p_email text)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v uuid;
begin
  if btrim(coalesce(p_path, '')) = '' then raise exception 'footage needs somewhere to live'; end if;
  insert into kb.footage (name, storage_path, bytes, added_by)
  values (left(coalesce(p_name, ''), 200), p_path, p_bytes, left(coalesce(p_email, ''), 254))
  returning id into v;
  return v;
end;
$$;

create or replace function public.kb_footage_state(p_id uuid, p_status text, p_error text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.footage set status = p_status, error = p_error, updated_at = now() where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_footage_ready(
  p_id uuid, p_transcript text, p_words jsonb, p_seconds numeric)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.footage
     set status = 'ready', transcript = p_transcript, words = coalesce(p_words, '[]'::jsonb),
         word_count = coalesce(jsonb_array_length(p_words), 0), seconds = p_seconds,
         error = null, updated_at = now()
   where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_footage(p_limit integer default 50)
returns table (id uuid, name text, bytes bigint, seconds numeric, status text,
               word_count integer, error text, created_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select f.id, f.name, f.bytes, f.seconds, f.status, f.word_count, f.error, f.created_at
    from kb.footage f
   order by f.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

/* The whole thing, words and all — for the agent that picks the clips. */
create or replace function public.kb_footage_read(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(f) - 'added_by' from kb.footage f where f.id = p_id;
$$;

create or replace function public.kb_footage_delete(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v text;
begin
  delete from kb.footage where id = p_id returning storage_path into v;
  if v is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'storage_path', v);
end;
$$;

grant execute on function public.kb_footage_create(text, text, bigint, text) to anon, authenticated, service_role;
grant execute on function public.kb_footage_state(uuid, text, text) to anon, authenticated, service_role;
grant execute on function public.kb_footage_ready(uuid, text, jsonb, numeric) to anon, authenticated, service_role;
grant execute on function public.kb_footage(integer) to anon, authenticated, service_role;
grant execute on function public.kb_footage_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_footage_delete(uuid) to anon, authenticated, service_role;;
