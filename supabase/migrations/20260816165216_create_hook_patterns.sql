-- Hook and angle patterns from Spyglass, an ad-intelligence corpus separate
-- from our Meta sweep.
--
-- These brands are NOT Trilith's competitors. Spyglass has no insight coverage
-- for investor lenders at all — Kiavi, Lima One and the rest return empty. What
-- it does have is abstracted creative structure for advertisers who are good at
-- advertising in adjacent finance categories. The value is the shape of the
-- hook, borrowed and adapted; nothing here says what any competitor is doing.
--
-- Kept in adspy alongside the ad corpus because it answers the same question
-- from the other side: ads.copy is what was said, hook_patterns is the form.
create table if not exists adspy.hook_patterns (
  brand_id     text    not null,
  brand_name   text    not null,
  category     text,
  -- HOOK: how the creative opens. USP: the claim it leads with.
  -- TARGET_PERSONA: who it addresses. MEDIA_MIX: format split.
  insight_type text    not null check (insight_type in ('HOOK','USP','TARGET_PERSONA','MEDIA_MIX')),
  label        text    not null,
  total        integer not null,
  -- Change against the previous window, as Spyglass reports it. Negative means
  -- the brand is using the pattern less than it was. Null means no comparison
  -- was available, which is not the same as no change.
  raw_delta     integer,
  percent_delta numeric,
  -- Spyglass is reachable only through an MCP connector, not an HTTP API, so
  -- the daily CI job cannot refresh this. Stamp every row so staleness is
  -- visible rather than assumed.
  captured_at  date    not null default current_date,
  label_tsv    tsvector generated always as (to_tsvector('english', label)) stored,
  primary key (brand_id, insight_type, label)
);

create index if not exists hook_patterns_tsv_idx   on adspy.hook_patterns using gin (label_tsv);
create index if not exists hook_patterns_trgm_idx  on adspy.hook_patterns using gin (label gin_trgm_ops);
create index if not exists hook_patterns_type_idx  on adspy.hook_patterns (insight_type, total desc);

alter table adspy.hook_patterns enable row level security;

drop policy if exists hook_patterns_read on adspy.hook_patterns;
create policy hook_patterns_read on adspy.hook_patterns
  for select to anon, authenticated using (true);

grant select on adspy.hook_patterns to anon, authenticated, service_role;;
