-- The client that got no answer. It waits until the original request has done its work (the holder announces
-- itself only after the action), then:
--   1. asks for the receipt of that operation id — while the original transaction is still open;
--   2. sends the SAME operation id with the SAME intent and the versions it saw (it waits for the user's lock);
--   3. asks for the receipt again.
set role service_role;
select th.wait_for_application('c08-holder');
insert into public.th_c08_outcome
select 'lookup while the original is open', public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->>'found';
insert into public.th_c08_outcome
select 'receipts and pairs visible while the original is open',
       (select count(*) from public.card_payment_recovery_actions where user_id = rrh.aa()) || ' / '
       || (select count(*) from public.card_payment_decisions where user_id = rrh.aa() and kind = 'pair');
set application_name = 'c08-contender';
insert into public.th_c08_outcome
select 'same operation sent again', rrh.outcome(rrh.act(rrh.op(1), rrh.pair_kw(), rrh.aa(), s.input, s.review)) from public.th_c08_seen s;
insert into public.th_c08_outcome
select 'lookup after the original committed', public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->>'found';
