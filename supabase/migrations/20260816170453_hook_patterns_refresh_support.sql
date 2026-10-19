-- Automated refresh loads whatever Spyglass returns, including the creator-
-- content noise that was filtered by hand on the first load. Muting keeps that
-- judgement visible and reversible instead of re-deleting rows every refresh.
alter table adspy.hook_patterns
  add column if not exists muted boolean not null default false;

comment on column adspy.hook_patterns.muted is
  'Set true for patterns with no bearing on financial creative (song lyrics, seasonal personas). Excluded from search; survives refresh.';

-- Write path for the scheduled refresh. service_role only, like the others.
create or replace function public.hook_patterns_upsert(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = adspy, public, pg_temp
as $$
declare
  n integer;
begin
  insert into adspy.hook_patterns
    (brand_id, brand_name, category, insight_type, label, total, raw_delta, percent_delta, captured_at)
  select r.brand_id, r.brand_name, r.category, upper(r.insight_type), r.label,
         r.total, r.raw_delta, r.percent_delta, current_date
  from jsonb_to_recordset(payload) as r(
    brand_id text, brand_name text, category text, insight_type text,
    label text, total integer, raw_delta integer, percent_delta numeric
  )
  on conflict (brand_id, insight_type, label) do update set
    total         = excluded.total,
    raw_delta     = excluded.raw_delta,
    percent_delta = excluded.percent_delta,
    brand_name    = excluded.brand_name,
    category      = coalesce(excluded.category, adspy.hook_patterns.category),
    captured_at   = current_date;
    -- muted is deliberately not touched: a refresh must not un-mute noise.

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.hook_patterns_upsert is
  'Write path for the scheduled Spyglass refresh. service_role only. Never clears the muted flag.';

revoke execute on function public.hook_patterns_upsert(jsonb) from public, anon, authenticated;
grant  execute on function public.hook_patterns_upsert(jsonb) to service_role;;
