-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Pin search_path on every knowledge-base function.
--
-- Without it, name and operator resolution inside the function follows the
-- caller's search_path, which a caller can set. The SECURITY DEFINER writers
-- already pinned theirs; this closes the same hole on the readers, where it
-- matters less but is no harder to fix.
--
-- extensions must stay in the path: the pgvector distance operator <=> lives
-- there, and operator resolution goes through search_path like everything else.
do $do$
declare f record;
begin
    for f in
        select n.nspname as schema, p.proname as name,
               pg_get_function_identity_arguments(p.oid) as args
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where (n.nspname = 'kb')
           or (n.nspname = 'public' and p.proname like 'kb\_%')
    loop
        execute format(
            'alter function %I.%I(%s) set search_path = kb, public, extensions, pg_catalog',
            f.schema, f.name, f.args);
    end loop;
end
$do$;

-- kb.ingest_jobs keeps RLS on with no policy, deliberately. It is an internal
-- work queue: service_role bypasses RLS and touches it, and no policy means
-- anon and authenticated get nothing, which is the intended answer rather than
-- an oversight. The linter reports this as INFO; this comment is the record.
comment on table kb.ingest_jobs is
  'Spec section 40. Async ingestion queue. RLS is on with no policy on purpose — '
  'only service_role, which bypasses RLS, has any business reading it.';;
