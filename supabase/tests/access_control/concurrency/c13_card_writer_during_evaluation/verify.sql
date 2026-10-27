set role service_role;
select th.assert((select input_version = evaluated_version + 1 from public.card_payment_eval_versions
                  where user_id = '00000000-0000-0000-0000-0000000000aa'), 'the write bumped after the evaluation published');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean,
  'the user is stale, never falsely fresh');
select th.assert(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs' is null, 'no states are returned');
select th.assert((select amount_cents from public.card_payment_leg_states s join public.transactions t on t.id = s.transaction_id
                  where t.plaid_transaction_id = 'c13-pay') = 10000,
  '(the stored states are the pre-write ones — which is why they must not be readable)');
