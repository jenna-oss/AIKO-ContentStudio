-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Where finished videos live, and the record tying each one back to the brief.
--
-- Until now a render existed for fourteen days as a zip on an Actions page and
-- was then deleted, with nothing connecting it to the plan that produced it.
-- Re-rendering is not a recovery path either: the Assembly agent writes a fresh
-- component each run, so the same brief does not give back the same video.
--
-- Private, unlike the two existing buckets. These are drafts nobody has watched
-- yet, going out under a client's brand; a guessable URL is the wrong default
-- for that. Reviewers get a signed link. Flip `public` to true if that friction
-- outweighs the risk.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('videos', 'videos', false, 524288000, array['video/mp4'])
on conflict (id) do nothing;

create table if not exists kb.video_renders (
    id            uuid primary key default gen_random_uuid(),
    brand_id      uuid not null references kb.brands(id) on delete cascade,

    session_id    text,
    slot          integer,
    topic         text not null,

    /* Path within the videos bucket. The URL is minted from this on demand
     * rather than stored: a signed URL expires, and a dead link in a database
     * is worse than no link. */
    storage_path  text,
    bytes         bigint,
    duration_seconds numeric(8,2),

    status        text not null default 'rendered'
                  check (status in ('rendered', 'failed', 'reviewed', 'published')),
    error         text,

    /* The Actions run, so a bad video leads straight to the log that made it. */
    run_url       text,
    composition   text,

    metadata      jsonb not null default '{}'::jsonb,
    rendered_at   timestamptz not null default now()
);

create index if not exists video_renders_session on kb.video_renders (session_id, slot);
create index if not exists video_renders_recent on kb.video_renders (brand_id, rendered_at desc);

comment on table kb.video_renders is
  'One row per render attempt, successful or not. Ties a finished mp4 in the '
  'videos bucket back to the planning session and slot it came from.';

alter table kb.video_renders enable row level security;

drop policy if exists video_renders_read on kb.video_renders;
create policy video_renders_read on kb.video_renders
    for select to anon, authenticated using (true);
grant select on kb.video_renders to anon, authenticated;

create or replace function public.kb_record_render(payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare v_brand uuid; v_id uuid;
begin
    v_brand := (select id from kb.brands where slug = coalesce(payload ->> 'brand_slug', 'aiko'));
    if v_brand is null then raise exception 'unknown brand'; end if;

    insert into kb.video_renders (
        brand_id, session_id, slot, topic, storage_path, bytes,
        duration_seconds, status, error, run_url, composition, metadata
    )
    values (
        v_brand,
        left(payload ->> 'session_id', 64),
        (payload ->> 'slot')::integer,
        coalesce(payload ->> 'topic', 'untitled'),
        payload ->> 'storage_path',
        (payload ->> 'bytes')::bigint,
        (payload ->> 'duration_seconds')::numeric,
        coalesce(payload ->> 'status', 'rendered'),
        payload ->> 'error',
        payload ->> 'run_url',
        payload ->> 'composition',
        coalesce(payload -> 'metadata', '{}'::jsonb)
    )
    returning id into v_id;

    return v_id;
end;
$fn$;

revoke execute on function public.kb_record_render(jsonb) from public, anon, authenticated;
grant execute on function public.kb_record_render(jsonb) to service_role;
alter function public.kb_record_render(jsonb) set search_path = kb, public, extensions, pg_catalog;;
