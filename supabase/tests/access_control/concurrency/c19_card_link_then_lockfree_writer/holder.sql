-- The confirmation completes and holds its locks.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  v_result := public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select id from public.transactions where plaid_transaction_id = 'c19-p'), (select id from public.transactions where plaid_transaction_id = 'c19-x'), 0, (select v from public.th_c19_state));
  insert into public.th_c19_outcome values ('holder', v_result->>'status');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c19-holder', false);
  v_contender := th.wait_for_application('c19-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;
