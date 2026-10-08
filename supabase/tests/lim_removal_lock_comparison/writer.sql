-- The LOCK-FREE writer (design §3.7): a direct statement, as an old backend or a person at a SQL prompt would
-- run it. No advisory lock, no evaluation. psql variables: dt = this session's deadlock_timeout; scenario.
--
-- A direct UPDATE takes its row lock first (FOR NO KEY UPDATE, for the columns changed here) and bumps the
-- version row (L2) in its AFTER trigger, at the end of the statement. The barrier between the two is made
-- explicit: the same row lock is taken, the session waits until the removal is blocked on that row, and only
-- then runs the UPDATE whose trigger asks for L2.
--   S1–S3: a transaction row of the item (its amount changes).
--   S4:    an account row of the item (it becomes excluded from cash flow).
--   S5:    an account row of the item, held by the foreign-key lock (KEY SHARE) of an INSERT of a transaction
--          on it; the insert's trigger then bumps the version row.
\set ON_ERROR_STOP 1
set deadlock_timeout = :'dt';
set session authorization postgres;
select :'scenario' = 'S4' as hold_account, :'scenario' = 'S5' as reference_account \gset
select set_config('application_name', 'lc-writer', false);
begin;
set local role service_role;
\if :hold_account
select 1 from public.accounts where id = '00000000-0000-0000-0000-0000000c1002' for no key update;
\elif :reference_account
select 1 from public.accounts where id = '00000000-0000-0000-0000-0000000c1002' for key share;
\else
select 1 from public.transactions where plaid_transaction_id = 'lc-held' for no key update;
\endif
set local role none;
select set_config('application_name', 'lc-writer-holding', false);
-- The overlap is established, not assumed: the removal is waiting, and this session is what blocks it.
select th.wait_until_blocked_by(th.wait_for_application('lc-removal'), pg_backend_pid());
-- Recorded here, while it is certainly true (this session still holds the row): what the removal waits on.
-- The watching session only samples, and when no cycle forms this wait ends within a few milliseconds.
-- (Its own key, so that the watching session's insert never waits for this transaction.)
select pg_stat_clear_snapshot();
insert into public.th_lc_waits (waiter, blocker, wait_event)
select 'removal', 'writer', coalesce(a.wait_event_type || '/' || a.wait_event, 'unknown') || ' at the barrier'
from pg_stat_activity a
where a.application_name = 'lc-removal' and pg_backend_pid() = any (pg_blocking_pids(a.pid));
set local role service_role;
\if :hold_account
do $$
declare
  v_detail text;
begin
  begin
    update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000c1002';
    insert into public.th_lc_outcome values ('writer', 'updated', null, null);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into public.th_lc_outcome values ('writer', 'error', sqlstate, v_detail);
  end;
end $$;
\elif :reference_account
do $$
declare
  v_detail text;
begin
  begin
    insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
    values ('00000000-0000-0000-0000-0000000c1002', 'lc-new', 12.34, '2026-09-21', 'Purchase', 'expense', 'sign_default', 'low', 1);
    insert into public.th_lc_outcome values ('writer', 'updated', null, null);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into public.th_lc_outcome values ('writer', 'error', sqlstate, v_detail);
  end;
end $$;
\else
do $$
declare
  v_detail text;
begin
  begin
    update public.transactions set amount = amount - 1 where plaid_transaction_id = 'lc-held';
    insert into public.th_lc_outcome values ('writer', 'updated', null, null);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into public.th_lc_outcome values ('writer', 'error', sqlstate, v_detail);
  end;
end $$;
\endif
commit;
