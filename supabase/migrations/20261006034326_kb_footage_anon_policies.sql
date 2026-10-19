-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* The footage bucket's policies were written for the wrong role.
 *
 * The browser does not talk to storage with a session after all — it uploads
 * with a signature the Worker mints, which was the right call (handing the
 * page the anon key would let it call every kb_* function directly). But that
 * means the *Worker* is the one asking storage for things, and the Worker
 * holds the anon key, which had no rights on this bucket. So signing an upload
 * failed, and so would deleting a take.
 *
 * Anon is the tighter of the two here, not the looser: that key lives only in
 * the Worker, behind the sign-in gate, while `authenticated` on this project
 * means any signed-in user of any AIKO tool sharing it. So the authenticated
 * policies go and anon takes their place, which is also how kb-recordings has
 * always worked. */

drop policy if exists "app users put footage" on storage.objects;
drop policy if exists "app users read footage" on storage.objects;
drop policy if exists "app users remove footage" on storage.objects;

create policy "kb footage anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'kb-footage');

create policy "kb footage anon read" on storage.objects
  for select to anon using (bucket_id = 'kb-footage');

create policy "kb footage anon delete" on storage.objects
  for delete to anon using (bucket_id = 'kb-footage');;
