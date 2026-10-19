-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Facebook Login replaces Instagram Login: one approval gives a Page and the
-- Instagram account linked to it. kb.ig_account was never used (0 rows).
drop function if exists public.kb_ig_account();
drop function if exists public.kb_ig_secret();
drop function if exists public.kb_ig_save(text, text, text, text, timestamptz, text);
drop function if exists public.kb_ig_forget();
drop table if exists kb.ig_account;

create table kb.meta_pages (
  page_id      text primary key,
  page_name    text not null default '',
  ig_user_id   text,
  ig_username  text,
  token_cipher text not null,
  token_iv     text not null,
  selected     boolean not null default false,
  connected_by text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table kb.meta_pages enable row level security;
create unique index meta_pages_one_selected on kb.meta_pages (selected) where selected;

-- Every Page the approval covered, replacing what was there. With only one,
-- it is chosen; otherwise the previous choice is kept if it is still there.
create or replace function public.kb_meta_save(p_pages jsonb, p_email text)
returns integer language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
declare v_prev text; v_n integer;
begin
  if coalesce(jsonb_array_length(p_pages), 0) = 0 then raise exception 'no pages to save'; end if;
  select page_id into v_prev from kb.meta_pages where selected;
  delete from kb.meta_pages;
  insert into kb.meta_pages (page_id, page_name, ig_user_id, ig_username, token_cipher, token_iv, connected_by)
  select p->>'page_id', left(coalesce(p->>'page_name', ''), 200), nullif(p->>'ig_user_id', ''),
         left(nullif(p->>'ig_username', ''), 120), p->>'cipher', p->>'iv', left(coalesce(p_email, ''), 254)
    from jsonb_array_elements(p_pages) p
   where coalesce(p->>'page_id', '') <> '' and coalesce(p->>'cipher', '') <> '';
  get diagnostics v_n = row_count;
  if v_n = 1 then
    update kb.meta_pages set selected = true;
  elsif v_prev is not null then
    update kb.meta_pages set selected = true where page_id = v_prev;
  end if;
  return v_n;
end; $$;

-- What the page shows: never the tokens.
create or replace function public.kb_meta_account()
returns jsonb language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'page_id', m.page_id, 'page_name', m.page_name, 'ig_user_id', m.ig_user_id,
           'ig_username', m.ig_username, 'selected', m.selected, 'connected_at', m.created_at)
         order by m.selected desc, m.page_name), '[]'::jsonb)
    from kb.meta_pages m;
$$;

create or replace function public.kb_meta_pick(p_page_id text)
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  if not exists (select 1 from kb.meta_pages where page_id = p_page_id) then return false; end if;
  update kb.meta_pages set selected = false, updated_at = now() where selected;
  update kb.meta_pages set selected = true, updated_at = now() where page_id = p_page_id;
  return true;
end; $$;

-- The chosen Page with its (encrypted) token, for the scheduler.
create or replace function public.kb_meta_secret()
returns jsonb language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select jsonb_build_object('page_id', m.page_id, 'page_name', m.page_name,
           'ig_user_id', m.ig_user_id, 'cipher', m.token_cipher, 'iv', m.token_iv)
    from kb.meta_pages m where m.selected limit 1;
$$;

create or replace function public.kb_meta_forget()
returns boolean language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
begin
  delete from kb.meta_pages where true;
  return true;
end; $$;

-- One row per platform, so each keeps its own state, link and error.
alter table kb.posts add column platform text not null default 'instagram'
  check (platform in ('instagram', 'facebook'));

drop function if exists public.kb_post_create(text, jsonb, text, timestamptz, uuid, text);
create or replace function public.kb_post_create(p_kind text, p_media jsonb, p_caption text, p_when timestamptz,
                                                 p_render_id uuid, p_email text, p_platform text default 'instagram')
returns uuid language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
declare v uuid;
begin
  if coalesce(jsonb_array_length(p_media), 0) = 0 then raise exception 'a post needs something to post'; end if;
  if p_when is null then raise exception 'a post needs a time'; end if;
  insert into kb.posts (kind, media, caption, scheduled_for, render_id, created_by, platform)
  values (p_kind, p_media, left(coalesce(p_caption, ''), 2200), p_when, p_render_id,
          left(coalesce(p_email, ''), 254), coalesce(p_platform, 'instagram'))
  returning id into v;
  return v;
end; $$;

drop function if exists public.kb_posts(integer);
create function public.kb_posts(p_limit integer default 50)
returns table(id uuid, kind text, media jsonb, caption text, scheduled_for timestamptz, status text,
              permalink text, error text, attempts integer, render_id uuid, created_at timestamptz,
              posted_at timestamptz, platform text)
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog' as $$
  select p.id, p.kind, p.media, p.caption, p.scheduled_for, p.status, p.permalink,
         p.error, p.attempts, p.render_id, p.created_at, p.posted_at, p.platform
    from kb.posts p
   order by p.scheduled_for desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;;
