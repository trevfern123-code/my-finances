-- The standalone evaluation completes and holds its locks.
begin;
do $$
declare
  v_contender integer;
  v_result jsonb;
begin
  perform set_config('role', 'service_role', true);
  perform public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
  insert into public.th_c28_outcome values ('holder', 'evaluated at ' || (select evaluated_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'));
  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c28-holder', false);
  v_contender := th.wait_for_application('c28-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
end $$;
commit;
