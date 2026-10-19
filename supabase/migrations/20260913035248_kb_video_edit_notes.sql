-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Edits come from the Edit tab now, as notes: each says what to change, and
-- most are pinned to a moment of the video (seconds). They are sent together
-- as one edit. The notes are kept as sent; instruction is the readable text
-- built from them, which the Output and Edit pages show.
--
-- Only videos in Ready to review can be edited: the Edit tab lists nothing
-- else, and a video moved to To Be Posted or Rejected meanwhile is refused.
alter table kb.video_edits add column if not exists notes jsonb not null default '[]'::jsonb;

drop function if exists public.kb_video_request_edit(uuid, text);

create function public.kb_video_request_edit(p_render_id uuid, p_notes jsonb)
returns jsonb
language plpgsql
volatile
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
$function$;

revoke all on function public.kb_video_request_edit(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kb_video_request_edit(uuid, jsonb) to anon, authenticated, service_role;

-- The workflow also needs the notes (to cut a frame for each pinned one) and
-- the video's own file (to cut them from).
create or replace function public.kb_video_edit_start(p_edit_id uuid, p_run_url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
declare
  v_edit kb.video_edits%rowtype;
  v_render kb.video_renders%rowtype;
  v_slot jsonb;
  v_goal text;
begin
  update kb.video_edits
     set status = 'running', run_url = left(p_run_url, 300), updated_at = now()
   where id = p_edit_id
     and status = 'queued'
  returning * into v_edit;
  if not found then
    raise exception 'edit % is not waiting to start', p_edit_id;
  end if;

  select * into v_render from kb.video_renders where id = v_edit.render_id;
  select s.slots -> (v_render.slot - 1), s.goal
    into v_slot, v_goal
    from kb.planning_sessions s
   where s.id = v_render.session_id;

  return jsonb_build_object(
    'edit_id', v_edit.id,
    'instruction', v_edit.instruction,
    'notes', v_edit.notes,
    'render_id', v_render.id,
    'session_id', v_render.session_id,
    'slot', v_render.slot,
    'topic', coalesce(nullif(v_slot ->> 'topic', ''), split_part(v_render.topic, E'\n', 1)),
    'storage_path', v_render.storage_path,
    'source_path', v_render.metadata ->> 'source_path',
    'goal', v_goal,
    'plan_slot', coalesce(v_slot, '{}'::jsonb)
  );
end;
$function$;

revoke all on function public.kb_video_edit_start(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_video_edit_start(uuid, text) to service_role;;
