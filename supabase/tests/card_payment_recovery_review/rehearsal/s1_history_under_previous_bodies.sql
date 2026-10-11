-- Under the PREVIOUS bodies (20261008120000): the removal preserves its decisions and their provenance, and an
-- unrelated transaction that arrives afterwards pairs automatically — published fresh. This is the exposure.
set role service_role;
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'reh-item-kept', 'Kept Bank');
select rrh.account('00000000-0000-0000-0000-00000001f0a1', '00000000-0000-0000-0000-000000000001', 'reh-x', 'credit');
select rrh.account('00000000-0000-0000-0000-00000001f0c1', '00000000-0000-0000-0000-000000000003', 'reh-c', 'depository');
select rrh.account('00000000-0000-0000-0000-00000001f0c2', '00000000-0000-0000-0000-000000000003', 'reh-y', 'credit');
select rrh.account('00000000-0000-0000-0000-00000001f0b1', '00000000-0000-0000-0000-000000000002', 'reh-bc', 'depository');
select rrh.account('00000000-0000-0000-0000-00000001f0b2', '00000000-0000-0000-0000-000000000002', 'reh-by', 'credit');
select rrh.cardleg('k', '00000000-0000-0000-0000-00000001f0c1', 370, '2026-09-10'), rrh.cardleg('x', '00000000-0000-0000-0000-00000001f0a1', -370, '2026-09-11'),
       rrh.cardleg('y', '00000000-0000-0000-0000-00000001f0c2', -370, '2026-09-12');
select rrh.cardleg('bk', '00000000-0000-0000-0000-00000001f0b1', 50, '2026-09-10'), rrh.cardleg('by', '00000000-0000-0000-0000-00000001f0b2', -50, '2026-09-10');
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'reh-item-other', 'Other Bank');
select rrh.account('00000000-0000-0000-0000-00000001f0e1', '00000000-0000-0000-0000-000000000008', 'reh-w', 'credit');
select rrh.cardleg('w', '00000000-0000-0000-0000-00000001f0e1', -370, '2026-09-11');
select public.evaluate_card_payments(rrh.aa()), public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.line('k') = 'tracked/auto_pair/0 partner=w decision=- range=0..0', 'previous bodies: the unrelated leg pairs automatically and reads "tracked, 0", fresh: ' || rrh.line('k'));
select th.assert(rrh.retained('k') = 'D(k) H(y/k@2026-09-11)' and (select count(*) from public.card_payment_removal_sources) = 2, 'the record, the hold and their provenance are retained: ' || rrh.retained('k'));
select th.assert(rrh.line('bk', rrh.bb()) = 'tracked/auto_pair/0 partner=by decision=- range=0..0', 'the other user has an ordinary automatic pair');
select th.assert((select count(*) from public.card_payment_review_obligations) = 0, 'no review obligation exists: nothing captured them');
