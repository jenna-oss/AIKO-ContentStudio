-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Pages in the existing content schema that have not yet been mirrored into
-- kb.published_content.
--
-- The two tables answer different questions and are both worth keeping:
-- content.chunks answers "what has Trilith written about X", kb.published_content
-- answers "have we already made this argument". The second needs topic, angle
-- and hook, which the website corpus does not record, so the mirror derives
-- them rather than copying columns across.
create or replace function public.kb_content_mirror_source(p_limit integer default 25)
returns table (
    url text, kind text, title text, summary text,
    published date, date_source text, body text
)
language sql
security definer
set search_path = kb, public, content, extensions
as $fn$
    select d.url, d.kind, d.title, d.summary, d.published, d.date_source,
           left(d.body, 6000)
    from content.documents d
    left join kb.published_content p
           on p.source_key = d.url
          and p.brand_id = (select id from kb.brands where slug = 'aiko')
    where p.id is null
    order by d.published desc nulls last, d.id
    limit greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;

revoke execute on function public.kb_content_mirror_source(integer) from public, anon, authenticated;
grant execute on function public.kb_content_mirror_source(integer) to service_role;;
