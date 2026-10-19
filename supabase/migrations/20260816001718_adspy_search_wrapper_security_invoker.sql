-- anon and authenticated already hold usage on adspy and select on its tables,
-- gated by the RLS policies. Running the read wrapper as DEFINER bought nothing
-- and bypassed those policies, so future row-level rules would silently not
-- apply to REST callers. INVOKER keeps the policies in the path.
alter function public.adspy_search_ads(text, text, text, text, date, date, integer)
  security invoker;;
