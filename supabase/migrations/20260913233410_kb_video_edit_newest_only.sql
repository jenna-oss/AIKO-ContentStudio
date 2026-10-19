-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- An edit can only be made to the newest version of a video. A page loaded
-- before another edit finished still shows the older version, and an edit of
-- it would become the newest version, silently dropping the other change.
create or replace function public.kb_video_request_edit(p_render_id uuid, p_notes jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_render kb.video_renders%rowtype;
  v_note jsonb;
  v_text text;
  v_at numeric;
  v_notes jsonb := '[]'::jsonb;
  v_lines text[] := '{}';
  v_id uuid;
begin
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' or jsonb_array_length(p_notes) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Add at least one note saying what should change.');
  end if;
  if jsonb_array_length(p_notes) > 8 then
    return jsonb_build_object('ok', false, 'error', 'Up to 8 notes per edit.');
  end if;

  for v_note in select value from jsonb_array_elements(p_notes) loop
    v_text := btrim(coalesce(v_note ->> 'note', ''));
    if char_length(v_text) < 3 then
      return jsonb_build_object('ok', false, 'error', 'Each note needs to say what should change.');
    end if;
    if char_length(v_text) > 400 then
      return jsonb_build_object('ok', false, 'error', 'Keep each note under 400 characters.');
    end if;
    v_at := case when jsonb_typeof(v_note -> 'at') = 'number' then round((v_note ->> 'at')::numeric, 2) end;
    if v_at is not null and (v_at < 0 or v_at > 3600) then
      v_at := null;
    end if;
    v_notes := v_notes || jsonb_build_array(jsonb_build_object('at', v_at, 'note', v_text));
    v_lines := v_lines || case
      when v_at is null then 'Whole video: ' || v_text
      else format('At %s:%s (frame %s): %s',
                  floor(v_at / 60)::int, lpad((floor(v_at)::int % 60)::text, 2, '0'),
                  round(v_at * 30)::int, v_text)
    end;
  end loop;

  select * into v_render from kb.video_renders where id = p_render_id and status = 'rendered';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That video isn''t finished, so it can''t be edited.');
  end if;

  -- The same test the library uses to pick the version it shows.
  if exists (
    select 1 from kb.video_renders r
     where r.session_id is not distinct from v_render.session_id
       and r.slot is not distinct from v_render.slot
       and r.status = 'rendered'
       and r.storage_path is not null
       and r.id <> v_render.id
       and r.rendered_at > v_render.rendered_at
  ) then
    return jsonb_build_object('ok', false, 'newer', true,
      'error', 'This video has a newer version. Refresh the page to edit that one.');
  end if;

  if v_render.review_status is not null then
    return jsonb_build_object('ok', false, 'error', 'Only videos in Ready to review can be edited.');
  end if;

  if exists (
    select 1 from kb.video_edits e
     where e.session_id is not distinct from v_render.session_id
       and e.slot is not distinct from v_render.slot
       and e.status in ('queued', 'running')
       and e.created_at > now() - interval '3 hours'
  ) then
    return jsonb_build_object('ok', false, 'error', 'This video already has an edit in progress. Wait for it to finish.');
  end if;

  if (select count(*) from kb.video_edits where created_at > now() - interval '24 hours') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'The limit of 10 edits a day has been reached. Try again tomorrow.');
  end if;

  insert into kb.video_edits (render_id, session_id, slot, instruction, notes)
  values (v_render.id, v_render.session_id, v_render.slot, array_to_string(v_lines, E'\n'), v_notes)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$function$;;
