-- Replayed through the Supabase CLI, whose session does not have the
-- extensions schema (pgvector) on its search_path the way the dashboard does.
set search_path = "$user", public, extensions;

-- Spyglass dropped the USP insight type in September 2026; AD_ANGLE is its
-- nearest replacement. USP stays allowed so the rows already stored remain.
alter table adspy.hook_patterns drop constraint hook_patterns_insight_type_check;
alter table adspy.hook_patterns add constraint hook_patterns_insight_type_check
  check (insight_type = any (array['HOOK', 'USP', 'AD_ANGLE', 'TARGET_PERSONA', 'MEDIA_MIX']));;
