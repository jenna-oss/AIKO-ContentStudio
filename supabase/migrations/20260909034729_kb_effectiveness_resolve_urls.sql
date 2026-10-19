-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- The first real session showed the agent cites sources by URL, not by row id.
-- That is the right instinct — a URL is checkable by a human and a UUID is not —
-- but it meant the two sides of this metric spoke different languages: the log
-- records published_content ids, the ideas record trilithfunding.com links, and
-- the join found nothing. The metric would have read 0% forever and looked like
-- a finding rather than a mismatch.
--
-- Resolve a cited URL to its row id where one exists, and leave anything else
-- alone so chunk ids still match as themselves.
create or replace view kb.retrieval_effectiveness as
with retrieved as (
    select l.session_id, jsonb_array_elements_text(l.result_ids) as source_id
    from kb.retrieval_log l
    where l.session_id is not null
),
used as (
    select
        i.session_id,
        coalesce(p.id::text, sid) as source_id,
        i.status
    from kb.content_ideas i
    cross join lateral jsonb_array_elements_text(i.source_ids) as sid
    left join kb.published_content p on p.source_key = sid
    where i.session_id is not null
)
select
    r.session_id,
    count(distinct r.source_id)                                as sources_retrieved,
    count(distinct u.source_id)                                as sources_used,
    round(100.0 * count(distinct u.source_id)
          / nullif(count(distinct r.source_id), 0), 1)         as percent_used,
    count(distinct u.source_id) filter (
        where u.status in ('approved', 'used'))                as sources_reaching_final
from retrieved r
left join used u
       on u.session_id = r.session_id
      and u.source_id = r.source_id
group by r.session_id;

comment on view kb.retrieval_effectiveness is
  'Spec section 39. Per planning session: how many retrieved sources were built '
  'into a saved idea, and how many reached approved or used. Cited URLs are '
  'resolved to row ids first, because the agent cites links and the log records '
  'ids — without that the join silently reports zero.';

grant select on kb.retrieval_effectiveness to service_role;;
