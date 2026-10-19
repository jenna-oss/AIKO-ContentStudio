-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Version 6 of the app: one layout (Create, Videos, Library, Schedule) and
-- clips you can edit.

-- 1. A review decision can be taken back: 'review' clears it.
create or replace function public.kb_video_set_review(p_id uuid, p_status text)
returns jsonb language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
declare
  v_status text;
  v_at timestamptz;
  v_found boolean;
  v_new text := case when p_status = 'review' then null else p_status end;
begin
  if p_status is null or p_status not in ('to_post', 'rejected', 'review') then
    raise exception 'status must be to_post, rejected or review';
  end if;

  update kb.video_renders
     set review_status = v_new,
         reviewed_at = case when v_new is null then null
                            when review_status is distinct from v_new then now() else reviewed_at end
   where id = p_id and status = 'rendered'
  returning review_status, reviewed_at into v_status, v_at;
  v_found := found;

  if not v_found then
    update kb.clips
       set review_status = v_new,
           reviewed_at = case when v_new is null then null
                              when review_status is distinct from v_new then now() else reviewed_at end,
           updated_at = now()
     where id = p_id and status = 'ready'
    returning review_status, reviewed_at into v_status, v_at;
    v_found := found;
  end if;

  return jsonb_build_object('found', v_found, 'review_status', v_status, 'reviewed_at', v_at);
end $$;

-- 2. Editing a clip. A clip is a window on its take, so an edit is a new
-- window: where it starts and ends, sections cut out of the middle, and words
-- the transcript got wrong. All three are kept in the take's own clock, so a
-- fix survives a later trim. The cutting workflow applies them and replaces
-- the clip's file in place.
alter table kb.clips
  add column if not exists cuts jsonb not null default '[]'::jsonb,
  add column if not exists fixes jsonb not null default '[]'::jsonb,
  add column if not exists edit jsonb,
  add column if not exists edit_status text,
  add column if not exists edit_error text,
  add column if not exists edit_summary text,
  add column if not exists edited_at timestamptz,
  add column if not exists edits integer not null default 0;

create or replace function public.kb_clip_edit_info(p_id uuid)
returns jsonb language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select jsonb_build_object(
    'id', c.id, 'start_s', c.start_s, 'end_s', c.end_s, 'cuts', c.cuts, 'fixes', c.fixes,
    'take_seconds', f.seconds, 'take_name', f.name,
    -- The take's words a minute either side, so a trim can reach past the
    -- current ends and still show what is said there.
    'words', coalesce((select jsonb_agg(w order by (w ->> 's')::numeric)
                         from jsonb_array_elements(f.words) w
                        where (w ->> 's')::numeric between c.start_s - 60 and c.end_s + 60), '[]'::jsonb))
  from kb.clips c join kb.footage f on f.id = c.footage_id
  where c.id = p_id;
$$;

create or replace function public.kb_clip_request_edit(p_id uuid, p_start numeric, p_end numeric,
                                                        p_cuts jsonb, p_fixes jsonb, p_summary text)
returns jsonb language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
declare
  v_clip kb.clips%rowtype;
  v_take numeric;
  v_cut jsonb;
  v_prev numeric := null;
  v_a numeric; v_b numeric;
  v_kept numeric;
  v_fix jsonb;
  v_cuts jsonb := '[]'::jsonb;
  v_fixes jsonb := '[]'::jsonb;
begin
  select * into v_clip from kb.clips where id = p_id and status = 'ready';
  if not found then return jsonb_build_object('ok', false, 'error', 'That clip isn''t ready, so it can''t be edited.'); end if;
  if v_clip.review_status is not null then
    return jsonb_build_object('ok', false, 'error', 'Only clips in To review can be edited. Move it back to review first.');
  end if;
  if v_clip.edit_status in ('queued', 'running') and v_clip.edited_at > now() - interval '1 hour' then
    return jsonb_build_object('ok', false, 'error', 'This clip already has an edit in progress. Wait for it to finish.');
  end if;
  if (select count(*) from kb.clips where edited_at > now() - interval '24 hours') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'The limit of 30 clip edits a day has been reached. Try again tomorrow.');
  end if;

  select seconds into v_take from kb.footage where id = v_clip.footage_id;
  p_start := round(coalesce(p_start, v_clip.start_s), 2);
  p_end := round(coalesce(p_end, v_clip.end_s), 2);
  if p_start < 0 or (v_take is not null and p_end > v_take) or p_end - p_start < 3 then
    return jsonb_build_object('ok', false, 'error', 'The clip has to be at least 3 seconds and inside the take.');
  end if;
  if p_end - p_start > 180 then
    return jsonb_build_object('ok', false, 'error', 'A clip can be up to 3 minutes long.');
  end if;

  if p_cuts is null or jsonb_typeof(p_cuts) <> 'array' then p_cuts := '[]'::jsonb; end if;
  if jsonb_array_length(p_cuts) > 10 then return jsonb_build_object('ok', false, 'error', 'Up to 10 sections can be cut out.'); end if;
  v_kept := p_end - p_start;
  for v_cut in select value from jsonb_array_elements(p_cuts) order by (value ->> 'from')::numeric loop
    v_a := round((v_cut ->> 'from')::numeric, 2);
    v_b := round((v_cut ->> 'to')::numeric, 2);
    if v_a is null or v_b is null or v_b - v_a < 0.1 or v_a <= p_start or v_b >= p_end then
      return jsonb_build_object('ok', false, 'error', 'A section to cut out has to sit inside the clip, not at either end. Trim the ends instead.');
    end if;
    if v_prev is not null and v_a < v_prev then
      return jsonb_build_object('ok', false, 'error', 'Two sections to cut out overlap.');
    end if;
    v_prev := v_b;
    v_kept := v_kept - (v_b - v_a);
    v_cuts := v_cuts || jsonb_build_array(jsonb_build_object('from', v_a, 'to', v_b));
  end loop;
  if v_kept < 3 then return jsonb_build_object('ok', false, 'error', 'That would leave less than 3 seconds.'); end if;

  if p_fixes is null or jsonb_typeof(p_fixes) <> 'array' then p_fixes := '[]'::jsonb; end if;
  if jsonb_array_length(p_fixes) > 80 then return jsonb_build_object('ok', false, 'error', 'Up to 80 caption fixes.'); end if;
  for v_fix in select value from jsonb_array_elements(p_fixes) loop
    if jsonb_typeof(v_fix -> 'at') <> 'number' or char_length(btrim(coalesce(v_fix ->> 'text', ''))) not between 1 and 40 then
      return jsonb_build_object('ok', false, 'error', 'Each caption fix needs a word of 1 to 40 characters.');
    end if;
    v_fixes := v_fixes || jsonb_build_array(jsonb_build_object('at', round((v_fix ->> 'at')::numeric, 2), 'text', btrim(v_fix ->> 'text')));
  end loop;

  update kb.clips
     set edit = jsonb_build_object('start_s', p_start, 'end_s', p_end, 'cuts', v_cuts, 'fixes', v_fixes),
         edit_status = 'queued', edit_error = null,
         edit_summary = left(coalesce(nullif(btrim(p_summary), ''), 'Clip edit'), 300),
         edited_at = now(), updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

create or replace function public.kb_clip_edit_state(p_id uuid, p_status text, p_error text)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  if p_status not in ('running', 'failed') then raise exception 'status must be running or failed'; end if;
  update kb.clips set edit_status = p_status, edit_error = left(p_error, 400), updated_at = now() where id = p_id;
  return found;
end $$;

create or replace function public.kb_clip_edit_done(p_id uuid, p_words jsonb, p_url text, p_bytes bigint)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  update kb.clips
     set start_s = (edit ->> 'start_s')::numeric,
         end_s = (edit ->> 'end_s')::numeric,
         cuts = coalesce(edit -> 'cuts', '[]'::jsonb),
         fixes = coalesce(edit -> 'fixes', '[]'::jsonb),
         words = coalesce(p_words, words),
         url = coalesce(p_url, url), bytes = coalesce(p_bytes, bytes),
         edit_status = 'done', edit_error = null, edits = edits + 1, updated_at = now()
   where id = p_id and edit is not null;
  return found;
end $$;

-- The library: a clip's length is its window less what is cut out of it, and
-- its edit reads like a render's.
create or replace function public.kb_video_library(p_limit integer default 60)
returns table(id uuid, session_id text, slot integer, topic text, hook text, angle text, product text,
              audience text, storage_path text, duration_seconds numeric, rendered_at timestamptz,
              review_status text, reviewed_at timestamptz, has_source boolean, last_edit jsonb, kind text)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select * from (
    select latest.*,
      (select jsonb_build_object(
                'status', e.status, 'mode', e.mode, 'instruction', e.instruction, 'error', e.error,
                'created_at', e.created_at,
                'in_progress', e.status in ('queued', 'running') and e.created_at > now() - interval '3 hours')
         from kb.video_edits e
        where e.session_id is not distinct from latest.session_id
          and e.slot is not distinct from latest.slot
        order by e.created_at desc limit 1),
      'render'::text
    from (
      select distinct on (r.session_id, r.slot)
        r.id, r.session_id, r.slot,
        coalesce(nullif(s.slots -> (r.slot - 1) ->> 'topic', ''), split_part(r.topic, E'\n', 1)),
        coalesce(s.slots -> (r.slot - 1) ->> 'hook', s.slots -> (r.slot - 1) ->> 'opening_line'),
        s.slots -> (r.slot - 1) ->> 'angle',
        s.slots -> (r.slot - 1) ->> 'product',
        s.slots -> (r.slot - 1) ->> 'audience',
        r.storage_path, r.duration_seconds, r.rendered_at, r.review_status, r.reviewed_at,
        (r.metadata ? 'source_path')
      from kb.video_renders r
      left join kb.planning_sessions s on s.id = r.session_id
      where r.status = 'rendered' and r.storage_path is not null
      order by r.session_id, r.slot, r.rendered_at desc
    ) latest

    union all

    select c.id, null::text, c.idx,
      coalesce(nullif(f.name, ''), 'Untitled take'), c.hook, c.why, null::text, null::text,
      'clips/' || c.id::text || '.mp4',
      round(c.end_s - c.start_s - coalesce((select sum((x ->> 'to')::numeric - (x ->> 'from')::numeric)
                                             from jsonb_array_elements(c.cuts) x), 0), 2),
      c.updated_at, c.review_status, c.reviewed_at, true,
      case when c.edit_status is null then null else jsonb_build_object(
        'status', c.edit_status, 'mode', 'clip', 'instruction', c.edit_summary, 'error', c.edit_error,
        'created_at', c.edited_at,
        'in_progress', c.edit_status in ('queued', 'running') and c.edited_at > now() - interval '1 hour') end,
      'clip'::text
    from kb.clips c join kb.footage f on f.id = c.footage_id
    where c.status = 'ready' and c.url is not null
  ) everything
  order by rendered_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
$$;

-- 3. The Library's files: what has been put into the knowledge base by hand
-- (uploaded files and links read in a chat). Only the upload: namespace, so
-- nothing the pipelines load can be listed or removed from the app.
create or replace function public.kb_uploads_list(p_limit integer default 100)
returns table(id uuid, title text, document_type text, source_url text, status text, chunk_count integer, created_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select d.id, d.title, d.document_type, d.source_url, d.status, d.chunk_count, d.created_at
    from kb.documents d
   where d.source_key like 'upload:%'
   order by d.created_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

create or replace function public.kb_upload_delete(p_id uuid)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  delete from kb.documents where id = p_id and source_key like 'upload:%';
  return found;
end $$;

-- 4. Recent plans, for picking one back up on the Create page.
create or replace function public.kb_plans_recent(p_limit integer default 8)
returns table(id text, goal text, slots integer, status text, rendered integer, updated_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select s.id, s.goal, jsonb_array_length(coalesce(s.slots, '[]'::jsonb)), s.status,
         (select count(distinct r.slot)::int from kb.video_renders r where r.session_id = s.id and r.status = 'rendered'),
         s.updated_at
    from kb.planning_sessions s
   where jsonb_array_length(coalesce(s.slots, '[]'::jsonb)) > 0
   order by s.updated_at desc
   limit least(greatest(coalesce(p_limit, 8), 1), 50);
$$;

revoke all on function public.kb_clip_edit_info(uuid), public.kb_clip_request_edit(uuid, numeric, numeric, jsonb, jsonb, text),
  public.kb_clip_edit_state(uuid, text, text), public.kb_clip_edit_done(uuid, jsonb, text, bigint),
  public.kb_uploads_list(integer), public.kb_upload_delete(uuid), public.kb_plans_recent(integer) from public;
grant execute on function public.kb_clip_edit_info(uuid), public.kb_clip_request_edit(uuid, numeric, numeric, jsonb, jsonb, text),
  public.kb_uploads_list(integer), public.kb_upload_delete(uuid), public.kb_plans_recent(integer) to anon, service_role;
grant execute on function public.kb_clip_edit_state(uuid, text, text), public.kb_clip_edit_done(uuid, jsonb, text, bigint) to service_role;
;
