-- Brought in line with content.search_content. The original ANDed every query
-- term via websearch_to_tsquery, so a multi-word question only matched an ad
-- containing all of it; trigram similarity() papered over that on short copy
-- but fails as soon as an ad runs long. Match any term, rank so ads carrying
-- all of them win, and use word_similarity for the fuzzy path since it scores
-- a query against a *portion* of the copy rather than the whole string.
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
  with parsed as (
    select
      nullif(btrim(coalesce(q, '')), '')               as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq_all,
      (select array_agg(lexeme)
         from unnest(to_tsvector('english', coalesce(q, '')))) as lex
  ),
  built as (
    select p.raw, p.tsq_all,
           -- 'simple', not 'english': these lexemes are already stemmed and
           -- stemming them twice turns 'apprais' into 'apprai', which matches
           -- nothing at all.
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
    a.product_lines,
    a.audience as audience_tag,
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
    and (product is null or product = any(a.product_lines))
    and (search_ads.audience is null or a.audience = search_ads.audience)
    and (seen_since is null or a.first_seen >= seen_since)
    and (started_since is null or a.started >= started_since)
  order by
    relevance desc,
    a.first_seen desc,
    a.seen_count desc
  limit least(coalesce(max_rows, 40), 500);
$$;;
