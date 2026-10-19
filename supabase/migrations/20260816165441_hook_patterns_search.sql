create or replace function adspy.search_hook_patterns(
  q            text    default null,
  insight_type text    default null,
  brand        text    default null,
  min_total    integer default null,
  max_rows     integer default 25
)
returns table (
  brand_name    text,
  type_tag      text,
  label         text,
  total         integer,
  raw_delta     integer,
  percent_delta numeric,
  captured_at   date,
  relevance     real
)
language sql
stable
security invoker
set search_path = adspy, public, pg_temp
as $$
  with built as (
    select
      nullif(btrim(coalesce(q, '')), '')               as raw,
      websearch_to_tsquery('english', coalesce(q, '')) as tsq_all,
      -- 'simple', because these lexemes come out of to_tsvector already
      -- stemmed and stemming them twice matches nothing.
      (select case when array_agg(lexeme) is null then null
                   else to_tsquery('simple', string_agg(lexeme, ' | ')) end
         from unnest(to_tsvector('english', coalesce(q, '')))) as tsq_any
  )
  select
    h.brand_name,
    h.insight_type as type_tag,
    h.label,
    h.total,
    h.raw_delta,
    h.percent_delta,
    h.captured_at,
    case
      when b.raw is null then 0::real
      else ts_rank(h.label_tsv, b.tsq_any)
           + case when h.label_tsv @@ b.tsq_all then 1.0 else 0.0 end
           + word_similarity(b.raw, h.label)
    end as relevance
  from adspy.hook_patterns h
  cross join built b
  where
        (b.raw is null
         or (b.tsq_any is not null and h.label_tsv @@ b.tsq_any)
         or b.raw <% h.label)
    and (search_hook_patterns.insight_type is null
         or h.insight_type = upper(search_hook_patterns.insight_type))
    and (search_hook_patterns.brand is null
         or h.brand_name ilike '%' || search_hook_patterns.brand || '%')
    and (min_total is null or h.total >= min_total)
  order by relevance desc, h.total desc
  limit least(coalesce(max_rows, 25), 200);
$$;

comment on function adspy.search_hook_patterns is
  'Creative structure — how an ad opens (HOOK) or what it claims (USP) — from adjacent finance advertisers. These brands are NOT Trilith competitors; the patterns are forms to adapt, never evidence of what a competitor is doing.';

create or replace function public.hook_patterns_search(
  q            text    default null,
  insight_type text    default null,
  brand        text    default null,
  min_total    integer default null,
  max_rows     integer default 25
)
returns table (
  brand_name text, type_tag text, label text, total integer,
  raw_delta integer, percent_delta numeric, captured_at date, relevance real
)
language sql
stable
security invoker
set search_path = adspy, public, pg_temp
as $$
  select * from adspy.search_hook_patterns(q, insight_type, brand, min_total, max_rows);
$$;

grant execute on function adspy.search_hook_patterns  to anon, authenticated, service_role;
grant execute on function public.hook_patterns_search to anon, authenticated, service_role;;
