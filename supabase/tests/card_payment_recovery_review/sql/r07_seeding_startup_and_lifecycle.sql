-- Startup, seeding and lifecycle (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §3.4, §9, §10).
--   STAMP    a result that this evaluator did not publish is never read as current, even when the stored versions
--            are equal; nothing can be acted on from it; the next evaluation makes it current.
--   SEED     history that exists BEFORE its obligations do (a database upgraded from 20261008120000): until it is
--            seeded the unguarded pair is published; seeding makes the owner stale in its own transaction and
--            registers the refresh; the next evaluation publishes the guarded range. Nothing in between reads as
--            current.
--   BETWEEN  while inputs have changed and no evaluation has run, no reader returns a leg, a review or a range.
--   USER     deleting the USER removes every review row of that user and nothing of anyone else. Deleting a
--            decision, or an account, removes neither an obligation nor a receipt (r02 shows the account cascade).
-- (The real upgrade path — this migration applied to a database that holds evaluated states and removal
-- history — is the rehearsal, rehearsal.sh: it needs the migration to be absent first.)
-- A run that failed midway leaves this file's test-only function (and, with it, its triggers) behind: remove them first.
drop function if exists public.th_r07_no_capture() cascade;
set role service_role;

select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r07-item-kept', 'Kept Bank');
select rrh.item('00000000-0000-0000-0000-000000000005', rrh.bb(), 'r07-item-bb-kept', 'BB Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000107a1', '00000000-0000-0000-0000-000000000001', 'r07-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000107b1', '00000000-0000-0000-0000-000000000003', 'r07-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000107b2', '00000000-0000-0000-0000-000000000003', 'r07-y', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000107b3', '00000000-0000-0000-0000-000000000003', 'r07-w', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000107c1', '00000000-0000-0000-0000-000000000002', 'r07-bx', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000107d1', '00000000-0000-0000-0000-000000000005', 'r07-bc', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000107d2', '00000000-0000-0000-0000-000000000005', 'r07-by', 'credit');
create function pg_temp.c() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000107b1'::uuid $$;
create function pg_temp.y() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000107b2'::uuid $$;
create function pg_temp.w() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000107b3'::uuid $$;
create function pg_temp.snapshot_card(p_user uuid) returns jsonb language sql as $$
  select public.get_financial_read_snapshot(p_user, '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01')->'cardPayments' $$;

-- ==== SEED: history first, obligations later =====================================================================
-- k +370 C 10 | y −370 Y 12 | w −370 W 11 (an unrelated leg that arrived after an earlier removal). As an earlier
-- body left them: a record on k and a hold on k/y dated the 11th — with their provenance: a removal of this user
-- (generation 1, recorded) and the two provenance rows. No obligation exists: this file's migration never saw them.
select rrh.cardleg('k', pg_temp.c(), 370, '2026-09-10'), rrh.cardleg('y', pg_temp.y(), -370, '2026-09-12'), rrh.cardleg('w', pg_temp.w(), -370, '2026-09-11');
select rrh.cardleg('x', '00000000-0000-0000-0000-0000000107a1', -370, '2026-09-11');
select public.evaluate_card_payments(rrh.aa());
-- The removal is run with the capture switched off, exactly as 20261008120000's body ran it.
reset role;
create function public.th_r07_no_capture() returns trigger language plpgsql as $$ begin return null; end $$;
create trigger th_r07_no_obligations before insert on public.card_payment_review_obligations for each row execute function public.th_r07_no_capture();
create trigger th_r07_no_sources before insert on public.card_payment_review_obligation_sources for each row execute function public.th_r07_no_capture();
create trigger th_r07_no_memberships before insert on public.card_payment_review_memberships for each row execute function public.th_r07_no_capture();
set role service_role;
select th.expect_error(format('select rrh.remove(%L, %L)', rrh.aa(), '00000000-0000-0000-0000-000000000001'), '%known card-payment destinations could not be preserved%');
select th.assert(exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') and exists (select 1 from public.transactions where plaid_transaction_id = 'x')
                 and not exists (select 1 from public.card_payment_decisions where user_id = rrh.aa()),
                 'CAPTURE IS STRICT: a removal whose review obligations cannot be recorded removes nothing and writes nothing');
-- So the pre-existing history is written directly instead (the removal's own rows of 20261008120000).
reset role;
drop trigger th_r07_no_obligations on public.card_payment_review_obligations;
drop trigger th_r07_no_sources on public.card_payment_review_obligation_sources;
drop trigger th_r07_no_memberships on public.card_payment_review_memberships;
drop function public.th_r07_no_capture();
delete from public.transactions where plaid_transaction_id = 'x';
insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) values
  ('00000000-0000-0000-0000-00000107d001', rrh.aa(), 'destination_removed_card', pg_temp.c(), 'k', 37000);
insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, counterpart_date) values
  ('00000000-0000-0000-0000-00000107d002', rrh.aa(), 'ambiguity_hold_removed_card', pg_temp.y(), 'y', -37000, pg_temp.c(), 'k', 37000, '2026-09-11');
set role service_role;
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k') = 'tracked/auto_pair/0 partner=w decision=- range=0..0' and rrh.review('k') = 'none',
                 'SEED, before: with no obligation the unrelated leg pairs automatically — the exposure this packet closes: ' || rrh.line('k'));
create temporary table before_seed as select rrh.iv() as input, rrh.rev() as review;
reset role;
select th.assert(public.card_payment_review_seed_retained() = 2, 'SEED: two retained decisions are seeded');
set role service_role;
select th.assert(rrh.iv() > (select input from pg_temp.before_seed) and rrh.rev() > (select review from pg_temp.before_seed) and not rrh.fresh(),
                 'SEED: seeding advances the matching input version (and the review revision): the old result is stale at once');
select th.assert(not (rrh.states() ? 'legs') and not (rrh.states() ? 'reviews') and (pg_temp.snapshot_card(rrh.aa())->>'fresh')::boolean = false and not (pg_temp.snapshot_card(rrh.aa()) ? 'legs'),
                 'SEED: between seeding and evaluation no reader — the states, the financial snapshot — returns the old pair');
select th.assert((select q.target_version = rrh.iv() from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()), 'SEED: the refresh is registered for the seeded version');
select th.assert((public.get_card_payment_recovery_reviews(rrh.aa())->>'fresh')::boolean = false and (public.get_card_payment_recovery_reviews(rrh.aa())->>'affectedPaymentCount')::integer = 1
                 and jsonb_array_length(public.get_card_payment_recovery_reviews(rrh.aa())->'reviews') = 0,
                 'SEED: the review reader knows one payment is affected and shows no figure for it');
create temporary table kept (name text primary key, v jsonb);
insert into pg_temp.kept values ('claim', public.claim_card_payment_recovery_refresh(rrh.op(1), 10)->'claims');
insert into pg_temp.kept select 'refresh', public.refresh_card_payment_recovery_owner(rrh.aa(), (v->0->>'leaseToken')::uuid) from pg_temp.kept where name = 'claim';
select th.assert((select v->>'status' from pg_temp.kept where name = 'refresh') = 'fresh'
                 and rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0' and rrh.review('k') = 'withheld=w obligations=2 gap=t',
                 'SEED, after: the guarded range, with the unattributed history as a gap: ' || rrh.line('k') || ' ' || rrh.review('k'));
select th.assert((pg_temp.snapshot_card(rrh.aa())->>'fresh')::boolean and (pg_temp.snapshot_card(rrh.aa())->>'evaluatorContract')::integer = 2
                 and jsonb_array_length(pg_temp.snapshot_card(rrh.aa())->'reviews') = 2, 'SEED, after: the financial snapshot carries the contract and the review states');

-- ==== STAMP: equal versions are not enough =========================================================================
reset role;
delete from public.card_payment_evaluator_contracts where user_id = rrh.aa();
set role service_role;
select th.assert((select evaluated_version = input_version from public.card_payment_eval_versions where user_id = rrh.aa()) and not rrh.fresh() and not (rrh.states() ? 'legs'),
                 'STAMP: with equal versions but no stamp of this evaluator, nothing is readable');
select th.assert(rrh.states()->>'evaluatorContract' is null and (public.card_payment_recovery_freshness(rrh.aa())->>'fresh')::boolean = false, 'STAMP: the reader says which contract is missing');
select th.assert(rrh.outcome(rrh.act(rrh.op(2), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k')))) = 'refused: card_payment_stale_version', 'STAMP: no action is accepted on an unstamped result');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.fresh() and (select c.contract = 2 and c.evaluated_version = rrh.iv() from public.card_payment_evaluator_contracts c where c.user_id = rrh.aa()), 'STAMP: the next evaluation stamps the user');
reset role;
update public.card_payment_evaluator_contracts set contract = 1 where user_id = rrh.aa();
set role service_role;
select th.assert(not rrh.fresh() and (rrh.states()->>'evaluatorContract')::integer = 1, 'STAMP: another contract''s stamp is not this contract''s');
select public.evaluate_card_payments(rrh.aa());

-- ==== BETWEEN: inputs changed, not yet evaluated =======================================================================
select rrh.cardleg('n', pg_temp.c(), 12, '2026-09-25');
select th.assert(not rrh.fresh() and rrh.states() - 'inputVersion' - 'evaluatedVersion' = '{"fresh": false, "lastErrorCode": null, "evaluatorContract": 2}'::jsonb,
                 'BETWEEN: a stale answer carries versions and nothing else: ' || rrh.states()::text);
select th.assert(jsonb_array_length(public.get_card_payment_recovery_reviews(rrh.aa())->'reviews') = 0 and (public.get_card_payment_recovery_action(rrh.aa(), rrh.op(2))->>'found')::boolean = false,
                 'BETWEEN: no review is returned');
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.outcome(rrh.act(rrh.op(3), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k')))) = 'committed_fresh', 'a receipt and a note for the deletion checks below');

-- ==== USER: full-user deletion against a supporting row's deletion ======================================================
-- bb gets a complete history of its own, so that there is something of another user to keep.
select rrh.cardleg('bk', '00000000-0000-0000-0000-0000000107d1', 90, '2026-09-10'), rrh.cardleg('bx', '00000000-0000-0000-0000-0000000107c1', -90, '2026-09-11'),
       rrh.cardleg('by', '00000000-0000-0000-0000-0000000107d2', -90, '2026-09-12');
select rrh.remove(rrh.bb(), '00000000-0000-0000-0000-000000000002');
select th.assert(rrh.outcome(rrh.act(rrh.op(4), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('bk')), rrh.bb())) = 'committed_fresh', 'bb has a receipt and a note too');
create function pg_temp.rows_of(p_user uuid) returns text language sql as $$
  select format('obligations=%s sources=%s edges=%s states=%s stamp=%s revision=%s notes=%s receipts=%s queue=%s',
    (select count(*) from public.card_payment_review_obligations where user_id = p_user), (select count(*) from public.card_payment_review_obligation_sources where user_id = p_user),
    (select count(*) from public.card_payment_review_memberships where user_id = p_user), (select count(*) from public.card_payment_review_states where user_id = p_user),
    (select count(*) from public.card_payment_evaluator_contracts where user_id = p_user), (select count(*) from public.card_payment_review_revisions where user_id = p_user),
    (select count(*) from public.card_payment_review_annotations where user_id = p_user), (select count(*) from public.card_payment_recovery_actions where user_id = p_user),
    (select count(*) from public.card_payment_recovery_refresh_queue where user_id = p_user)) $$;
select th.assert(pg_temp.rows_of(rrh.aa()) = 'obligations=2 sources=2 edges=1 states=2 stamp=1 revision=1 notes=1 receipts=1 queue=0', 'aa before: ' || pg_temp.rows_of(rrh.aa()));
select th.assert(pg_temp.rows_of(rrh.bb()) = 'obligations=1 sources=2 edges=1 states=1 stamp=1 revision=1 notes=1 receipts=1 queue=0', 'bb before: ' || pg_temp.rows_of(rrh.bb()));
-- A supporting DECISION is deleted (the service role may; no application path does): the obligation, its source
-- row and the receipt stay. Its deletion is an input change, registered for refresh like any other.
delete from public.card_payment_decisions where id = '00000000-0000-0000-0000-00000107d001';
select th.assert(pg_temp.rows_of(rrh.aa()) = 'obligations=2 sources=2 edges=1 states=2 stamp=1 revision=1 notes=1 receipts=1 queue=1', 'deleting a decision deletes no review row: ' || pg_temp.rows_of(rrh.aa()));
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.review('k') = 'withheld=w obligations=2 gap=t', 'the payment is still under review after its record was deleted: ' || rrh.review('k'));
-- The USER is deleted: everything of that user goes, and nothing of bb's.
reset role;
delete from public.plaid_items where user_id = rrh.aa();  -- the application removes a user's institutions first; this key does not cascade
delete from auth.users where id = rrh.aa();
set role service_role;
select th.assert(pg_temp.rows_of(rrh.aa()) = 'obligations=0 sources=0 edges=0 states=0 stamp=0 revision=0 notes=0 receipts=0 queue=0', 'full-user deletion removes every review row of that user: ' || pg_temp.rows_of(rrh.aa()));
select th.assert(pg_temp.rows_of(rrh.bb()) = 'obligations=1 sources=2 edges=1 states=1 stamp=1 revision=1 notes=1 receipts=1 queue=0', 'and nothing of another user: ' || pg_temp.rows_of(rrh.bb()));
select th.assert(rrh.fresh(rrh.bb()) and rrh.review('bk', rrh.bb()) = 'withheld=- obligations=1 gap=f', 'bb is still fresh and still under review');
