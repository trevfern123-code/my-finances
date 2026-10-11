-- One request, one transaction: the decision, its receipt and the refresh work commit together or not at all;
-- an operation id names one logical action; what a client can learn after an unknown outcome
-- (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §7; traceability cases 33, 36, 37, 38, 44, 45).
--
-- User aa: item 1 "Card Bank" (card X) removed; item 3 kept (checking C, card Y); item 8 brings card W. Six
-- guarded payments k-1 … k-6 (+110 … +160, the 10th) with x (the 11th), y (the 12th) and, after the removal, an
-- unrelated w on the 11th. Failures are injected by triggers this file installs and removes itself.
-- A run that failed midway leaves this file's test-only function (and, with it, its triggers) behind: remove them first.
drop function if exists public.th_r05_refuse() cascade;
set role service_role;

select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r05-item-kept', 'Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000105a1', '00000000-0000-0000-0000-000000000001', 'r05-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000105b1', '00000000-0000-0000-0000-000000000003', 'r05-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000105b2', '00000000-0000-0000-0000-000000000003', 'r05-y', 'credit');
select rrh.cardleg('k-' || n, '00000000-0000-0000-0000-0000000105b1', 100 + 10 * n, '2026-09-10'),
       rrh.cardleg('x-' || n, '00000000-0000-0000-0000-0000000105a1', -(100 + 10 * n), '2026-09-11'),
       rrh.cardleg('y-' || n, '00000000-0000-0000-0000-0000000105b2', -(100 + 10 * n), '2026-09-12')
from generate_series(1, 6) n;
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'r05-item-other', 'Other Bank');
select rrh.account('00000000-0000-0000-0000-0000000105e1', '00000000-0000-0000-0000-000000000008', 'r05-w', 'credit');
select rrh.cardleg('w-' || n, '00000000-0000-0000-0000-0000000105e1', -(100 + 10 * n), '2026-09-11') from generate_series(1, 6) n;
select public.evaluate_card_payments(rrh.aa());
select th.assert(rrh.line('k-' || n) = 'unresolved/relink_review_required/null partner=- decision=- range=' || (-(100 + 10 * n) * 100) || '..0', 'fixture: k-' || n || ' is guarded')
from generate_series(1, 6) n;

create function pg_temp.pair(p_n integer) returns jsonb language sql as $$
  select jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-' || p_n), 'counterpartTransactionId', rrh.tid('w-' || p_n), 'acceptedDifferenceCents', 0) $$;
create function pg_temp.snapshot() returns text language sql as $$
  select format('decisions=%s receipts=%s notes=%s queue=%s input=%s evaluated=%s review=%s',
                (select count(*) from public.card_payment_decisions), (select count(*) from public.card_payment_recovery_actions),
                (select count(*) from public.card_payment_review_annotations), (select count(*) from public.card_payment_recovery_refresh_queue),
                rrh.iv(), (select evaluated_version from public.card_payment_eval_versions where user_id = rrh.aa()), rrh.rev()) $$;
create temporary table marks (name text primary key, snap text not null);
create temporary table answers (name text primary key, answer jsonb not null);

-- ==== 1. A failure at the receipt: the decision is rolled back with it (case 36) ===================================
reset role;
create function public.th_r05_refuse() returns trigger language plpgsql as $$ begin raise exception 'th_r05: injected failure on %', tg_table_name; end $$;
create trigger th_r05_refuse_receipt before insert on public.card_payment_recovery_actions for each row execute function public.th_r05_refuse();
set role service_role;
insert into pg_temp.marks values ('before receipt failure', pg_temp.snapshot());
insert into pg_temp.answers values ('receipt failure', rrh.act(rrh.op(1), pg_temp.pair(1)));
select th.assert(answer->>'refused' like 'th_r05: injected failure on card_payment_recovery_actions', 'the injected failure at the receipt surfaces: ' || answer::text) from pg_temp.answers where name = 'receipt failure';
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'before receipt failure'), 'receipt failure: the decision, the evaluation and the versions were rolled back with it: ' || pg_temp.snapshot());
select th.assert(rrh.line('k-1') = 'unresolved/relink_review_required/null partner=- decision=- range=-11000..0', 'receipt failure: no half-resolution: ' || rrh.line('k-1'));
select th.assert((public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->>'found')::boolean = false, 'receipt failure: the operation is ABSENT — and may be sent again');
reset role;
drop trigger th_r05_refuse_receipt on public.card_payment_recovery_actions;

-- ==== 2. A failure at the refresh registration: everything is rolled back (case 36) ================================
-- The queue row is written in the transaction of the decision (the version trigger, for an owner under review).
create trigger th_r05_refuse_queue before insert or update on public.card_payment_recovery_refresh_queue for each row execute function public.th_r05_refuse();
set role service_role;
insert into pg_temp.answers values ('queue failure', rrh.act(rrh.op(1), pg_temp.pair(1)));
select th.assert(answer->>'refused' like 'th_r05: injected failure on card_payment_recovery_refresh_queue', 'the injected failure at the refresh registration surfaces: ' || answer::text) from pg_temp.answers where name = 'queue failure';
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'before receipt failure'), 'queue failure: nothing was written: ' || pg_temp.snapshot());
reset role;
drop trigger th_r05_refuse_queue on public.card_payment_recovery_refresh_queue;

-- ==== 3. An ORDINARY evaluation failure: the action commits, pending (case 37) =====================================
create trigger th_r05_refuse_states before insert on public.card_payment_leg_states for each row execute function public.th_r05_refuse();
set role service_role;
insert into pg_temp.answers values ('pending', rrh.act(rrh.op(1), pg_temp.pair(1)));
select th.assert(answer->>'status' = 'committed_pending' and (answer->'freshness'->>'fresh')::boolean = false and (answer->'freshness'->'refresh'->>'queued')::boolean,
                 'pending: the action committed, the figures are not current, and refresh work is registered: ' || answer::text) from pg_temp.answers where name = 'pending';
select th.assert(answer->'receipt'->>'outcome' = 'saved' and answer->'receipt'->>'decisionId' is not null and not answer ? 'legs' and not (answer->'receipt') ? 'legs',
                 'pending: the receipt holds the committed facts and no figure') from pg_temp.answers where name = 'pending';
select th.assert(exists (select 1 from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null and d.a_plaid_transaction_id = 'k-1')
                 and (select q.target_version = rrh.iv() from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()),
                 'pending: the decision is stored and the queue row names the input version it left');
select th.assert(not rrh.fresh() and not (rrh.states() ? 'legs'), 'pending: no stale-derived figure is readable');
select th.assert((public.get_card_payment_recovery_reviews(rrh.aa())->>'fresh')::boolean = false and jsonb_array_length(public.get_card_payment_recovery_reviews(rrh.aa())->'reviews') = 0,
                 'pending: the review reader returns no review and says the figures are not current');
-- An unknown outcome (the client timed out): the same operation id tells committed-pending from absent (case 38).
select th.assert((public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->>'found')::boolean and (public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->'freshness'->>'fresh')::boolean = false
                 and (public.get_card_payment_recovery_action(rrh.aa(), rrh.op(99))->>'found')::boolean = false,
                 'unknown outcome: operation 1 is found (committed, pending); an operation that never committed is absent');
insert into pg_temp.answers values ('pending replay', rrh.act(rrh.op(1), pg_temp.pair(1), rrh.aa(), 1, 1));
select th.assert(answer->>'status' = 'replayed' and answer->'receipt' = (select answer->'receipt' from pg_temp.answers where name = 'pending'),
                 'unknown outcome: sending the same operation again returns the same receipt — whatever versions it carries — and does nothing: ' || answer::text) from pg_temp.answers where name = 'pending replay';
-- Later the evaluation succeeds — through the durable queue, with no further action and no sync.
reset role;
drop trigger th_r05_refuse_states on public.card_payment_leg_states;
set role service_role;
create temporary table claim as select public.claim_card_payment_recovery_refresh(rrh.op(500), 10) as c;
select th.assert((select public.refresh_card_payment_recovery_owner(rrh.aa(), (c->'claims'->0->>'leaseToken')::uuid)->>'status' from pg_temp.claim) = 'fresh', 'pending: the worker''s refresh publishes');
select th.assert(rrh.line('k-1') = 'tracked/user_pair/0 partner=w-1 decision=pair range=0..0' and (public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->'freshness'->>'fresh')::boolean
                 and public.get_card_payment_recovery_action(rrh.aa(), rrh.op(1))->'receipt' = (select answer->'receipt' from pg_temp.answers where name = 'pending')
                 and not exists (select 1 from public.card_payment_recovery_refresh_queue),
                 'pending: later success uses the current inputs; the receipt is unchanged; the work is done: ' || rrh.line('k-1'));

-- ==== 4. The same operation a hundred times: one logical action (case 33) ============================================
insert into pg_temp.answers values ('first', rrh.act(rrh.op(2), pg_temp.pair(2)));
insert into pg_temp.marks values ('after first', pg_temp.snapshot());
create temporary table replays as select n, rrh.act(rrh.op(2), pg_temp.pair(2)) as answer from generate_series(1, 100) n;
select th.assert((select count(*) filter (where answer->>'status' = 'replayed') = 100 and count(distinct answer->'receipt') = 1 from pg_temp.replays)
                 and (select answer->'receipt' from pg_temp.replays limit 1) = (select answer->'receipt' from pg_temp.answers where name = 'first'),
                 'a hundred replays: each returns the one receipt');
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'after first'), 'a hundred replays: no decision, no receipt, no note, no version moved: ' || pg_temp.snapshot());
select th.assert((select count(*) from public.card_payment_decisions d where d.kind = 'pair' and d.a_plaid_transaction_id = 'k-2') = 1, 'a hundred replays: one pair');

-- ==== 5. The same operation id for another request ====================================================================
insert into pg_temp.answers values
  ('conflict other subject', rrh.act(rrh.op(2), pg_temp.pair(3))),
  ('conflict other action', rrh.act(rrh.op(2), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k-2')))),
  ('conflict other amount', rrh.act(rrh.op(2), pg_temp.pair(2) || jsonb_build_object('acceptedDifferenceCents', 1)));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_recovery_operation_conflict', name || ': refused: ' || answer::text) from pg_temp.answers where name like 'conflict%';
select th.expect_error(format('select public.request_card_payment_recovery_refresh(%L, %L)', rrh.aa(), rrh.op(2)), 'card_payment_recovery_operation_conflict:%');
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'after first'), 'conflicting reuse: nothing changed: ' || pg_temp.snapshot());
-- An extra field does not make another request: the intent is exactly the action's own fields.
select th.assert(rrh.act(rrh.op(2), pg_temp.pair(2) || jsonb_build_object('userId', rrh.bb(), 'note', 'x'))->>'status' = 'replayed', 'an unknown extra field is not part of the intent');

-- ==== 6. Stale and malformed requests write nothing (cases 44, 45) ====================================================
insert into pg_temp.marks values ('before refusals', pg_temp.snapshot());
insert into pg_temp.answers values
  ('stale input', rrh.act(rrh.op(10), pg_temp.pair(3), rrh.aa(), rrh.iv() - 1, null)),
  ('future input', rrh.act(rrh.op(11), pg_temp.pair(3), rrh.aa(), rrh.iv() + 1, null)),
  ('stale review', rrh.act(rrh.op(12), pg_temp.pair(3), rrh.aa(), null, rrh.rev() + 1)),
  ('not under review', rrh.act(rrh.op(13), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('y-3')))),
  ('unknown action', rrh.act(rrh.op(14), jsonb_build_object('action', 'retire_hold', 'transactionId', rrh.tid('k-3')))),
  ('release', rrh.act(rrh.op(15), jsonb_build_object('action', 'mark_reviewed', 'transactionId', rrh.tid('k-3')))),
  ('missing field', rrh.act(rrh.op(16), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-3')))),
  ('bad id', rrh.act(rrh.op(17), jsonb_build_object('action', 'defer', 'transactionId', 'not-a-uuid'))),
  ('not a suggestion', rrh.act(rrh.op(18), jsonb_build_object('action', 'reject_suggestion', 'transactionId', rrh.tid('k-3'), 'candidateTransactionId', rrh.tid('w-4')))),
  ('system decision', rrh.act(rrh.op(19), jsonb_build_object('action', 'undo_decision', 'decisionId', (select d.id from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-3')))),
  ('hold', rrh.act(rrh.op(20), jsonb_build_object('action', 'undo_decision', 'decisionId', (select d.id from public.card_payment_decisions d where d.kind = 'ambiguity_hold_removed_card' and d.b_plaid_transaction_id = 'k-3'))));
select th.assert((select string_agg(name || '=' || rrh.outcome(answer), ' | ' order by name) from pg_temp.answers
                  where name in ('stale input', 'future input', 'stale review', 'not under review', 'unknown action', 'release', 'missing field', 'bad id', 'not a suggestion', 'system decision', 'hold'))
                 = 'bad id=refused: card_payment_recovery_invalid | future input=refused: card_payment_stale_version | hold=refused: card_payment_invalid | missing field=refused: card_payment_recovery_invalid'
                || ' | not a suggestion=refused: card_payment_recovery_invalid | not under review=refused: card_payment_recovery_not_reviewable | release=refused: card_payment_recovery_invalid'
                || ' | stale input=refused: card_payment_stale_version | stale review=refused: card_payment_recovery_stale_review | system decision=refused: card_payment_invalid'
                || ' | unknown action=refused: card_payment_recovery_invalid',
                 'each refusal has its own code: ' || (select string_agg(name || '=' || rrh.outcome(answer), ' | ' order by name) from pg_temp.answers where name not like 'conflict%' and name not in ('receipt failure', 'queue failure', 'pending', 'pending replay', 'first')));
select th.assert((select answer->>'refused' from pg_temp.answers where name = 'system decision') like '%system_decision%' and (select answer->>'refused' from pg_temp.answers where name = 'hold') like '%system_decision%',
                 'a record and a hold cannot be undone through recovery: they are not the user''s');
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'before refusals'), 'eleven refusals: nothing was written and no version moved: ' || pg_temp.snapshot());
select th.assert(not exists (select 1 from public.card_payment_recovery_actions a where a.operation_id in (select rrh.op(n) from generate_series(10, 20) n)), 'no refused operation has a receipt');
-- A workflow note is not exempt: sent with versions that are no longer current, it is refused too.
insert into pg_temp.answers values
  ('stale input, note', rrh.act(rrh.op(21), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k-3')), rrh.aa(), rrh.iv() - 1, null)),
  ('stale review, note', rrh.act(rrh.op(22), jsonb_build_object('action', 'reject_suggestion', 'transactionId', rrh.tid('k-3'), 'candidateTransactionId', rrh.tid('w-3')), rrh.aa(), null, rrh.rev() - 1));
select th.assert((select rrh.outcome(answer) from pg_temp.answers where name = 'stale input, note') = 'refused: card_payment_stale_version', 'a note sent with an old input version is refused as stale: ' || (select answer::text from pg_temp.answers where name = 'stale input, note'));
select th.assert((select rrh.outcome(answer) from pg_temp.answers where name = 'stale review, note') = 'refused: card_payment_recovery_stale_review', 'a note sent with an old review revision is refused: ' || (select answer::text from pg_temp.answers where name = 'stale review, note'));
select th.assert(pg_temp.snapshot() = (select snap from pg_temp.marks where name = 'before refusals'), 'the two refused notes wrote nothing: ' || pg_temp.snapshot());

-- ==== 7. The evidence changes while the request waits (cases 44, 45) ===================================================
-- The candidate is withdrawn by the bank after the user looked: the request names the versions it saw.
create temporary table seen as select rrh.iv() as input, rrh.rev() as review, rrh.tid('w-4') as candidate;
delete from public.transactions where plaid_transaction_id = 'w-4';
insert into pg_temp.answers values ('candidate gone, old versions', rrh.act(rrh.op(30), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-4'),
                                       'counterpartTransactionId', (select candidate from pg_temp.seen), 'acceptedDifferenceCents', 0), rrh.aa(), (select input from pg_temp.seen), (select review from pg_temp.seen)));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_stale_version', 'a request planned on withdrawn evidence is refused as stale: ' || answer::text) from pg_temp.answers where name = 'candidate gone, old versions';
select public.evaluate_card_payments(rrh.aa());
insert into pg_temp.answers values ('candidate gone, current versions', rrh.act(rrh.op(30), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k-4'),
                                       'counterpartTransactionId', (select candidate from pg_temp.seen), 'acceptedDifferenceCents', 0)));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_not_found', 'even with current versions a withdrawn candidate cannot be paired: ' || answer::text) from pg_temp.answers where name = 'candidate gone, current versions';
select th.assert(not exists (select 1 from public.card_payment_recovery_actions a where a.operation_id = rrh.op(30))
                 and rrh.line('k-4') = 'untracked/removed_card/-14000 partner=- decision=destination_removed_card range=-14000..-14000' and rrh.retained('k-4') = 'D(k-4) H(y-4/k-4@2026-09-11)',
                 'no receipt claims a resolution; with the candidate gone the payment reads its retained record again: ' || rrh.line('k-4'));
-- The user corrects the payment while another request for it waits: the later request is refused, the user's
-- latest decision stands.
create temporary table seen2 as select rrh.iv() as input, rrh.rev() as review;
select th.assert(rrh.outcome(rrh.act(rrh.op(31), jsonb_build_object('action', 'confirm_unlinked', 'transactionId', rrh.tid('k-5')))) = 'committed_fresh', 'the user decides k-5');
insert into pg_temp.answers values ('overtaken', rrh.act(rrh.op(32), pg_temp.pair(5), rrh.aa(), (select input from pg_temp.seen2), (select review from pg_temp.seen2)));
select th.assert(rrh.outcome(answer) = 'refused: card_payment_stale_version' and rrh.line('k-5') = 'untracked/user_confirmed_unlinked/-15000 partner=- decision=destination_unlinked range=-15000..-15000',
                 'a request overtaken by the user''s own correction is refused; the latest decision stands: ' || rrh.line('k-5')) from pg_temp.answers where name = 'overtaken';

reset role;
drop function public.th_r05_refuse();
