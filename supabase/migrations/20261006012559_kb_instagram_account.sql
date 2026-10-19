-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

/* Connecting an Instagram account, so the app can publish to it.
 *
 * The token is stored encrypted and this schema never sees the key. That is
 * deliberate: this Supabase project is shared with other AIKO tools, so any of
 * them holding the project's anon key can call a public.kb_* function —
 * including kb_ig_secret below. What that returns is ciphertext; the key lives
 * only in the Worker, as INSTAGRAM_TOKEN_KEY. Losing the anon key should not
 * mean losing the Instagram account.
 *
 * The ticket table exists because an OAuth redirect is a browser navigation
 * and cannot carry our Authorization header. A signed-in page asks for a
 * ticket, Instagram hands it back as `state`, and the callback is only
 * believed if the ticket is one we issued, unused, and minutes old. */

create table if not exists kb.ig_account (
  id            uuid primary key default gen_random_uuid(),
  ig_user_id    text not null unique,
  username      text,
  token_cipher  text not null,
  token_iv      text not null,
  expires_at    timestamptz,
  connected_by  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists kb.ig_ticket (
  ticket     uuid primary key default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

alter table kb.ig_account enable row level security;
alter table kb.ig_ticket enable row level security;

create or replace function public.kb_ig_ticket_new(p_email text)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v uuid;
begin
  delete from kb.ig_ticket where created_at < now() - interval '1 day';
  insert into kb.ig_ticket (email) values (left(coalesce(p_email, ''), 254)) returning ticket into v;
  return v;
end;
$$;

/* One use, ten minutes. Returns who asked for it, or nothing. */
create or replace function public.kb_ig_ticket_take(p_ticket uuid)
returns text
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v text;
begin
  update kb.ig_ticket
     set used_at = now()
   where ticket = p_ticket
     and used_at is null
     and created_at > now() - interval '10 minutes'
  returning email into v;
  return v;
end;
$$;

create or replace function public.kb_ig_save(
  p_ig_user_id text, p_username text, p_cipher text, p_iv text,
  p_expires timestamptz, p_email text)
returns uuid
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
declare v uuid;
begin
  if btrim(coalesce(p_cipher, '')) = '' then raise exception 'a connection needs a token'; end if;
  insert into kb.ig_account (ig_user_id, username, token_cipher, token_iv, expires_at, connected_by)
  values (p_ig_user_id, left(coalesce(p_username, ''), 120), p_cipher, p_iv, p_expires,
          left(coalesce(p_email, ''), 254))
  on conflict (ig_user_id) do update
    set username = excluded.username, token_cipher = excluded.token_cipher,
        token_iv = excluded.token_iv, expires_at = excluded.expires_at,
        connected_by = excluded.connected_by, updated_at = now()
  returning id into v;
  return v;
end;
$$;

/* What the page is allowed to know: that it is connected, to whom, and until
 * when. No token material. */
create or replace function public.kb_ig_account()
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select jsonb_build_object(
           'ig_user_id', a.ig_user_id, 'username', a.username,
           'expires_at', a.expires_at, 'connected_at', a.created_at)
    from kb.ig_account a order by a.updated_at desc limit 1;
$$;

/* The encrypted token, for the Worker to open. */
create or replace function public.kb_ig_secret()
returns jsonb
language sql stable security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
  select jsonb_build_object(
           'ig_user_id', a.ig_user_id, 'cipher', a.token_cipher,
           'iv', a.token_iv, 'expires_at', a.expires_at)
    from kb.ig_account a order by a.updated_at desc limit 1;
$$;

create or replace function public.kb_ig_forget()
returns boolean
language plpgsql security definer
set search_path to 'kb', 'public', 'extensions', 'pg_catalog'
as $$
begin
  delete from kb.ig_account;
  return true;
end;
$$;

grant execute on function public.kb_ig_ticket_new(text) to anon, authenticated, service_role;
grant execute on function public.kb_ig_ticket_take(uuid) to anon, authenticated, service_role;
grant execute on function public.kb_ig_save(text, text, text, text, timestamptz, text) to anon, authenticated, service_role;
grant execute on function public.kb_ig_account() to anon, authenticated, service_role;
grant execute on function public.kb_ig_secret() to anon, authenticated, service_role;
grant execute on function public.kb_ig_forget() to anon, authenticated, service_role;;
