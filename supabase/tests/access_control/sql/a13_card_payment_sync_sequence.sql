-- End-of-sync card-payment evaluation (Phase B packet 2b-2a), against the real database objects the
-- sync pipeline uses. The steps follow syncService.syncItemTransactions in order, each committed on its
-- own (psql autocommit: every statement below is its own transaction, as each backend call is):
--   the batch RPC → a reconciliation-style role write → the carry-over sweep's delete (its
--   expired-unconsumed branch) → the wrapper's exact call, try_evaluate_card_payments(p_user_id).
-- Loan auto-linking and the repair sweep write the same kinds of inputs (roles, loan links) through their
-- own RPCs; they are not separately represented here.
-- Shows:
--   * the batch and every later input step invalidate matching;
--   * the final evaluation publishes fresh states once inputs are quiescent;
--   * a caught evaluation failure after changed inputs withholds the stale states;
--   * a later evaluation recovers;
--   * a further input change invalidates again.
-- "Fresh" here means fresh for the inputs committed before the evaluation (the committed-input contract
-- of 20260930120000); it does not mean every concurrent sync pipeline has finished.
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000a13c1', '00000000-0000-0000-0000-000000000001', 'a13-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000a13c2', '00000000-0000-0000-0000-000000000001', 'a13-x', 'Card', 'credit');

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.states() returns jsonb language sql as $$ select public.get_card_payment_states(pg_temp.aa()) $$;
create function pg_temp.fresh() returns boolean language sql as $$ select coalesce((pg_temp.states()->>'fresh')::boolean, false) $$;
create function pg_temp.iv() returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = pg_temp.aa() $$;
create function pg_temp.leg(p_plaid text) returns jsonb language sql as $$
  select l from jsonb_array_elements(pg_temp.states()->'legs') l
  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = p_plaid) $$;
-- One sync-shaped insert object (the batch RPC's own input format).
create function pg_temp.row(p_plaid text, p_account uuid, p_amount numeric, p_date date, p_role text, p_source text)
returns jsonb language sql as $$
  select jsonb_build_object('plaid_transaction_id', p_plaid, 'account_id', p_account, 'amount', p_amount,
    'iso_currency_code', 'USD', 'date', p_date, 'name', 'Synthetic', 'merchant_name', null, 'category', null,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null,
    'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', p_role, 'role_source', p_source,
    'role_confidence', 'high', 'classifier_version', 1, 'pending_transaction_id', null) $$;

-- A quiescent, evaluated starting point (an earlier successful sync).
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), 'starting evaluation succeeds');
select th.assert(pg_temp.fresh(), 'fresh before the sync');
create temporary table v0 as select pg_temp.iv() as iv;
-- An expired, unconsumed carry-over the sweep will delete (a pending row that never posted).
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                           pending_amount, pending_date, needs_review, expires_at)
values (pg_temp.aa(), '00000000-0000-0000-0000-0000000a13c1', 'a13-never-posted', gen_random_uuid(), 9, '2026-08-01', false, now() - interval '1 day');
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), 're-evaluated after the carry-over insert');
update pg_temp.v0 set iv = pg_temp.iv();

-- ---- 1. The batch (a card payment and its card leg, plus an ordinary row) ------------------------------
select public.apply_synced_transaction_batch_v2(pg_temp.aa(),
  jsonb_build_array(
    pg_temp.row('a13-pay', '00000000-0000-0000-0000-0000000a13c1', 100, '2026-09-01', 'credit_card_payment', 'category_detailed'),
    pg_temp.row('a13-card', '00000000-0000-0000-0000-0000000a13c2', -100, '2026-09-02', 'credit_card_payment', 'category_detailed'),
    pg_temp.row('a13-move', '00000000-0000-0000-0000-0000000a13c1', 40, '2026-09-03', 'expense', 'sign_default')),
  '[]'::jsonb, '{}'::text[]);
select th.assert(not pg_temp.fresh() and pg_temp.states()->'legs' is null, 'after the batch: stale, no states readable');
select th.assert(pg_temp.iv() > (select iv from pg_temp.v0), 'the batch advanced the input version');
update pg_temp.v0 set iv = pg_temp.iv();

-- ---- 2. Reconciliation (role application) — a later, separately committed input change -------------------
select public.apply_transaction_semantic_roles(pg_temp.aa(),
  array[(select id from public.transactions where plaid_transaction_id = 'a13-move')], array['sign_default'],
  'internal_transfer', 'account_pair_match', 'high', 1::smallint);
select th.assert(pg_temp.iv() > (select iv from pg_temp.v0) and not pg_temp.fresh(), 'the role write advanced the version again: still stale');
update pg_temp.v0 set iv = pg_temp.iv();

-- ---- 3. The carry-over sweep's delete (dataService.sweepTransactionCarryovers) -----------------------------
delete from public.transaction_carryovers where user_id = pg_temp.aa() and consumed_at is null and expires_at < now();
select th.assert(pg_temp.iv() > (select iv from pg_temp.v0) and not pg_temp.fresh(), 'the sweep delete is an input too: still stale');

-- ---- 4. The end-of-sync evaluation, with inputs quiescent ---------------------------------------------------
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()) is true, 'the wrapper''s exact call returns true');
select th.assert(pg_temp.fresh(), 'fresh once evaluated with no later input change');
select th.assert(pg_temp.leg('a13-pay')->>'state' = 'tracked' and pg_temp.leg('a13-pay')->>'reason' = 'auto_pair',
  'the synced payment is matched to its synced card leg');

-- ---- 5. A later sync changes inputs; its evaluation fails (caught) → the old states are withheld ------------
select public.apply_synced_transaction_batch_v2(pg_temp.aa(),
  jsonb_build_array(pg_temp.row('a13-pay2', '00000000-0000-0000-0000-0000000a13c1', 55, '2026-09-10', 'credit_card_payment', 'category_detailed')),
  '[]'::jsonb, '{}'::text[]);
-- Fault injection: a session temp table shadowing the evaluator's scratch table makes it fail inside
-- try_evaluate's subtransaction (the same technique as a10/a11).
create temporary table cpe_txn (x integer);
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()) is false, 'the evaluation fails and is caught: false, no exception');
select th.assert(not pg_temp.fresh() and pg_temp.states()->'legs' is null,
  'the previous fresh states are NOT returned: stale inputs are never served as resolved');
select th.assert(exists (select 1 from public.card_payment_leg_states where user_id = pg_temp.aa()),
  '(the old derived rows still exist; the version check is what withholds them)');
select th.assert(pg_temp.states()->>'lastErrorCode' is not null, 'the sanitized error code is recorded');
select th.assert(exists (select 1 from public.transactions where plaid_transaction_id = 'a13-pay2'),
  'the sync''s own write is committed regardless');

-- ---- 6. A later evaluation (the next sync, even one with an empty batch) recovers ---------------------------
drop table pg_temp.cpe_txn;
update pg_temp.v0 set iv = pg_temp.iv();
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, '{}'::text[]);
select th.assert(pg_temp.iv() = (select iv from pg_temp.v0) and not pg_temp.fresh(), 'an empty batch changes no input (same version): still stale');
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()) is true, 'the next evaluation succeeds');
select th.assert(pg_temp.fresh() and pg_temp.leg('a13-pay2') is not null, 'fresh again, now including the new leg');
select th.assert((select last_error_code is null from public.card_payment_eval_versions where user_id = pg_temp.aa()),
  'the recorded error code is cleared');

-- ---- 7. Any later input change invalidates again ---------------------------------------------------------------
update public.transactions set amount = 101 where plaid_transaction_id = 'a13-pay';
select th.assert(not pg_temp.fresh() and pg_temp.states()->'legs' is null, 'a later input change makes the states unreadable again');
