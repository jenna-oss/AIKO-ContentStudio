-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Hook patterns not yet adapted into the hook library.
--
-- adspy.hook_patterns holds creative structure from seven advertisers OUTSIDE
-- the lending category. Those rows are labels, not templates, and they are not
-- competitor intelligence. Adapting one into a usable hook is a rewrite, and
-- kb.hooks records where it came from so the planner can say so.
--
-- The table's key is (brand_id, insight_type, label) with no surrogate id, so
-- origin_ref is a digest of it: stable across refreshes, short enough to index,
-- and it survives the label being re-lowercased upstream only if the label
-- itself is unchanged — which is the behaviour we want, since a changed label
-- is a different pattern.
create or replace function public.kb_hook_seed_source(p_limit integer default 40)
returns table (
    pattern_ref text, brand_name text, category text, label text,
    total integer, weeks_active integer
)
language sql
security definer
set search_path = kb, public, adspy, extensions
as $fn$
    select
        h.brand_id || ':' || md5(h.label) as pattern_ref,
        h.brand_name, h.category, h.label, h.total, h.weeks_active
    from adspy.hook_patterns h
    left join kb.hooks k
           on k.origin = 'hook_patterns'
          and k.origin_ref = h.brand_id || ':' || md5(h.label)
    where not h.muted
      and k.id is null
      and h.insight_type = 'HOOK'
    order by coalesce(h.total, 0) desc, h.weeks_active desc nulls last
    limit greatest(1, least(coalesce(p_limit, 40), 200));
$fn$;

create or replace function public.kb_upsert_hooks(payload jsonb)
returns integer
language plpgsql
security definer
set search_path = kb, public, extensions
as $fn$
declare n integer;
begin
    insert into kb.hooks (brand_id, category, template, example, topics, origin, origin_ref, metadata)
    select
        (select id from kb.brands where slug = coalesce(e ->> 'brand_slug', 'aiko')),
        e ->> 'category',
        e ->> 'template',
        e ->> 'example',
        coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(e -> 'topics')), '{}'),
        coalesce(e ->> 'origin', 'hook_patterns'),
        e ->> 'origin_ref',
        coalesce(e -> 'metadata', '{}'::jsonb)
    from jsonb_array_elements(payload) e
    where e ->> 'template' is not null and e ->> 'category' is not null;

    get diagnostics n = row_count;
    return n;
end;
$fn$;

create unique index if not exists hooks_origin_ref
    on kb.hooks (origin, origin_ref) where origin_ref is not null;

revoke execute on function public.kb_hook_seed_source(integer), public.kb_upsert_hooks(jsonb)
from public, anon, authenticated;
grant execute on function public.kb_hook_seed_source(integer), public.kb_upsert_hooks(jsonb)
to service_role;;
