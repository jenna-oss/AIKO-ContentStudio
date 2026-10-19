-- Exhaustive counting was the one thing the whole-corpus ask page did better
-- than retrieval: it saw every ad at once, where a search returns 40. This
-- replaces that property with something stronger — the count is computed by
-- Postgres over every row, so it is exact rather than a model tallying text,
-- and it costs a few hundred tokens instead of a 135k-token prompt.
create or replace function adspy.count_ads(
  q             text default null,
  advertiser    text default null,
  product       text default null,
  audience      text default null,
  started_since date default null,
  group_by      text default 'advertiser'
)
returns table (
  bucket        text,
  ads           bigint,
  advertisers   bigint,
  earliest      date,
  latest        date,
  share_percent numeric
)
language sql
stable
security invoker
set search_path = adspy, public, pg_temp
as $$
  with built as (
    select
      nullif(btrim(coalesce(q, '')), '') as raw,
      (select case when array_agg(lexeme) is null then null
                   else to_tsquery('simple', string_agg(lexeme, ' | ')) end
         from unnest(to_tsvector('english', coalesce(q, '')))) as tsq_any
  ),
  matched as (
    select a.*
    from adspy.ads a
    cross join built b
    where
          (b.raw is null
           or (b.tsq_any is not null and a.copy_tsv @@ b.tsq_any)
           or b.raw <% a.copy)
      and (count_ads.advertiser is null
           or a.advertiser_name ilike '%' || count_ads.advertiser || '%')
      and (count_ads.product is null or count_ads.product = any(a.product_lines))
      and (count_ads.audience is null or a.audience = count_ads.audience)
      and (started_since is null or a.started >= started_since)
  ),
  labelled as (
    select
      case lower(coalesce(group_by, 'advertiser'))
        when 'advertiser' then m.advertiser_name
        when 'audience'   then m.audience
        when 'month'      then to_char(m.started, 'YYYY-MM')
        when 'product'    then coalesce(pl, '(untagged)')
        else 'all'
      end as bucket,
      m.advertiser_name, m.started
    from matched m
    left join lateral unnest(
      case when lower(coalesce(group_by, 'advertiser')) = 'product'
           then m.product_lines else null end
    ) as pl on true
  ),
  total as (select count(*)::numeric as n from matched)
  select
    l.bucket,
    count(*)                      as ads,
    count(distinct l.advertiser_name) as advertisers,
    min(l.started)                as earliest,
    max(l.started)                as latest,
    round(100 * count(*) / nullif((select n from total), 0), 1) as share_percent
  from labelled l
  group by l.bucket
  order by count(*) desc, l.bucket;
$$;

comment on function adspy.count_ads is
  'Exact counts over the whole ad corpus, grouped by advertiser | product | audience | month | none. Use instead of counting search results, which are capped.';

create or replace function public.adspy_count_ads(
  q text default null, advertiser text default null, product text default null,
  audience text default null, started_since date default null,
  group_by text default 'advertiser'
)
returns table (
  bucket text, ads bigint, advertisers bigint,
  earliest date, latest date, share_percent numeric
)
language sql stable security invoker
set search_path = adspy, public, pg_temp
as $$
  select * from adspy.count_ads(q, advertiser, product, audience, started_since, group_by);
$$;

grant execute on function adspy.count_ads  to anon, authenticated, service_role;
grant execute on function public.adspy_count_ads to anon, authenticated, service_role;;
