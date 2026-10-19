-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Clips belong in the library with everything else.
 *
 * A clip cut out of a take and a video built from a plan are both finished
 * videos to review and post, so they come back from one call rather than two.
 * What they are not is interchangeable: a render has a plan behind it, a
 * script and a kept source, and the Edit page's whole flow depends on that. A
 * clip has a take behind it instead. So the library now says which kind each
 * row is, and the pages that cannot yet handle a clip can leave them out
 * rather than offering something that would break.
 *
 * Reviewing is the same for both — to_post or rejected — so clips get the same
 * two columns and kb_video_set_review looks in both places. */

alter table kb.clips add column if not exists review_status text
  check (review_status in ('to_post', 'rejected'));
alter table kb.clips add column if not exists reviewed_at timestamptz;

drop function if exists public.kb_video_library(integer);

create or replace function public.kb_video_library(p_limit integer default 60)
returns table (id uuid, session_id text, slot integer, topic text, hook text, angle text,
               product text, audience text, storage_path text, duration_seconds numeric,
               rendered_at timestamptz, review_status text, reviewed_at timestamptz,
               has_source boolean, last_edit jsonb, kind text)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select * from (
    select latest.*,
      (select jsonb_build_object(
                'status', e.status,
                'mode', e.mode,
                'instruction', e.instruction,
                'error', e.error,
                'created_at', e.created_at,
                'in_progress', e.status in ('queued', 'running') and e.created_at > now() - interval '3 hours')
         from kb.video_edits e
        where e.session_id is not distinct from latest.session_id
          and e.slot is not distinct from latest.slot
        order by e.created_at desc
        limit 1),
      'render'::text
    from (
      select distinct on (r.session_id, r.slot)
        r.id,
        r.session_id,
        r.slot,
        coalesce(nullif(s.slots -> (r.slot - 1) ->> 'topic', ''), split_part(r.topic, E'\n', 1)),
        coalesce(s.slots -> (r.slot - 1) ->> 'hook', s.slots -> (r.slot - 1) ->> 'opening_line'),
        s.slots -> (r.slot - 1) ->> 'angle',
        s.slots -> (r.slot - 1) ->> 'product',
        s.slots -> (r.slot - 1) ->> 'audience',
        r.storage_path,
        r.duration_seconds,
        r.rendered_at,
        r.review_status,
        r.reviewed_at,
        (r.metadata ? 'source_path')
      from kb.video_renders r
      left join kb.planning_sessions s on s.id = r.session_id
      where r.status = 'rendered'
        and r.storage_path is not null
      order by r.session_id, r.slot, r.rendered_at desc
    ) latest

    union all

    /* A clip's topic is the take it came out of, and its hook is the sentence
     * it opens on — which is the reason it was cut at all. `why` is the
     * agent's reasoning, which reads well in the place an angle would. */
    select
      c.id,
      null::text,
      c.idx,
      coalesce(nullif(f.name, ''), 'Untitled take'),
      c.hook,
      c.why,
      null::text,
      null::text,
      'clips/' || c.id::text || '.mp4',
      round(c.end_s - c.start_s, 2),
      c.updated_at,
      c.review_status,
      c.reviewed_at,
      false,
      null::jsonb,
      'clip'::text
    from kb.clips c
    join kb.footage f on f.id = c.footage_id
    where c.status = 'ready'
      and c.url is not null
  ) everything
  order by rendered_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
$function$;

/* Reviewing works the same on both, so this looks in both. */
create or replace function public.kb_video_set_review(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_status text;
  v_at timestamptz;
  v_found boolean;
begin
  if p_status is null or p_status not in ('to_post', 'rejected') then
    raise exception 'status must be to_post or rejected';
  end if;

  update kb.video_renders
     set review_status = p_status,
         reviewed_at = case when review_status is distinct from p_status then now() else reviewed_at end
   where id = p_id
     and status = 'rendered'
  returning review_status, reviewed_at into v_status, v_at;
  v_found := found;

  if not v_found then
    update kb.clips
       set review_status = p_status,
           reviewed_at = case when review_status is distinct from p_status then now() else reviewed_at end,
           updated_at = now()
     where id = p_id
       and status = 'ready'
    returning review_status, reviewed_at into v_status, v_at;
    v_found := found;
  end if;

  return jsonb_build_object('found', v_found, 'review_status', v_status, 'reviewed_at', v_at);
end;
$function$;

grant execute on function public.kb_video_library(integer) to anon, authenticated, service_role;
grant execute on function public.kb_video_set_review(uuid, text) to anon, authenticated, service_role;;
