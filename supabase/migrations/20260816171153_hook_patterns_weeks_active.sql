-- The REST insights endpoint returns clusters with only {id, label, rawDelta,
-- percentDelta} — no per-pattern volume. The `total` values already in this
-- table came from the MCP surface, which does expose one, and they must not be
-- overwritten with zeros by a refresh that simply cannot see them.
--
-- weeks_active is what REST *can* tell us: how many weekly buckets in the
-- window the pattern appeared in. It is a persistence signal, not a volume, and
-- is kept in its own column rather than smuggled into total.
alter table adspy.hook_patterns
  add column if not exists weeks_active integer;

comment on column adspy.hook_patterns.total is
  'Times the pattern was used, from the Spyglass MCP surface. The REST insights endpoint does not expose this, so a scheduled refresh leaves it untouched rather than zeroing it.';

comment on column adspy.hook_patterns.weeks_active is
  'Weekly buckets in which the pattern appeared. Persistence, not volume — a pattern used once a week for eight weeks scores higher here than a burst of twenty in one week.';

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
    (brand_id, brand_name, category, insight_type, label, total,
     raw_delta, percent_delta, weeks_active, captured_at)
  select r.brand_id, r.brand_name, r.category, upper(r.insight_type), r.label,
         r.total, r.raw_delta, r.percent_delta, r.weeks_active, current_date
  from jsonb_to_recordset(payload) as r(
    brand_id text, brand_name text, category text, insight_type text,
    label text, total integer, raw_delta integer, percent_delta numeric,
    weeks_active integer
  )
  on conflict (brand_id, insight_type, label) do update set
    -- Never let an absent volume overwrite a known one.
    total         = coalesce(excluded.total, adspy.hook_patterns.total),
    raw_delta     = excluded.raw_delta,
    percent_delta = excluded.percent_delta,
    weeks_active  = excluded.weeks_active,
    brand_name    = excluded.brand_name,
    category      = coalesce(excluded.category, adspy.hook_patterns.category),
    captured_at   = current_date;
    -- muted is deliberately not touched: a refresh must not un-mute noise.

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.hook_patterns_upsert(jsonb) from public, anon, authenticated;
grant  execute on function public.hook_patterns_upsert(jsonb) to service_role;;
