-- total was NOT NULL when every row came from the MCP surface, which reports a
-- usage count. The REST insights endpoint does not, so a pattern discovered by
-- a scheduled refresh legitimately has no volume. Null now means "unknown",
-- which is the honest value and is already handled by search (min_total skips
-- nulls, and ordering places them after known volumes).
alter table adspy.hook_patterns alter column total drop not null;;
