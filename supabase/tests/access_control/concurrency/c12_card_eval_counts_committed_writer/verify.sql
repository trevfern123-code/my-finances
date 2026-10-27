set role service_role;
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean,
  'fresh: the published version is exactly the committed input version');
select th.assert((select l->>'amountCents' from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where l->>'side' = 'cash') = '9800', 'the evaluation saw the writer''s committed change');
select th.assert((select l->>'reason' from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where l->>'side' = 'cash') = 'amount_differs', 'and evaluated it: 98 against −100 is a near-amount suggestion');
