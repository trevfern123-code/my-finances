-- The approved packet 2-A oracle (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §5; product approval of 2026-10-09, §2–§3).
-- Every expected value below is written out by hand from the approved rules; none is computed by a helper.
--
-- One fixture, one case per amount (dollars; a database cent amount is 100x). All dates are days of 2026-09.
-- User aa: item 1 "Card Bank" (card X) is REMOVED. Item 3 "Kept Bank" stays: checking C, EXCLUDED checking CE,
-- card Y. Before the removal every payment k (+amount, C, the 10th) is matched automatically to x (−amount, X, the
-- 11th, one day away); y (−amount, Y, the 12th, two days away) was already there. The removal therefore leaves,
-- for every case: a record D on k (its destination was removed) and a hold H on the pair k/y (dated the 11th).
-- AFTER the removal two institutions are linked: item 7 "Card Bank (relinked)" with card X2 and EXCLUDED card
-- XE2, and item 8 "Other Bank" with card W. What arrives then:
--
--   case   amount  arrives after the removal            expected reading of k (hand-derived)
--   E1     360     x2 on the 14th (4 days)              k/y is still the selected pair and H withholds it; the guard
--                                                       withholds nothing more: D, untracked / removed_card, −360
--   E7     370     w on the 11th, UNRELATED (1 day)     k/w is selected, H does not concern it, no obligation lists
--                                                       it: withheld. Range {−370, 0}; w unresolved, 0
--   E2     380     x2 on the 11th, the genuine return   the same as E7: identity is not consent
--   PAIR   390     x2 on the 11th; the user pairs       tracked / user_pair / 0; H, D and the obligation remain;
--                  k with x2, then undoes it            after the undo: the guarded range again
--   REJ    400     w on the 11th; reject suggestion     no decision, no figure change: still the range
--   DEF    410     w on the 11th; defer                 the same
--   DIS    420     w on the 11th; the user dismisses    k/w is gone by the user's decision; k/y is selected and H
--                  k/w; then a NEW w2 arrives           withholds it: D, −420. w2 gets no permission: the range
--   DIS2   430     w on the 11th; dismiss, then undo    after the undo: the guarded range again
--   XEX    440     xe2 on the 11th, card EXCLUDED       k is still guarded and uncertain (an included card exists);
--                                                       xe2 is not counted
--   KEX    450     payment on EXCLUDED CE; w on the 11th   k not counted, 0, with its review state; w unresolved
-- User bb (no included card): item 2 (card BX, included) is REMOVED; item 5 stays: checking BC and EXCLUDED card
-- BY. After the removal item 9 is linked with EXCLUDED card BW.
--   NOC    460     bw on the 11th (excluded card)       no included card exists: untracked / no_included_card,
--                                                       −460, with its review state. Including BW: the range.
set role service_role;

-- ---- Fixture -----------------------------------------------------------------------------------------------
update public.plaid_items set institution_name = 'Card Bank' where id = '00000000-0000-0000-0000-000000000001';
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r01-item-kept', 'Kept Bank');
select rrh.item('00000000-0000-0000-0000-000000000005', rrh.bb(), 'r01-item-bb-kept', 'BB Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000101a1', '00000000-0000-0000-0000-000000000001', 'r01-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000101b1', '00000000-0000-0000-0000-000000000003', 'r01-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000101b2', '00000000-0000-0000-0000-000000000003', 'r01-ce', 'depository', true);
select rrh.account('00000000-0000-0000-0000-0000000101b3', '00000000-0000-0000-0000-000000000003', 'r01-y', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000101c1', '00000000-0000-0000-0000-000000000002', 'r01-bx', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000101d1', '00000000-0000-0000-0000-000000000005', 'r01-bc', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000101d2', '00000000-0000-0000-0000-000000000005', 'r01-by', 'credit', true);
create function pg_temp.x() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101a1'::uuid $$;
create function pg_temp.c() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101b1'::uuid $$;
create function pg_temp.ce() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101b2'::uuid $$;
create function pg_temp.y() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101b3'::uuid $$;
create function pg_temp.x2() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101e1'::uuid $$;
create function pg_temp.xe2() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101e2'::uuid $$;
create function pg_temp.w() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000101f1'::uuid $$;

-- (case, amount, the payment's account) — the same three legs for every case.
create temporary table cases (kase text primary key, amount numeric not null, cash uuid not null);
insert into pg_temp.cases values
  ('e1', 360, pg_temp.c()), ('e7', 370, pg_temp.c()), ('e2', 380, pg_temp.c()), ('pair', 390, pg_temp.c()),
  ('rej', 400, pg_temp.c()), ('def', 410, pg_temp.c()), ('dis', 420, pg_temp.c()), ('dis2', 430, pg_temp.c()),
  ('xex', 440, pg_temp.c()), ('kex', 450, pg_temp.ce());
select rrh.cardleg('k-' || kase, cash, amount, '2026-09-10'), rrh.cardleg('x-' || kase, pg_temp.x(), -amount, '2026-09-11'),
       rrh.cardleg('y-' || kase, pg_temp.y(), -amount, '2026-09-12')
from pg_temp.cases;
select rrh.cardleg('k-noc', '00000000-0000-0000-0000-0000000101d1', 460, '2026-09-10'),
       rrh.cardleg('x-noc', '00000000-0000-0000-0000-0000000101c1', -460, '2026-09-11'),
       rrh.cardleg('y-noc', '00000000-0000-0000-0000-0000000101d2', -460, '2026-09-12');

-- ---- Before the removal: the automatic matches the removal will delete ---------------------------------------
select public.evaluate_card_payments(rrh.aa()), public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.line('k-e7') = 'tracked/auto_pair/0 partner=x-e7 decision=- range=0..0', 'before: k-e7 is matched automatically to the card that will be removed: ' || rrh.line('k-e7'));
select th.assert(rrh.line('k-kex') = 'not_counted/excluded_account/0 partner=x-kex decision=- range=0..0', 'before: the payment on the excluded account is evidence, matched to x: ' || rrh.line('k-kex'));
select th.assert(rrh.line('k-noc', rrh.bb()) = 'tracked/auto_pair/0 partner=x-noc decision=- range=0..0', 'before: bb''s payment is matched to its only included card: ' || rrh.line('k-noc', rrh.bb()));
select th.assert((select count(*) from public.card_payment_review_obligations) = 0, 'before: no review obligation exists');
select th.assert(rrh.review('k-e7') = 'none', 'before: no payment is under review');

-- ---- The removals -----------------------------------------------------------------------------------------
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select rrh.remove(rrh.bb(), '00000000-0000-0000-0000-000000000002');

-- What every case reads after the removal, before anything new arrives (the baseline 20261006120000 contract).
select th.assert(rrh.line('k-' || kase) = case when kase = 'kex' then 'not_counted/excluded_account/0 partner=- decision=destination_removed_card range=0..0'
                                               else 'untracked/removed_card/' || (-amount * 100)::bigint || ' partner=- decision=destination_removed_card range=' || (-amount * 100)::bigint || '..' || (-amount * 100)::bigint end,
                 'after the removal, ' || kase || ': the payment reads its removed destination: ' || rrh.line('k-' || kase))
from pg_temp.cases;
select th.assert(rrh.retained('k-' || kase) = 'D(k-' || kase || ') H(y-' || kase || '/k-' || kase || '@2026-09-11)',
                 'after the removal, ' || kase || ': one record and one hold are retained: ' || rrh.retained('k-' || kase))
from pg_temp.cases;
-- The capture: ONE obligation per affected payment, both of its sources, and the one surviving edge (k/y).
select th.assert(rrh.obligations('k-' || kase) = 'captured(harness-item-a) edges=y-' || kase || ' sources=ambiguity_hold:x-' || kase || ',removed_destination:x-' || kase,
                 'after the removal, ' || kase || ': the obligation, its sources and its surviving edge were captured: ' || rrh.obligations('k-' || kase))
from pg_temp.cases;
select th.assert(rrh.review('k-' || kase) = 'withheld=- obligations=1 gap=f', 'after the removal, ' || kase || ': the payment is under review, nothing withheld: ' || rrh.review('k-' || kase))
from pg_temp.cases;
select th.assert(rrh.obligations('y-e7') = 'none' and rrh.review('y-e7') = 'none', 'the kept card''s leg is not an affected payment: it has no obligation and no review state');
select th.assert(rrh.line('k-noc', rrh.bb()) = 'untracked/removed_card/-46000 partner=- decision=destination_removed_card range=-46000..-46000',
                 'after the removal, NOC: the record is read before the no-included-card rule: ' || rrh.line('k-noc', rrh.bb()));
select th.assert(rrh.obligations('k-noc', rrh.bb()) = 'captured(harness-item-b) edges=y-noc sources=ambiguity_hold:x-noc,removed_destination:x-noc',
                 'after the removal, NOC: the edge to the EXCLUDED kept card is captured too: ' || rrh.obligations('k-noc', rrh.bb()));
create temporary table before_arrivals as
  select (select count(*) from public.card_payment_review_obligations) as obligations,
         (select count(*) from public.card_payment_review_memberships) as memberships,
         (select count(*) from public.card_payment_review_obligation_sources) as sources,
         (select count(*) from public.card_payment_decisions where superseded_by is null and kind in ('destination_removed_card', 'ambiguity_hold_removed_card')) as retained;
select th.assert((select obligations = 11 and memberships = 11 and sources = 22 and retained = 22 from pg_temp.before_arrivals),
                 'eleven affected payments: eleven obligations, eleven known edges, twenty-two sources, twenty-two retained decisions: '
                 || (select row(obligations, memberships, sources, retained)::text from pg_temp.before_arrivals));

-- ---- What arrives afterwards --------------------------------------------------------------------------------
select rrh.item('00000000-0000-0000-0000-000000000007', rrh.aa(), 'r01-item-relinked', 'Card Bank (relinked)');
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'r01-item-other', 'Other Bank');
select rrh.item('00000000-0000-0000-0000-000000000009', rrh.bb(), 'r01-item-bb-other', 'BB Other Bank');
select rrh.account(pg_temp.x2(), '00000000-0000-0000-0000-000000000007', 'r01-x2', 'credit');
select rrh.account(pg_temp.xe2(), '00000000-0000-0000-0000-000000000007', 'r01-xe2', 'credit', true);
select rrh.account(pg_temp.w(), '00000000-0000-0000-0000-000000000008', 'r01-w', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000101d3', '00000000-0000-0000-0000-000000000009', 'r01-bw', 'credit', true);
select rrh.cardleg('x2-e1', pg_temp.x2(), -360, '2026-09-14');
select rrh.cardleg('w-e7', pg_temp.w(), -370, '2026-09-11');
select rrh.cardleg('x2-e2', pg_temp.x2(), -380, '2026-09-11');
select rrh.cardleg('x2-pair', pg_temp.x2(), -390, '2026-09-11');
select rrh.cardleg('w-rej', pg_temp.w(), -400, '2026-09-11');
select rrh.cardleg('w-def', pg_temp.w(), -410, '2026-09-11');
select rrh.cardleg('w-dis', pg_temp.w(), -420, '2026-09-11');
select rrh.cardleg('w-dis2', pg_temp.w(), -430, '2026-09-11');
select rrh.cardleg('xe2-xex', pg_temp.xe2(), -440, '2026-09-11');
select rrh.cardleg('w-kex', pg_temp.w(), -450, '2026-09-11');
select rrh.cardleg('bw-noc', '00000000-0000-0000-0000-0000000101d3', -460, '2026-09-11');
select th.assert(not rrh.fresh() and not rrh.fresh(rrh.bb()), 'new bank rows make both users stale: nothing is readable until they are evaluated');
select public.evaluate_card_payments(rrh.aa()), public.evaluate_card_payments(rrh.bb());

-- E1: the return is FARTHER than the kept card. k/y is the selected pair, H withholds it (|11−10| <= |10−12|);
-- the guard has nothing left to withhold. The fixture stays −360 through D.
select th.assert(rrh.line('k-e1') = 'untracked/removed_card/-36000 partner=- decision=destination_removed_card range=-36000..-36000', 'E1: still the removed-card result, −360: ' || rrh.line('k-e1'));
select th.assert(rrh.review('k-e1') = 'withheld=- obligations=1 gap=f', 'E1: under review, and the guard withheld no pair: ' || rrh.review('k-e1'));
select th.assert(rrh.line('x2-e1') = 'unresolved/ambiguous/0 partner=- decision=- range=0..0' and rrh.review('x2-e1') = 'none', 'E1: the returned leg is an ordinary unmatched candidate: ' || rrh.line('x2-e1'));
select th.assert(rrh.auto_pair('k-e1') = '-', 'E1: no automatic pair is published for k');

-- E7: an UNRELATED payment on the original day. It would have won (1 day against 2). Withheld both ways.
select th.assert(rrh.line('k-e7') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0', 'E7: the payment is a range, with no partner and no decision named: ' || rrh.line('k-e7'));
select th.assert(rrh.line('w-e7') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0', 'E7: the unrelated card leg is unresolved, effect 0: ' || rrh.line('w-e7'));
select th.assert(rrh.review('k-e7') = 'withheld=w-e7 obligations=1 gap=f' and rrh.review('w-e7') = 'withheld=k-e7 obligations=1 gap=f', 'E7: both legs carry the withheld pair and the obligation: ' || rrh.review('k-e7') || ' / ' || rrh.review('w-e7'));
select th.assert(rrh.auto_pair('k-e7') = '-', 'E7: no automatic pair row is published');
select th.assert(rrh.candidates('k-e7') = 'w-e7,y-e7' and rrh.candidates('w-e7') = 'k-e7', 'E7: both legs stay in the pool as each other''s candidates: ' || rrh.candidates('k-e7') || ' / ' || rrh.candidates('w-e7'));
select th.assert(rrh.line('y-e7') = 'unresolved/ambiguous/0 partner=- decision=- range=0..0', 'E7: nothing is selected in the withheld pair''s place: the kept card stays unmatched: ' || rrh.line('y-e7'));
select th.assert(rrh.retained('k-e7') = 'D(k-e7) H(y-e7/k-e7@2026-09-11)', 'E7: H and D are retained, live: ' || rrh.retained('k-e7'));

-- E2: the GENUINE return on the original day. Identity is not consent: the same outcome as E7.
select th.assert(rrh.line('k-e2') = 'unresolved/relink_review_required/null partner=- decision=- range=-38000..0', 'E2: the genuine return does not restore the automatic zero: ' || rrh.line('k-e2'));
select th.assert(rrh.line('x2-e2') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0', 'E2: the returned leg is unresolved, 0: ' || rrh.line('x2-e2'));
select th.assert(rrh.review('k-e2') = 'withheld=x2-e2 obligations=1 gap=f', 'E2: withheld: ' || rrh.review('k-e2'));

-- XEX: the returning card is EXCLUDED and another included card exists: k stays guarded and uncertain.
select th.assert(rrh.line('k-xex') = 'unresolved/relink_review_required/null partner=- decision=- range=-44000..0', 'XEX: the payment is the guarded range, not partner_excluded: ' || rrh.line('k-xex'));
select th.assert(rrh.line('xe2-xex') = 'not_counted/excluded_account/0 partner=- decision=- range=0..0' and rrh.review('xe2-xex') = 'withheld=k-xex obligations=1 gap=f', 'XEX: the excluded card leg is not counted and keeps its review state: ' || rrh.line('xe2-xex') || ' ' || rrh.review('xe2-xex'));

-- KEX: the PAYMENT's account is excluded: not counted, 0 — and still under review, with the pair withheld.
select th.assert(rrh.line('k-kex') = 'not_counted/excluded_account/0 partner=- decision=- range=0..0' and rrh.review('k-kex') = 'withheld=w-kex obligations=1 gap=f', 'KEX: not counted, with its review state: ' || rrh.line('k-kex') || ' ' || rrh.review('k-kex'));
select th.assert(rrh.line('w-kex') = 'unresolved/relink_review_required/0 partner=- decision=- range=0..0', 'KEX: the card leg is unresolved, 0, and not "funded from excluded": ' || rrh.line('w-kex'));

-- NOC: bb has no included card. The guard withholds k/bw; the independently established rule gives −460.
select th.assert(rrh.line('k-noc', rrh.bb()) = 'untracked/no_included_card/-46000 partner=- decision=- range=-46000..-46000', 'NOC: no included card: the full outflow, the record not named: ' || rrh.line('k-noc', rrh.bb()));
select th.assert(rrh.review('k-noc', rrh.bb()) = 'withheld=bw-noc obligations=1 gap=f', 'NOC: its review state is kept: ' || rrh.review('k-noc', rrh.bb()));
update public.accounts set exclude_from_cash_flow = false where id = '00000000-0000-0000-0000-0000000101d3';
select th.assert(not rrh.fresh(rrh.bb()), 'NOC: including a card invalidates the published states');
select public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.line('k-noc', rrh.bb()) = 'unresolved/relink_review_required/null partner=- decision=- range=-46000..0', 'NOC: with an included card the payment is the guarded range: ' || rrh.line('k-noc', rrh.bb()));

-- The aggregate of aa's September (every counted cash leg). By hand, in cents:
--   e1 −36000 (definite); e7, e2, pair, rej, def, dis, dis2, xex: ranges of 37000, 38000, 39000, 40000, 41000,
--   42000, 43000, 44000 = 324000; kex is not counted.   low = −36000 − 324000 = −360000;  high = −36000.
select th.assert(rrh.bounds('2026-09-01', '2026-10-01') = '-360000..-36000', 'the fresh aggregate carries the uncertainty: ' || rrh.bounds('2026-09-01', '2026-10-01'));

-- ---- PAIR: an explicit current pair, then an ordinary undo ------------------------------------------------------
create temporary table answers (name text primary key, answer jsonb not null);
insert into pg_temp.answers select 'pair', rrh.act(rrh.op(1), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-pair'),
                                                    'counterpartTransactionId', rrh.tid('x2-pair'), 'acceptedDifferenceCents', 0));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'PAIR: the action commits with a fresh evaluation: ' || answer::text) from pg_temp.answers where name = 'pair';
select th.assert(rrh.line('k-pair') = 'tracked/user_pair/0 partner=x2-pair decision=pair range=0..0', 'PAIR: the explicit pair gives 0: ' || rrh.line('k-pair'));
select th.assert(rrh.line('x2-pair') = 'paired/user_pair/0 partner=k-pair decision=pair range=0..0', 'PAIR: the card leg is paired: ' || rrh.line('x2-pair'));
select th.assert(rrh.retained('k-pair') = 'D(k-pair) H(y-pair/k-pair@2026-09-11)', 'PAIR: H and D remain, live: ' || rrh.retained('k-pair'));
select th.assert(rrh.review('k-pair') = 'withheld=- obligations=1 gap=f', 'PAIR: the payment is still an affected payment: ' || rrh.review('k-pair'));
select th.assert(jsonb_array_length(answer->'receipt'->'retainedObligationIds') = 1 and (answer->'receipt'->>'permanentRetirement')::boolean = false
                 and answer->'receipt'->>'outcome' = 'saved' and answer->'receipt'->>'decisionId' is not null,
                 'PAIR: the receipt names the obligation that REMAINS and claims no retirement: ' || (answer->'receipt')::text) from pg_temp.answers where name = 'pair';
select th.assert(not (answer->'receipt') ?| array['effectCents', 'lowCents', 'highCents', 'legs'] and not answer ? 'legs', 'PAIR: the answer carries no figure') from pg_temp.answers where name = 'pair';
insert into pg_temp.answers select 'undo', rrh.act(rrh.op(2), jsonb_build_object('action', 'undo_decision', 'decisionId', (select (answer->'receipt'->>'decisionId')::uuid from pg_temp.answers where name = 'pair')));
select th.assert(rrh.outcome(answer) = 'committed_fresh' and answer->'receipt'->>'outcome' = 'undone', 'PAIR: the undo commits: ' || answer::text) from pg_temp.answers where name = 'undo';
select th.assert(rrh.line('k-pair') = 'unresolved/relink_review_required/null partner=- decision=- range=-39000..0', 'PAIR: after the undo the payment is guarded again: ' || rrh.line('k-pair'));
select th.assert(rrh.retained('k-pair') = 'D(k-pair) H(y-pair/k-pair@2026-09-11)' and rrh.obligations('k-pair') = 'captured(harness-item-a) edges=y-pair sources=ambiguity_hold:x-pair,removed_destination:x-pair',
                 'PAIR: the undo retired nothing: ' || rrh.retained('k-pair') || ' | ' || rrh.obligations('k-pair'));

-- ---- REJ and DEF: workflow only ------------------------------------------------------------------------------
create temporary table versions_before as select rrh.iv() as input, rrh.rev() as review, (select count(*) from public.card_payment_decisions) as decisions;
insert into pg_temp.answers select 'rej', rrh.act(rrh.op(3), jsonb_build_object('action', 'reject_suggestion', 'transactionId', rrh.tid('k-rej'), 'candidateTransactionId', rrh.tid('w-rej')));
insert into pg_temp.answers select 'def', rrh.act(rrh.op(4), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k-def')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', name || ': commits: ' || answer::text) from pg_temp.answers where name in ('rej', 'def');
select th.assert(rrh.iv() = (select input from pg_temp.versions_before), 'REJ/DEF: the matching input version did not move');
select th.assert(rrh.rev() = (select review + 2 from pg_temp.versions_before), 'REJ/DEF: the review revision advanced once per note');
select th.assert((select count(*) from public.card_payment_decisions) = (select decisions from pg_temp.versions_before), 'REJ/DEF: no decision — and so no dismissal — was written');
select th.assert(rrh.line('k-rej') = 'unresolved/relink_review_required/null partner=- decision=- range=-40000..0' and rrh.candidates('k-rej') = 'w-rej,y-rej', 'REJ: still guarded, the rejected candidate still in the pool: ' || rrh.line('k-rej'));
select th.assert(rrh.line('k-def') = 'unresolved/relink_review_required/null partner=- decision=- range=-41000..0', 'DEF: still guarded: ' || rrh.line('k-def'));

-- ---- DIS: an explicit dismissal changes the figure; a NEW transaction gets no permission from it ----------------
insert into pg_temp.answers select 'dis', rrh.act(rrh.op(5), jsonb_build_object('action', 'dismiss_candidate', 'transactionId', rrh.tid('k-dis'), 'candidateTransactionId', rrh.tid('w-dis')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'DIS: commits: ' || answer::text) from pg_temp.answers where name = 'dis';
select th.assert(rrh.line('k-dis') = 'untracked/removed_card/-42000 partner=- decision=destination_removed_card range=-42000..-42000', 'DIS: with k/w dismissed, k/y is selected and H withholds it: the retained D gives −420: ' || rrh.line('k-dis'));
select th.assert(rrh.review('k-dis') = 'withheld=- obligations=1 gap=f' and rrh.retained('k-dis') like 'D(k-dis) H(y-dis/k-dis@2026-09-11)%', 'DIS: D is unchanged and nothing is withheld by the guard: ' || rrh.review('k-dis'));
select rrh.cardleg('w2-dis', pg_temp.w(), -420, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-dis') = 'unresolved/relink_review_required/null partner=- decision=- range=-42000..0' and rrh.review('k-dis') = 'withheld=w2-dis obligations=1 gap=f',
                 'DIS: a new transaction (w2) gets no permission from the earlier action: the payment is guarded again: ' || rrh.line('k-dis') || ' ' || rrh.review('k-dis'));

-- ---- DIS2: undoing the dismissal restores the guarded case --------------------------------------------------------
insert into pg_temp.answers select 'dis2', rrh.act(rrh.op(6), jsonb_build_object('action', 'dismiss_candidate', 'transactionId', rrh.tid('k-dis2'), 'candidateTransactionId', rrh.tid('w-dis2')));
select th.assert(rrh.line('k-dis2') = 'untracked/removed_card/-43000 partner=- decision=destination_removed_card range=-43000..-43000', 'DIS2: dismissed: −430 through D: ' || rrh.line('k-dis2'));
insert into pg_temp.answers select 'dis2-undo', rrh.act(rrh.op(7), jsonb_build_object('action', 'undo_decision', 'decisionId', (select (answer->'receipt'->>'decisionId')::uuid from pg_temp.answers where name = 'dis2')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'DIS2: the undo commits: ' || answer::text) from pg_temp.answers where name = 'dis2-undo';
select th.assert(rrh.line('k-dis2') = 'unresolved/relink_review_required/null partner=- decision=- range=-43000..0', 'DIS2: undoing the dismissal restores the guarded range: ' || rrh.line('k-dis2'));

-- ---- Nothing was retired by anything above ------------------------------------------------------------------------
select th.assert((select count(*) from public.card_payment_review_obligations) = (select obligations from pg_temp.before_arrivals)
                 and (select count(*) from public.card_payment_review_memberships) = (select memberships from pg_temp.before_arrivals)
                 and (select count(*) from public.card_payment_review_obligation_sources) = (select sources from pg_temp.before_arrivals),
                 'every obligation, known edge and source is exactly as the removals left it');
select th.assert((select count(*) from public.card_payment_decisions where superseded_by is null and kind in ('destination_removed_card', 'ambiguity_hold_removed_card'))
                 = (select retained from pg_temp.before_arrivals), 'every hold and every record is still live');
select th.assert((select count(*) from public.card_payment_recovery_actions where user_id = rrh.aa()) = 7, 'seven operations, seven receipts');

-- ---- E1, from its review: a payment that reads its record is still offered its possible other sides ----------------
-- The leg state of k-e1 carries no candidate list (it reads a definite figure). The review offers the return (x2, the
-- 14th) and the kept card (y, the 12th) as suggestions; neither is applied. The user chooses the return: 0, with H, D
-- and the obligation retained.
create function pg_temp.offered(p_plaid text) returns text language sql as $$
  select coalesce(string_agg(rrh.pid((c->>'transactionId')::uuid) || ':' || (c->>'kind') || ':' || (c->>'distanceDays') || ':' || (c->>'suggestionOnly') || ':' || (c->>'withheldByGuard'), ','
                             order by rrh.pid((c->>'transactionId')::uuid) collate "C"), '')
  from jsonb_array_elements(public.get_card_payment_recovery_reviews(rrh.aa(), null, 50)->'reviews') r
  cross join lateral jsonb_array_elements(r->'candidates') c
  where (r->>'transactionId')::uuid = rrh.tid(p_plaid) $$;
select th.assert(rrh.candidates('k-e1') = '' and pg_temp.offered('k-e1') = 'x2-e1:tier1_competitor:4:true:false,y-e1:tier1_competitor:2:true:false',
                 'E1: the review offers the return and the kept leg, as suggestions, although the leg state lists none: ' || pg_temp.offered('k-e1'));
select th.assert(pg_temp.offered('k-e7') = 'w-e7:tier1_competitor:1:true:true,y-e7:tier1_competitor:2:true:false', 'E7: a guarded leg is offered its own candidates, the withheld one marked: ' || pg_temp.offered('k-e7'));
insert into pg_temp.answers select 'e1-pair', rrh.act(rrh.op(8), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-e1'),
                                                       'counterpartTransactionId', rrh.tid('x2-e1'), 'acceptedDifferenceCents', 0));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'E1: the explicit pair with the return commits: ' || answer::text) from pg_temp.answers where name = 'e1-pair';
select th.assert(rrh.line('k-e1') = 'tracked/user_pair/0 partner=x2-e1 decision=pair range=0..0' and rrh.retained('k-e1') = 'D(k-e1) H(y-e1/k-e1@2026-09-11)'
                 and rrh.obligations('k-e1') = 'captured(harness-item-a) edges=y-e1 sources=ambiguity_hold:x-e1,removed_destination:x-e1',
                 'E1: the user''s pair gives 0 and retires nothing: ' || rrh.line('k-e1') || ' | ' || rrh.retained('k-e1'));
-- A dismissed pair is not offered again, and a leg a user decision holds is not offered to another payment.
select th.assert(pg_temp.offered('k-dis2') = 'w-dis2:tier1_competitor:1:true:true,y-dis2:tier1_competitor:2:true:false', 'DIS2 (dismissal undone): both are offered again: ' || pg_temp.offered('k-dis2'));
select th.assert(pg_temp.offered('k-pair') not like '%x2-e1%' and pg_temp.offered('k-e2') not like '%x2-e1%', 'a leg that a user pair holds is offered to no other payment');
