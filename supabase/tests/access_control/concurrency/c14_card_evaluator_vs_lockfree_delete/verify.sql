set role service_role;
select th.assert(not exists (select 1 from public.transactions where plaid_transaction_id like 'c14-del-%'),
  'all 50 deletes committed (no round deadlocked or timed out)');
select th.assert((select input_version > evaluated_version from public.card_payment_eval_versions
                  where user_id = '00000000-0000-0000-0000-0000000000aa'), 'the last round''s delete came after its evaluation: stale');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean,
  'not readable until re-evaluated');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((select count(*) from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs')) = 2,
  'after re-evaluation all 50 deleted legs are gone');
