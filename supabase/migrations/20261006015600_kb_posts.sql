-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Posts waiting to go out to Instagram.
 *
 * Instagram has no scheduling of its own, so the waiting happens here: a cron
 * on the Worker wakes every few minutes and takes whatever is due. Publishing
 * is two steps with processing in between — a container is created, Instagram
 * chews on it, and only then can it be published — so a post moves through
 * states rather than being sent in one go, and the cron picks it up wherever
 * it got to.
 *
 * `media` is an array of {url, kind} so one row can be a reel, a single image
 * or a carousel, which are three container shapes rather than three tables.
 *
 * Claiming is why kb_post_claim exists: two cron runs overlapping must not
 * both publish the same post. The claim is an update that only one of them
 * can win. */

create table if not exists kb.posts (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('reel', 'image', 'carousel')),
  media         jsonb not null default '[]'::jsonb,
  caption       text,
  scheduled_for timestamptz not null,
  status        text not null default 'scheduled'
                check (status in ('scheduled', 'working', 'posted', 'failed', 'cancelled')),
  /* Where it got to with Instagram: the container being built, then the id of
   * what was published. */
  container_id  text,
  children      jsonb not null default '[]'::jsonb,
  media_id      text,
  permalink     text,
  error         text,
  attempts      integer not null default 0,
  /* The render it came from, when it came from one, so the page can show the
   * script beside the caption. */
  render_id     uuid,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  posted_at     timestamptz
);

create index if not exists posts_due_idx on kb.posts (scheduled_for) where status in ('scheduled', 'working');
create index if not exists posts_created_idx on kb.posts (created_at desc);

alter table kb.posts enable row level security;

create or replace function public.kb_post_create(
  p_kind text, p_media jsonb, p_caption text, p_when timestamptz,
  p_render_id uuid, p_email text)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v uuid;
begin
  if coalesce(jsonb_array_length(p_media), 0) = 0 then raise exception 'a post needs something to post'; end if;
  if p_when is null then raise exception 'a post needs a time'; end if;

  insert into kb.posts (kind, media, caption, scheduled_for, render_id, created_by)
  values (p_kind, p_media, left(coalesce(p_caption, ''), 2200), p_when, p_render_id,
          left(coalesce(p_email, ''), 254))
  returning id into v;
  return v;
end;
$$;

create or replace function public.kb_posts(p_limit integer default 50)
returns table (id uuid, kind text, media jsonb, caption text, scheduled_for timestamptz,
               status text, permalink text, error text, attempts integer,
               render_id uuid, created_at timestamptz, posted_at timestamptz)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select p.id, p.kind, p.media, p.caption, p.scheduled_for, p.status, p.permalink,
         p.error, p.attempts, p.render_id, p.created_at, p.posted_at
    from kb.posts p
   order by p.scheduled_for desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

create or replace function public.kb_post_read(p_id uuid)
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select to_jsonb(p) - 'created_by' from kb.posts p where p.id = p_id;
$$;

/* Only what has not gone out yet can be changed. */
create or replace function public.kb_post_edit(p_id uuid, p_caption text, p_when timestamptz)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.posts
     set caption = coalesce(left(p_caption, 2200), caption),
         scheduled_for = coalesce(p_when, scheduled_for),
         updated_at = now()
   where id = p_id and status in ('scheduled', 'failed');
  return found;
end;
$$;

create or replace function public.kb_post_cancel(p_id uuid)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.posts set status = 'cancelled', updated_at = now()
   where id = p_id and status in ('scheduled', 'failed');
  return found;
end;
$$;

/* One run takes one post. The where clause is the lock: a second run arriving
 * at the same moment updates nothing and gets nothing back. */
create or replace function public.kb_post_claim()
returns jsonb
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v kb.posts;
begin
  update kb.posts
     set status = 'working', attempts = attempts + 1, updated_at = now()
   where id = (
     select p.id from kb.posts p
      where p.scheduled_for <= now()
        and (p.status = 'scheduled'
             or (p.status = 'working' and p.updated_at < now() - interval '10 minutes'))
        and p.attempts < 5
      order by p.scheduled_for
      limit 1
      for update skip locked)
  returning * into v;
  if not found then return null; end if;
  return to_jsonb(v) - 'created_by';
end;
$$;

create or replace function public.kb_post_state(
  p_id uuid, p_status text, p_container text, p_children jsonb,
  p_media_id text, p_permalink text, p_error text)
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  update kb.posts
     set status = coalesce(p_status, status),
         container_id = coalesce(p_container, container_id),
         children = coalesce(p_children, children),
         media_id = coalesce(p_media_id, media_id),
         permalink = coalesce(p_permalink, permalink),
         error = p_error,
         posted_at = case when p_status = 'posted' then now() else posted_at end,
         updated_at = now()
   where id = p_id;
  return found;
end;
$$;

grant execute on function public.kb_post_create(text, jsonb, text, timestamptz, uuid, text) to anon, authenticated, service_role;
grant execute on function public.kb_posts(integer) to anon, authenticated, service_role;
grant execute on function public.kb_post_read(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_post_edit(uuid, text, timestamptz) to anon, authenticated, service_role;
grant execute on function public.kb_post_cancel(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_post_claim() to anon, authenticated, service_role;
grant execute on function public.kb_post_state(uuid, text, text, jsonb, text, text, text) to anon, authenticated, service_role;;
