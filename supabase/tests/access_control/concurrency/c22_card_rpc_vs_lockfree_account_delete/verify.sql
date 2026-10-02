set role service_role;
do $$
declare
  v_holder text := (select outcome from public.th_c22_outcome where who = 'holder');
  v_contender text := (select outcome from public.th_c22_outcome where who = 'contender');
  v_account boolean := exists (select 1 from public.accounts where id = '00000000-0000-0000-0000-000000022c02');
  v_decisions bigint := (select count(*) from public.card_payment_decisions);
  v_before jsonb;
  v_after jsonb;
begin
  perform th.assert(v_holder is not null and v_contender is not null, 'both sessions recorded an outcome');
  perform th.assert((v_holder = 'deadlock') <> (v_contender = 'deadlock'),
    format('exactly one side hit deadlock_detected (writer %s, rpc %s)', v_holder, v_contender));
  if v_contender = 'deadlock' then
    perform th.assert(not v_account and v_decisions = 0, 'the aborted RPC wrote nothing; the account delete committed');
  else
    perform th.assert(v_contender = 'saved' and v_account and v_decisions = 1, 'the aborted delete rolled back completely; the RPC committed');
  end if;
  v_before := public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa');
  if (v_before->>'fresh')::boolean then
    perform public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
    v_after := public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa');
    perform th.assert(v_before->'legs' = v_after->'legs', 'fresh states equal a re-evaluation of the committed data');
  else
    perform th.assert((select input_version > coalesce(evaluated_version, -1) from public.card_payment_eval_versions
                       where user_id = '00000000-0000-0000-0000-0000000000aa'), 'not fresh means input is ahead of the evaluation');
  end if;
end $$;
