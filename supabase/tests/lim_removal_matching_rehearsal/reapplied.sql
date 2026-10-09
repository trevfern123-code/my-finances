-- Rehearsal step 7: both migration files applied again (20261006110000, then 20261006120000) on top of the
-- restored bodies and the schema the rollback left in place.
select rehearsal.take('reapplied');
select th.assert(rehearsal.same('schema_rolled_back_rpc_probe_undone', 'reapplied'), 're-apply: no row changed');
select th.assert(rehearsal.body_md5() = '7997a757408fa888aa44bdbc9d85f89d'
                 and rehearsal.fn_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = '6cb5e299b0383fab0b6517cc2e7522c8'
                 and rehearsal.fn_md5('public.link_card_payment(uuid, uuid, uuid, bigint, bigint)') = '1ddf83f559f5179975ef52a08b7f2063'
                 and rehearsal.fn_md5('public.mark_card_payment_destination(uuid, uuid, bigint)') = 'c2c5368d749e490ed8f7e062ded261cd'
                 and rehearsal.fn_md5('public.undo_card_payment_decision(uuid, uuid, bigint)') = 'dfcba4535ba1087928185d14cc978c10',
  're-apply: the 20261006110000 and 20261006120000 bodies again');
set role service_role;
-- The preserved decision is understood again as soon as something evaluates.
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.fresh() and rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.records() = array['k2']
                 and rehearsal.preserved() = array['ku2=valid'] and rehearsal.sre('ku2') = 'untracked/removed_card/-40000'
                 and rehearsal.holder('ku2') = 'pair_counterpart_removed' and rehearsal.partner('yu') is null,
  're-apply: the record and the preserved user decision are as they were, and the user''s payment counts again');
select th.assert(rehearsal.holds() = array['k2=ambiguity_hold_removed_card:y2@2026-09-04', 'kt=ambiguity_hold_removed_card:yt@2026-09-16'] and rehearsal.sre('kt') = 'unresolved/ambiguous/null'
                 and rehearsal.holder('kt') = 'none' and rehearsal.partner('kt') is null and rehearsal.sre('yt') = 'unresolved/ambiguous/0',
  're-apply: the hold is understood again — a system record on a pair, not a decision on either leg; the tie is still a tie');
-- Revision 5: the Option B hold is a hold again, not a claim. k2 reads its record (a figure); y2 is back in
-- automatic matching for every other leg, so the bystander is tied again and the wrong figure is gone.
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.bounds('k2') = '-20000..-20000' and rehearsal.partner('k2') is null
                 and rehearsal.holder('k2') = 'destination_removed_card' and rehearsal.detail('k2') is null
                 and rehearsal.sre('y2') = 'unresolved/ambiguous/0' and rehearsal.partner('y2') is null and rehearsal.holder('y2') = 'none',
  're-apply (Option B): the automatically matched payment reads its removed destination again — untracked, −200, named by its system record — and is not switched to the kept card leg');
select th.assert(rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.bounds('kb') = '-20000..0' and rehearsal.partner('kb') is null and rehearsal.holder('kb') = 'none'
                 and rehearsal.sre('zb') = 'unresolved/ambiguous/0' and rehearsal.partner('zb') is null
                 and not exists (select 1 from public.card_payment_auto_pairs p where p.cash_transaction_id::text = rehearsal.tid('kb')),
  're-apply: the bystander payment is tied again (the range −200…0); the automatic match the previous evaluator published for it is gone');
reset role;
select rehearsal.take('reapplied_evaluated');
set role service_role;
-- A replay of an operation cleaned under either body returns its stored result and writes nothing.
select th.assert((public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000001')->>'replayed')::boolean
                 and (public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000004')->>'replayed')::boolean
                 and (public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000006')->>'replayed')::boolean,
  're-apply: all three cleaned operations replay');
reset role;
select rehearsal.take('replayed');
select th.assert(rehearsal.same('reapplied_evaluated', 'replayed'), 're-apply: and the replays changed no row');

-- What an undo of a hold DURING THE ROLLED-BACK INTERVAL leaves behind (the 20261006110000 rollback's header, (v)).
-- Shown inside a transaction that is rolled back. The revision 5 undo refuses a hold; the previous one did not
-- (rolled_back_schema.sql), and all it did was superseded_by = the hold's own id. That one statement is repeated
-- here BY HAND, standing in for an undo made before the re-apply: nothing writes the hold again, so with both
-- migrations applied again the payment is matched automatically to the kept card leg that was already there.
begin;
set local role service_role;
select th.expect_error(format('select public.undo_card_payment_decision(%L, %L, %s)', rehearsal.aa(),
                              (select id from public.card_payment_decisions where kind = 'ambiguity_hold_removed_card' and b_plaid_transaction_id = 'k2'),
                              (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa())),
                       'card_payment_invalid: undo_card_payment_decision: system_decision%');
update public.card_payment_decisions set superseded_by = id
where kind = 'ambiguity_hold_removed_card' and b_plaid_transaction_id = 'k2' and superseded_by is null;
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.holds() = array['kt=ambiguity_hold_removed_card:yt@2026-09-16'] and rehearsal.records() = array['k2']
                 and rehearsal.sre('k2') = 'tracked/auto_pair/0' and rehearsal.partner('k2') = rehearsal.tid('y2') and rehearsal.holder('k2') = 'none',
  're-apply (v): a hold that was undone while 20261006110000 was rolled back stays undone — the revision 5 evaluator then matches the payment automatically to the kept card leg that was already there, its record dormant: the protection is gone for good');
rollback;
select rehearsal.take('reapplied_hold_undo_probe_undone');
select th.assert(rehearsal.same('replayed', 'reapplied_hold_undo_probe_undone'), 'the hold-undo demonstration was rolled back: no row changed');
