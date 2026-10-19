-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Voice recordings uploaded on the Recordings page: the audio in a private
-- bucket, the transcript here, and the same transcript ingested into the
-- knowledge base as a document, so the planner can both search it and be
-- pointed at one in full.
create table if not exists kb.recordings (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  storage_path text,
  bytes bigint,
  seconds numeric,
  transcript text,
  words integer,
  status text not null default 'transcribing',
  error text,
  document_id uuid references kb.documents(id) on delete set null,
  uploaded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table kb.recordings drop constraint if exists recordings_status_check;
alter table kb.recordings add constraint recordings_status_check
  check (status in ('transcribing', 'ready', 'failed'));
create index if not exists recordings_created_idx on kb.recordings (created_at desc);
alter table kb.recordings enable row level security;

-- The audio. Private: the Worker holds the anon key and nothing else reaches
-- this bucket, the same assumption the open write RPCs already make.
insert into storage.buckets (id, name, public) values ('recordings', 'recordings', false)
  on conflict (id) do nothing;
drop policy if exists "recordings anon insert" on storage.objects;
drop policy if exists "recordings anon read" on storage.objects;
drop policy if exists "recordings anon delete" on storage.objects;
create policy "recordings anon insert" on storage.objects for insert to anon with check (bucket_id = 'recordings');
create policy "recordings anon read" on storage.objects for select to anon using (bucket_id = 'recordings');
create policy "recordings anon delete" on storage.objects for delete to anon using (bucket_id = 'recordings');

create or replace function public.kb_recording_create(p_name text, p_storage_path text, p_bytes bigint, p_email text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare v_id uuid;
begin
  if btrim(coalesce(p_name, '')) = '' then raise exception 'a recording needs a name'; end if;
  insert into kb.recordings (name, storage_path, bytes, uploaded_by)
  values (left(btrim(p_name), 120), p_storage_path, p_bytes, left(coalesce(p_email, ''), 254))
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function public.kb_recording_ready(p_id uuid, p_transcript text, p_seconds numeric, p_document_id uuid)
 returns void
 language sql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  update kb.recordings
     set transcript = p_transcript,
         words = coalesce(array_length(regexp_split_to_array(btrim(coalesce(p_transcript, '')), '\s+'), 1), 0),
         seconds = p_seconds,
         document_id = p_document_id,
         status = 'ready',
         error = null,
         updated_at = now()
   where id = p_id;
$function$;

create or replace function public.kb_recording_failed(p_id uuid, p_error text)
 returns void
 language sql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  update kb.recordings
     set status = 'failed', error = left(coalesce(p_error, 'transcription failed'), 300), updated_at = now()
   where id = p_id and status <> 'ready';
$function$;

create or replace function public.kb_recordings(p_limit integer default 50)
 returns table(id uuid, name text, seconds numeric, words integer, status text, error text, has_audio boolean, created_at timestamptz)
 language sql
 stable security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select r.id, r.name, r.seconds, r.words, r.status, r.error, r.storage_path is not null, r.created_at
    from kb.recordings r
   order by r.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$function$;

-- One recording in full, for the Recordings page and for the planner when the
-- person points it at one.
create or replace function public.kb_recording_read(p_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select jsonb_build_object(
           'id', r.id, 'name', r.name, 'status', r.status, 'seconds', r.seconds,
           'words', r.words, 'error', r.error, 'storage_path', r.storage_path,
           'transcript', left(coalesce(r.transcript, ''), 200000))
    from kb.recordings r where r.id = p_id;
$function$;

create or replace function public.kb_recording_rename(p_id uuid, p_name text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
begin
  if btrim(coalesce(p_name, '')) = '' then return false; end if;
  update kb.recordings set name = left(btrim(p_name), 120), updated_at = now() where id = p_id;
  return found;
end;
$function$;

-- Deleting a recording takes its transcript out of the corpus with it, and
-- hands back the audio's path so the Worker can drop the file too.
create or replace function public.kb_recording_delete(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare v_rec kb.recordings%rowtype;
begin
  select * into v_rec from kb.recordings where id = p_id;
  if not found then return jsonb_build_object('ok', false); end if;
  if v_rec.document_id is not null then
    delete from kb.documents where id = v_rec.document_id;
  end if;
  delete from kb.recordings where id = p_id;
  return jsonb_build_object('ok', true, 'storage_path', v_rec.storage_path);
end;
$function$;

revoke all on function public.kb_recording_create(text, text, bigint, text) from public;
revoke all on function public.kb_recording_ready(uuid, text, numeric, uuid) from public;
revoke all on function public.kb_recording_failed(uuid, text) from public;
revoke all on function public.kb_recordings(integer) from public;
revoke all on function public.kb_recording_read(uuid) from public;
revoke all on function public.kb_recording_rename(uuid, text) from public;
revoke all on function public.kb_recording_delete(uuid) from public;
grant execute on function public.kb_recording_create(text, text, bigint, text) to anon, authenticated, service_role;
grant execute on function public.kb_recording_ready(uuid, text, numeric, uuid) to anon, authenticated, service_role;
grant execute on function public.kb_recording_failed(uuid, text) to anon, authenticated, service_role;
grant execute on function public.kb_recordings(integer) to anon, authenticated, service_role;
grant execute on function public.kb_recording_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_recording_rename(uuid, text) to anon, authenticated, service_role;
grant execute on function public.kb_recording_delete(uuid) to anon, authenticated, service_role;;
