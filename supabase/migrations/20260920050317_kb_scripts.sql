-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Scripts for solo talking-head videos: the ones you read to camera, as
 * opposed to the narration the render pipeline speaks over b-roll. A planned
 * slot can go either way, so a script is tied back to the plan session and
 * slot it came from rather than to a render.
 *
 * One script per slot. Writing it again replaces what was there: a slot has
 * one script the way it has one video, and a pile of versions is a thing to
 * manage rather than a thing to film.
 *
 * Only the SECURITY DEFINER wrappers below reach the table; RLS is on with no
 * policies, as everywhere else in kb. */

create table if not exists kb.scripts (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  slot        integer not null,
  topic       text,
  angle       text,
  /* The opening line the plan asked for, kept beside what was written so a
   * script that drifted off its own hook is visible. */
  hook        text,
  lines       jsonb not null default '[]'::jsonb,
  words       integer,
  status      text not null default 'written' check (status in ('written', 'filmed')),
  /* What the brand-voice lint said when it was written, so the page can show
   * it without asking again. */
  flags       jsonb not null default '[]'::jsonb,
  written_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists scripts_slot_idx on kb.scripts (session_id, slot);
create index if not exists scripts_created_idx on kb.scripts (created_at desc);

alter table kb.scripts enable row level security;

create or replace function public.kb_script_save(
  p_session text, p_slot integer, p_topic text, p_angle text, p_hook text,
  p_lines jsonb, p_words integer, p_flags jsonb, p_email text)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v_id uuid;
begin
  if coalesce(jsonb_array_length(p_lines), 0) = 0 then raise exception 'a script needs lines'; end if;

  insert into kb.scripts (session_id, slot, topic, angle, hook, lines, words, flags, written_by)
  values (left(btrim(coalesce(p_session, '')), 64), p_slot,
          left(coalesce(p_topic, ''), 400), left(coalesce(p_angle, ''), 600),
          left(coalesce(p_hook, ''), 400), p_lines, p_words,
          coalesce(p_flags, '[]'::jsonb), left(coalesce(p_email, ''), 254))
  on conflict (session_id, slot) do update
    set topic = excluded.topic, angle = excluded.angle, hook = excluded.hook,
        lines = excluded.lines, words = excluded.words, flags = excluded.flags,
        status = 'written', updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.kb_scripts(p_limit integer default 50)
returns table (id uuid, session_id text, slot integer, topic text, hook text,
               words integer, status text, lines integer,
               created_at timestamptz, updated_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select s.id, s.session_id, s.slot, s.topic, s.hook, s.words, s.status,
         jsonb_array_length(s.lines), s.created_at, s.updated_at
    from kb.scripts s
   order by s.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.kb_script_read(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(s) - 'written_by' from kb.scripts s where s.id = p_id;
$$;

create or replace function public.kb_script_lines(p_id uuid, p_lines jsonb, p_words integer, p_flags jsonb)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  if coalesce(jsonb_array_length(p_lines), 0) = 0 then raise exception 'a script needs lines'; end if;
  update kb.scripts
     set lines = p_lines, words = p_words, flags = coalesce(p_flags, '[]'::jsonb), updated_at = now()
   where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_script_status(p_id uuid, p_status text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  if p_status not in ('written', 'filmed') then raise exception 'a script is written or filmed'; end if;
  update kb.scripts set status = p_status, updated_at = now() where id = p_id;
  return found;
end;
$$;

create or replace function public.kb_script_delete(p_id uuid)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  delete from kb.scripts where id = p_id;
  return found;
end;
$$;

grant execute on function public.kb_script_save(text, integer, text, text, text, jsonb, integer, jsonb, text) to anon, authenticated, service_role;
grant execute on function public.kb_scripts(integer) to anon, authenticated, service_role;
grant execute on function public.kb_script_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_script_lines(uuid, jsonb, integer, jsonb) to anon, authenticated, service_role;
grant execute on function public.kb_script_status(uuid, text) to anon, authenticated, service_role;
grant execute on function public.kb_script_delete(uuid) to anon, authenticated, service_role;;
