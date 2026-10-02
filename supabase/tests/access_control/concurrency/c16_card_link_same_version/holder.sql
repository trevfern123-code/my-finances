-- The first confirmation (p–x) completes inside its transaction, then holds its locks until the second is
-- observed waiting on the per-user lock.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  v_result := public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select id from public.transactions where plaid_transaction_id = 'c16-p'), (select id from public.transactions where plaid_transaction_id = 'c16-x'), 0, (select v from public.th_c16_state));
  insert into public.th_c16_outcome values ('holder', v_result->>'status');
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c16-holder', false);
  v_contender := th.wait_for_application('c16-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;
