-- The standalone evaluation, waiting on the per-user lock.
select th.wait_for_application('c29-holder');
select set_config('application_name', 'c29-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  insert into public.th_c29_outcome values ('contender', 'evaluated:' || public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa'));
end $$;
commit;
