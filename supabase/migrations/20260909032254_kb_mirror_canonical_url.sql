-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- The content corpus holds every page twice — once as trilithfunding.com and
-- once as www.trilithfunding.com — so 80 rows are 41 pages. The mirror copied
-- that faithfully and doubled it, which matters more here than upstream:
-- published_content is what repetition detection compares against, and a piece
-- that appears twice reads as a topic already covered twice over.
--
-- Canonicalise on the www form, which is the complete set (41 rows against 39).
-- source_key stays a working URL because the agent returns it as the link.

-- 1. Drop the duplicates already mirrored, keeping one row per real page.
delete from kb.published_content a
using kb.published_content b
where a.brand_id = b.brand_id
  and regexp_replace(a.source_key, '^https?://(www\.)?', '')
    = regexp_replace(b.source_key, '^https?://(www\.)?', '')
  and a.ctid > b.ctid;

-- 2. Normalise what remains, so the two spellings can never both land again.
update kb.published_content
   set source_key = 'https://www.' || regexp_replace(source_key, '^https?://(www\.)?', '')
 where source_key ~ '^https?://';

-- 3. Teach the mirror to hand back one row per page, and to recognise a page it
--    has already mirrored under either spelling.
create or replace function public.kb_content_mirror_source(p_limit integer default 25)
returns table (
    url text, kind text, title text, summary text,
    published date, date_source text, body text
)
language sql
security definer
set search_path = kb, public, content, extensions
as $fn$
    with canon as (
        select distinct on (regexp_replace(d.url, '^https?://(www\.)?', ''))
               d.url, d.kind, d.title, d.summary, d.published, d.date_source, d.body,
               regexp_replace(d.url, '^https?://(www\.)?', '') as path
        from content.documents d
        -- Prefer the row with the fuller body: the two crawls of one page are
        -- not always byte-identical, and a truncated extraction is the worse
        -- of the pair to keep.
        order by regexp_replace(d.url, '^https?://(www\.)?', ''), length(d.body) desc, d.url
    )
    select c.url, c.kind, c.title, c.summary, c.published, c.date_source, left(c.body, 6000)
    from canon c
    left join kb.published_content p
           on p.brand_id = (select id from kb.brands where slug = 'aiko')
          and regexp_replace(p.source_key, '^https?://(www\.)?', '') = c.path
    where p.id is null
    order by c.published desc nulls last, c.url
    limit greatest(1, least(coalesce(p_limit, 25), 200));
$fn$;

revoke execute on function public.kb_content_mirror_source(integer) from public, anon, authenticated;
grant execute on function public.kb_content_mirror_source(integer) to service_role;;
