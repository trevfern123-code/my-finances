set role service_role;
select th.assert((select result from public.th_c01_outcome where who = 'holder') = 'committed_fresh', 'the first request commits');
select th.assert((select result from public.th_c01_outcome where who = 'contender') = 'replayed', 'the second, with the same operation id, is a replay of the first: ' || (select result from public.th_c01_outcome where who = 'contender'));
select th.assert((select count(*) from public.card_payment_recovery_actions where user_id = rrh.aa()) = 1
                 and (select count(*) from public.card_payment_decisions where kind = 'pair' and a_plaid_transaction_id = 'k') = 1, 'one receipt and one pair exist');
select th.assert(rrh.line('k') = 'tracked/user_pair/0 partner=w decision=pair range=0..0', 'the pair stands: ' || rrh.line('k'));
