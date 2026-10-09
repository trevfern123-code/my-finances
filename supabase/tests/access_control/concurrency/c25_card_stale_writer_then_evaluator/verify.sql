-- Durable outcome: fresh, and the published states include the writer's change (98.00, not 99.00).
set role service_role;
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fresh after the race');
select th.assert((select l->>'amountCents' from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where l->>'side' = 'cash') = '9800', 'the evaluation saw the writer''s committed change');
