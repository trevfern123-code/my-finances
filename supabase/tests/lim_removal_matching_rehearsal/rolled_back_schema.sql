-- Rehearsal step 6: right after the rollback script of 20261006110000 ran (20261006120000 was rolled back
-- first). The PREVIOUS evaluator and RPCs now meet a preserved user decision and a system ambiguity hold they
-- do not know. This file checks, for the shapes the fixture has, what that rollback's header says happens (the
-- header names what is not rehearsed) — it is not transparent while such rows exist. Under revision 5 that
-- includes a hold on a payment whose figure was KNOWN (k2: record + Option B hold), and a payment on no held
-- pair that gets a figure the evidence does not support (kb): header (i), (ii), (v).
select rehearsal.take('schema_rolled_back');
select th.assert(rehearsal.same('rolled_back_removed', 'schema_rolled_back'), 'schema rollback: no row changed — the preserved decisions are kept, with the column that holds their status');
select th.assert(rehearsal.fn_md5('public.evaluate_card_payments(uuid, timestamp with time zone)') = 'f620515feaee49b382965cc8b73f02e2'
                 and rehearsal.fn_md5('public.link_card_payment(uuid, uuid, uuid, bigint, bigint)') = '72676208bb4c33cf3d801ddf294f2543'
                 and rehearsal.fn_md5('public.mark_card_payment_destination(uuid, uuid, bigint)') = 'b3a105575539bf30e306e68511258bfc'
                 and rehearsal.fn_md5('public.undo_card_payment_decision(uuid, uuid, bigint)') = '8b3e51df8455a7ac93a423ea174eb3f8'
                 and to_regprocedure('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') is null,
  'schema rollback: the evaluator and the three RPCs are the previous bodies, byte for byte; the helper is gone');
select th.assert(rehearsal.preserved() = array['ku2=valid']
                 and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'card_payment_decisions' and column_name = 'counterpart_status'),
  'schema rollback: the preserved user decision, its status and the column are still there');
select th.assert(rehearsal.holds() = array['k2=ambiguity_hold_removed_card:y2@2026-09-04', 'kt=ambiguity_hold_removed_card:yt@2026-09-16']
                 and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'card_payment_decisions' and column_name = 'counterpart_date'),
  'schema rollback: the ambiguity holds, their dates and the column are still there');

set role service_role;
-- The states published before the rollback are still the stored ones (nothing evaluated yet).
select th.assert(rehearsal.fresh() and rehearsal.sre('ku2') = 'untracked/removed_card/-40000', 'schema rollback: the stored states are untouched until something evaluates');
select th.assert(rehearsal.sre('k2') = 'untracked/removed_card/-20000' and rehearsal.sre('kb') = 'unresolved/ambiguous/null',
  'schema rollback: the stored states of the 200 legs are untouched too, until something evaluates');
-- The previous evaluator: the leg is still CLAIMED by the decision (so still not available to the competing
-- card), but it knows no effect for the kind — the payment reads unresolved, a range instead of a figure.
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.sre('ku2') like 'unresolved/%/null' and rehearsal.holder('ku2') = 'pair_counterpart_removed' and rehearsal.partner('ku2') is null
                 and rehearsal.partner('yu') is null,
  'previous evaluator: the preserved payment is still held (the competing card leg does not pair with it) but reads UNRESOLVED instead of −400');
-- CHANGED DELIBERATELY for revision 5. Until revision 4 this line read
--   sre('k2') = 'untracked/removed_card/-20000'   'previous evaluator: the system record is understood as before'
-- and that was true because no hold stood on k2. Option B now writes one, on (y2, k2), and the previous evaluator
-- reads it — card leg first — as an INACTIVE decision (not_cash_side) that CLAIMS both legs. The claim is read
-- before the system record: the record is still there and still live, but the payment no longer reads it.
-- Header (i): a known figure (−200) becomes a range. Not a wrong figure; "can't tell".
select th.assert(rehearsal.records() = array['k2']
                 and rehearsal.sre('k2') = 'unresolved/decision_invalidated/null' and rehearsal.bounds('k2') = '-20000..0' and rehearsal.partner('k2') is null
                 and rehearsal.holder('k2') = 'ambiguity_hold_removed_card' and rehearsal.detail('k2') = 'not_cash_side'
                 and rehearsal.sre('y2') = 'unresolved/decision_invalidated/0' and rehearsal.partner('y2') is null
                 and rehearsal.holder('y2') = 'ambiguity_hold_removed_card' and rehearsal.detail('y2') = 'not_cash_side',
  'previous evaluator (i): the payment with a KNOWN removed destination reads UNRESOLVED, the range −200…0 instead of −200 — the misread Option B hold claims it before its system record is read');
-- Header (ii): A WRONG FIGURE. kb is on no held pair. It was tied between y2 and zb (five days each): unresolved,
-- the range −200…0. The misread hold took y2 out of automatic matching for every leg, so zb is the only candidate
-- kb has left and the previous evaluator matches them automatically. y2 is still there, unchanged, claimed by no
-- user and exactly as close: nothing supports choosing zb. This assertion PINS that defect of the rollback; it
-- does not approve it.
select th.assert(rehearsal.sre('kb') = 'tracked/auto_pair/0' and rehearsal.bounds('kb') = '0..0' and rehearsal.partner('kb') = rehearsal.tid('zb')
                 and rehearsal.holder('kb') = 'none'
                 and rehearsal.sre('zb') = 'paired/auto_pair/0' and rehearsal.partner('zb') = rehearsal.tid('kb')
                 and exists (select 1 from public.card_payment_auto_pairs p
                             where p.cash_transaction_id::text = rehearsal.tid('kb') and p.credit_transaction_id::text = rehearsal.tid('zb')),
  'previous evaluator (ii): A WRONG FIGURE — the bystander payment, tied under revision 5 (the range −200…0), is published as automatically matched to zb, effect 0, because the misread hold took the equally close y2 out of the pool; the evidence does not support that figure');
-- The previous evaluator and the HOLD: an unknown kind is read as a decision on its legs. The hold is written
-- card leg first, so it is read as an INACTIVE one (not_cash_side): both legs are claimed and unresolved. Not
-- a confirmed pair (while the card leg's account is a credit account: header (iv), not rehearsed), and not the
-- automatic pair the hold exists to withhold.
select th.assert(rehearsal.sre('kt') = 'unresolved/decision_invalidated/null' and rehearsal.holder('kt') = 'ambiguity_hold_removed_card' and rehearsal.partner('kt') is null
                 and rehearsal.sre('yt') = 'unresolved/decision_invalidated/0' and rehearsal.partner('yt') is null
                 and (select l->>'detail' from jsonb_array_elements(public.get_card_payment_states(rehearsal.aa())->'legs') l
                      where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'kt')) = 'not_cash_side',
  'previous evaluator: the hold is read as an inactive decision that holds BOTH legs — the tie stays unresolved, it is not matched to the kept card');
reset role;
select rehearsal.take('schema_rolled_back_evaluated');

-- The previous RPCs, shown inside a transaction that is rolled back (the rehearsal continues from the state above).
begin;
set local role service_role;
-- A new confirmation on the held leg is saved WITHOUT superseding the preserved decision: both then conflict.
select th.assert(public.link_card_payment(rehearsal.aa(), (select id from public.transactions where plaid_transaction_id = 'ku2'),
                   (select id from public.transactions where plaid_transaction_id = 'yu'), 0,
                   (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'saved',
  'previous RPC: a new match on the held leg is saved');
select th.assert((select superseded_by is null from public.card_payment_decisions where kind = 'pair_counterpart_removed' and a_plaid_transaction_id = 'ku2')
                 and rehearsal.sre('ku2') = 'unresolved/decision_invalidated/null'
                 and (select l->>'detail' from jsonb_array_elements(public.get_card_payment_states(rehearsal.aa())->'legs') l
                      where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'ku2')) = 'conflicting_decisions',
  'previous RPC: it did not supersede the preserved decision; the two conflict and the payment is unresolved');
-- Undo still works on the preserved decision (it refuses only the system kind); the new match then decides the leg.
select th.assert(public.undo_card_payment_decision(rehearsal.aa(),
                   (select id from public.card_payment_decisions where kind = 'pair_counterpart_removed' and a_plaid_transaction_id = 'ku2'),
                   (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'undone',
  'previous RPC: the user can undo the preserved decision');
select th.assert(rehearsal.sre('ku2') = 'tracked/user_pair/0', 'previous RPC: and the new match then decides the payment');
-- The same for the hold: the user's own confirmation of the held pair is saved, but reads as conflicting with
-- the hold (both claim the two legs); the previous undo does not refuse a hold, and then the confirmation decides.
select th.assert(public.link_card_payment(rehearsal.aa(), (select id from public.transactions where plaid_transaction_id = 'kt'), (select id from public.transactions where plaid_transaction_id = 'yt'), 0, (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'saved',
  'previous RPC: the user''s confirmation of the held pair is saved');
select th.assert(rehearsal.sre('kt') = 'unresolved/decision_invalidated/null'
                 and (select l->>'detail' from jsonb_array_elements(public.get_card_payment_states(rehearsal.aa())->'legs') l
                      where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'kt')) = 'conflicting_decisions',
  'previous evaluator: it reads as conflicting with the hold, and the payment stays unresolved');
select th.assert(public.undo_card_payment_decision(rehearsal.aa(),
                   (select id from public.card_payment_decisions where kind = 'ambiguity_hold_removed_card' and b_plaid_transaction_id = 'kt'), (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'undone',
  'previous RPC: undo does not refuse the hold');
select th.assert(rehearsal.sre('kt') = 'tracked/user_pair/0', 'previous RPC: and the user''s confirmation then decides the payment');
-- Header (v), revision 5: the Option B hold is the decision shown on k2 ("needs review"). The previous undo does
-- not refuse it either, and what it leaves is exactly the switch Option B forbids: with the hold undone, y2 and
-- k2 are back in automatic matching, tier 1 pairs them (the system record goes dormant behind the pair), and the
-- bystander is tied again. The undo is permanent — superseded_by = the hold's own id — so this is also what the
-- payment reads after both migrations are applied again (reapplied.sql shows that).
select th.assert(public.undo_card_payment_decision(rehearsal.aa(),
                   (select id from public.card_payment_decisions where kind = 'ambiguity_hold_removed_card' and b_plaid_transaction_id = 'k2'), (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'undone',
  'previous RPC (v): undo does not refuse the Option B hold');
select th.assert((select superseded_by = id from public.card_payment_decisions where kind = 'ambiguity_hold_removed_card' and b_plaid_transaction_id = 'k2')
                 and rehearsal.records() = array['k2']
                 and rehearsal.sre('k2') = 'tracked/auto_pair/0' and rehearsal.partner('k2') = rehearsal.tid('y2') and rehearsal.holder('k2') = 'none'
                 and rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.partner('kb') is null,
  'previous RPC (v): with its hold undone the payment is SWITCHED to the kept card leg that was already there, although its removed-destination record is still live — the protection Option B added is gone');
rollback;
select rehearsal.take('schema_rolled_back_rpc_probe_undone');
select th.assert(rehearsal.same('schema_rolled_back_evaluated', 'schema_rolled_back_rpc_probe_undone'), 'the RPC demonstration was rolled back: no row changed');
