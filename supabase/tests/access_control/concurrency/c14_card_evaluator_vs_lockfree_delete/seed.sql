-- 16b: the evaluator never waits on a data-row lock (L3) — 50 coordinated repetitions. In each round a
-- lock-free DELETE holds its row lock and waits for L2 in its trigger, while an RPC-shaped transaction
-- holding L2 evaluates. Because the derived tables have no foreign key to transactions, writing a state
-- for the row being deleted needs no lock on it, so no wait cycle can form. (With such a foreign key the
-- evaluator's insert needs a KEY SHARE lock that conflicts with the DELETE, and the sessions deadlock —
-- verified by mutation.) The overlap is established by bounded barriers, not sleeps: the holder
-- proceeds only once it has observed the deleter blocked on it.
set role service_role;
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-00000000c141', '00000000-0000-0000-0000-000000000001', 'c14-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000c142', '00000000-0000-0000-0000-000000000001', 'c14-x', 'Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000c141', 'c14-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000c142', 'c14-card', -100, '2026-09-02', 'credit_card_payment'),
  -- an ordinary expense: the RPC-shaped round's input write (its bump takes L2)
  ('00000000-0000-0000-0000-00000000c141', 'c14-bump', 10, '2026-09-05', 'expense');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
select '00000000-0000-0000-0000-00000000c141', 'c14-del-' || g, 300 + g, date '2026-08-01' + g, 'credit_card_payment'
from generate_series(1, 50) g;
reset role;

-- Procedures commit once per round. They run as the session user (postgres) so the barriers can read
-- pg_stat_activity, and switch to service_role for the writes and the evaluation.
create or replace procedure public.th_c14_holder()
language plpgsql as $$
declare
  v_round integer;
  v_deleter integer;
begin
  for v_round in 1 .. 50 loop
    -- The deleter is idle and ready for this round: its previous DELETE has committed.
    v_deleter := th.wait_for_application('c14-deleter-ready-' || v_round);
    if v_round > 1 then
      perform th.assert((select input_version > evaluated_version from public.card_payment_eval_versions
                         where user_id = '00000000-0000-0000-0000-0000000000aa'),
        format('round %s: the delete that landed after the evaluation left the user stale', v_round - 1));
    end if;
    -- RPC shape: L1, then an input write whose bump takes L2.
    perform set_config('role', 'service_role', true);
    perform pg_advisory_xact_lock(hashtext('00000000-0000-0000-0000-0000000000aa'));
    update public.transactions set amount = amount + 1 where plaid_transaction_id = 'c14-bump';
    perform set_config('role', 'none', true);
    perform set_config('application_name', 'c14-holder-holding-l2-' || v_round, false);
    -- Established overlap: the deleter holds its row and is blocked on this session's L2.
    perform th.wait_until_blocked_by(v_deleter, pg_backend_pid());
    -- The evaluation writes a state for the row being deleted. It must not wait on that row: if it
    -- did, both sessions would wait on each other and PostgreSQL would abort this procedure.
    perform set_config('role', 'service_role', true);
    perform public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
    commit;
  end loop;
end;
$$;

create or replace procedure public.th_c14_deleter()
language plpgsql as $$
declare
  v_round integer;
begin
  for v_round in 1 .. 50 loop
    perform set_config('application_name', 'c14-deleter-ready-' || v_round, false);
    perform th.wait_for_application('c14-holder-holding-l2-' || v_round);
    perform set_config('application_name', 'c14-deleter-deleting-' || v_round, false);
    perform set_config('role', 'service_role', true);
    delete from public.transactions where plaid_transaction_id = 'c14-del-' || v_round;
    commit;
  end loop;
end;
$$;
