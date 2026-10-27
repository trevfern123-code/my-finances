-- Rehearsal step 4: right after 20261006120000 was applied to the populated database.
select rehearsal.take('upgraded');
select th.assert(rehearsal.same('schema_upgraded_evaluated', 'upgraded'), 'upgrade: no row of any card-payment, transaction, account, item, removal, loan, carry-over or split table changed');
select th.assert(rehearsal.body_md5() = '7997a757408fa888aa44bdbc9d85f89d', 'upgrade: remove_plaid_item_local is the 20261006120000 body');

set role service_role;
select th.assert(rehearsal.fresh() and rehearsal.sre('k2') = 'tracked/auto_pair/0' and rehearsal.sre('ku2') = 'tracked/user_pair/0', 'upgrade: freshness and states are as they were');
create temporary table r as select public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000004') as v;
select th.assert((select (v->>'replayed')::boolean = false and (v->'loan_adjustments'->0->>'restored')::numeric = 100 from r)
                 and (select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000e00f1') = 1000,
  'new body: removal 2 runs and restores the loan exactly');
select th.assert(rehearsal.records() = array['k2'], 'new body: the destination of the AUTOMATICALLY matched payment to the removed card is preserved as a system record');
select th.assert(rehearsal.preserved() = array['ku2=valid'], 'new body: the USER-confirmed pair with the removed card is preserved as the user''s own decision');
select th.assert(rehearsal.fresh() and rehearsal.sre('k2') = 'untracked/removed_card/-20000', 'new body: committed fresh; the payment counts as leaving the tracked accounts');
select th.assert(rehearsal.sre('ku2') = 'untracked/removed_card/-40000' and rehearsal.holder('ku2') = 'pair_counterpart_removed'
                 and rehearsal.sre('yu') = 'unresolved/no_candidate/0',
  'new body: the user-confirmed payment counts too, held by the user''s decision; the competing card leg on the kept card is not paired with it');
select th.assert(rehearsal.holds() = array['k2=ambiguity_hold_removed_card:y2@2026-09-04', 'kt=ambiguity_hold_removed_card:yt@2026-09-16']
                 and rehearsal.sre('kt') = 'unresolved/ambiguous/null' and rehearsal.partner('kt') is null and rehearsal.holder('kt') = 'none'
                 and rehearsal.sre('yt') = 'unresolved/ambiguous/0',
  'new body: the tie between the removed card and the kept card is NOT resolved by the deletion — a system hold is written, and the payment stays unresolved (the other hold is Option B''s, next)');
-- Revision 5, Option B. k2 was matched automatically to x2 (removed, 1 day); y2 on the kept card was already there
-- (4 days). The removal wrote k2's record AND a hold on the pair (y2, k2) with x2's date. With x2 gone, tier 1
-- does form (k2, y2) — y2 is closer to k2 than to kb — and the hold withholds exactly that pair.
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.bounds('k2') = '-20000..-20000' and rehearsal.partner('k2') is null
                 and rehearsal.holder('k2') = 'destination_removed_card'
                 and rehearsal.sre('y2') = 'unresolved/ambiguous/0' and rehearsal.partner('y2') is null and rehearsal.holder('y2') = 'none',
  'new body (Option B): the automatically matched payment keeps its removed destination — a figure, named by its system record — and is NOT switched to the kept card leg that was already there, which stays unmatched');
-- The bystander: on no held pair (no candidate on the removed institution), still tied between y2 and zb.
select th.assert(rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.bounds('kb') = '-20000..0' and rehearsal.partner('kb') is null and rehearsal.holder('kb') = 'none'
                 and rehearsal.sre('zb') = 'unresolved/ambiguous/0' and rehearsal.partner('zb') is null
                 and not exists (select 1 from public.card_payment_decisions d where 'kb' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id) or 'zb' in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)),
  'new body: the bystander payment is on no held pair and no decision names it; it is still tied between the two kept card legs — unresolved, a range');
select th.assert(rehearsal.sre('kt1') = 'tracked/auto_pair/0' and rehearsal.sre('kt3') = 'unresolved/ambiguous/null',
  'new body: the tie the previous body already resolved is not undone, and the tie with the third institution is untouched');
select th.assert(rehearsal.sre('k3') = 'tracked/auto_pair/0' and rehearsal.sre('ky') = 'tracked/auto_pair/0'
                 and rehearsal.sre('ku') = 'untracked/user_confirmed_unlinked/-2500' and rehearsal.sre('k1') = 'unresolved/no_candidate/null',
  'new body: every other leg is as it was (the earlier loss is not repaired, and not invented)');
select th.assert(rehearsal.fresh('00000000-0000-0000-0000-0000000000bb') and rehearsal.sre('b-pay', '00000000-0000-0000-0000-0000000000bb') = 'tracked/auto_pair/0',
  'new body: the other user is untouched');
reset role;
select rehearsal.take('new_removed');
