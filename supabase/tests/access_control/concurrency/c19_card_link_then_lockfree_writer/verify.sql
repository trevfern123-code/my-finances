set role service_role;
select th.assert((select outcome from public.th_c19_outcome where who = 'holder') = 'saved' and (select outcome from public.th_c19_outcome where who = 'contender') = 'committed', 'both committed, no deadlock');
select th.assert((select b_cents from public.card_payment_decisions where superseded_by is null) = -10000, 'the decision records the amount the user saw');
select th.assert((select amount from public.transactions where plaid_transaction_id = 'c19-x') = -98, 'the writer''s change committed');
select th.assert((select input_version > evaluated_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
  'the writer''s bump landed after the RPC''s evaluation: stale');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert((select l->>'reason' = 'decision_invalidated' and l->>'detail' = 'amount_changed'
                  from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c19-p')), 're-evaluated: the confirmation is inactive, amount changed');
