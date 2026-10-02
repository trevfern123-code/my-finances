-- Durable outcome: stale, never falsely fresh; a later evaluation includes all three writes.
set role service_role;
select th.assert((select input_version > evaluated_version from public.card_payment_eval_versions
                  where user_id = '00000000-0000-0000-0000-0000000000aa'), 'the writes advanced past the published version');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'stale, never falsely fresh');
select th.assert(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs' is null, 'no states are returned');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fresh after re-evaluation');
select th.assert((select count(*) from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  join public.transactions t on t.id = (l->>'transactionId')::uuid
                  where t.plaid_transaction_id in ('c24-pay', 'c24-extra', 'c24-card')
                    and (l->>'amountCents')::bigint in (9800, 5500, -9700, 9700)) = 3, 'the re-evaluation reflects every write');
