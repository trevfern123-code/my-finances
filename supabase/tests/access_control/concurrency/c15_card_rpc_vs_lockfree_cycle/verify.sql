set role service_role;
do $$
declare
  v_holder text := (select outcome from public.th_c15_outcome where who = 'holder');
  v_contender text := (select outcome from public.th_c15_outcome where who = 'contender');
  v_a numeric := (select amount from public.transactions where plaid_transaction_id = 'c15-a');
  v_b numeric := (select amount from public.transactions where plaid_transaction_id = 'c15-b');
  v_before jsonb;
  v_after jsonb;
begin
  perform th.assert(v_holder is not null and v_contender is not null, 'both sessions recorded an outcome');
  -- The scenario is timed to form the cycle: exactly one side must have been aborted.
  perform th.assert((v_holder = 'deadlock') <> (v_contender = 'deadlock'),
    format('exactly one side hit deadlock_detected (holder %s, contender %s)', v_holder, v_contender));
  if v_holder = 'deadlock' then
    perform th.assert(v_a = 100 and v_b = 202, 'the aborted RPC rolled back completely; the lock-free write committed');
  else
    perform th.assert(v_a = 101 and v_b = 201, 'the aborted lock-free write rolled back completely; the RPC committed');
  end if;
  -- Never falsely fresh: if the states are readable, they equal a re-evaluation of the committed data.
  v_before := public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa');
  if (v_before->>'fresh')::boolean then
    perform public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
    v_after := public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa');
    perform th.assert(v_before->'legs' = v_after->'legs', 'fresh states equal a re-evaluation of the committed data');
  else
    perform th.assert((select input_version > evaluated_version from public.card_payment_eval_versions
                       where user_id = '00000000-0000-0000-0000-0000000000aa'), 'not fresh means input is ahead of the evaluation');
  end if;
end $$;
