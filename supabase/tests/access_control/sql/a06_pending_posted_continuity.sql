-- Pending -> posted continuity (PENDING_POSTED_CONTINUITY_DESIGN.md §10.1, cases K1-K14, K17 and the
-- K12 clamp family): the one atomic sync RPC carries a pending row's category (copied exactly, NULL
-- included), approval, splits, loan link and role override to the posted row that names it, in every
-- arrival order, keeping the manual-loan ledger exact at every commit.
set role service_role;

-- Fixture: user aa (item 1): checking C, card X; six manual loans so each ledger case is arithmetic
-- on its own loan; three budget categories.
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-000000000001', 'acct-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000006a2', '00000000-0000-0000-0000-000000000001', 'acct-x', 'Card', 'credit'),
  ('00000000-0000-0000-0000-0000000006a9', '00000000-0000-0000-0000-000000000002', 'acct-b', 'BB Checking', 'depository');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000000aa', 'SoFi', 10000),
  ('00000000-0000-0000-0000-0000000006b2', '00000000-0000-0000-0000-0000000000aa', 'Car', 5000),
  ('00000000-0000-0000-0000-0000000006b3', '00000000-0000-0000-0000-0000000000aa', 'Boat', 2000),
  ('00000000-0000-0000-0000-0000000006b4', '00000000-0000-0000-0000-0000000000aa', 'Small', 300),
  ('00000000-0000-0000-0000-0000000006b5', '00000000-0000-0000-0000-0000000000aa', 'Mid', 1000),
  ('00000000-0000-0000-0000-0000000006b6', '00000000-0000-0000-0000-0000000000aa', 'Tiny', 250);
insert into public.budget_categories (id, user_id, name) values
  ('00000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000000aa', 'Dining'),
  ('00000000-0000-0000-0000-0000000006c2', '00000000-0000-0000-0000-0000000000aa', 'Groceries'),
  ('00000000-0000-0000-0000-0000000006c3', '00000000-0000-0000-0000-0000000000aa', 'Household');

-- One insert payload exactly as dataService.applyTransactionChanges builds it (row-level
-- classification included; budget_category_id = the mapping's answer, null when none).
create function pg_temp.ins(p_plaid text, p_account text, p_amount numeric, p_pending boolean,
                            p_pending_of text default null, p_category uuid default null,
                            p_plaid_category text default 'FOOD_AND_DRINK') returns jsonb
language sql as $$
  select jsonb_build_object(
    'plaid_transaction_id', p_plaid, 'account_id', p_account, 'amount', p_amount, 'iso_currency_code', 'USD',
    'date', '2026-09-10', 'name', 'Row ' || p_plaid, 'merchant_name', null, 'category', p_plaid_category,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null,
    'plaid_category', null, 'pending', p_pending, 'needs_review', true, 'budget_category_id', p_category,
    'auto_role', case when p_amount > 0 then 'expense' else 'income' end, 'role_source', 'sign_default',
    'role_confidence', 'low', 'classifier_version', 1, 'pending_transaction_id', p_pending_of)
$$;
create function pg_temp.page(p_inserts jsonb, p_removed text[]) returns jsonb
language sql as $$
  select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000aa', p_inserts, '[]'::jsonb, p_removed)
$$;
create function pg_temp.txn(p_plaid text) returns public.transactions
language sql as $$ select t from public.transactions t where t.plaid_transaction_id = p_plaid $$;
create function pg_temp.id_of(p_plaid text) returns uuid
language sql as $$ select id from public.transactions where plaid_transaction_id = p_plaid $$;
create function pg_temp.loan(p_id text) returns numeric
language sql as $$ select current_balance from public.manual_loans where id = p_id::uuid $$;
create function pg_temp.carry(p_plaid text) returns public.transaction_carryovers
language sql as $$ select c from public.transaction_carryovers c where c.pending_plaid_transaction_id = p_plaid $$;
create function pg_temp.applied_total() returns numeric
language sql as $$ select coalesce(sum(loan_balance_applied), 0) from public.transactions where manual_loan_id is not null $$;
create function pg_temp.link(p_plaid text, p_loan text, p_principal numeric) returns void
language plpgsql as $$
begin
  perform th.assert(public.link_transaction_to_manual_loan('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of(p_plaid), p_loan::uuid, p_principal, 1::smallint) = 'linked',
    'fixture link ' || p_plaid);
end $$;

-- ---- K1: same page, same amount — everything carries; approval kept; no note -------------------------
select th.assert((pg_temp.page(jsonb_build_array(pg_temp.ins('p1', '00000000-0000-0000-0000-0000000006a1', 52.10, true)), '{}')->>'carried_count')::int = 0,
  'K1: inserting the pending row carries nothing');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p1'), '00000000-0000-0000-0000-0000000006c1');
select public.approve_transaction('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p1'));
update public.transactions set user_role_override = 'expense', user_role_override_at = '2026-09-11T10:00:00Z' where plaid_transaction_id = 'p1';
select th.assert((pg_temp.page(jsonb_build_array(pg_temp.ins('q1', '00000000-0000-0000-0000-0000000006a1', 52.10, false, 'p1', '00000000-0000-0000-0000-0000000006c2')), array['p1'])->>'carried_count')::int = 1,
  'K1: one carry');
select th.assert(pg_temp.id_of('p1') is null, 'K1: pending row deleted');
select th.assert((pg_temp.txn('q1')).budget_category_id = '00000000-0000-0000-0000-0000000006c1', 'K1: the user''s Dining beats the payload''s mapping (Groceries)');
select th.assert((pg_temp.txn('q1')).budget_category_source = 'user', 'K1: label copied');
select th.assert((pg_temp.txn('q1')).needs_review = false, 'K1: approval kept (same amount)');
select th.assert((pg_temp.txn('q1')).user_role_override = 'expense' and (pg_temp.txn('q1')).user_role_override_at = '2026-09-11T10:00:00Z', 'K1: override + timestamp kept');
select th.assert((pg_temp.txn('q1')).pending_transaction_id = 'p1' and (pg_temp.txn('q1')).review_note is null and (pg_temp.txn('q1')).posted_from_pending_amount is null,
  'K1: link recorded, no note, no amount change');
select th.assert((pg_temp.carry('p1')).consumed_by_transaction_id = pg_temp.id_of('q1') and (pg_temp.carry('p1')).consumed_at is not null, 'K1: carry-over consumed by q1');

-- ---- K2: same page, amount changed — re-flagged, splits dropped, note --------------------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p2', '00000000-0000-0000-0000-0000000006a2', 52.10, true)), '{}');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p2'), '00000000-0000-0000-0000-0000000006c1');
select count(*) from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p2'),
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000006c1","amount":30,"note":null},{"budget_category_id":"00000000-0000-0000-0000-0000000006c2","amount":22.10,"note":"half"}]');
select public.approve_transaction('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p2'));
select pg_temp.page(jsonb_build_array(pg_temp.ins('q2', '00000000-0000-0000-0000-0000000006a2', 60.10, false, 'p2')), array['p2']);
select th.assert((pg_temp.txn('q2')).budget_category_id = '00000000-0000-0000-0000-0000000006c1', 'K2: category kept');
select th.assert((pg_temp.txn('q2')).needs_review = true, 'K2: re-flagged on amount change (C1)');
select th.assert(not exists (select 1 from public.transaction_splits where transaction_id = pg_temp.id_of('q2')), 'K2: splits dropped, never scaled');
select th.assert((pg_temp.txn('q2')).review_note = 'Amount changed from 52.10 to 60.10; splits removed', format('K2: note (got %s)', (pg_temp.txn('q2')).review_note));
select th.assert((pg_temp.txn('q2')).posted_from_pending_amount = 52.10, 'K2: pending amount recorded');
select th.assert(jsonb_array_length((pg_temp.carry('p2')).splits) = 2, 'K2: the carry-over still holds the two splits for audit');

-- ---- K3: posted first, removal in a later page — the live pending row is carried now ----------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p3', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p3', '00000000-0000-0000-0000-0000000006b1', 350);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9650, 'K3: L 10000 -> 9650 after the pending link');
select th.assert((pg_temp.page(jsonb_build_array(pg_temp.ins('q3', '00000000-0000-0000-0000-0000000006a1', 400, false, 'p3')), '{}')->>'carried_count')::int = 1,
  'K3: page 1 (posted only) carries from the live pending row');
select th.assert(pg_temp.id_of('p3') is null, 'K3: the live pending row was brought through removal in the same page');
select th.assert((pg_temp.txn('q3')).manual_loan_id = '00000000-0000-0000-0000-0000000006b1' and (pg_temp.txn('q3')).principal_portion = 350
                 and (pg_temp.txn('q3')).loan_balance_applied = 350, 'K3: re-linked with the same principal, applied 350');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9650, 'K3: L net unchanged (restored 350, applied 350)');
select th.assert((pg_temp.txn('q3')).needs_review = true and (pg_temp.txn('q3')).review_note is null, 'K3: the pending row was never approved, so the posted row still needs review; no note (same amount)');
select th.assert((pg_temp.page('[]', array['p3'])->>'removed')::int = 0, 'K3: page 2 (the removal) is a no-op');
select th.assert(pg_temp.id_of('q3') is not null and pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9650, 'K3: nothing changed on the late removal');

-- ---- K4: removal first (sync 1), posting later at a smaller amount (sync 2) --------------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p4', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p4', '00000000-0000-0000-0000-0000000006b1', 350);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9300, 'K4: L -> 9300');
select th.assert((pg_temp.page('[]', array['p4'])->>'removed')::int = 1, 'K4: sync 1 removes the pending row');
select th.assert((pg_temp.carry('p4')).consumed_at is null and (pg_temp.carry('p4')).manual_loan_id = '00000000-0000-0000-0000-0000000006b1'
                 and (pg_temp.carry('p4')).principal_portion = 350 and (pg_temp.carry('p4')).manual_loan_name_snapshot = 'SoFi',
  'K4: carry-over holds the link');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9650, 'K4: restored 350 on removal');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q4', '00000000-0000-0000-0000-0000000006a1', 300, false, 'p4')), '{}');
select th.assert((pg_temp.txn('q4')).manual_loan_id = '00000000-0000-0000-0000-0000000006b1' and (pg_temp.txn('q4')).principal_portion = 300
                 and (pg_temp.txn('q4')).loan_balance_applied = 300, 'K4: re-linked with least(350, 300) = 300 (C3)');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 9350, 'K4: L net +50 versus before the posting');
select th.assert((pg_temp.txn('q4')).needs_review and (pg_temp.txn('q4')).review_note = 'Amount changed from 400.00 to 300.00; Principal reduced from 350.00 to 300.00 (posted amount 300.00)',
  format('K4: note (got %s)', (pg_temp.txn('q4')).review_note));

-- ---- K5: never posts — the carry-over expires; a later posting after expiry is a new row ------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p5', '00000000-0000-0000-0000-0000000006a1', 25, true)), '{}');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p5'), '00000000-0000-0000-0000-0000000006c2');
select pg_temp.page('[]', array['p5']);
update public.transaction_carryovers set expires_at = now() - interval '1 day' where pending_plaid_transaction_id = 'p5';
select th.assert((pg_temp.page(jsonb_build_array(pg_temp.ins('q5', '00000000-0000-0000-0000-0000000006a1', 25, false, 'p5')), '{}')->>'carried_count')::int = 0,
  'K5: an expired carry-over is not consumed');
select th.assert((pg_temp.txn('q5')).budget_category_id is null and (pg_temp.txn('q5')).needs_review and (pg_temp.txn('q5')).pending_transaction_id = 'p5',
  'K5: posted as a new row (the id is still recorded for the UI)');
select th.assert((pg_temp.carry('p5')).consumed_at is null, 'K5: the expired record stays unconsumed until the sweep');

-- ---- K6: sign flip — override dropped, loan link explicitly NOT re-applied ---------------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p6', '00000000-0000-0000-0000-0000000006a1', 52.10, true)), '{}');
update public.transactions set user_role_override = 'expense', user_role_override_at = now() where plaid_transaction_id = 'p6';
select pg_temp.link('p6', '00000000-0000-0000-0000-0000000006b2', 50);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b2') = 4950, 'K6: Car 5000 -> 4950');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q6', '00000000-0000-0000-0000-0000000006a1', -52.10, false, 'p6')), array['p6']);
select th.assert((pg_temp.txn('q6')).user_role_override is null and (pg_temp.txn('q6')).user_role_override_at is null, 'K6: override dropped on sign flip (C4)');
select th.assert((pg_temp.txn('q6')).manual_loan_id is null and (pg_temp.txn('q6')).loan_balance_applied is null, 'K6: no link attempted');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b2') = 5000, 'K6: the 50 was restored and nothing re-applied');
select th.assert((pg_temp.txn('q6')).needs_review and (pg_temp.txn('q6')).review_note like '%Sign changed%role correction%' and (pg_temp.txn('q6')).review_note like '%loan payment link was not carried over%',
  format('K6: both sign-flip notes (got %s)', (pg_temp.txn('q6')).review_note));

-- ---- K7: the loan is deleted between removal and posting — explained by the snapshot ----------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p7', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p7', '00000000-0000-0000-0000-0000000006b3', 350);
select pg_temp.page('[]', array['p7']);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b3') = 2000, 'K7: restored before the loan goes');
delete from public.manual_loans where id = '00000000-0000-0000-0000-0000000006b3';
select th.assert((pg_temp.carry('p7')).manual_loan_id is null and (pg_temp.carry('p7')).manual_loan_id_snapshot = '00000000-0000-0000-0000-0000000006b3'
                 and (pg_temp.carry('p7')).manual_loan_name_snapshot = 'Boat', 'K7: FK nulled, snapshots kept');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q7', '00000000-0000-0000-0000-0000000006a1', 400, false, 'p7')), '{}');
select th.assert((pg_temp.txn('q7')).manual_loan_id is null and (pg_temp.txn('q7')).needs_review
                 and (pg_temp.txn('q7')).review_note = 'Its loan ''Boat'' was deleted before this posted; the payment is no longer linked',
  format('K7: note names the deleted loan (got %s)', (pg_temp.txn('q7')).review_note));

-- ---- K8: replay — the same removal again and a second posting naming p2 carry nothing twice ---------
select th.assert((pg_temp.page('[]', array['p2'])->>'removed')::int = 0, 'K8: replaying the removal is a no-op');
select th.assert((pg_temp.page(jsonb_build_array(pg_temp.ins('q2b', '00000000-0000-0000-0000-0000000006a2', 60.10, false, 'p2')), '{}')->>'carried_count')::int = 0,
  'K8: a consumed carry-over is never consumed again');
select th.assert((select count(*) from public.transaction_carryovers where pending_plaid_transaction_id = 'p2') = 1
                 and (pg_temp.carry('p2')).consumed_by_transaction_id = pg_temp.id_of('q2'), 'K8: one carry-over, consumed once, by q2');
select th.assert((pg_temp.txn('q2')).needs_review and (pg_temp.txn('q2')).review_note like 'Amount changed%', 'K8: q2 unchanged by the replay');

-- ---- K11: Plaid did not link the posted row — nothing is guessed --------------------------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p11', '00000000-0000-0000-0000-0000000006a1', 52.10, true)), '{}');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p11'), '00000000-0000-0000-0000-0000000006c1');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q11', '00000000-0000-0000-0000-0000000006a1', 52.10, false)), array['p11']);
select th.assert((pg_temp.txn('q11')).budget_category_id is null and (pg_temp.txn('q11')).pending_transaction_id is null and (pg_temp.txn('q11')).needs_review,
  'K11: a posted row without pending_transaction_id is a new row');
select th.assert((pg_temp.carry('p11')).consumed_at is null, 'K11: the carry-over waits for expiry');

-- ---- K12: the balance clamp binds ------------------------------------------------------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p12', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p12', '00000000-0000-0000-0000-0000000006b4', 350);
select th.assert((pg_temp.txn('p12')).loan_balance_applied = 300 and pg_temp.loan('00000000-0000-0000-0000-0000000006b4') = 0, 'K12: the pending link already clamped (300 of 350)');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q12', '00000000-0000-0000-0000-0000000006a1', 400, false, 'p12')), array['p12']);
select th.assert((pg_temp.txn('q12')).principal_portion = 350 and (pg_temp.txn('q12')).loan_balance_applied = 300 and pg_temp.loan('00000000-0000-0000-0000-0000000006b4') = 0,
  'K12: re-link applies least(350, 300) = 300; the user''s 350 is kept as principal_portion; the ledger says 300');
select th.assert((pg_temp.txn('q12')).needs_review and (pg_temp.txn('q12')).review_note = 'Only 300.00 of the 350.00 principal could be applied; the loan balance reached 0',
  format('K12: clamp note (got %s)', (pg_temp.txn('q12')).review_note));

-- K12b: another payment lands between removal and posting.
select pg_temp.page(jsonb_build_array(pg_temp.ins('p12b', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p12b', '00000000-0000-0000-0000-0000000006b5', 350);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b5') = 650, 'K12b: Mid 1000 -> 650');
select pg_temp.page('[]', array['p12b']);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b5') = 1000, 'K12b: restored');
select pg_temp.page(jsonb_build_array(pg_temp.ins('r12b', '00000000-0000-0000-0000-0000000006a1', 900, false)), '{}');
select pg_temp.link('r12b', '00000000-0000-0000-0000-0000000006b5', 900);
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b5') = 100, 'K12b: another posted payment takes Mid to 100');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q12b', '00000000-0000-0000-0000-0000000006a1', 400, false, 'p12b')), '{}');
select th.assert((pg_temp.txn('q12b')).loan_balance_applied = 100 and pg_temp.loan('00000000-0000-0000-0000-0000000006b5') = 0, 'K12b: applied least(350, 100) = 100');
select th.assert((pg_temp.txn('q12b')).review_note = 'Only 100.00 of the 350.00 principal could be applied; the loan balance reached 0', format('K12b: note (got %s)', (pg_temp.txn('q12b')).review_note));
select th.assert((select sum(loan_balance_applied) from public.transactions where manual_loan_id = '00000000-0000-0000-0000-0000000006b5') = 1000,
  'K12b: Σ applied over live rows = 900 + 100 = the ledger');

-- K12c: the posted-amount clamp (C3) and the balance clamp bind together.
select pg_temp.page(jsonb_build_array(pg_temp.ins('p12c', '00000000-0000-0000-0000-0000000006a1', 400, true)), '{}');
select pg_temp.link('p12c', '00000000-0000-0000-0000-0000000006b6', 350);
select th.assert((pg_temp.txn('p12c')).loan_balance_applied = 250 and pg_temp.loan('00000000-0000-0000-0000-0000000006b6') = 0, 'K12c: Tiny 250 -> 0 (applied 250)');
select pg_temp.page(jsonb_build_array(pg_temp.ins('q12c', '00000000-0000-0000-0000-0000000006a1', 300, false, 'p12c')), array['p12c']);
select th.assert((pg_temp.txn('q12c')).principal_portion = 300 and (pg_temp.txn('q12c')).loan_balance_applied = 250 and pg_temp.loan('00000000-0000-0000-0000-0000000006b6') = 0,
  'K12c: principal'' = least(350, 300) = 300, applied least(300, 250) = 250');
select th.assert((pg_temp.txn('q12c')).posted_from_pending_amount = 400
                 and (pg_temp.txn('q12c')).review_note = 'Amount changed from 400.00 to 300.00; Principal reduced from 350.00 to 300.00 (posted amount 300.00); Only 250.00 of the 300.00 principal could be applied; the loan balance reached 0',
  format('K12c: all three notes (got %s)', (pg_temp.txn('q12c')).review_note));

-- ---- K13: a split category is deleted while the splits are held in the carry-over --------------------
select pg_temp.page(jsonb_build_array(pg_temp.ins('p13', '00000000-0000-0000-0000-0000000006a2', 60, true)), '{}');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p13'), '00000000-0000-0000-0000-0000000006c2');
select count(*) from public.replace_transaction_splits('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p13'),
  '[{"budget_category_id":"00000000-0000-0000-0000-0000000006c2","amount":40,"note":null},{"budget_category_id":"00000000-0000-0000-0000-0000000006c3","amount":20,"note":null}]');
select pg_temp.page('[]', array['p13']);
delete from public.budget_categories where id = '00000000-0000-0000-0000-0000000006c3';
select pg_temp.page(jsonb_build_array(pg_temp.ins('q13', '00000000-0000-0000-0000-0000000006a2', 60, false, 'p13')), '{}');
select th.assert(not exists (select 1 from public.transaction_splits where transaction_id = pg_temp.id_of('q13')), 'K13: splits dropped whole, not partially re-created');
select th.assert((pg_temp.txn('q13')).budget_category_id = '00000000-0000-0000-0000-0000000006c2', 'K13: the row''s own category (Groceries) kept');
select th.assert((pg_temp.txn('q13')).needs_review and (pg_temp.txn('q13')).review_note = 'A category used by this transaction''s splits was deleted; splits removed',
  format('K13: note (got %s)', (pg_temp.txn('q13')).review_note));

-- ---- K14 / C6: a cleared category stays cleared; a mapping-derived one is copied as the mapping's ------
select pg_temp.page(jsonb_build_array(
  pg_temp.ins('p14', '00000000-0000-0000-0000-0000000006a1', 52.10, true, null, '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('p14b', '00000000-0000-0000-0000-0000000006a1', 52.10, true, null, '00000000-0000-0000-0000-0000000006c1')), '{}');
select th.assert((pg_temp.txn('p14')).budget_category_source = 'mapping' and (pg_temp.txn('p14')).budget_category_set_seq is not null,
  'K14: a mapping-derived insert is labelled mapping and stamped');
select public.set_transaction_budget_category('00000000-0000-0000-0000-0000000000aa', pg_temp.id_of('p14'), null);
select th.assert((pg_temp.txn('p14')).budget_category_id is null and (pg_temp.txn('p14')).budget_category_source = 'user', 'K14: the clear is labelled user');
select pg_temp.page(jsonb_build_array(
  pg_temp.ins('q14', '00000000-0000-0000-0000-0000000006a1', 52.10, false, 'p14', '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('q14b', '00000000-0000-0000-0000-0000000006a1', 52.10, false, 'p14b', '00000000-0000-0000-0000-0000000006c1')), array['p14', 'p14b']);
select th.assert((pg_temp.txn('q14')).budget_category_id is null and (pg_temp.txn('q14')).budget_category_source = 'user',
  'K14: the mapping is NOT re-applied to a deliberately cleared row (C6)');
select th.assert((pg_temp.txn('q14b')).budget_category_id = '00000000-0000-0000-0000-0000000006c1' and (pg_temp.txn('q14b')).budget_category_source = 'mapping',
  'K14 control: the mapping-derived category is copied with its label');

-- ---- K17: value and label copied byte-for-byte whatever their origin ------------------------------------
select pg_temp.page(jsonb_build_array(
  pg_temp.ins('p17a', '00000000-0000-0000-0000-0000000006a1', 10, true),
  pg_temp.ins('p17b', '00000000-0000-0000-0000-0000000006a1', 10, true, null, '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('p17c', '00000000-0000-0000-0000-0000000006a1', 10, true, null, '00000000-0000-0000-0000-0000000006c2'),
  pg_temp.ins('p17d', '00000000-0000-0000-0000-0000000006a1', 10, true),
  pg_temp.ins('p17e', '00000000-0000-0000-0000-0000000006a1', 10, true, null, '00000000-0000-0000-0000-0000000006c1')), '{}');
-- (a) pre-column row: a hand-chosen Dining with no label.
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000006c1', budget_category_source = null, budget_category_set_seq = null where plaid_transaction_id = 'p17a';
-- (b) old-backend edit: value changed to Groceries, label left stale at 'mapping'.
update public.transactions set budget_category_id = '00000000-0000-0000-0000-0000000006c2' where plaid_transaction_id = 'p17b';
-- (c) Groceries/'mapping' whose posted payload maps to Dining.
-- (d) pre-column clear / never categorised: NULL/null.
-- (e) old-backend clear: NULL with a stale 'mapping' label.
update public.transactions set budget_category_id = null where plaid_transaction_id = 'p17e';
select pg_temp.page(jsonb_build_array(
  pg_temp.ins('q17a', '00000000-0000-0000-0000-0000000006a1', 10, false, 'p17a', '00000000-0000-0000-0000-0000000006c2'),
  pg_temp.ins('q17b', '00000000-0000-0000-0000-0000000006a1', 10, false, 'p17b', '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('q17c', '00000000-0000-0000-0000-0000000006a1', 10, false, 'p17c', '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('q17d', '00000000-0000-0000-0000-0000000006a1', 10, false, 'p17d', '00000000-0000-0000-0000-0000000006c1'),
  pg_temp.ins('q17e', '00000000-0000-0000-0000-0000000006a1', 10, false, 'p17e', '00000000-0000-0000-0000-0000000006c1')),
  array['p17a', 'p17b', 'p17c', 'p17d', 'p17e']);
select th.assert((pg_temp.txn('q17a')).budget_category_id = '00000000-0000-0000-0000-0000000006c1' and (pg_temp.txn('q17a')).budget_category_source is null, 'K17a: chosen Dining kept, label null');
select th.assert((pg_temp.txn('q17b')).budget_category_id = '00000000-0000-0000-0000-0000000006c2' and (pg_temp.txn('q17b')).budget_category_source = 'mapping', 'K17b: old-backend Groceries kept, stale label kept');
select th.assert((pg_temp.txn('q17c')).budget_category_id = '00000000-0000-0000-0000-0000000006c2' and (pg_temp.txn('q17c')).budget_category_source = 'mapping', 'K17c: Groceries NOT re-derived to Dining');
select th.assert((pg_temp.txn('q17d')).budget_category_id is null and (pg_temp.txn('q17d')).budget_category_source is null, 'K17d: NULL/null stays NULL (not re-mapped)');
select th.assert((pg_temp.txn('q17e')).budget_category_id is null and (pg_temp.txn('q17e')).budget_category_source = 'mapping', 'K17e: an old-backend clear stays NULL');

-- ---- Ownership: user bb''s rows are never touched by aa''s page, and bb cannot post into aa''s account --
select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000bb',
  jsonb_build_array(pg_temp.ins('pb1', '00000000-0000-0000-0000-0000000006a9', 5, true)), '[]', '{}');
select th.assert((pg_temp.page('[]', array['pb1'])->>'removed')::int = 0 and pg_temp.id_of('pb1') is not null, 'ownership: aa''s removal of bb''s plaid id is a no-op');
select th.expect_error($q$ select public.apply_synced_transaction_batch_v2('00000000-0000-0000-0000-0000000000bb',
  jsonb_build_array(pg_temp.ins('pb2', '00000000-0000-0000-0000-0000000006a1', 5, true)), '[]', '{}') $q$,
  '%account not owned by this user%');
select th.assert(not exists (select 1 from public.transaction_carryovers where user_id = '00000000-0000-0000-0000-0000000000bb'), 'ownership: no carry-over for bb');

-- ---- Ledger invariant across everything above -------------------------------------------------------------
select th.assert(pg_temp.applied_total() = (select sum(loan_balance_applied) from public.transactions where manual_loan_id is not null), 'ledger: consistent');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b1') = 10000 - (select coalesce(sum(loan_balance_applied), 0) from public.transactions where manual_loan_id = '00000000-0000-0000-0000-0000000006b1'),
  'ledger: SoFi balance = 10000 - Σ applied over its live rows');
select th.assert(pg_temp.loan('00000000-0000-0000-0000-0000000006b2') = 5000, 'ledger: Car fully restored');
