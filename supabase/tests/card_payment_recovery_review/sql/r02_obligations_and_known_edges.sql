-- Review obligations, their independent sources, their known surviving edges, and gaps
-- (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §3; product approval of 2026-10-09, §1 and §4).
--
-- What is shown, each with hand-derived expectations:
--   KNOWN   a pair that survived the removal and that the obligation lists stays AUTOMATIC when the hold releases
--           it: the guard withholds only what no obligation knows.
--   EVERY   two removals, two obligations on one payment, three sources kept apart. A pair must be listed by
--           EVERY obligation: one listed by the first removal's obligation only is withheld.
--   EITHER  the affected leg can be the CARD leg (a cash account was removed): a new cash leg that would pair
--           with it is withheld just the same.
--   PEND    a pending payment and a pending kept leg that post later are the same lineages: still affected,
--           still a known edge.
--   NOFALL  when the guard withholds the selected pair, NOTHING is selected in its place — not even the payment's
--           other edge that the obligation lists and that would be the automatic match without the newcomer.
--   LEGACY  decisions that exist with NO provenance row (as a database upgraded from 20261006120000 holds them)
--           are seeded: the hold's own edge is recorded, nothing else is inferred, and the missing attribution
--           is its own gap — which lists nothing, so even the hold's own pair is withheld once the hold releases it.
--   MARKER  a removal that finished without recording its sources casts a gap on every earlier obligation; a
--           later, complete capture does not remove that gap.
--   DETACH  when the affected payment's own account is deleted, its hold and record go with the account, and the
--           obligations STAY (no foreign key) — detached, resolving to no row.
-- User aa. Item 1 "Bank A" (card XA, checking RA) and item 4 "Bank B" (card XB) are removed, in that order. Item 3
-- "Kept Bank" stays: checking C, cards Y and Z. Dates are days of 2026-09; amounts are dollars.
set role service_role;

update public.plaid_items set institution_name = 'Bank A' where id = '00000000-0000-0000-0000-000000000001';
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r02-item-kept', 'Kept Bank');
select rrh.item('00000000-0000-0000-0000-000000000004', rrh.aa(), 'r02-item-b', 'Bank B');
select rrh.account('00000000-0000-0000-0000-0000000102a1', '00000000-0000-0000-0000-000000000001', 'r02-xa', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000102a2', '00000000-0000-0000-0000-000000000001', 'r02-ra', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000102b1', '00000000-0000-0000-0000-000000000004', 'r02-xb', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000102c1', '00000000-0000-0000-0000-000000000003', 'r02-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000102c2', '00000000-0000-0000-0000-000000000003', 'r02-y', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000102c3', '00000000-0000-0000-0000-000000000003', 'r02-z', 'credit');
create function pg_temp.xa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102a1'::uuid $$;
create function pg_temp.ra() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102a2'::uuid $$;
create function pg_temp.xb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102b1'::uuid $$;
create function pg_temp.c() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102c1'::uuid $$;
create function pg_temp.y() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102c2'::uuid $$;
create function pg_temp.z() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000102c3'::uuid $$;
create function pg_temp.redate(p_plaid text, p_date date) returns void language sql as $$
  update public.transactions set date = p_date where plaid_transaction_id = p_plaid $$;

-- KNOWN (100): k +100 C 10 | xa −100 XA 11 (1 day: the automatic match) | y −100 Y 13 (3 days).
select rrh.cardleg('k-known', pg_temp.c(), 100, '2026-09-10'), rrh.cardleg('xa-known', pg_temp.xa(), -100, '2026-09-11'),
       rrh.cardleg('y-known', pg_temp.y(), -100, '2026-09-13');
-- EVERY (500): k +500 C 10 | xa −500 XA 11 and xb −500 XB 11 (a tie: no automatic match) | y −500 Y 12 | z −500 Z 12.
select rrh.cardleg('k-every', pg_temp.c(), 500, '2026-09-10'), rrh.cardleg('xa-every', pg_temp.xa(), -500, '2026-09-11'),
       rrh.cardleg('xb-every', pg_temp.xb(), -500, '2026-09-11'), rrh.cardleg('y-every', pg_temp.y(), -500, '2026-09-12'),
       rrh.cardleg('z-every', pg_temp.z(), -500, '2026-09-12');
-- EITHER (600): card leg yc −600 Y 10 | removed CASH ra +600 RA 11 (1 day: its automatic match) | kept cash k +600 C 13.
select rrh.cardleg('yc-either', pg_temp.y(), -600, '2026-09-10'), rrh.cardleg('ra-either', pg_temp.ra(), 600, '2026-09-11'),
       rrh.cardleg('k-either', pg_temp.c(), 600, '2026-09-13');
-- PEND (800): k +800 C 10 PENDING | xa −800 XA 11 | y −800 Y 13 PENDING.
select rrh.cardleg('k-pend', pg_temp.c(), 800, '2026-09-10', true), rrh.cardleg('xa-pend', pg_temp.xa(), -800, '2026-09-11'),
       rrh.cardleg('y-pend', pg_temp.y(), -800, '2026-09-13', true);
-- NOFALL (900): k +900 C 10 | xa −900 XA 12 (2 days: the automatic match) | y −900 Y 13 (3 days).
select rrh.cardleg('k-nofall', pg_temp.c(), 900, '2026-09-10'), rrh.cardleg('xa-nofall', pg_temp.xa(), -900, '2026-09-12'),
       rrh.cardleg('y-nofall', pg_temp.y(), -900, '2026-09-13');
-- LEGACY (700): k +700 C 10 | y −700 Y 12 — and, written directly as an earlier body left them, a record on k and a
-- hold on k/y dated the 11th, with no provenance row and no removal named.
select rrh.cardleg('k-legacy', pg_temp.c(), 700, '2026-09-10'), rrh.cardleg('y-legacy', pg_temp.y(), -700, '2026-09-12');
insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) values
  (rrh.aa(), 'destination_removed_card', pg_temp.c(), 'k-legacy', 70000);
insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date) values
  (rrh.aa(), 'ambiguity_hold_removed_card', pg_temp.y(), 'y-legacy', -70000, pg_temp.c(), 'k-legacy', 70000, '2026-09-11');

-- ---- LEGACY: seeding from what is retained -----------------------------------------------------------------
reset role;
select th.assert(public.card_payment_review_seed_retained() = 2, 'LEGACY: the two retained decisions are seeded');
select th.assert(public.card_payment_review_seed_retained() = 0, 'LEGACY: seeding again finds nothing to do');
set role service_role;
select th.expect_error($$select public.card_payment_review_seed_retained()$$, '%permission denied%');
select th.assert(rrh.obligations('k-legacy') = 'gap[unattributed_decision](-) edges= sources= ; seeded(-) edges=y-legacy sources=ambiguity_hold:?,removed_destination:?',
                 'LEGACY: one seeded obligation with the hold''s own edge and both decisions as sources of unknown origin, and the missing attribution as its own gap: ' || rrh.obligations('k-legacy'));
select th.assert(not rrh.fresh(), 'LEGACY: seeding makes the owner stale');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-legacy') = 'untracked/removed_card/-70000 partner=- decision=destination_removed_card range=-70000..-70000', 'LEGACY: the hold still withholds k/y, the record reads −700: ' || rrh.line('k-legacy'));
select th.assert(rrh.review('k-legacy') = 'withheld=- obligations=2 gap=t', 'LEGACY: under review, with a coverage gap: ' || rrh.review('k-legacy'));
-- The hold releases its own pair when y comes strictly closer than the removed date. The seeded obligation lists
-- that pair; the gap lists nothing. So the pair is withheld by the guard.
select pg_temp.redate('y-legacy', '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-legacy') = 'unresolved/relink_review_required/null partner=- decision=- range=-70000..0' and rrh.review('k-legacy') = 'withheld=y-legacy obligations=2 gap=t',
                 'LEGACY: unknown attribution withholds even the hold''s own pair: ' || rrh.line('k-legacy') || ' ' || rrh.review('k-legacy'));

-- ---- Before the removals ------------------------------------------------------------------------------------
select th.assert(rrh.line('k-known') = 'tracked/auto_pair/0 partner=xa-known decision=- range=0..0', 'before: KNOWN is matched to xa: ' || rrh.line('k-known'));
select th.assert(rrh.line('k-every') = 'unresolved/ambiguous/null partner=- decision=- range=-50000..0', 'before: EVERY is a tie between xa and xb: ' || rrh.line('k-every'));
select th.assert(rrh.line('yc-either') = 'paired/auto_pair/0 partner=ra-either decision=- range=0..0', 'before: EITHER''s card leg is matched to the cash leg that will be removed: ' || rrh.line('yc-either'));

-- ---- Removal 1: Bank A ---------------------------------------------------------------------------------------
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select th.assert(rrh.obligations('k-known') = 'captured(harness-item-a) edges=y-known sources=ambiguity_hold:xa-known,removed_destination:xa-known', 'removal 1, KNOWN: ' || rrh.obligations('k-known'));
-- EVERY: no automatic match, so no record. Two holds (k with xb, k with y, k with z: three), ONE removed source.
-- Every surviving edge of k is captured: xb, y and z.
select th.assert(rrh.obligations('k-every') = 'captured(harness-item-a) edges=xb-every,y-every,z-every sources=ambiguity_hold:xa-every,ambiguity_hold:xa-every,ambiguity_hold:xa-every',
                 'removal 1, EVERY: one obligation, three holds on one source, three surviving edges: ' || rrh.obligations('k-every'));
-- EITHER: the affected payment is the CARD leg; no record exists for a card leg.
select th.assert(rrh.obligations('yc-either') = 'captured(harness-item-a) edges=k-either sources=ambiguity_hold:ra-either' and rrh.obligations('k-either') = 'none',
                 'removal 1, EITHER: the card leg has the obligation; the kept cash leg has none: ' || rrh.obligations('yc-either'));
select th.assert((select o.anchor_side from public.card_payment_review_obligations o where o.anchor_plaid_transaction_id = 'yc-either') = 'credit', 'EITHER: the obligation records the card side');
select th.assert(rrh.line('yc-either') = 'unresolved/ambiguous/0 partner=- decision=- range=0..0', 'removal 1, EITHER: the hold withholds yc/k, the card leg is unmatched: ' || rrh.line('yc-either'));
select th.assert(rrh.line('k-every') = 'unresolved/ambiguous/null partner=- decision=- range=-50000..0' and rrh.review('k-every') = 'withheld=- obligations=1 gap=f',
                 'removal 1, EVERY: k/xb would now be selected and the hold withholds it: still a tie-range, nothing for the guard: ' || rrh.line('k-every') || ' ' || rrh.review('k-every'));

-- KNOWN: the kept leg comes strictly closer (the 10th): the hold releases k/y, the obligation lists k/y: automatic.
select pg_temp.redate('y-known', '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-known') = 'tracked/auto_pair/0 partner=y-known decision=- range=0..0' and rrh.auto_pair('k-known') = 'y-known',
                 'KNOWN: a pair the obligation lists stays automatic under the existing rules: ' || rrh.line('k-known'));
select th.assert(rrh.review('k-known') = 'withheld=- obligations=1 gap=f' and rrh.retained('k-known') = 'D(k-known) H(y-known/k-known@2026-09-11)', 'KNOWN: still an affected payment; H and D retained: ' || rrh.review('k-known'));

-- EITHER: a NEW cash leg n (+600, C, the 10th: the same day as yc). yc/n is selected; the card leg's obligation
-- does not list n: withheld. The new cash leg reads the range; the card leg unresolved, 0.
select rrh.cardleg('n-either', pg_temp.c(), 600, '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('n-either') = 'unresolved/relink_review_required/null partner=- decision=- range=-60000..0' and rrh.review('n-either') = 'withheld=yc-either obligations=1 gap=f',
                 'EITHER: a new cash leg does not become "tracked, 0" against an affected card leg: ' || rrh.line('n-either') || ' ' || rrh.review('n-either'));
select th.assert(rrh.line('yc-either') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0' and rrh.review('yc-either') = 'withheld=n-either obligations=1 gap=f',
                 'EITHER: the affected card leg is unresolved, effect 0: ' || rrh.line('yc-either'));
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id in ('yc-either', 'n-either', 'k-either')),
                 'EITHER: no removed-card record was created on the mirror side');

-- PEND: both pending rows post. k posts unchanged; y posts on the 10th (closer). Same lineages: k is still the
-- affected payment, k/y is still the listed edge; the hold (which follows the lineage too) releases it.
select rrh.cardleg('k-pend-posted', pg_temp.c(), 800, '2026-09-10', false, 'k-pend'), rrh.cardleg('y-pend-posted', pg_temp.y(), -800, '2026-09-10', false, 'y-pend');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-pend-posted') = 'tracked/auto_pair/0 partner=y-pend-posted decision=- range=0..0' and rrh.review('k-pend-posted') = 'withheld=- obligations=1 gap=f',
                 'PEND: the posted rows are the same lineages: affected, and a known edge: ' || rrh.line('k-pend-posted') || ' ' || rrh.review('k-pend-posted'));
select th.assert(rrh.obligations('k-pend') = 'captured(harness-item-a) edges=y-pend sources=ambiguity_hold:xa-pend,removed_destination:xa-pend', 'PEND: the obligation still names the references it was captured with: ' || rrh.obligations('k-pend'));

-- NOFALL. The removal left a record on k and a hold on k/y dated the 12th. y comes to the 11th (1 day; the removed
-- leg was 2 days away): the hold releases k/y, the obligation lists it, it is the automatic match.
select pg_temp.redate('y-nofall', '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-nofall') = 'tracked/auto_pair/0 partner=y-nofall decision=- range=0..0', 'NOFALL, before the newcomer: the known edge is the automatic match: ' || rrh.line('k-nofall'));
-- A NEW leg arrives on the payment's own day (card Z, 0 days). k/w is now the selected pair; no obligation lists it:
-- withheld. k/y is NOT formed in its place, although it is listed and was the match a moment ago.
select rrh.cardleg('w-nofall', pg_temp.z(), -900, '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-nofall') = 'unresolved/relink_review_required/null partner=- decision=- range=-90000..0' and rrh.review('k-nofall') = 'withheld=w-nofall obligations=1 gap=f',
                 'NOFALL: the selected pair is withheld and the payment is the range: ' || rrh.line('k-nofall') || ' ' || rrh.review('k-nofall'));
select th.assert(rrh.line('y-nofall') = 'unresolved/ambiguous/0 partner=- decision=- range=0..0' and rrh.auto_pair('k-nofall') = '-',
                 'NOFALL: nothing is selected in the withheld pair''s place — the listed edge k/y is not a fallback: ' || rrh.line('y-nofall'));
select th.assert(rrh.candidates('k-nofall') = 'w-nofall,y-nofall', 'NOFALL: both stay candidates: ' || rrh.candidates('k-nofall'));

-- ---- Removal 2: Bank B. Before it, z leaves k's window (the 20th), so the second removal does not list it. -----
select pg_temp.redate('z-every', '2026-09-20');
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000004');
select th.assert(rrh.obligations('k-every') = 'captured(harness-item-a) edges=xb-every,y-every,z-every sources=ambiguity_hold:xa-every,ambiguity_hold:xa-every,ambiguity_hold:xa-every'
                                              || ' ; captured(r02-item-b) edges=y-every sources=ambiguity_hold:xb-every',
                 'removal 2, EVERY: a second obligation with its own source; the first is untouched, also where its hold on k/xb went with xb''s account: ' || rrh.obligations('k-every'));
select th.assert(rrh.retained('k-every') = 'H(y-every/k-every@2026-09-11) H(y-every/k-every@2026-09-11) H(z-every/k-every@2026-09-11)', 'removal 2, EVERY: the live holds: ' || rrh.retained('k-every'));
select th.assert(rrh.line('k-every') = 'unresolved/ambiguous/null partner=- decision=- range=-50000..0', 'removal 2, EVERY: both holds withhold k/y: ' || rrh.line('k-every'));
select th.assert(rrh.review('k-every') = 'withheld=- obligations=2 gap=f', 'removal 2, EVERY: two obligations, nothing for the guard yet: ' || rrh.review('k-every'));

-- z comes back onto the payment's own day. k/z is selected (0 days against 2) and the first removal's hold
-- releases it (the removed candidate was 1 day away). The FIRST obligation lists k/z; the SECOND does not: withheld.
select pg_temp.redate('z-every', '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-every') = 'unresolved/relink_review_required/null partner=- decision=- range=-50000..0' and rrh.review('k-every') = 'withheld=z-every obligations=2 gap=f',
                 'EVERY: a pair one obligation lists and the other does not is withheld: ' || rrh.line('k-every') || ' ' || rrh.review('k-every'));
-- y comes onto the payment's own day too, and z leaves: k/y is listed by BOTH obligations and both holds release it.
select pg_temp.redate('z-every', '2026-09-20');
select pg_temp.redate('y-every', '2026-09-10');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-every') = 'tracked/auto_pair/0 partner=y-every decision=- range=0..0' and rrh.review('k-every') = 'withheld=- obligations=2 gap=f',
                 'EVERY: a pair EVERY obligation lists stays automatic: ' || rrh.line('k-every') || ' ' || rrh.review('k-every'));
select th.assert((select count(*) from public.card_payment_review_obligation_sources s join public.card_payment_review_obligations o on o.id = s.obligation_id
                  where o.anchor_plaid_transaction_id = 'k-every') = 4, 'EVERY: the four sources (three of removal 1, one of removal 2) are four rows, never merged');
select th.assert(rrh.line('k-nofall') = 'unresolved/relink_review_required/null partner=- decision=- range=-90000..0', 'NOFALL: unchanged by the second removal: ' || rrh.line('k-nofall'));

-- ---- MARKER: a removal that recorded no sources ----------------------------------------------------------------
-- As a database holds it after a removal ran while this provenance was rolled back: a cleaned removal of this user
-- with no generation row. When it ran is not known, so it casts a gap on every obligation of the user.
reset role;
insert into public.plaid_item_removals (user_id, item_id, plaid_item_id, institution_name, status_before, status, preview_digest, plaid_outcome, plaid_removed_at, cleaned_at, deleted_counts, loan_adjustments)
values (rrh.aa(), '00000000-0000-0000-0000-0000000000f9', 'r02-item-unrecorded', 'Unrecorded Bank', 'active', 'cleaned', repeat('0', 64), 'removed', now(), now(), '{}'::jsonb, '[]'::jsonb);
set role service_role;
select public.card_payment_review_record_gaps(rrh.aa());
select th.assert(rrh.obligations('k-known') = 'captured(harness-item-a) edges=y-known sources=ambiguity_hold:xa-known,removed_destination:xa-known ; gap[unrecorded_removal](r02-item-unrecorded) edges= sources=',
                 'MARKER: the unrecorded removal is its own gap on the payment, beside the captured obligation: ' || rrh.obligations('k-known'));
select th.assert(not rrh.fresh(), 'MARKER: a new gap is a matching input: the owner is stale');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-known') = 'unresolved/relink_review_required/null partner=- decision=- range=-10000..0' and rrh.review('k-known') = 'withheld=y-known obligations=2 gap=t',
                 'MARKER: with a gap, the pair that was known and automatic is withheld: ' || rrh.line('k-known') || ' ' || rrh.review('k-known'));
select public.card_payment_review_record_gaps(rrh.aa());
select th.assert((select count(*) from public.card_payment_review_obligations o where o.anchor_plaid_transaction_id = 'k-known') = 2, 'MARKER: recording the gaps again adds nothing');

-- ---- DETACH: the affected payments' own account goes ---------------------------------------------------------------
-- The Kept Bank (item 3) is removed: C, Y and Z, every payment above and every hold and record on them are
-- deleted. The obligations stay.
create temporary table before_detach as
  select (select count(*) from public.card_payment_review_obligations) as obligations,
         (select count(*) from public.card_payment_review_obligation_sources) as sources,
         (select count(*) from public.card_payment_review_memberships) as memberships;
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000003');
select th.assert((select count(*) from public.card_payment_decisions where user_id = rrh.aa()) = 0, 'DETACH: every decision went with its account');
select th.assert((select count(*) from public.card_payment_review_obligations) >= (select obligations from pg_temp.before_detach)
                 and (select count(*) from public.card_payment_review_obligation_sources) >= (select sources from pg_temp.before_detach)
                 and (select count(*) from public.card_payment_review_memberships) >= (select memberships from pg_temp.before_detach),
                 'DETACH: no obligation, source or known edge was deleted by the account cascade');
select th.assert((select count(*) from public.card_payment_review_obligation_sources s
                  where not exists (select 1 from public.card_payment_decisions d where d.id = s.decision_id)) = (select count(*) from public.card_payment_review_obligation_sources),
                 'DETACH: the sources now name decisions that no longer exist — kept as history');
select th.assert(rrh.fresh() and jsonb_array_length(rrh.states()->'reviews') = 0, 'DETACH: no current row is under review: the anchors resolve to nothing');
select th.assert((public.get_card_payment_recovery_reviews(rrh.aa())->>'affectedPaymentCount')::integer = 0, 'DETACH: the review list is empty');
select th.assert((select count(distinct (o.anchor_account_id, o.anchor_plaid_transaction_id)) from public.card_payment_review_obligations o where o.user_id = rrh.aa()) = 6,
                 'DETACH: six affected payments are still on record (known, every, either, pend, nofall, legacy)');
