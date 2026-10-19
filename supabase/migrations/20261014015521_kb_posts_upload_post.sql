-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Upload-Post carries all four platforms; YouTube and TikTok join the list.
alter table kb.posts drop constraint if exists posts_platform_check;
alter table kb.posts add constraint posts_platform_check
  check (platform in ('instagram', 'facebook', 'youtube', 'tiktok'));
-- YouTube needs a title of its own; the others use the caption.
alter table kb.posts add column if not exists title text;

-- Small settings the Worker keeps, such as which Facebook Page Upload-Post
-- posts to when the connected account manages several.
create table if not exists kb.social_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
alter table kb.social_settings enable row level security;

create or replace function public.kb_social_get(p_key text)
returns text language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select value from kb.social_settings where key = p_key;
$$;

create or replace function public.kb_social_set(p_key text, p_value text)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  insert into kb.social_settings (key, value) values (left(p_key, 64), left(p_value, 200))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return true;
end; $$;

drop function if exists public.kb_post_create(text, jsonb, text, timestamptz, uuid, text, text);
create or replace function public.kb_post_create(p_kind text, p_media jsonb, p_caption text, p_when timestamptz,
                                                 p_render_id uuid, p_email text, p_platform text default 'instagram',
                                                 p_title text default null)
returns uuid language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
declare v uuid;
begin
  if coalesce(jsonb_array_length(p_media), 0) = 0 then raise exception 'a post needs something to post'; end if;
  if p_when is null then raise exception 'a post needs a time'; end if;
  insert into kb.posts (kind, media, caption, scheduled_for, render_id, created_by, platform, title)
  values (p_kind, p_media, left(coalesce(p_caption, ''), 2200), p_when, p_render_id,
          left(coalesce(p_email, ''), 254), coalesce(p_platform, 'instagram'), left(p_title, 100))
  returning id into v;
  return v;
end; $$;;
