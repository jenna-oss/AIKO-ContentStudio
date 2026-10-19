-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Who may use the marketing tool. Supabase Auth in this project is shared
-- with other AIKO tools, so having an account is not enough: the Worker
-- checks this list at sign-in and on every request. Nothing is added to
-- auth.users itself, because a rule there would block the other tools too.
create table if not exists kb.app_users (
  email text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  note text,
  added_at timestamptz not null default now()
);
-- No policies: read only through the function below.
alter table kb.app_users enable row level security;

create or replace function public.kb_app_user_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path to 'kb', 'public', 'pg_catalog'
as $$
  select exists (select 1 from kb.app_users where email = lower(btrim(coalesce(p_email, ''))));
$$;

revoke all on function public.kb_app_user_allowed(text) from public;
grant execute on function public.kb_app_user_allowed(text) to anon, service_role;;
