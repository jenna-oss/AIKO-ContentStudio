-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- AIKO's ad corpus is AI content tools, video and scheduling apps, and agencies
-- selling to founders, so an ad is filtered by what it sells (category) rather
-- than by a loan product and a broker/borrower audience. The planner's tools
-- (worker/src/ideas.js) send `category`; this is the database side of that.
--
-- product_lines and audience stay on the table, unused, so the older loaders
-- still insert cleanly. The search and count functions drop them from their
-- signatures, which means dropping and recreating rather than replacing.

alter table adspy.ads add column if not exists category text;
create index if not exists ads_category_idx on adspy.ads (category);

comment on column adspy.ads.category is
  'What the ad sells: ai-video, ai-writing, scheduling, repurposing, all-in-one or agency. Null when not yet classified.';

drop function if exists public.adspy_search_ads(text, text, text, text, date, date, integer);
drop function if exists adspy.search_ads(text, text, text, text, date, date, integer);
drop function if exists public.adspy_count_ads(text, text, text, text, date, text);
drop function if exists adspy.count_ads(text, text, text, text, date, text);

create function adspy.search_ads(
  q             text    default null,
  advertiser    text    default null,
  category      text    default null,
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
  category        text,
  relevance       real,
  ad_library_url  text
)
language sql
stable
security invoker
set search_path = adspy, public, pg_temp
as $$
  with parsed as (
    select
      nullif(btrim(coalesce(q, '')), '')               as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq_all,
      (select array_agg(lexeme)
         from unnest(to_tsvector('english', coalesce(q, '')))) as lex
  ),
  built as (
    select p.raw, p.tsq_all,
           -- 'simple', not 'english': these lexemes are already stemmed.
           case when p.lex is null then null
                else to_tsquery('simple', array_to_string(p.lex, ' | ')) end as tsq_any
    from parsed p
  )
  select
    a.library_id,
    a.advertiser_name,
    a.copy,
    a.started,
    a.first_seen,
    a.last_seen,
    a.seen_count,
    a.source,
    a.category,
    case
      when b.raw is null then 0::real
      else ts_rank(a.copy_tsv, b.tsq_any)
           + 3.0 * ts_rank_cd(a.copy_tsv, b.tsq_any)
           + case when a.copy_tsv @@ b.tsq_all then 1.0 else 0.0 end
           + word_similarity(b.raw, a.copy)
    end as relevance,
    'https://www.facebook.com/ads/library/?id=' || a.library_id as ad_library_url
  from adspy.ads a
  cross join built b
  where
        (b.raw is null
         or (b.tsq_any is not null and a.copy_tsv @@ b.tsq_any)
         or b.raw <% a.copy)
    and (search_ads.advertiser is null
         or a.advertiser_name ilike '%' || search_ads.advertiser || '%')
    and (search_ads.category is null or a.category = search_ads.category)
    and (seen_since is null or a.first_seen >= seen_since)
    and (started_since is null or a.started >= started_since)
  order by
    relevance desc,
    a.first_seen desc,
    a.seen_count desc
  limit least(coalesce(max_rows, 40), 500);
$$;

create function public.adspy_search_ads(
  q             text    default null,
  advertiser    text    default null,
  category      text    default null,
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
  category        text,
  relevance       real,
  ad_library_url  text
)
language sql
stable
security invoker
set search_path = adspy, public, pg_temp
as $$
  select * from adspy.search_ads(q, advertiser, category, seen_since, started_since, max_rows);
$$;

comment on function public.adspy_search_ads is
  'Read-only door into the ad corpus for clients that speak PostgREST. Wraps adspy.search_ads.';

create function adspy.count_ads(
  q             text default null,
  advertiser    text default null,
  category      text default null,
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
      and (count_ads.category is null or a.category = count_ads.category)
      and (started_since is null or a.started >= started_since)
  ),
  labelled as (
    select
      case lower(coalesce(group_by, 'advertiser'))
        when 'advertiser' then m.advertiser_name
        when 'category'   then coalesce(m.category, '(untagged)')
        when 'month'      then to_char(m.started, 'YYYY-MM')
        else 'all'
      end as bucket,
      m.advertiser_name, m.started
    from matched m
  ),
  total as (select count(*)::numeric as n from matched)
  select
    l.bucket,
    count(*)                          as ads,
    count(distinct l.advertiser_name) as advertisers,
    min(l.started)                    as earliest,
    max(l.started)                    as latest,
    round(100 * count(*) / nullif((select n from total), 0), 1) as share_percent
  from labelled l
  group by l.bucket
  order by count(*) desc, l.bucket;
$$;

comment on function adspy.count_ads is
  'Exact counts over the whole ad corpus, grouped by advertiser | category | month | none. Use instead of counting search results, which are capped.';

create function public.adspy_count_ads(
  q text default null, advertiser text default null, category text default null,
  started_since date default null, group_by text default 'advertiser'
)
returns table (
  bucket text, ads bigint, advertisers bigint,
  earliest date, latest date, share_percent numeric
)
language sql stable security invoker
set search_path = adspy, public, pg_temp
as $$
  select * from adspy.count_ads(q, advertiser, category, started_since, group_by);
$$;

grant execute on function adspy.search_ads         to anon, authenticated, service_role;
grant execute on function public.adspy_search_ads  to anon, authenticated, service_role;
grant execute on function adspy.count_ads          to anon, authenticated, service_role;
grant execute on function public.adspy_count_ads   to anon, authenticated, service_role;

-- The write path takes category alongside the old fields.
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
     seen_count, source, product_lines, audience, category)
  select r.library_id, r.advertiser_name, r.copy, r.started, r.first_seen,
         r.last_seen, r.seen_count, r.source,
         coalesce(r.product_lines, '{}'), coalesce(r.audience, 'unknown'), r.category
  from jsonb_to_recordset(payload) as r(
    library_id text, advertiser_name text, copy text, started date,
    first_seen date, last_seen date, seen_count integer, source text,
    product_lines text[], audience text, category text
  )
  on conflict (library_id) do update set
    copy          = excluded.copy,
    last_seen     = greatest(adspy.ads.last_seen, excluded.last_seen),
    seen_count    = excluded.seen_count,
    category      = coalesce(excluded.category, adspy.ads.category),
    updated_at    = now();

  get diagnostics n = row_count;

  insert into adspy.advertisers (name)
  select distinct advertiser_name from adspy.ads
  on conflict (name) do nothing;

  return n;
end;
$$;

revoke execute on function public.adspy_upsert_ads(jsonb) from public, anon, authenticated;
grant  execute on function public.adspy_upsert_ads(jsonb) to service_role;
