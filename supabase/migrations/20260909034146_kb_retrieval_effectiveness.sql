-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Spec section 39 calls this the particularly valuable metric: how often does a
-- retrieved candidate become part of the final content plan?
--
-- It was unanswerable until now, for two reasons that had to be fixed together.
-- The per-corpus tools logged nothing, so there was no record of what had been
-- retrieved; and saved ideas carried no session, so there was no way to tie an
-- idea back to the searches that produced it. With both fixed the join exists,
-- and it is a join rather than a stored number so it is always current.
create or replace view kb.retrieval_effectiveness as
with retrieved as (
    select l.session_id, jsonb_array_elements_text(l.result_ids) as source_id
    from kb.retrieval_log l
    where l.session_id is not null
),
used as (
    select i.session_id, jsonb_array_elements_text(i.source_ids) as source_id, i.status
    from kb.content_ideas i
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
  'Spec section 39. Per planning session: how many retrieved sources were '
  'actually built into a saved idea, and how many of those reached an approved '
  'or used state. A low percentage means retrieval is returning things the '
  'planner does not want, which is the signal worth acting on.';

grant select on kb.retrieval_effectiveness to service_role;

-- Clean up the round-trip test rows.
delete from kb.retrieval_log where session_id = 'plan-roundtrip-test';
delete from kb.planning_sessions where id = 'plan-roundtrip-test';;
