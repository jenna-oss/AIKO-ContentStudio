-- Single entry point for agents. Full-text when a query is given, trigram as a
-- fallback so misspelled advertiser names and partial phrases still land, plus
-- the structured filters an agent actually asks for.
create or replace function adspy.search_ads(
  q          text    default null,
  advertiser text    default null,
  product    text    default null,
  audience   text    default null,
  seen_since date    default null,
  started_since date default null,
  max_rows   integer default 40
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
security invoker
set search_path = adspy, public, pg_temp
as $$
  select
    a.library_id,
    a.advertiser_name,
    a.copy,
    a.started,
    a.first_seen,
    a.last_seen,
    a.seen_count,
    a.source,
    a.product_lines,
    a.audience as audience_tag,
    case
      when q is null or q = '' then 0::real
      else greatest(
             ts_rank(a.copy_tsv, websearch_to_tsquery('english', q)),
             similarity(a.copy, q)
           )
    end as relevance,
    'https://www.facebook.com/ads/library/?id=' || a.library_id as ad_library_url
  from adspy.ads a
  where
        (q is null or q = ''
         or a.copy_tsv @@ websearch_to_tsquery('english', q)
         or a.copy % q)
    and (search_ads.advertiser is null
         or a.advertiser_name ilike '%' || search_ads.advertiser || '%')
    and (product is null or product = any(a.product_lines))
    and (search_ads.audience is null or a.audience = search_ads.audience)
    and (seen_since is null or a.first_seen >= seen_since)
    and (started_since is null or a.started >= started_since)
  order by
    case when q is null or q = '' then 0 else 1 end desc,
    relevance desc,
    a.first_seen desc,
    a.seen_count desc
  limit least(coalesce(max_rows, 40), 500);
$$;

comment on function adspy.search_ads is
  'Agent retrieval entry point. Pass q for relevance search, or omit it and use the filters alone to browse. relevance is 0 when no query was supplied.';

-- Who is spending, at a glance. Cheaper than making an agent aggregate by hand.
create or replace view adspy.advertiser_summary as
select
  a.advertiser_name,
  count(*)                                as ad_count,
  min(a.started)                          as earliest_ad,
  max(a.started)                          as latest_ad,
  min(a.first_seen)                       as first_observed,
  max(a.last_seen)                        as last_observed,
  array_agg(distinct pl)
    filter (where pl is not null)         as product_lines,
  mode() within group (order by a.audience) as primary_audience
from adspy.ads a
left join lateral unnest(a.product_lines) as pl on true
group by a.advertiser_name;

grant execute on function adspy.search_ads to anon, authenticated, service_role;
grant select on adspy.advertiser_summary to anon, authenticated, service_role;;
