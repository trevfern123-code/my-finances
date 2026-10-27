-- Durable outcome, read from new transactions after both sessions committed.
set role service_role;
create temporary table published as select public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa') s;
select th.assert((select (s->>'fresh')::boolean from published), 'fresh after the race');
select th.assert((select jsonb_array_length(s->'legs') from published) = 3, 'all three legs, including the inserted one');
select th.assert((select count(*) from published, jsonb_array_elements(s->'legs') l
                  join public.transactions t on t.id = (l->>'transactionId')::uuid
                  where t.plaid_transaction_id in ('c23-pay', 'c23-extra', 'c23-card')
                    and (l->>'amountCents')::bigint in (9800, 5500, -9700, 9700)) = 3, 'every write is reflected in the published states');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((select s->'legs' from published) = public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs'
                 and (select s->'decisions' from published) = public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'decisions',
  'the raced publication equals a fresh re-evaluation');
