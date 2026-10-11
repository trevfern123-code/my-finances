-- User authority is untouched by the guard and by recovery (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §4; product
-- approval of 2026-10-09, §2 first paragraph and §3). Hand-derived expectations.
--
-- User aa. Item 1 "Card Bank" (card X) is removed; item 3 "Kept Bank" stays (checking C, card Y); afterwards
-- item 7 "Card Bank (relinked)" brings card X2. Dates are days of 2026-09; amounts are dollars. Every case has
-- k (+amount, C, the 10th), x (−amount, X, the 11th) and y (−amount, Y, the 12th) unless stated.
--   ACT    100   the user CONFIRMED k/x before the removal. Preserved, active: untracked / removed_card, −100,
--                named on the leg. A return of x changes none of it.
--   INACT  110   confirmed, then the bank changed x's amount: the confirmation was invalid on the removed side
--                when it was removed. Preserved, INACTIVE, frozen: the leg stays reserved and unresolved; a return
--                does not repair it and nothing pairs with it automatically.
--   UNL    120   after the removal the user says "a card I haven't linked" (through recovery). That decides the
--                payment; a return does not change it. Undoing it brings the guarded evaluation back.
--   SUP    130   confirmed before the removal (preserved). After the relink the user pairs k with x2: the newer
--                explicit decision supersedes the preserved one, and the receipt says so. Undoing the new pair
--                does NOT bring the preserved confirmation back.
--   DIFF   250   the return is −248: a pair needs the difference of 2.00 accepted explicitly. A wrong difference
--                is refused and writes nothing; the right one gives a tracked pair whose cash excess counts.
--   RES    140   the user tries to pair k with a card leg that another confirmed match holds: refused, nothing
--                written.
--   LOAN         a transaction on the removed card is linked to a manual loan: the removal restores exactly what
--                it had applied, as before.
set role service_role;

update public.plaid_items set institution_name = 'Card Bank' where id = '00000000-0000-0000-0000-000000000001';
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r03-item-kept', 'Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000103a1', '00000000-0000-0000-0000-000000000001', 'r03-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000103b1', '00000000-0000-0000-0000-000000000003', 'r03-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000103b2', '00000000-0000-0000-0000-000000000003', 'r03-y', 'credit');
create function pg_temp.x() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000103a1'::uuid $$;
create function pg_temp.c() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000103b1'::uuid $$;
create function pg_temp.y() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000103b2'::uuid $$;
create function pg_temp.x2() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000103c1'::uuid $$;
create function pg_temp.detail(p_plaid text) returns text language sql as $$ select coalesce(rrh.leg(p_plaid)->>'detail', '-') $$;
create function pg_temp.decision_of(p_plaid text, p_kind text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d where d.kind = p_kind and d.a_plaid_transaction_id = p_plaid order by d.decided_seq desc limit 1 $$;

create temporary table cases (kase text primary key, amount numeric not null);
insert into pg_temp.cases values ('act', 100), ('inact', 110), ('unl', 120), ('sup', 130), ('diff', 250), ('res', 140);
select rrh.cardleg('k-' || kase, pg_temp.c(), amount, '2026-09-10'), rrh.cardleg('x-' || kase, pg_temp.x(), -amount, '2026-09-11'),
       rrh.cardleg('y-' || kase, pg_temp.y(), -amount, '2026-09-12')
from pg_temp.cases;
-- RES: an unrelated confirmed match that holds a card leg (141 against 141).
select rrh.cardleg('k-other', pg_temp.c(), 141, '2026-09-10'), rrh.cardleg('y-other', pg_temp.y(), -141, '2026-09-10');
-- LOAN: an ordinary payment on the removed card, linked to a manual loan of 1000 with 100 of principal.
insert into public.manual_loans (id, user_id, name, current_balance) values ('00000000-0000-0000-0000-0000000103d1', rrh.aa(), 'R03 loan', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)
values ('00000000-0000-0000-0000-0000000103e1', pg_temp.x(), 'loan-payment', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);
select th.assert(public.link_transaction_to_manual_loan(rrh.aa(), '00000000-0000-0000-0000-0000000103e1', '00000000-0000-0000-0000-0000000103d1', 100, 1::smallint) = 'linked', 'fixture: the loan link');
select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000103d1') = 900, 'fixture: the link applied 100');

select public.evaluate_card_payments(rrh.aa());
select th.assert(public.link_card_payment(rrh.aa(), rrh.tid('k-' || kase), rrh.tid('x-' || kase), 0, rrh.iv())->>'status' = 'saved', 'fixture: the user confirms ' || kase)
from pg_temp.cases where kase in ('act', 'inact', 'sup') order by kase;
select th.assert(public.link_card_payment(rrh.aa(), rrh.tid('k-other'), rrh.tid('y-other'), 0, rrh.iv())->>'status' = 'saved', 'fixture: the unrelated confirmed match');
update public.transactions set amount = -111 where plaid_transaction_id = 'x-inact';
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-inact') = 'unresolved/decision_invalidated/null partner=- decision=pair range=-11000..0' and pg_temp.detail('k-inact') = 'amount_changed',
                 'before: the confirmation is invalid because the card side''s amount changed: ' || rrh.line('k-inact'));

-- ---- The removal -------------------------------------------------------------------------------------------
create temporary table removal as select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001') as result;
select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000103d1') = 1000
                 and (select (result->'loan_adjustments'->0->>'restored')::numeric = 100 and (result->'loan_adjustments'->0->>'balance_before')::numeric = 900
                             and (result->'loan_adjustments'->0->>'balance_after')::numeric = 1000 and jsonb_array_length(result->'loan_adjustments') = 1 from pg_temp.removal),
                 'LOAN: the removal restores exactly the applied 100: ' || (select result::text from pg_temp.removal));

select th.assert(rrh.line('k-act') = 'untracked/removed_card/-10000 partner=- decision=pair_counterpart_removed range=-10000..-10000', 'ACT: the preserved confirmation decides the payment: ' || rrh.line('k-act'));
select th.assert(rrh.obligations('k-act') = 'captured(harness-item-a) edges= sources=preserved_confirmation:x-act' and rrh.review('k-act') = 'withheld=- obligations=1 gap=f',
                 'ACT: the payment is an affected payment; a leg a user decision holds has no automatic edge to list: ' || rrh.obligations('k-act'));
select th.assert(rrh.line('k-inact') = 'unresolved/decision_invalidated/null partner=- decision=pair_counterpart_removed range=-11000..0' and pg_temp.detail('k-inact') = 'amount_changed',
                 'INACT: preserved inactive, with the frozen reason: ' || rrh.line('k-inact') || ' ' || pg_temp.detail('k-inact'));
select th.assert((select d.counterpart_status from public.card_payment_decisions d where d.id = pg_temp.decision_of('k-inact', 'pair_counterpart_removed')) = 'amount_changed', 'INACT: the removed side''s invalidity is frozen on the decision');

-- ---- The relink ----------------------------------------------------------------------------------------------
select rrh.item('00000000-0000-0000-0000-000000000007', rrh.aa(), 'r03-item-relinked', 'Card Bank (relinked)');
select rrh.account(pg_temp.x2(), '00000000-0000-0000-0000-000000000007', 'r03-x2', 'credit');
select rrh.cardleg('x2-act', pg_temp.x2(), -100, '2026-09-11'), rrh.cardleg('x2-inact', pg_temp.x2(), -110, '2026-09-11'),
       rrh.cardleg('x2-sup', pg_temp.x2(), -130, '2026-09-11'), rrh.cardleg('x2-diff', pg_temp.x2(), -248, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-act') = 'untracked/removed_card/-10000 partner=- decision=pair_counterpart_removed range=-10000..-10000' and rrh.review('k-act') = 'withheld=- obligations=1 gap=f',
                 'ACT: the return changes nothing: the user''s confirmation is authoritative and holds the leg: ' || rrh.line('k-act'));
select th.assert(rrh.line('x2-act') = 'unresolved/no_candidate/0 partner=- decision=- range=0..0' and rrh.auto_pair('k-act') = '-', 'ACT: the returned leg finds no free payment to pair with: ' || rrh.line('x2-act'));
select th.assert(rrh.line('k-inact') = 'unresolved/decision_invalidated/null partner=- decision=pair_counterpart_removed range=-11000..0' and pg_temp.detail('k-inact') = 'amount_changed'
                 and rrh.auto_pair('k-inact') = '-' and rrh.line('x2-inact') = 'unresolved/no_candidate/0 partner=- decision=- range=0..0',
                 'INACT: the return does not repair a frozen invalidity, and the reserved leg is not matched automatically: ' || rrh.line('k-inact'));

-- ---- UNL -------------------------------------------------------------------------------------------------------
create temporary table answers (name text primary key, answer jsonb not null);
insert into pg_temp.answers select 'unl', rrh.act(rrh.op(1), jsonb_build_object('action', 'confirm_unlinked', 'transactionId', rrh.tid('k-unl')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'UNL: commits: ' || answer::text) from pg_temp.answers where name = 'unl';
select th.assert(rrh.line('k-unl') = 'untracked/user_confirmed_unlinked/-12000 partner=- decision=destination_unlinked range=-12000..-12000', 'UNL: the user''s statement decides the payment: ' || rrh.line('k-unl'));
select th.assert(rrh.retained('k-unl') = 'D(k-unl) H(y-unl/k-unl@2026-09-11)', 'UNL: it retired neither the record nor the hold: ' || rrh.retained('k-unl'));
select rrh.cardleg('x2-unl', pg_temp.x2(), -120, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-unl') = 'untracked/user_confirmed_unlinked/-12000 partner=- decision=destination_unlinked range=-12000..-12000', 'UNL: a return does not change a user-confirmed destination: ' || rrh.line('k-unl'));
insert into pg_temp.answers select 'unl-undo', rrh.act(rrh.op(2), jsonb_build_object('action', 'undo_decision', 'decisionId', pg_temp.decision_of('k-unl', 'destination_unlinked')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'UNL: the undo commits: ' || answer::text) from pg_temp.answers where name = 'unl-undo';
select th.assert(rrh.line('k-unl') = 'unresolved/relink_review_required/null partner=- decision=- range=-12000..0' and rrh.review('k-unl') = 'withheld=x2-unl obligations=1 gap=f',
                 'UNL: after the undo the guarded evaluation is back: ' || rrh.line('k-unl'));

-- ---- SUP -------------------------------------------------------------------------------------------------------
insert into pg_temp.answers select 'sup', rrh.act(rrh.op(3), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-sup'),
                                                   'counterpartTransactionId', rrh.tid('x2-sup'), 'acceptedDifferenceCents', 0));
select th.assert(rrh.outcome(answer) = 'committed_fresh' and answer->'receipt'->'supersededDecisionIds' = jsonb_build_array(pg_temp.decision_of('k-sup', 'pair_counterpart_removed')),
                 'SUP: the receipt names the preserved confirmation the new pair superseded: ' || (answer->'receipt')::text) from pg_temp.answers where name = 'sup';
select th.assert(rrh.line('k-sup') = 'tracked/user_pair/0 partner=x2-sup decision=pair range=0..0', 'SUP: the newer explicit decision wins: ' || rrh.line('k-sup'));
select th.assert((select d.superseded_by = (select (answer->'receipt'->>'decisionId')::uuid from pg_temp.answers where name = 'sup')
                  from public.card_payment_decisions d where d.id = pg_temp.decision_of('k-sup', 'pair_counterpart_removed')), 'SUP: the preserved confirmation is superseded by the new pair');
insert into pg_temp.answers select 'sup-undo', rrh.act(rrh.op(4), jsonb_build_object('action', 'undo_decision', 'decisionId', (select (answer->'receipt'->>'decisionId')::uuid from pg_temp.answers where name = 'sup')));
select th.assert(rrh.outcome(answer) = 'committed_fresh', 'SUP: the undo commits: ' || answer::text) from pg_temp.answers where name = 'sup-undo';
select th.assert((select d.superseded_by is not null and d.superseded_by <> d.id from public.card_payment_decisions d where d.id = pg_temp.decision_of('k-sup', 'pair_counterpart_removed')),
                 'SUP: undoing the new pair does not bring the preserved confirmation back');
select th.assert(rrh.line('k-sup') = 'unresolved/relink_review_required/null partner=- decision=- range=-13000..0' and rrh.review('k-sup') = 'withheld=x2-sup obligations=1 gap=f',
                 'SUP: the payment is back under guarded evaluation, with no decision: ' || rrh.line('k-sup'));
select th.assert(rrh.obligations('k-sup') = 'captured(harness-item-a) edges= sources=preserved_confirmation:x-sup', 'SUP: the obligation is unchanged: ' || rrh.obligations('k-sup'));

-- ---- DIFF ------------------------------------------------------------------------------------------------------
select th.assert(rrh.line('k-diff') = 'untracked/removed_card/-25000 partner=- decision=destination_removed_card range=-25000..-25000' and rrh.candidates('k-diff', 'near_amount') = '',
                 'DIFF: a near amount is no automatic pair; the payment still reads its record: ' || rrh.line('k-diff'));
create temporary table receipts_before as select count(*) as n from public.card_payment_recovery_actions;
insert into pg_temp.answers select 'diff-wrong', rrh.act(rrh.op(5), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-diff'),
                                                          'counterpartTransactionId', rrh.tid('x2-diff'), 'acceptedDifferenceCents', 0));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_invalid' and answer->>'refused' like '%difference_not_accepted%', 'DIFF: a difference that was not accepted is refused: ' || answer::text) from pg_temp.answers where name = 'diff-wrong';
select th.assert((select count(*) from public.card_payment_recovery_actions) = (select n from pg_temp.receipts_before)
                 and not exists (select 1 from public.card_payment_decisions d where d.kind = 'pair' and d.a_plaid_transaction_id = 'k-diff'),
                 'DIFF: the refusal wrote no decision and no receipt');
insert into pg_temp.answers select 'diff', rrh.act(rrh.op(5), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-diff'),
                                                    'counterpartTransactionId', rrh.tid('x2-diff'), 'acceptedDifferenceCents', 200));
select th.assert(rrh.outcome(answer) = 'committed_fresh' and (answer->'receipt'->'intent'->>'acceptedDifferenceCents')::bigint = 200,
                 'DIFF: the same operation id may be used again after a refusal (nothing was committed under it); the accepted difference is on the receipt: ' || answer::text) from pg_temp.answers where name = 'diff';
select th.assert(rrh.line('k-diff') = 'tracked/user_pair/-200 partner=x2-diff decision=pair range=-200..-200' and (rrh.leg('k-diff')->>'cashExcessCents')::bigint = 200,
                 'DIFF: the pair is tracked and the 2.00 that never reached the card counts: ' || rrh.line('k-diff'));
select th.assert(rrh.retained('k-diff') = 'D(k-diff) H(y-diff/k-diff@2026-09-11)', 'DIFF: H and D remain: ' || rrh.retained('k-diff'));

-- ---- RES -------------------------------------------------------------------------------------------------------
insert into pg_temp.answers select 'res', rrh.act(rrh.op(6), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-res'),
                                                   'counterpartTransactionId', rrh.tid('y-other'), 'acceptedDifferenceCents', -100));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_counterpart_reserved', 'RES: a leg another confirmed match holds cannot be taken: ' || answer::text) from pg_temp.answers where name = 'res';
select th.assert(rrh.line('k-other') = 'tracked/user_pair/0 partner=y-other decision=pair range=0..0' and rrh.line('k-res') = 'untracked/removed_card/-14000 partner=- decision=destination_removed_card range=-14000..-14000'
                 and not exists (select 1 from public.card_payment_recovery_actions a where a.operation_id = rrh.op(6)),
                 'RES: both payments are as they were, and no receipt exists');

-- ---- Nothing above changed a system row or an obligation ----------------------------------------------------------
select th.assert((select count(*) from public.card_payment_decisions d where d.kind in ('destination_removed_card', 'ambiguity_hold_removed_card') and d.superseded_by is not null) = 0,
                 'no hold and no record was superseded by any action');
select th.assert((select count(*) from public.card_payment_review_obligations) = 6 and (select count(*) from public.card_payment_review_memberships) = 3,
                 'six affected payments (three with a known edge to y, three that a user decision held): unchanged');
