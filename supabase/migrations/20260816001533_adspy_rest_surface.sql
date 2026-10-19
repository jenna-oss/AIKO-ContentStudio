-- The adspy schema is deliberately not exposed over PostgREST. These two
-- wrappers in public are the only doors into it: one read, one write. Agents
-- talking SQL through the MCP should keep calling adspy.search_ads directly.

create or replace function public.adspy_search_ads(
  q             text    default null,
  advertiser    text    default null,
  product       text    default null,
  audience      text    default null,
  seen_since    date    default null,
  started_since date    default null,
  max_rows      integer default 40
)
returns table (
  library_id      text,
  advertiser_name text,
  copy            text,
  started         date,
  first_seen      date,
  last_seen       date,
  seen_count      integer,
  source          text,
  product_lines   text[],
  audience_tag    text,
  relevance       real,
  ad_library_url  text
)
language sql
stable
security definer
set search_path = adspy, public, pg_temp
as $$
  select * from adspy.search_ads(
    q, advertiser, product, audience, seen_since, started_since, max_rows
  );
$$;

comment on function public.adspy_search_ads is
  'Read-only door into the ad corpus for clients that speak PostgREST. Wraps adspy.search_ads.';

-- Write path for the daily harvest. Takes the same payload shape that
-- tools/to-sql.mjs emits, so the merge rules live here rather than in the
-- job: first_seen is never overwritten, and last_seen only moves forward.
create or replace function public.adspy_upsert_ads(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = adspy, public, pg_temp
as $$
declare
  n integer;
begin
  insert into adspy.ads
    (library_id, advertiser_name, copy, started, first_seen, last_seen,
     seen_count, source, product_lines, audience)
  select r.library_id, r.advertiser_name, r.copy, r.started, r.first_seen,
         r.last_seen, r.seen_count, r.source, r.product_lines, r.audience
  from jsonb_to_recordset(payload) as r(
    library_id text, advertiser_name text, copy text, started date,
    first_seen date, last_seen date, seen_count integer, source text,
    product_lines text[], audience text
  )
  on conflict (library_id) do update set
    copy          = excluded.copy,
    last_seen     = greatest(adspy.ads.last_seen, excluded.last_seen),
    seen_count    = excluded.seen_count,
    product_lines = excluded.product_lines,
    audience      = excluded.audience,
    updated_at    = now();

  get diagnostics n = row_count;

  insert into adspy.advertisers (name)
  select distinct advertiser_name from adspy.ads
  on conflict (name) do nothing;

  return n;
end;
$$;

comment on function public.adspy_upsert_ads is
  'Write path for the daily harvest. service_role only — a definer function that anon could call would let anyone write the corpus.';

grant execute on function public.adspy_search_ads to anon, authenticated, service_role;

-- Definer functions are granted to public by default. Revoke first, then hand
-- the write path to service_role alone.
revoke execute on function public.adspy_upsert_ads(jsonb) from public, anon, authenticated;
grant  execute on function public.adspy_upsert_ads(jsonb) to service_role;;
