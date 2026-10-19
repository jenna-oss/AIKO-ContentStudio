-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Two new kinds of change from the Edit page.
--
-- mode 'remake': the pipeline makes the video again from its plan, with the
-- reviewer's notes as the change requested: a new script and new visuals, for
-- when the problem is what the video says. A video whose source wasn't kept
-- can only be re-made, so its edits are recorded as re-makes. Re-makes cost
-- about as much as a render, so there are 3 a day, inside the 10 edits.
--
-- script_changes: narration lines rewritten on the Edit page's script panel,
-- [{line, from, to}], numbered from 1 against the lines saved with the video
-- (metadata.script, written when the video is stored).

alter table kb.video_edits
  add column if not exists mode text not null default 'exact',
  add column if not exists script_changes jsonb not null default '[]'::jsonb;
alter table kb.video_edits drop constraint if exists video_edits_mode_check;
alter table kb.video_edits add constraint video_edits_mode_check check (mode in ('exact', 'remake'));

drop function if exists public.kb_video_request_edit(uuid, jsonb);

create function public.kb_video_request_edit(
  p_render_id uuid,
  p_notes jsonb,
  p_mode text default 'exact',
  p_script jsonb default '[]'::jsonb
)
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
  v_mode text := coalesce(nullif(btrim(p_mode), ''), 'exact');
  v_script jsonb;
  v_change jsonb;
  v_n int;
  v_from text;
  v_changes jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if v_mode not in ('exact', 'remake') then
    return jsonb_build_object('ok', false, 'error', 'Unknown kind of edit.');
  end if;
  if p_notes is null or jsonb_typeof(p_notes) <> 'array' then p_notes := '[]'::jsonb; end if;
  if p_script is null or jsonb_typeof(p_script) <> 'array' then p_script := '[]'::jsonb; end if;
  if jsonb_array_length(p_notes) = 0 and jsonb_array_length(p_script) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Add a note or change a line of the script.');
  end if;
  if jsonb_array_length(p_notes) > 8 then
    return jsonb_build_object('ok', false, 'error', 'Up to 8 notes per edit.');
  end if;
  if jsonb_array_length(p_script) > 20 then
    return jsonb_build_object('ok', false, 'error', 'Up to 20 script changes per edit.');
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

  -- Script changes, checked against the lines saved with this version.
  if jsonb_array_length(p_script) > 0 then
    v_script := v_render.metadata -> 'script';
    if v_script is null or jsonb_typeof(v_script) <> 'array' then
      return jsonb_build_object('ok', false,
        'error', 'This video''s script wasn''t saved, so its lines can''t be changed here. Say what to change in a note.');
    end if;
    for v_change in select value from jsonb_array_elements(p_script) loop
      v_n := case when jsonb_typeof(v_change -> 'line') = 'number' then (v_change ->> 'line')::numeric::int end;
      if v_n is null or v_n < 1 or v_n > jsonb_array_length(v_script) then
        return jsonb_build_object('ok', false, 'error', 'A script change points at a line this video doesn''t have. Refresh the page.');
      end if;
      v_text := btrim(regexp_replace(coalesce(v_change ->> 'text', ''), '\s+', ' ', 'g'));
      if char_length(v_text) < 2 then
        return jsonb_build_object('ok', false, 'error', 'A script line can''t be empty. To cut a line, say so in a note.');
      end if;
      if char_length(v_text) > 300 then
        return jsonb_build_object('ok', false, 'error', 'Keep each script line under 300 characters.');
      end if;
      v_from := v_script ->> (v_n - 1);
      continue when v_text = btrim(coalesce(v_from, ''));
      if v_changes @> jsonb_build_array(jsonb_build_object('line', v_n)) then
        return jsonb_build_object('ok', false, 'error', 'The same script line was changed twice.');
      end if;
      v_changes := v_changes || jsonb_build_array(jsonb_build_object('line', v_n, 'from', v_from, 'to', v_text));
      v_lines := v_lines || format('Narration line %s: change "%s" to "%s"', v_n, v_from, v_text);
    end loop;
    if jsonb_array_length(v_changes) = 0 and jsonb_array_length(v_notes) = 0 then
      return jsonb_build_object('ok', false, 'error', 'Nothing in the script changed. Change a line or add a note.');
    end if;
  end if;

  -- Without a kept source there is nothing to edit exactly: it is re-made.
  if not (v_render.metadata ? 'source_path') then
    v_mode := 'remake';
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
  if v_mode = 'remake'
     and (select count(*) from kb.video_edits where mode = 'remake' and created_at > now() - interval '24 hours') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'The limit of 3 re-makes a day has been reached. Try again tomorrow.');
  end if;

  insert into kb.video_edits (render_id, session_id, slot, instruction, notes, mode, script_changes)
  values (v_render.id, v_render.session_id, v_render.slot, array_to_string(v_lines, E'\n'), v_notes, v_mode, v_changes)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'mode', v_mode);
end;
$function$;

revoke all on function public.kb_video_request_edit(uuid, jsonb, text, jsonb) from public;
grant execute on function public.kb_video_request_edit(uuid, jsonb, text, jsonb) to anon, authenticated, service_role;

create or replace function public.kb_video_edit_start(p_edit_id uuid, p_run_url text)
 returns jsonb
 language plpgsql
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
    'mode', v_edit.mode,
    'instruction', v_edit.instruction,
    'notes', v_edit.notes,
    'script_changes', v_edit.script_changes,
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

create or replace function public.kb_video_library(p_limit integer default 60)
 returns table(id uuid, session_id text, slot integer, topic text, hook text, angle text, product text, audience text, storage_path text, duration_seconds numeric, rendered_at timestamp with time zone, review_status text, reviewed_at timestamp with time zone, has_source boolean, last_edit jsonb)
 language sql
 stable security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
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
      limit 1)
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
  order by latest.rendered_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
$function$;

-- The saved narration lines of one finished video, for the script panel.
create or replace function public.kb_video_script(p_render_id uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select jsonb_build_object(
    'lines', case when jsonb_typeof(r.metadata -> 'script') = 'array' then r.metadata -> 'script' end,
    'has_source', r.metadata ? 'source_path')
    from kb.video_renders r
   where r.id = p_render_id and r.status = 'rendered';
$function$;
revoke all on function public.kb_video_script(uuid) from public;
grant execute on function public.kb_video_script(uuid) to anon, authenticated, service_role;

-- For the one-off backfill workflow: finished videos with a kept source and
-- no saved script, and a way to save one. Service role only.
create or replace function public.kb_video_scripts_missing()
 returns table(id uuid, source_path text)
 language sql
 stable security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
  select r.id, r.metadata ->> 'source_path'
    from kb.video_renders r
   where r.status = 'rendered'
     and r.metadata ? 'source_path'
     and jsonb_typeof(r.metadata -> 'script') is distinct from 'array'
   order by r.rendered_at desc
   limit 200;
$function$;
revoke all on function public.kb_video_scripts_missing() from public, anon, authenticated;
grant execute on function public.kb_video_scripts_missing() to service_role;

create or replace function public.kb_video_set_script(p_render_id uuid, p_script jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $function$
begin
  if p_script is null or jsonb_typeof(p_script) <> 'array'
     or jsonb_array_length(p_script) = 0 or jsonb_array_length(p_script) > 30
     or exists (select 1 from jsonb_array_elements(p_script) x
                 where jsonb_typeof(x.value) <> 'string' or char_length(x.value #>> '{}') > 400) then
    raise exception 'a script is 1 to 30 lines of text, each under 400 characters';
  end if;
  update kb.video_renders
     set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('script', p_script)
   where id = p_render_id and status = 'rendered';
  return found;
end;
$function$;
revoke all on function public.kb_video_set_script(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.kb_video_set_script(uuid, jsonb) to service_role;;
