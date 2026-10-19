-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- The bucket named `recordings` is not ours: another AIKO tool created it in
-- May and it is public. The previous migration's "on conflict do nothing"
-- left it that way and attached our anon policies to it, which would have put
-- private audio in someone else's public bucket. Ours is `kb-recordings`,
-- private, and the stray policies come off.
drop policy if exists "recordings anon insert" on storage.objects;
drop policy if exists "recordings anon read" on storage.objects;
drop policy if exists "recordings anon delete" on storage.objects;

insert into storage.buckets (id, name, public) values ('kb-recordings', 'kb-recordings', false)
  on conflict (id) do update set public = false;

drop policy if exists "kb recordings anon insert" on storage.objects;
drop policy if exists "kb recordings anon read" on storage.objects;
drop policy if exists "kb recordings anon delete" on storage.objects;
create policy "kb recordings anon insert" on storage.objects for insert to anon with check (bucket_id = 'kb-recordings');
create policy "kb recordings anon read" on storage.objects for select to anon using (bucket_id = 'kb-recordings');
create policy "kb recordings anon delete" on storage.objects for delete to anon using (bucket_id = 'kb-recordings');;
