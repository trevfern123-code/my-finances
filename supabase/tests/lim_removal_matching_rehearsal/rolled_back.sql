-- Rehearsal step 5: right after the rollback script of 20261006120000 ran. 20261006110000 is still installed.
select rehearsal.take('rolled_back');
select th.assert(rehearsal.same('new_removed', 'rolled_back'), 'rollback: no row changed — it restores a function body and nothing else');
select th.assert(rehearsal.body_md5() = 'a8f567d397b9dae5b777497317985ab7', 'rollback: remove_plaid_item_local is the 20260926120000 body again, byte for byte');

set role service_role;
-- What a removal wrote under the forward function is still there, and the (unchanged) evaluator still honours it.
select th.assert(rehearsal.records() = array['k2'] and rehearsal.preserved() = array['ku2=valid'] and rehearsal.fresh()
                 and rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.sre('ku2') = 'untracked/removed_card/-40000'
                 and rehearsal.holds() = array['k2=ambiguity_hold_removed_card:y2@2026-09-04', 'kt=ambiguity_hold_removed_card:yt@2026-09-16'] and rehearsal.sre('kt') = 'unresolved/ambiguous/null',
  'rollback: the system record, the preserved user decision and the ambiguity hold are all still there');
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.sre('ku2') = 'untracked/removed_card/-40000'
                 and rehearsal.holder('ku2') = 'pair_counterpart_removed' and rehearsal.sre('yu') = 'unresolved/no_candidate/0'
                 and rehearsal.sre('kt') = 'unresolved/ambiguous/null' and rehearsal.partner('kt') is null,
  'rollback: and a new evaluation keeps honouring all three — the user''s payment is still held against the competing card, and the tie is still a tie');
-- Revision 5's rows too. The evaluator is untouched, so k2 (record + Option B hold) and the bystander kb read
-- exactly what they read after removal 2.
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.bounds('k2') = '-20000..-20000' and rehearsal.partner('k2') is null
                 and rehearsal.holder('k2') = 'destination_removed_card'
                 and rehearsal.sre('y2') = 'unresolved/ambiguous/0' and rehearsal.partner('y2') is null and rehearsal.holder('y2') = 'none'
                 and rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.bounds('kb') = '-20000..0' and rehearsal.partner('kb') is null
                 and rehearsal.sre('zb') = 'unresolved/ambiguous/0',
  'rollback of 20261006120000 alone: UNCHANGED — the automatically matched payment keeps its removed destination and is not switched to the kept card leg; the bystander is still tied');
-- A removal after the rollback behaves as before the migration: nothing preserved, user left stale.
select th.assert((public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000006')->>'replayed')::boolean = false, 'rolled back: removal 3 runs');
select th.assert(rehearsal.records() = array['k2'] and rehearsal.preserved() = array['ku2=valid']
                 and rehearsal.holds() = array['k2=ambiguity_hold_removed_card:y2@2026-09-04', 'kt=ambiguity_hold_removed_card:yt@2026-09-16'],
  'rolled back: removal 3 preserves nothing and writes no hold (the previous behaviour)');
select th.assert(not rehearsal.fresh(), 'rolled back: and leaves the user stale, never falsely fresh');
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.sre('k3') = 'unresolved/no_candidate/null' and rehearsal.sre('k2') = 'untracked/removed_card/-20000',
  'rolled back: the third payment lost its destination; the second keeps the one it was given');
select th.assert(rehearsal.sre('kt3') = 'tracked/auto_pair/0' and rehearsal.partner('kt3') = (select id from public.transactions where plaid_transaction_id = 'yt3')::text and rehearsal.sre('kt') = 'unresolved/ambiguous/null',
  'rolled back: the third institution''s tie was resolved by its deletion (the previous behaviour); the tie that already has a hold is still held');
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.holder('k2') = 'destination_removed_card' and rehearsal.partner('y2') is null
                 and rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.partner('kb') is null,
  'rolled back: removal 3 does not touch the 200 legs (none of them is on the third institution): the Option B hold still withholds (k2, y2), and the bystander is still tied');
reset role;
select rehearsal.take('rolled_back_removed');
