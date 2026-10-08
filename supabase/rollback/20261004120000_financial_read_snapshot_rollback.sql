-- Rollback of 20261004120000_financial_read_snapshot.sql: the migration added exactly one function and
-- nothing else, so removing it is the whole rollback. No data is touched.
--
-- After it, a backend that expects the function serves level-1 aggregates that fit one response exactly
-- as before, fails closed (never truncates) on larger ones, and reports role-aware figures as unavailable.
drop function if exists public.get_financial_read_snapshot(uuid, date, date, boolean, boolean, boolean, date, date);
