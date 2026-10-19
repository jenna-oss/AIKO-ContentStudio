-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Clips cut out of a take.
 *
 * A clip is a window on the raw footage — a start and an end in seconds —
 * plus the words said inside it, carried over from the take's transcript with
 * their timings rebased to the clip's own clock. That is what lets the
 * captions land on the word in the rendered short without transcribing
 * anything twice.
 *
 * `hook` is the sentence the clip opens on, which is the whole reason the
 * clip exists: only passages that open on something worth opening on are
 * kept. `why` is the agent's reasoning, kept so a bad run can be read rather
 * than guessed at.
 *
 * Both the Worker and the cutting workflow write here, so everything goes
 * through these wrappers rather than two different sets of SQL. */

create table if not exists kb.clips (
  id          uuid primary key default gen_random_uuid(),
  footage_id  uuid not null references kb.footage(id) on delete cascade,
  idx         integer not null default 1,
  start_s     numeric not null,
  end_s       numeric not null,
  hook        text,
  why         text,
  /* [{ t, s, e }] with s and e relative to the clip, not the take. */
  words       jsonb not null default '[]'::jsonb,
  status      text not null default 'suggested'
              check (status in ('suggested', 'rendering', 'ready', 'failed', 'rejected')),
  url         text,
  bytes       bigint,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists clips_footage_idx on kb.clips (footage_id, idx);
alter table kb.clips enable row level security;

create or replace function public.kb_clip_create(
  p_footage uuid, p_idx integer, p_start numeric, p_end numeric,
  p_hook text, p_why text, p_words jsonb)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v uuid;
begin
  if p_end <= p_start then raise exception 'a clip ends after it starts'; end if;
  insert into kb.clips (footage_id, idx, start_s, end_s, hook, why, words)
  values (p_footage, p_idx, p_start, p_end, left(coalesce(p_hook, ''), 400),
          left(coalesce(p_why, ''), 600), coalesce(p_words, '[]'::jsonb))
  returning id into v;
  return v;
end;
$$;

create or replace function public.kb_clip_state(p_id uuid, p_status text, p_url text, p_bytes bigint, p_error text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.clips
     set status = coalesce(p_status, status),
         url = coalesce(p_url, url),
         bytes = coalesce(p_bytes, bytes),
         error = p_error,
         updated_at = now()
   where id = p_id;
  return found;
end;
$$;

/* Everything cut from one take, newest take first when no take is named. */
create or replace function public.kb_clips(p_footage uuid default null, p_limit integer default 100)
returns table (id uuid, footage_id uuid, idx integer, start_s numeric, end_s numeric,
               hook text, why text, status text, url text, error text, created_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select c.id, c.footage_id, c.idx, c.start_s, c.end_s, c.hook, c.why,
         c.status, c.url, c.error, c.created_at
    from kb.clips c
   where p_footage is null or c.footage_id = p_footage
   order by c.footage_id, c.idx
   limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

/* With the words, for the renderer. */
create or replace function public.kb_clip_read(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(c) from kb.clips c where c.id = p_id;
$$;

create or replace function public.kb_clip_reject(p_id uuid, p_rejected boolean)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.clips
     set status = case when p_rejected then 'rejected' else 'ready' end, updated_at = now()
   where id = p_id and status in ('ready', 'rejected');
  return found;
end;
$$;

grant execute on function public.kb_clip_create(uuid, integer, numeric, numeric, text, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.kb_clip_state(uuid, text, text, bigint, text) to anon, authenticated, service_role;
grant execute on function public.kb_clips(uuid, integer) to anon, authenticated, service_role;
grant execute on function public.kb_clip_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_clip_reject(uuid, boolean) to anon, authenticated, service_role;;
