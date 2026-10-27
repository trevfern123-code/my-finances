-- RPC-written decision sequences (Phase B slice 2b-1). Each scenario drives the decision RPCs
-- (link / mark / dismiss / undo, each with the version the caller saw), plus the sync-shaped input changes
-- between them, then evaluates at a fixed time and prints, per user:
--   S|<scenario>|<step>|<status>   each RPC's outcome (refusals as refused:<code>)
--   I|<scenario>|<user>|<json>      the database inputs in the TypeScript reference evaluator's input shape
--   R|<scenario>|<user>|<json>      get_card_payment_states
--   E|<scenario>|<json>             the expected reference outcome of the sequence
--   CI|<scenario>|<stage>|<user>|<json>, CR|<scenario>|<stage>|<user>|<json>
--                                   the same inputs and states at a named stage INSIDE a sequence (Q13–Q15)
-- compare_rpc.cjs runs the reference evaluator on each I line (so on exactly the decisions the RPCs wrote,
-- superseded ones included), requires it to equal R, and checks E against it. It does the same for every
-- CI / CR pair, so the hand-written S lines around a checkpoint state what BOTH evaluators computed there.
-- Q9, Q10 and Q11 (integration slice I3A) do the same for the decisions an institution removal writes
-- (remove_plaid_item_local, 20261006120000): the SYSTEM record of an automatic pair, and the USER decision
-- pair_counterpart_removed that preserves a confirmed pair. Q12 does it for the SYSTEM ambiguity hold.
-- Q13, Q14 and Q15 (revision 5) do it for: a hold whose owner is a leg on an EXCLUDED account (the audit's
-- finding P1); a preserved pair's frozen invalidity under a later amount correction (P2); and a payment that
-- was matched automatically to the removed card while a kept card's leg also fitted (Option B).
-- Q16–Q19 (20261008120000: the removal writes one system row per source) do it for what a removal now leaves
-- routinely: two holds on one pair with one date, written by two removals (Q16) or by one removal for two
-- identical removed transactions (Q17); two records on one payment after a relink and a second removal (Q18);
-- and a user pair whose removed leg was waiting to post (Q19).
\set ON_ERROR_STOP 1
set client_min_messages = warning;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000000bb'::uuid $$;
create function pg_temp.acct(p text) returns uuid language sql as $$
  select case p when 'C' then '00000000-0000-4000-8000-0000000a0c01'::uuid when 'C2' then '00000000-0000-4000-8000-0000000a0c02'::uuid
                when 'X' then '00000000-0000-4000-8000-0000000a0c03'::uuid when 'Y' then '00000000-0000-4000-8000-0000000a0c04'::uuid
                when 'E' then '00000000-0000-4000-8000-0000000a0c05'::uuid when 'BC' then '00000000-0000-4000-8000-0000000b0c01'::uuid
                when 'BX' then '00000000-0000-4000-8000-0000000b0c02'::uuid end $$;
create function pg_temp.t(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
create function pg_temp.v(p_user uuid default '00000000-0000-4000-8000-0000000000aa') returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.reset() returns void language plpgsql as $$
begin
  truncate auth.users cascade;
  insert into auth.users (id, email) values (pg_temp.aa(), 'a@example.test'), (pg_temp.bb(), 'b@example.test');
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
    ('00000000-0000-4000-8000-00000000a001', pg_temp.aa(), 'rpc-item-a', 'placeholder'),
    ('00000000-0000-4000-8000-00000000b001', pg_temp.bb(), 'rpc-item-b', 'placeholder');
  insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
    (pg_temp.acct('C'),  '00000000-0000-4000-8000-00000000a001', 'rpc-c',  'Checking', 'depository', false),
    (pg_temp.acct('C2'), '00000000-0000-4000-8000-00000000a001', 'rpc-c2', 'Savings',  'depository', false),
    (pg_temp.acct('X'),  '00000000-0000-4000-8000-00000000a001', 'rpc-x',  'Card X',   'credit', false),
    (pg_temp.acct('Y'),  '00000000-0000-4000-8000-00000000a001', 'rpc-y',  'Card Y',   'credit', false),
    (pg_temp.acct('E'),  '00000000-0000-4000-8000-00000000a001', 'rpc-e',  'Card E',   'credit', true),
    (pg_temp.acct('BC'), '00000000-0000-4000-8000-00000000b001', 'rpc-bc', 'BB Checking', 'depository', false),
    (pg_temp.acct('BX'), '00000000-0000-4000-8000-00000000b001', 'rpc-bx', 'BB Card',  'credit', false);
end $$;
create function pg_temp.tx(p_acct text, p_plaid text, p_amount numeric, p_date date, p_pending boolean default false,
                           p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override)
  values (pg_temp.acct(p_acct), p_plaid, p_amount, p_date, p_pending, p_pending_of, 'credit_card_payment') $$;
create function pg_temp.evaluate() returns void language sql as $$
  select public.evaluate_card_payments(pg_temp.aa()); select public.evaluate_card_payments(pg_temp.bb()); $$;

-- One RPC step: runs it (as the caller saw the current version), keeps the response by name, prints its status.
create temporary table res (scenario text, name text, r jsonb, primary key (scenario, name));
create function pg_temp.did(p_scenario text, p_name text) returns uuid language sql as $$
  select (r->>'decisionId')::uuid from pg_temp.res where scenario = p_scenario and name = p_name $$;
create function pg_temp.step(p_scenario text, p_name text, p_sql text) returns text language plpgsql as $$
declare
  v jsonb;
begin
  begin
    execute p_sql into v;
  exception when others then
    return 'S|' || p_scenario || '|' || p_name || '|refused:' || split_part(sqlerrm, ':', 1);
  end;
  insert into pg_temp.res values (p_scenario, p_name, v);
  return 'S|' || p_scenario || '|' || p_name || '|' || (v->>'status') || coalesce(':' || (v->>'reason'), '') || ':' || (v->>'matching');
end $$;
create function pg_temp.link(p_s text, p_c text, p_diff bigint) returns text language sql as $$
  select format('select public.link_card_payment(%L, %L, %L, %s, %s)', pg_temp.aa(), pg_temp.t(p_s), pg_temp.t(p_c), p_diff, pg_temp.v()) $$;
create function pg_temp.mark(p_s text) returns text language sql as $$
  select format('select public.mark_card_payment_destination(%L, %L, %s)', pg_temp.aa(), pg_temp.t(p_s), pg_temp.v()) $$;
create function pg_temp.dismiss(p_s text, p_c text) returns text language sql as $$
  select format('select public.dismiss_card_payment_candidate(%L, %L, %L, %s)', pg_temp.aa(), pg_temp.t(p_s), pg_temp.t(p_c), pg_temp.v()) $$;
create function pg_temp.undo(p_id uuid) returns text language sql as $$
  select format('select public.undo_card_payment_decision(%L, %L, %s)', pg_temp.aa(), p_id, pg_temp.v()) $$;

-- The reference evaluator's input, built from the database rows (every user's, as in export.cjs).
create function pg_temp.inputs(p_user uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'userId', p_user,
    'asOf', '2026-11-15T00:00:00Z',
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'userId', i.user_id, 'type', a.type,
                                                               'excludeFromCashFlow', a.exclude_from_cash_flow) order by a.id), '[]'::jsonb)
                 from public.accounts a join public.plaid_items i on i.id = a.item_id),
    'transactions', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'accountId', t.account_id,
                       'plaidTransactionId', t.plaid_transaction_id, 'pendingTransactionId', t.pending_transaction_id,
                       'pending', coalesce(t.pending, false), 'date', to_char(t.date, 'YYYY-MM-DD'),
                       'amountCents', (t.amount * 100)::bigint, 'effectiveRole', t.effective_role) order by t.id), '[]'::jsonb)
                     from public.transactions t),
    'carryovers', (select coalesce(jsonb_agg(jsonb_build_object('accountId', c.account_id,
                     'pendingPlaidTransactionId', c.pending_plaid_transaction_id,
                     'expiresAt', to_char(c.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                     'consumed', c.consumed_at is not null) order by c.pending_plaid_transaction_id), '[]'::jsonb)
                   from public.transaction_carryovers c),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'userId', d.user_id, 'kind', d.kind,
                    'a', jsonb_build_object('accountId', d.a_account_id, 'plaidTransactionId', d.a_plaid_transaction_id, 'cents', d.a_cents),
                    'b', case when d.b_account_id is null then null
                              else jsonb_build_object('accountId', d.b_account_id, 'plaidTransactionId', d.b_plaid_transaction_id, 'cents', d.b_cents) end,
                    'acceptedDifferenceCents', d.accepted_difference_cents, 'decidedSeq', d.decided_seq,
                    'supersededBy', d.superseded_by,
                    'counterpart', case when d.kind = 'pair_counterpart_removed'
                                        then jsonb_build_object('plaidTransactionId', d.b_plaid_transaction_id, 'cents', d.b_cents,
                                                                'status', d.counterpart_status) end,
                    'counterpartDate', to_char(d.counterpart_date, 'YYYY-MM-DD')) order by d.id), '[]'::jsonb)
                  from public.card_payment_decisions d))
$$;
create function pg_temp.dump(p_scenario text, p_expect jsonb) returns setof text language plpgsql as $$
begin
  perform public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z');
  perform public.evaluate_card_payments(pg_temp.bb(), '2026-11-15T00:00:00Z');
  return next 'I|' || p_scenario || '|' || pg_temp.aa() || '|' || pg_temp.inputs(pg_temp.aa())::text;
  return next 'R|' || p_scenario || '|' || pg_temp.aa() || '|' || public.get_card_payment_states(pg_temp.aa())::text;
  return next 'I|' || p_scenario || '|' || pg_temp.bb() || '|' || pg_temp.inputs(pg_temp.bb())::text;
  return next 'R|' || p_scenario || '|' || pg_temp.bb() || '|' || public.get_card_payment_states(pg_temp.bb())::text;
  return next 'E|' || p_scenario || '|' || p_expect::text;
end $$;
-- service_role (the RPC caller below) may use this session's temp schema implicitly; the result table needs a grant.
grant select, insert on pg_temp.res to service_role;

-- ==== Q1: replace a match, undo the replacement, confirm a destination, then match again; an older id is not undoable
-- bb holds a mirror-image tier 1 pair on the same days: never evidence for aa.
select pg_temp.reset();
select pg_temp.tx('C', 'q1-p', 100, '2026-09-01'), pg_temp.tx('X', 'q1-x', -100, '2026-09-20'), pg_temp.tx('Y', 'q1-y', -98, '2026-09-03'),
       pg_temp.tx('BC', 'q1-bp', 100, '2026-09-01'), pg_temp.tx('BX', 'q1-bk', -100, '2026-09-02');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q1', '1-link-x', pg_temp.link('q1-p', 'q1-x', 0));
select pg_temp.step('Q1', '2-link-y', pg_temp.link('q1-p', 'q1-y', 200));
select pg_temp.step('Q1', '3-undo-y', pg_temp.undo(pg_temp.did('Q1', '2-link-y')));
select pg_temp.step('Q1', '4-mark', pg_temp.mark('q1-p'));
select pg_temp.step('Q1', '5-link-x', pg_temp.link('q1-p', 'q1-x', 0));
select pg_temp.step('Q1', '6-undo-old', pg_temp.undo(pg_temp.did('Q1', '1-link-x')));
reset role;
select pg_temp.dump('Q1', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'saved:fresh', 'undone:fresh', 'saved:fresh', 'saved:fresh', 'refused:card_payment_decision_replaced'),
  'legs', jsonb_build_object('q1-p', 'tracked/user_pair', 'q1-x', 'paired/user_pair', 'q1-y', 'unresolved/no_candidate',
                             'q1-bp', 'tracked/auto_pair'),
  'liveDecisions', 1));

-- ==== Q2: a match saved on a pending row is replaced through its posted row
select pg_temp.reset();
select pg_temp.tx('C', 'q2-pc', 40, '2026-11-01', true), pg_temp.tx('X', 'q2-kx', -40, '2026-11-15'), pg_temp.tx('Y', 'q2-ky', -40, '2026-11-20');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q2', '1-link-pending', pg_temp.link('q2-pc', 'q2-kx', 0));
reset role;
select pg_temp.tx('C', 'q2-tc', 40, '2026-11-02', false, 'q2-pc');
delete from public.transactions where plaid_transaction_id = 'q2-pc';
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q2', '2-link-posted', pg_temp.link('q2-tc', 'q2-ky', 0));
reset role;
select pg_temp.dump('Q2', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'saved:fresh'),
  'legs', jsonb_build_object('q2-tc', 'tracked/user_pair', 'q2-ky', 'paired/user_pair', 'q2-kx', 'unresolved/no_candidate'),
  'liveDecisions', 1));

-- ==== Q3: two dismissals on one leg; a repeated dismissal is a no-op; confirming one dismissed pair supersedes
-- only that dismissal; a dismissal of the confirmed pair is refused; undoing the confirmation does not resurrect
-- the dismissal it replaced (the candidate is offered again)
select pg_temp.reset();
select pg_temp.tx('C', 'q3-d', 77, '2026-10-10'), pg_temp.tx('X', 'q3-dx', -77, '2026-10-20'), pg_temp.tx('Y', 'q3-dy', -77, '2026-10-25');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q3', '1-dismiss-x', pg_temp.dismiss('q3-d', 'q3-dx'));
select pg_temp.step('Q3', '2-dismiss-y', pg_temp.dismiss('q3-d', 'q3-dy'));
select pg_temp.step('Q3', '3-dismiss-y-again', pg_temp.dismiss('q3-dy', 'q3-d'));
select pg_temp.step('Q3', '4-link-x', pg_temp.link('q3-d', 'q3-dx', 0));
select pg_temp.step('Q3', '5-dismiss-confirmed', pg_temp.dismiss('q3-d', 'q3-dx'));
select pg_temp.step('Q3', '6-undo-link', pg_temp.undo(pg_temp.did('Q3', '4-link-x')));
reset role;
select pg_temp.dump('Q3', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'saved:fresh', 'unchanged:already_dismissed:fresh', 'saved:fresh',
                             'refused:card_payment_pair_confirmed', 'undone:fresh'),
  'legs', jsonb_build_object('q3-d', 'unresolved/possible_match'),
  'liveDecisions', 1));

-- ==== Q4: a destination confirmation contradicted by an excluded card's leg; dismissing it keeps the confirmation
select pg_temp.reset();
select pg_temp.tx('C', 'q4-c', 66, '2026-10-12'), pg_temp.tx('E', 'q4-e', -66, '2026-10-14');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q4', '1-mark', pg_temp.mark('q4-c'));
select pg_temp.step('Q4', '2-mark-again', pg_temp.mark('q4-c'));
select pg_temp.step('Q4', '3-dismiss-e', pg_temp.dismiss('q4-c', 'q4-e'));
reset role;
select pg_temp.dump('Q4', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'unchanged:already_confirmed:fresh', 'saved:fresh'),
  'legs', jsonb_build_object('q4-c', 'untracked/user_confirmed_unlinked', 'q4-e', 'not_counted/excluded_account'),
  'liveDecisions', 2));

-- ==== Q5: an invalidated confirmation protects its counterpart, and is corrected by re-matching with the new difference
select pg_temp.reset();
select pg_temp.tx('C', 'q5-a', 11, '2026-12-07'), pg_temp.tx('X', 'q5-ax', -11, '2026-12-20'), pg_temp.tx('C2', 'q5-a2', 11, '2026-12-31');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q5', '1-link', pg_temp.link('q5-a', 'q5-ax', 0));
reset role;
update public.transactions set amount = 12 where plaid_transaction_id = 'q5-a';
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q5', '2-take-counterpart', pg_temp.link('q5-a2', 'q5-ax', 0));
select pg_temp.step('Q5', '3-correct', pg_temp.link('q5-a', 'q5-ax', 100));
reset role;
select pg_temp.dump('Q5', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'refused:card_payment_counterpart_reserved', 'saved:fresh'),
  'legs', jsonb_build_object('q5-a', 'tracked/user_pair', 'q5-ax', 'paired/user_pair'),
  'liveDecisions', 1));

-- ==== Q6: a tie resolved by picking one payment; the other stays unresolved (never assumed unlinked)
select pg_temp.reset();
select pg_temp.tx('C', 'q6-c1', 400, '2026-09-01'), pg_temp.tx('C2', 'q6-c2', 400, '2026-09-03'), pg_temp.tx('X', 'q6-x', -400, '2026-09-02');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q6', '1-pick', pg_temp.link('q6-c1', 'q6-x', 0));
reset role;
select pg_temp.dump('Q6', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh'),
  'legs', jsonb_build_object('q6-c1', 'tracked/user_pair', 'q6-c2', 'unresolved/no_candidate'),
  'liveDecisions', 1));

-- ==== Q7: a return matched manually beyond the 60-day suggestion limit
select pg_temp.reset();
select pg_temp.tx('C', 'q7-p', 100, '2026-06-01'), pg_temp.tx('X', 'q7-k', -100, '2026-06-02'),
       pg_temp.tx('X', 'q7-rev', 100, '2026-07-10'), pg_temp.tx('C', 'q7-ret', -100, '2026-09-30');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q7', '1-link-return', pg_temp.link('q7-ret', 'q7-rev', 0));
reset role;
select pg_temp.dump('Q7', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh'),
  'legs', jsonb_build_object('q7-p', 'tracked/auto_pair', 'q7-ret', 'tracked/user_pair', 'q7-rev', 'paired/user_pair'),
  'liveDecisions', 1));

-- ==== Q8: a match whose pending leg was removed and is waiting to post, undone
select pg_temp.reset();
select pg_temp.tx('C', 'q8-pw', 33, '2026-10-01', true), pg_temp.tx('X', 'q8-wx', -33, '2026-10-10');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q8', '1-link', pg_temp.link('q8-pw', 'q8-wx', 0));
reset role;
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id, pending_amount,
                                           pending_date, needs_review, expires_at)
values (pg_temp.aa(), pg_temp.acct('C'), 'q8-pw', pg_temp.t('q8-pw'), 33, '2026-10-01', false, '2099-01-01T00:00:00Z');
delete from public.transactions where plaid_transaction_id = 'q8-pw';
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q8', '2-undo', pg_temp.undo(pg_temp.did('Q8', '1-link')));
select pg_temp.step('Q8', '3-undo-again', pg_temp.undo(pg_temp.did('Q8', '1-link')));
reset role;
select pg_temp.dump('Q8', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'undone:fresh', 'unchanged:already_undone:fresh'),
  'legs', jsonb_build_object('q8-wx', 'unresolved/no_candidate'),
  'liveDecisions', 0));

-- ---- Institution removal (20261006120000; design §4.7, T9) -------------------------------------------
-- The removal writes decisions: the SYSTEM record destination_removed_card for an automatic pair, the USER
-- decision pair_counterpart_removed for a confirmed one. The reference evaluator, run on exactly those
-- decisions and the rows the removal left, must equal the SQL states — and the states the removal itself
-- published must be the states of those final inputs.
create function pg_temp.card_r() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000a0c09'::uuid $$;
create function pg_temp.item_r() returns uuid language sql as $$ select '00000000-0000-4000-8000-00000000a002'::uuid $$;
-- A second institution of aa holding only card R (the one removed).
create function pg_temp.add_card_r() returns void language sql as $$
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values (pg_temp.item_r(), pg_temp.aa(), 'rpc-item-a2', 'placeholder');
  insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
    (pg_temp.card_r(), pg_temp.item_r(), 'rpc-r', 'Card R', 'credit', false);
$$;
create function pg_temp.txr(p_plaid text, p_amount numeric, p_date date) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
  values (pg_temp.card_r(), p_plaid, p_amount, p_date, 'credit_card_payment') $$;
-- The removal through its state machine, as one step line.
create function pg_temp.remove_r(p_scenario text, p_name text) returns text language plpgsql as $$
declare
  v jsonb;
begin
  perform public.begin_plaid_item_removal(pg_temp.aa(), pg_temp.item_r(), public.plaid_item_removal_digest(pg_temp.aa(), pg_temp.item_r()));
  perform public.record_plaid_item_removal_attempt(pg_temp.aa(), pg_temp.item_r(), 'removed', null);
  v := public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item_r());
  return 'S|' || p_scenario || '|' || p_name || '|' || case when (v->>'replayed')::boolean then 'replayed' else 'removed' end
         || case when coalesce((public.get_card_payment_states(pg_temp.aa())->>'fresh')::boolean, false) then ':fresh' else ':stale' end;
end $$;
-- A user's legs and decisions without the time-dependent `recent` label (the removal evaluates at now()).
create function pg_temp.timeless(p_states jsonb) returns jsonb language sql as $$
  select jsonb_build_object(
    'fresh', p_states->'fresh',
    'legs', (select coalesce(jsonb_agg(l - 'recent' order by l->>'transactionId'), '[]'::jsonb) from jsonb_array_elements(p_states->'legs') l),
    'decisions', p_states->'decisions', 'supersededTransactionIds', p_states->'supersededTransactionIds') $$;
create temporary table own (scenario text primary key, s jsonb);
grant select, insert on pg_temp.own to service_role;

-- ==== Q9: a removal preserves a tier 1 pair (system record), a user pair and a user pair with a difference
--      (the user's decisions, kept); an unresolved payment and a confirmed unlinked destination are left
--      alone; a pair with a card that stays is untouched
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q9-auto', 100, '2026-09-01'), pg_temp.txr('q9-r-auto', -100, '2026-09-02'),
       pg_temp.tx('C', 'q9-user', 250, '2026-09-01'), pg_temp.txr('q9-r-user', -250, '2026-09-15'),
       pg_temp.tx('C', 'q9-diff', 80, '2026-09-03'),  pg_temp.txr('q9-r-diff', -78, '2026-09-04'),
       pg_temp.tx('C', 'q9-open', 40, '2026-09-01'),  pg_temp.txr('q9-r-open', -40, '2026-09-25'),
       pg_temp.tx('C', 'q9-unl', 30, '2026-09-07'),
       pg_temp.tx('C', 'q9-kept', 500, '2026-09-09'), pg_temp.tx('X', 'q9-x', -500, '2026-09-10');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q9', '1-link', pg_temp.link('q9-user', 'q9-r-user', 0));
select pg_temp.step('Q9', '2-link-diff', pg_temp.link('q9-diff', 'q9-r-diff', 200));
select pg_temp.step('Q9', '3-mark', pg_temp.mark('q9-unl'));
select pg_temp.remove_r('Q9', '4-remove');
insert into pg_temp.own values ('Q9', public.get_card_payment_states(pg_temp.aa()));
reset role;
select pg_temp.dump('Q9', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'saved:fresh', 'saved:fresh', 'removed:fresh', 'own-states:same'),
  'legs', jsonb_build_object('q9-auto', 'untracked/removed_card', 'q9-user', 'untracked/removed_card', 'q9-diff', 'untracked/removed_card',
                             'q9-open', 'unresolved/no_candidate', 'q9-unl', 'untracked/user_confirmed_unlinked', 'q9-kept', 'tracked/auto_pair'),
  'liveDecisions', 4));
select 'S|Q9|5-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q9'))
                                             = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;

-- ==== Q10: after a removal, the bank corrects one preserved payment (its record is no longer proof) and the
--      card is linked again with new ids: a clear tier 1 match re-tracks, the records stay as history
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q10-a', 100, '2026-09-01'), pg_temp.txr('q10-r-a', -100, '2026-09-02'),
       pg_temp.tx('C', 'q10-b', 60, '2026-09-05'),  pg_temp.txr('q10-r-b', -60, '2026-09-06'),
       pg_temp.tx('C', 'q10-c', 70, '2026-09-08'),  pg_temp.txr('q10-r-c', -70, '2026-09-09');
select pg_temp.evaluate();
set role service_role;
select pg_temp.remove_r('Q10', '1-remove');
insert into pg_temp.own values ('Q10', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q10|2-own|own-states:' || case when (select count(*) from jsonb_array_elements((select s->'legs' from pg_temp.own where scenario = 'Q10')) l
                                                where l->>'reason' = 'removed_card') = 3 then 'three-preserved' else 'UNEXPECTED' end;
-- The bank corrects q10-b; the card comes back as a new institution, account and Plaid ids, re-importing a and c.
update public.transactions set amount = 58 where plaid_transaction_id = 'q10-b';
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('00000000-0000-4000-8000-00000000a003', pg_temp.aa(), 'rpc-item-a3', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-4000-8000-0000000a0c0a', '00000000-0000-4000-8000-00000000a003', 'rpc-r2', 'Card R (relinked)', 'credit', false);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-4000-8000-0000000a0c0a', 'q10-r2-a', -100, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-4000-8000-0000000a0c0a', 'q10-r2-b', -58, '2026-09-06', 'credit_card_payment');
select pg_temp.dump('Q10', jsonb_build_object(
  'steps', jsonb_build_array('removed:fresh', 'own-states:three-preserved'),
  'legs', jsonb_build_object('q10-a', 'tracked/auto_pair', 'q10-b', 'tracked/auto_pair', 'q10-c', 'untracked/removed_card'),
  'liveDecisions', 3));

-- ==== Q11: user-confirmed pairs through a removal, with a competing card (Y) or cash leg (C2) for each: an
--      active one, one waiting for its card leg, one whose card amount changed, and the mirror case (the CASH
--      account is on the removed institution, the card leg on Y survives). Then the card is linked again, and
--      the user re-matches one payment by hand: the newer decision supersedes the preserved one.
create function pg_temp.cash_r() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000a0c0b'::uuid $$;
select pg_temp.reset();
select pg_temp.add_card_r();
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  (pg_temp.cash_r(), pg_temp.item_r(), 'rpc-rc', 'Checking R', 'depository', false);
select pg_temp.tx('C', 'q11-act', 100, '2026-09-01'),  pg_temp.txr('q11-r-act', -100, '2026-09-02'),  pg_temp.tx('Y', 'q11-y-act', -100, '2026-09-03'),
       pg_temp.tx('C', 'q11-wait', 110, '2026-09-05'), pg_temp.tx('Y', 'q11-y-wait', -110, '2026-09-07'),
       pg_temp.tx('C', 'q11-chg', 120, '2026-09-09'),  pg_temp.txr('q11-r-chg', -120, '2026-09-10'),  pg_temp.tx('Y', 'q11-y-chg', -120, '2026-09-11'),
       pg_temp.tx('Y', 'q11-y-mir', -130, '2026-09-14'), pg_temp.tx('C2', 'q11-c2-mir', 130, '2026-09-16');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  (pg_temp.card_r(), 'q11-r-wait', -110, '2026-09-06', true, 'credit_card_payment'),
  (pg_temp.cash_r(), 'q11-rc-mir', 130, '2026-09-13', false, 'credit_card_payment');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q11', '1-link-active', pg_temp.link('q11-act', 'q11-r-act', 0));
select pg_temp.step('Q11', '2-link-waiting', pg_temp.link('q11-wait', 'q11-r-wait', 0));
select pg_temp.step('Q11', '3-link-changed', pg_temp.link('q11-chg', 'q11-r-chg', 0));
select pg_temp.step('Q11', '4-link-mirror', pg_temp.link('q11-rc-mir', 'q11-y-mir', 0));
-- The pending card leg is withdrawn by a sync (it is then waiting to post); the bank corrects another card leg.
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['q11-r-wait']) is not null as withdrawn;
update public.transactions set amount = -119 where plaid_transaction_id = 'q11-r-chg';
select pg_temp.remove_r('Q11', '5-remove');
insert into pg_temp.own values ('Q11', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q11|6-preserved|' || coalesce((select string_agg(d.a_plaid_transaction_id || '=' || d.counterpart_status, ',' order by d.a_plaid_transaction_id)
                                          from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.superseded_by is null), 'none')
       || ';system=' || (select count(*) from public.card_payment_decisions d where d.kind = 'destination_removed_card');
-- A standalone evaluation of the inputs the removal left, at the fixed time: it must equal what the removal published.
select public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z') is not null as evaluated;
select 'S|Q11|7-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q11'))
                                              = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;
-- The card comes back as a new institution with new ids; the user matches one payment with it by hand.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('00000000-0000-4000-8000-00000000a003', pg_temp.aa(), 'rpc-item-a3', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-4000-8000-0000000a0c0a', '00000000-0000-4000-8000-00000000a003', 'rpc-r2', 'Card R (relinked)', 'credit', false);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-4000-8000-0000000a0c0a', 'q11-r2-act', -100, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-4000-8000-0000000a0c0a', 'q11-r2-chg', -120, '2026-09-10', 'credit_card_payment'),
  ('00000000-0000-4000-8000-0000000a0c0a', 'q11-r2-wait', -110, '2026-09-06', 'credit_card_payment');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q11', '8-relink-rematch', pg_temp.link('q11-wait', 'q11-r2-wait', 0));
reset role;
select pg_temp.dump('Q11', jsonb_build_object(
  'steps', jsonb_build_array('saved:fresh', 'saved:fresh', 'saved:fresh', 'saved:fresh', 'removed:fresh',
                             'q11-act=valid,q11-chg=amount_changed,q11-wait=waiting_to_post,q11-y-mir=valid;system=0', 'own-states:same', 'saved:fresh'),
  'legs', jsonb_build_object(
    'q11-act', 'untracked/removed_card',          'q11-y-act', 'unresolved/no_candidate',   'q11-r2-act', 'unresolved/no_candidate',
    'q11-chg', 'unresolved/decision_invalidated', 'q11-y-chg', 'unresolved/no_candidate',   'q11-r2-chg', 'unresolved/no_candidate',
    'q11-wait', 'tracked/user_pair',              'q11-r2-wait', 'paired/user_pair',        'q11-y-wait', 'unresolved/no_candidate',
    'q11-y-mir', 'funded_from_excluded/removed_cash_account', 'q11-c2-mir', 'unresolved/no_candidate'),
  'liveDecisions', 4));

-- ==== Q12: an unresolved payment that a card of the removed institution and a kept card both fitted. The removal
--      is not evidence for the kept card: it writes a SYSTEM ambiguity hold — for a two-way tie, a three-way
--      one, and the mirror case (a card leg that a removed cash leg and a kept cash leg both fitted). A payment
--      whose kept card was strictly closer was paired before, and gets none. Then: the user cannot undo a hold;
--      the card is linked again (the tie is back by itself); the bank corrects the kept card's leg (the
--      re-imported leg pairs); a date change brings the mirror's kept cash leg strictly closer (it pairs); and
--      the user decides the three-way one.
create function pg_temp.sr(p_plaids text[]) returns text language sql as $$
  select string_agg(t.plaid_transaction_id || '=' || (l->>'state') || '/' || (l->>'reason'), ',' order by t.plaid_transaction_id collate "C")
  from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid
  where t.plaid_transaction_id = any (p_plaids) $$;
select pg_temp.reset();
select pg_temp.add_card_r();
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  (pg_temp.cash_r(), pg_temp.item_r(), 'rpc-rc', 'Checking R', 'depository', false);
select pg_temp.tx('C', 'q12-tie', 700, '2026-09-10'),   pg_temp.txr('q12-r-tie', -700, '2026-09-11'),   pg_temp.tx('Y', 'q12-y-tie', -700, '2026-09-11'),
       pg_temp.tx('C', 'q12-three', 710, '2026-09-10'), pg_temp.txr('q12-r-three', -710, '2026-09-11'), pg_temp.tx('X', 'q12-x-three', -710, '2026-09-11'),
                                                        pg_temp.tx('Y', 'q12-y-three', -710, '2026-09-11'),
       pg_temp.tx('C', 'q12-far', 720, '2026-09-10'),   pg_temp.txr('q12-r-far', -720, '2026-09-13'),   pg_temp.tx('Y', 'q12-y-far', -720, '2026-09-11'),
       pg_temp.tx('Y', 'q12-y-mir', -740, '2026-09-20'), pg_temp.tx('C2', 'q12-c2-mir', 740, '2026-09-21');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  (pg_temp.cash_r(), 'q12-rc-mir', 740, '2026-09-21', 'credit_card_payment');
select pg_temp.evaluate();
set role service_role;
select pg_temp.remove_r('Q12', '1-remove');
insert into pg_temp.own values ('Q12', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q12|2-holds|' || coalesce((select string_agg(d.kind || ':' || d.a_plaid_transaction_id || '+' || d.b_plaid_transaction_id || '@' || d.counterpart_date,
                                                       ',' order by d.b_plaid_transaction_id collate "C", d.a_plaid_transaction_id collate "C")
                                     from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' and d.superseded_by is null), 'none')
       || ';other=' || (select count(*) from public.card_payment_decisions d where d.kind not like 'ambiguity_hold_%');
-- A standalone evaluation of the inputs the removal left, at the fixed time: it must equal what the removal published.
select public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z') is not null as evaluated;
select 'S|Q12|3-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q12'))
                                              = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;
select 'S|Q12|4-after|' || pg_temp.sr(array['q12-tie', 'q12-three', 'q12-far', 'q12-y-mir', 'q12-c2-mir']);
-- A hold is not the user's to undo.
set role service_role;
select pg_temp.step('Q12', '5-undo-hold', pg_temp.undo((select d.id from public.card_payment_decisions d
                                                        where d.kind = 'ambiguity_hold_removed_card' and d.b_plaid_transaction_id = 'q12-tie')));
reset role;
-- The card comes back as a new institution with new ids: the tie is there again, by the ordinary rule.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('00000000-0000-4000-8000-00000000a003', pg_temp.aa(), 'rpc-item-a3', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-4000-8000-0000000a0c0a', '00000000-0000-4000-8000-00000000a003', 'rpc-r2', 'Card R (relinked)', 'credit', false);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-4000-8000-0000000a0c0a', 'q12-r2-tie', -700, '2026-09-11', 'credit_card_payment'),
  ('00000000-0000-4000-8000-0000000a0c0a', 'q12-r2-three', -710, '2026-09-11', 'credit_card_payment');
select pg_temp.evaluate();
select 'S|Q12|6-relinked|' || pg_temp.sr(array['q12-tie']);
-- New evidence: the bank corrects the kept card's leg of the tie; the mirror's kept cash leg is re-dated to the
-- card leg's own day (strictly closer than the removed candidate was).
update public.transactions set amount = -699 where plaid_transaction_id = 'q12-y-tie';
update public.transactions set date = '2026-09-20' where plaid_transaction_id = 'q12-c2-mir';
select pg_temp.evaluate();
-- The user decides the three-way one.
set role service_role;
select pg_temp.step('Q12', '7-link-three', pg_temp.link('q12-three', 'q12-x-three', 0));
reset role;
select pg_temp.dump('Q12', jsonb_build_object(
  'steps', jsonb_build_array('removed:fresh',
    'ambiguity_hold_removed_cash_account:q12-y-mir+q12-c2-mir@2026-09-21,ambiguity_hold_removed_card:q12-x-three+q12-three@2026-09-11,'
      || 'ambiguity_hold_removed_card:q12-y-three+q12-three@2026-09-11,ambiguity_hold_removed_card:q12-y-tie+q12-tie@2026-09-11;other=0',
    'own-states:same',
    'q12-c2-mir=unresolved/ambiguous,q12-far=tracked/auto_pair,q12-three=unresolved/ambiguous,q12-tie=unresolved/ambiguous,q12-y-mir=unresolved/ambiguous',
    'refused:card_payment_invalid', 'q12-tie=unresolved/ambiguous', 'saved:fresh'),
  'legs', jsonb_build_object(
    'q12-tie', 'tracked/auto_pair',     'q12-r2-tie', 'paired/auto_pair',     'q12-y-tie', 'unresolved/no_candidate',
    'q12-three', 'tracked/user_pair',   'q12-x-three', 'paired/user_pair',    'q12-y-three', 'unresolved/no_candidate', 'q12-r2-three', 'unresolved/no_candidate',
    'q12-far', 'tracked/auto_pair',
    'q12-y-mir', 'paired/auto_pair',    'q12-c2-mir', 'tracked/auto_pair'),
  'liveDecisions', 5));

-- ---- Revision 5 (2026-10-07): Q13–Q15 ---------------------------------------------------------------------
-- Each runs the real removal and states by hand, in its S lines, what a reader must see at every stage. A
-- checkpoint (CI / CR lines) inside a sequence makes compare_rpc.cjs require the reference evaluator, run on
-- the inputs as they are at that stage, to equal the SQL states there — not only at the end of the sequence.
--
-- Named legs of aa as a reader sees them now, by Plaid id:
--   <plaid>=<state>/<reason>/<effect>[<low>..<high>]/<detail>><partner's Plaid id>@<kind of the decision named on the leg>
-- ("-" for no detail, no partner, no decision).
create function pg_temp.srx(p_plaids text[]) returns text language sql as $$
  select coalesce(string_agg(
           t.plaid_transaction_id || '=' || (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null')
           || '[' || (l->>'lowCents') || '..' || (l->>'highCents') || ']/' || coalesce(l->>'detail', '-')
           || '>' || coalesce((select p.plaid_transaction_id from public.transactions p where p.id = (l->>'partnerTransactionId')::uuid), '-')
           || '@' || coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid), '-'),
           ',' order by t.plaid_transaction_id collate "C"), 'NO FRESH STATES')
  from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid
  where t.plaid_transaction_id = any (p_plaids) $$;
-- aa's live decisions as the evaluator reports them: <kind>:<leg a's Plaid id>=<status>[/<detail>], by leg a.
create function pg_temp.dst() returns text language sql as $$
  select coalesce(string_agg(d.kind || ':' || d.a_plaid_transaction_id || '=' || (s->>'status') || coalesce('/' || (s->>'detail'), ''),
                             ',' order by d.a_plaid_transaction_id collate "C", d.kind), 'none')
  from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'decisions') s
  join public.card_payment_decisions d on d.id = (s->>'decisionId')::uuid
  where d.superseded_by is null $$;
-- A checkpoint inside a sequence: both users evaluated at the fixed time, their inputs and their SQL states.
create function pg_temp.checkpoint(p_scenario text, p_stage text) returns setof text language plpgsql as $$
begin
  perform public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z');
  perform public.evaluate_card_payments(pg_temp.bb(), '2026-11-15T00:00:00Z');
  return next 'CI|' || p_scenario || '|' || p_stage || '|' || pg_temp.aa() || '|' || pg_temp.inputs(pg_temp.aa())::text;
  return next 'CR|' || p_scenario || '|' || p_stage || '|' || pg_temp.aa() || '|' || public.get_card_payment_states(pg_temp.aa())::text;
  return next 'CI|' || p_scenario || '|' || p_stage || '|' || pg_temp.bb() || '|' || pg_temp.inputs(pg_temp.bb())::text;
  return next 'CR|' || p_scenario || '|' || p_stage || '|' || pg_temp.bb() || '|' || public.get_card_payment_states(pg_temp.bb())::text;
end $$;

-- ==== Q13 (P1, the audit's counterexample): a kept payment (C, +100), a payment of the same amount on a checking
--      account of the removed institution, and a kept EXCLUDED card's leg (E, −100), all on one day; aa's two
--      included cards have no legs. The excluded card leg is tied between the two payments; it is published
--      not_counted, with no candidate list — and it is the OWNER of the ambiguity. The removal must not turn
--      the kept payment into "paid to the excluded card": exactly one hold, of the removed-CASH kind, on (the
--      excluded card leg, the kept payment). Then the user confirms that very pair (their decision decides:
--      untracked / partner_excluded), and undoes it (withheld again, as before they decided).
select pg_temp.reset();
select pg_temp.add_card_r();
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  (pg_temp.cash_r(), pg_temp.item_r(), 'rpc-rc', 'Checking R', 'depository', false);
select pg_temp.tx('C', 'q13-k', 100, '2026-09-10'), pg_temp.tx('E', 'q13-e', -100, '2026-09-10');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  (pg_temp.cash_r(), 'q13-rc', 100, '2026-09-10', 'credit_card_payment');
select pg_temp.evaluate();
select 'S|Q13|1-before|' || pg_temp.srx(array['q13-k', 'q13-rc', 'q13-e']);
set role service_role;
select pg_temp.remove_r('Q13', '2-remove');
insert into pg_temp.own values ('Q13', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q13|3-decisions|' || coalesce((select string_agg(d.kind || ':' || d.a_plaid_transaction_id || '+' || d.b_plaid_transaction_id || '@' || d.counterpart_date,
                                                           ',' order by d.b_plaid_transaction_id collate "C", d.a_plaid_transaction_id collate "C")
                                         from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' and d.superseded_by is null), 'none')
       || ';other=' || (select count(*) from public.card_payment_decisions d where d.kind not like 'ambiguity_hold_%');
-- A standalone evaluation of the inputs the removal left, at the fixed time: it must equal what the removal published.
select public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z') is not null as evaluated;
select 'S|Q13|4-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q13'))
                                              = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;
select 'S|Q13|5-after|' || pg_temp.srx(array['q13-k', 'q13-e']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q13', 'after-removal');
-- The user confirms the payment with the excluded card: their decision decides, the hold is left in place.
set role service_role;
select pg_temp.step('Q13', '6-link-excluded', pg_temp.link('q13-k', 'q13-e', 0));
reset role;
select 'S|Q13|7-linked|' || pg_temp.srx(array['q13-k', 'q13-e']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q13', 'linked');
-- ... and undoes it: the pair is withheld again.
set role service_role;
select pg_temp.step('Q13', '8-undo', pg_temp.undo(pg_temp.did('Q13', '6-link-excluded')));
reset role;
select 'S|Q13|9-undone|' || pg_temp.srx(array['q13-k', 'q13-e']) || ';' || pg_temp.dst();
select pg_temp.dump('Q13', jsonb_build_object(
  'steps', jsonb_build_array(
    'q13-e=not_counted/excluded_account/0[0..0]/->-@-,q13-k=unresolved/ambiguous/null[-10000..0]/->-@-,q13-rc=unresolved/ambiguous/null[-10000..0]/->-@-',
    'removed:fresh',
    'ambiguity_hold_removed_cash_account:q13-e+q13-k@2026-09-10;other=0',
    'own-states:same',
    'q13-e=not_counted/excluded_account/0[0..0]/->-@-,q13-k=unresolved/ambiguous/null[-10000..0]/->-@-;ambiguity_hold_removed_cash_account:q13-e=active',
    'saved:fresh',
    'q13-e=not_counted/excluded_account/0[0..0]/->q13-k@pair,q13-k=untracked/partner_excluded/-10000[-10000..-10000]/->q13-e@pair;'
      || 'ambiguity_hold_removed_cash_account:q13-e=active,pair:q13-k=active',
    'undone:fresh',
    'q13-e=not_counted/excluded_account/0[0..0]/->-@-,q13-k=unresolved/ambiguous/null[-10000..0]/->-@-;ambiguity_hold_removed_cash_account:q13-e=active'),
  'checkpoints', jsonb_build_array('after-removal', 'linked'),
  'legs', jsonb_build_object('q13-k', 'unresolved/ambiguous', 'q13-e', 'not_counted/excluded_account'),
  'liveDecisions', 1));

-- ==== Q14 (P2): two confirmed pairs with the card of the removed institution, which is aa's ONLY card. The pending
--      card leg of the first gets two conflicting posted replacements before the removal (frozen
--      lineage_ambiguous); the second is active at the removal (frozen valid). Afterwards aa has no card at all.
--      Then the bank corrects both surviving payments by −2.00: the first stays reserved and unresolved with its
--      frozen reason (revision 4 read it untracked / no_included_card); for the second an amount is the only
--      thing wrong, so the known-effect exception applies. Then both amounts are restored: the first is
--      unchanged, the second is active again (untracked / removed_card).
select pg_temp.reset();
delete from public.accounts where id in (pg_temp.acct('X'), pg_temp.acct('Y'), pg_temp.acct('E'));
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q14-la', 100, '2026-09-01'),
       pg_temp.tx('C', 'q14-va', 200, '2026-09-05'), pg_temp.txr('q14-r-va', -200, '2026-09-06');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  (pg_temp.card_r(), 'q14-r-la', -100, '2026-09-02', true, 'credit_card_payment');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q14', '1-link-pending', pg_temp.link('q14-la', 'q14-r-la', 0));
select pg_temp.step('Q14', '2-link-posted', pg_temp.link('q14-va', 'q14-r-va', 0));
reset role;
-- Two posted rows name the confirmed pending card leg.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override) values
  (pg_temp.card_r(), 'q14-r-la-p1', -100, '2026-09-02', false, 'q14-r-la', 'credit_card_payment'),
  (pg_temp.card_r(), 'q14-r-la-p2', -100, '2026-09-03', false, 'q14-r-la', 'credit_card_payment');
select pg_temp.evaluate();
select 'S|Q14|3-before|' || pg_temp.srx(array['q14-la', 'q14-va']) || ';' || pg_temp.dst();
set role service_role;
select pg_temp.remove_r('Q14', '4-remove');
insert into pg_temp.own values ('Q14', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q14|5-preserved|' || coalesce((select string_agg(d.a_plaid_transaction_id || '=' || d.counterpart_status, ',' order by d.a_plaid_transaction_id)
                                          from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.superseded_by is null), 'none')
       || ';other=' || (select count(*) from public.card_payment_decisions d where d.kind <> 'pair_counterpart_removed')
       || ';cards=' || (select count(*) from public.accounts a join public.plaid_items i on i.id = a.item_id where i.user_id = pg_temp.aa() and a.type = 'credit');
select public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z') is not null as evaluated;
select 'S|Q14|6-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q14'))
                                              = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;
select 'S|Q14|7-after|' || pg_temp.srx(array['q14-la', 'q14-va']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q14', 'after-removal');
-- The bank corrects both surviving payments by −2.00.
update public.transactions set amount = amount - 2 where plaid_transaction_id in ('q14-la', 'q14-va');
select pg_temp.evaluate();
select 'S|Q14|8-corrected|' || pg_temp.srx(array['q14-la', 'q14-va']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q14', 'corrected');
-- ... and restores both amounts.
update public.transactions set amount = amount + 2 where plaid_transaction_id in ('q14-la', 'q14-va');
select pg_temp.evaluate();
select 'S|Q14|9-restored|' || pg_temp.srx(array['q14-la', 'q14-va']) || ';' || pg_temp.dst();
select pg_temp.dump('Q14', jsonb_build_object(
  'steps', jsonb_build_array(
    'saved:fresh', 'saved:fresh',
    'q14-la=unresolved/decision_invalidated/null[-10000..0]/lineage_ambiguous>-@pair,q14-va=tracked/user_pair/0[0..0]/->q14-r-va@pair;'
      || 'pair:q14-la=inactive/lineage_ambiguous,pair:q14-va=active',
    'removed:fresh',
    'q14-la=lineage_ambiguous,q14-va=valid;other=0;cards=0',
    'own-states:same',
    'q14-la=unresolved/decision_invalidated/null[-10000..0]/lineage_ambiguous>-@pair_counterpart_removed,'
      || 'q14-va=untracked/removed_card/-20000[-20000..-20000]/->-@pair_counterpart_removed;'
      || 'pair_counterpart_removed:q14-la=inactive/lineage_ambiguous,pair_counterpart_removed:q14-va=active',
    'q14-la=unresolved/decision_invalidated/null[-9800..0]/lineage_ambiguous>-@pair_counterpart_removed,'
      || 'q14-va=untracked/no_included_card/-19800[-19800..-19800]/amount_changed>-@pair_counterpart_removed;'
      || 'pair_counterpart_removed:q14-la=inactive/lineage_ambiguous,pair_counterpart_removed:q14-va=inactive/amount_changed',
    'q14-la=unresolved/decision_invalidated/null[-10000..0]/lineage_ambiguous>-@pair_counterpart_removed,'
      || 'q14-va=untracked/removed_card/-20000[-20000..-20000]/->-@pair_counterpart_removed;'
      || 'pair_counterpart_removed:q14-la=inactive/lineage_ambiguous,pair_counterpart_removed:q14-va=active'),
  'checkpoints', jsonb_build_array('after-removal', 'corrected'),
  'legs', jsonb_build_object('q14-la', 'unresolved/decision_invalidated', 'q14-va', 'untracked/removed_card'),
  'liveDecisions', 2));

-- ==== Q15 (Option B): two payments, each matched AUTOMATICALLY to a leg of the removed card one day away, while a
--      kept card's leg three days away also fitted. The removal keeps each payment's known destination (the
--      SYSTEM record) and writes a hold on (the kept card's leg, the payment) with the removed leg's date: the
--      card that was already there does not take the payment merely because the destination disappeared. Then,
--      for the first payment, a NEW and strictly closer leg arrives on another kept card: new evidence, paired
--      by the ordinary rule. For the second, the removed card is linked again (a new item, account and ids; the
--      same date and amount): the re-imported leg is the closest candidate again, and pairs.
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q15-k', 300, '2026-09-10'),  pg_temp.txr('q15-r-k', -300, '2026-09-11'),  pg_temp.tx('Y', 'q15-b', -300, '2026-09-13'),
       pg_temp.tx('C', 'q15-k2', 310, '2026-09-10'), pg_temp.txr('q15-r-k2', -310, '2026-09-11'), pg_temp.tx('Y', 'q15-b2', -310, '2026-09-13');
select pg_temp.evaluate();
select 'S|Q15|1-before|' || pg_temp.srx(array['q15-k', 'q15-b', 'q15-k2', 'q15-b2']);
set role service_role;
select pg_temp.remove_r('Q15', '2-remove');
insert into pg_temp.own values ('Q15', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q15|3-decisions|' || coalesce((select string_agg(d.kind || ':' || d.a_plaid_transaction_id || '+' || d.b_plaid_transaction_id || '@' || d.counterpart_date,
                                                           ',' order by d.b_plaid_transaction_id collate "C", d.a_plaid_transaction_id collate "C")
                                         from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' and d.superseded_by is null), 'none')
       || ';records=' || coalesce((select string_agg(d.a_plaid_transaction_id || ':' || d.a_cents, ',' order by d.a_plaid_transaction_id collate "C")
                                   from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.superseded_by is null), 'none')
       || ';other=' || (select count(*) from public.card_payment_decisions d where d.kind not like 'ambiguity_hold_%' and d.kind <> 'destination_removed_card');
select public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z') is not null as evaluated;
select 'S|Q15|4-own|own-states:' || case when pg_temp.timeless((select s from pg_temp.own where scenario = 'Q15'))
                                              = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa())) then 'same' else 'DIFFERENT' end;
select 'S|Q15|5-after|' || pg_temp.srx(array['q15-k', 'q15-b', 'q15-k2', 'q15-b2']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q15', 'after-removal');
-- New evidence for the first payment: a leg on another kept card, on the payment's own day.
select pg_temp.tx('X', 'q15-z', -300, '2026-09-10');
select pg_temp.evaluate();
select 'S|Q15|6-new-leg|' || pg_temp.srx(array['q15-k', 'q15-z', 'q15-b']);
select pg_temp.checkpoint('Q15', 'new-leg');
-- The removed card comes back as a new institution with new ids, re-importing the second payment's leg.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('00000000-0000-4000-8000-00000000a003', pg_temp.aa(), 'rpc-item-a3', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-4000-8000-0000000a0c0a', '00000000-0000-4000-8000-00000000a003', 'rpc-r2', 'Card R (relinked)', 'credit', false);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-4000-8000-0000000a0c0a', 'q15-r2-k2', -310, '2026-09-11', 'credit_card_payment');
select pg_temp.evaluate();
select 'S|Q15|7-relinked|' || pg_temp.srx(array['q15-k2', 'q15-r2-k2', 'q15-b2']) || ';' || pg_temp.dst();
select pg_temp.dump('Q15', jsonb_build_object(
  'steps', jsonb_build_array(
    'q15-b=unresolved/ambiguous/0[0..0]/->-@-,q15-b2=unresolved/ambiguous/0[0..0]/->-@-,'
      || 'q15-k=tracked/auto_pair/0[0..0]/->q15-r-k@-,q15-k2=tracked/auto_pair/0[0..0]/->q15-r-k2@-',
    'removed:fresh',
    'ambiguity_hold_removed_card:q15-b+q15-k@2026-09-11,ambiguity_hold_removed_card:q15-b2+q15-k2@2026-09-11;records=q15-k:30000,q15-k2:31000;other=0',
    'own-states:same',
    'q15-b=unresolved/ambiguous/0[0..0]/->-@-,q15-b2=unresolved/ambiguous/0[0..0]/->-@-,'
      || 'q15-k=untracked/removed_card/-30000[-30000..-30000]/->-@destination_removed_card,'
      || 'q15-k2=untracked/removed_card/-31000[-31000..-31000]/->-@destination_removed_card;'
      || 'ambiguity_hold_removed_card:q15-b=active,ambiguity_hold_removed_card:q15-b2=active,'
      || 'destination_removed_card:q15-k=active,destination_removed_card:q15-k2=active',
    'q15-b=unresolved/ambiguous/0[0..0]/->-@-,q15-k=tracked/auto_pair/0[0..0]/->q15-z@-,q15-z=paired/auto_pair/0[0..0]/->q15-k@-',
    'q15-b2=unresolved/ambiguous/0[0..0]/->-@-,q15-k2=tracked/auto_pair/0[0..0]/->q15-r2-k2@-,q15-r2-k2=paired/auto_pair/0[0..0]/->q15-k2@-;'
      || 'ambiguity_hold_removed_card:q15-b=active,ambiguity_hold_removed_card:q15-b2=active,'
      || 'destination_removed_card:q15-k=active,destination_removed_card:q15-k2=active'),
  'checkpoints', jsonb_build_array('after-removal', 'new-leg'),
  'legs', jsonb_build_object(
    'q15-k', 'tracked/auto_pair',  'q15-z', 'paired/auto_pair',     'q15-b', 'unresolved/ambiguous',
    'q15-k2', 'tracked/auto_pair', 'q15-r2-k2', 'paired/auto_pair', 'q15-b2', 'unresolved/ambiguous'),
  'liveDecisions', 4));

-- ---- One system row per source (20261008120000): Q16–Q19 ----------------------------------------------------
-- The removal writes one hold for each removed candidate and one record for each removed partner, and never
-- reuses a row that an earlier removal wrote. Rows that differ in nothing but their id are then routine, and
-- nothing a reader is shown may change with their number. Each sequence runs the real removal(s) and states by
-- hand, in its S lines: what a reader must see at every stage; every row the removals left, with the removed
-- transaction its provenance row names (which removal, which removed account, which transaction); and the
-- removals in the user's order. At every checkpoint and at the end compare_rpc.cjs requires the reference
-- evaluator, run on exactly those rows, to equal the SQL states — and, where the E line says how many rows
-- share a key (`sameKeyRows`), that every one of them reached it.
create function pg_temp.item_r2() returns uuid language sql as $$ select '00000000-0000-4000-8000-00000000a003'::uuid $$;
create function pg_temp.card_r2() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000a0c0a'::uuid $$;
create function pg_temp.item_s() returns uuid language sql as $$ select '00000000-0000-4000-8000-00000000a004'::uuid $$;
create function pg_temp.card_s() returns uuid language sql as $$ select '00000000-0000-4000-8000-0000000a0c0c'::uuid $$;
-- Card R linked again: a new institution, a new account and new Plaid ids.
create function pg_temp.relink_card_r() returns void language sql as $$
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values (pg_temp.item_r2(), pg_temp.aa(), 'rpc-item-a3', 'placeholder');
  insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
    (pg_temp.card_r2(), pg_temp.item_r2(), 'rpc-r2', 'Card R (relinked)', 'credit', false);
$$;
-- Another institution of aa holding only card S.
create function pg_temp.add_card_s() returns void language sql as $$
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values (pg_temp.item_s(), pg_temp.aa(), 'rpc-item-a4', 'placeholder');
  insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
    (pg_temp.card_s(), pg_temp.item_s(), 'rpc-s', 'Card S', 'credit', false);
$$;
-- A card leg on an account given by its id.
create function pg_temp.txa(p_account uuid, p_plaid text, p_amount numeric, p_date date, p_pending boolean default false) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, user_role_override)
  values (p_account, p_plaid, p_amount, p_date, p_pending, 'credit_card_payment') $$;
-- The removal of one of aa's items through its state machine, as one step line (remove_r, for any item).
create function pg_temp.remove_item(p_scenario text, p_name text, p_item uuid) returns text language plpgsql as $$
declare
  v jsonb;
begin
  perform public.begin_plaid_item_removal(pg_temp.aa(), p_item, public.plaid_item_removal_digest(pg_temp.aa(), p_item));
  perform public.record_plaid_item_removal_attempt(pg_temp.aa(), p_item, 'removed', null);
  v := public.remove_plaid_item_local(pg_temp.aa(), p_item);
  return 'S|' || p_scenario || '|' || p_name || '|' || case when (v->>'replayed')::boolean then 'replayed' else 'removed' end
         || case when coalesce((public.get_card_payment_states(pg_temp.aa())->>'fresh')::boolean, false) then ':fresh' else ':stale' end;
end $$;
-- A standalone evaluation of the inputs a removal left, at the fixed time: it must equal what that removal
-- published (kept in pg_temp.own under p_key), the time-dependent label aside.
create function pg_temp.own_states(p_scenario text, p_name text, p_key text) returns text language plpgsql as $$
begin
  perform public.evaluate_card_payments(pg_temp.aa(), '2026-11-15T00:00:00Z');
  return 'S|' || p_scenario || '|' || p_name || '|own-states:'
         || case when pg_temp.timeless((select s from pg_temp.own where scenario = p_key)) = pg_temp.timeless(public.get_card_payment_states(pg_temp.aa()))
                 then 'same' else 'DIFFERENT' end;
end $$;
-- A question about the provenance tables, answered as text. Where they do not exist — a run with
-- EXCLUDE=20261008120000_card_payment_removal_provenance.sql, against the removal that merges — the answer is
-- NO PROVENANCE TABLES, so that such a run reaches its verdict and shows what else differs there.
create function pg_temp.pv(p_sql text) returns text language plpgsql as $$
declare
  v text;
begin
  if to_regclass('public.card_payment_removal_sources') is null or to_regclass('public.card_payment_removal_generations') is null then
    return 'NO PROVENANCE TABLES';
  end if;
  execute p_sql into v;
  return v;
end $$;
-- aa's live decisions that a removal wrote, each with the source its provenance row names, sorted:
--   <kind>:<leg a's Plaid id>[+<leg b's>][@<removed candidate's date>]<=<removed item's Plaid id>:<removed account's
--   Plaid id>:<removed transaction's Plaid id>[<relation>/<resolution>]
-- (hold_… for ambiguity_hold_…, record for destination_removed_card; "-" for the transaction when the source had
-- no single row; NO SOURCE when the decision has no provenance row). Rows that differ in nothing but their id
-- and their source are separate entries.
create function pg_temp.src() returns text language sql as $$
  select pg_temp.pv($q$
    select coalesce(string_agg(q.x, ',' order by q.x collate "C"), 'none')
    from (select replace(replace(d.kind, 'ambiguity_hold_', 'hold_'), 'destination_removed_card', 'record') || ':' || d.a_plaid_transaction_id
                 || case when d.b_account_id is not null then '+' || d.b_plaid_transaction_id else '' end
                 || coalesce('@' || d.counterpart_date, '') || '<='
                 || coalesce(r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || coalesce(s.source_plaid_transaction_id, '-')
                             || '[' || s.source_relation || '/' || s.source_resolution || ']', 'NO SOURCE') as x
          from public.card_payment_decisions d
          left join public.card_payment_removal_sources s on s.decision_id = d.id
          left join public.plaid_item_removals r on r.id = s.removal_id
          where d.user_id = pg_temp.aa() and d.superseded_by is null
            and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) q $q$) $$;
-- aa's removals as the provenance knows them, in the user's order: <ordinal>:<removed item's Plaid id>:<recorded|marker>.
create function pg_temp.gens() returns text language sql as $$
  select pg_temp.pv($q$
    select coalesce(string_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end, ',' order by g.ordinal), 'none')
    from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
    where g.user_id = pg_temp.aa() $q$) $$;
-- Which of the live records on a payment's own Plaid id its state names: "least-of-<n>" when it is the one with
-- the least id of the n. (The ids are random: which removal wrote the least one differs from run to run.)
create function pg_temp.named_record(p_plaid text) returns text language sql as $$
  select coalesce((
    select case when (l->>'decisionId')::uuid = (select d.id from public.card_payment_decisions d
                                               where d.user_id = pg_temp.aa() and d.kind = 'destination_removed_card' and d.superseded_by is null
                                                 and d.a_plaid_transaction_id = p_plaid
                                               order by d.id limit 1)
                then 'least' else 'NOT-THE-LEAST' end
    from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'legs') l
    join public.transactions t on t.id = (l->>'transactionId')::uuid
    where t.plaid_transaction_id = p_plaid), 'NO-LEG')
    || '-of-' || (select count(*) from public.card_payment_decisions d
                  where d.user_id = pg_temp.aa() and d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid) $$;

-- ==== Q16: TWO REMOVALS, one pair, one date. A payment (C, 09-10) that three cards' legs fit equally, all dated
--      09-11: card R (the institution removed first), card S (another institution, removed second) and the kept
--      card Y. A three-way tie: unresolved before, and after each removal. The first removal writes a hold on each
--      of the two pairs that are left, (S's leg, the payment) and (Y's leg, the payment), both because of R's leg.
--      The second deletes the first of them with card S and writes its OWN hold on (Y's leg, the payment), because
--      of S's leg — although a live hold with that pair and that date exists. The pair then has two live holds
--      that differ in nothing but their id, each naming its own removal's leg. They withhold as one: the payment
--      is unresolved, a range, with the kept card's leg as its candidate.
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.add_card_s();
select pg_temp.tx('C', 'q16-k', 500, '2026-09-10'), pg_temp.txr('q16-r', -500, '2026-09-11'),
       pg_temp.txa(pg_temp.card_s(), 'q16-s', -500, '2026-09-11'), pg_temp.tx('Y', 'q16-y', -500, '2026-09-11');
select pg_temp.evaluate();
select 'S|Q16|1-before|' || pg_temp.srx(array['q16-k', 'q16-r', 'q16-s', 'q16-y']);
set role service_role;
select pg_temp.remove_item('Q16', '2-remove-r', pg_temp.item_r());
insert into pg_temp.own values ('Q16/r', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q16|3-rows|' || pg_temp.src() || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q16', '4-own', 'Q16/r');
select 'S|Q16|5-after-r|' || pg_temp.srx(array['q16-k', 'q16-s', 'q16-y']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q16', 'after-first-removal');
set role service_role;
select pg_temp.remove_item('Q16', '6-remove-s', pg_temp.item_s());
insert into pg_temp.own values ('Q16/s', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q16|7-rows|' || pg_temp.src() || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q16', '8-own', 'Q16/s');
select 'S|Q16|9-after-s|' || pg_temp.srx(array['q16-k', 'q16-y']) || ';' || pg_temp.dst();
select pg_temp.dump('Q16', jsonb_build_object(
  'steps', jsonb_build_array(
    'q16-k=unresolved/ambiguous/null[-50000..0]/->-@-,q16-r=unresolved/ambiguous/0[0..0]/->-@-,'
      || 'q16-s=unresolved/ambiguous/0[0..0]/->-@-,q16-y=unresolved/ambiguous/0[0..0]/->-@-',
    'removed:fresh',
    'hold_removed_card:q16-s+q16-k@2026-09-11<=rpc-item-a2:rpc-r:q16-r[removed_candidate/row],'
      || 'hold_removed_card:q16-y+q16-k@2026-09-11<=rpc-item-a2:rpc-r:q16-r[removed_candidate/row];removals=1:rpc-item-a2:recorded',
    'own-states:same',
    'q16-k=unresolved/ambiguous/null[-50000..0]/->-@-,q16-s=unresolved/ambiguous/0[0..0]/->-@-,q16-y=unresolved/ambiguous/0[0..0]/->-@-;'
      || 'ambiguity_hold_removed_card:q16-s=active,ambiguity_hold_removed_card:q16-y=active',
    'removed:fresh',
    'hold_removed_card:q16-y+q16-k@2026-09-11<=rpc-item-a2:rpc-r:q16-r[removed_candidate/row],'
      || 'hold_removed_card:q16-y+q16-k@2026-09-11<=rpc-item-a4:rpc-s:q16-s[removed_candidate/row];'
      || 'removals=1:rpc-item-a2:recorded,2:rpc-item-a4:recorded',
    'own-states:same',
    'q16-k=unresolved/ambiguous/null[-50000..0]/->-@-,q16-y=unresolved/ambiguous/0[0..0]/->-@-;'
      || 'ambiguity_hold_removed_card:q16-y=active,ambiguity_hold_removed_card:q16-y=active'),
  'checkpoints', jsonb_build_array('after-first-removal'),
  'legs', jsonb_build_object('q16-k', 'unresolved/ambiguous', 'q16-y', 'unresolved/ambiguous'),
  'liveDecisions', 2,
  'sameKeyRows', jsonb_build_object('ambiguity_hold_removed_card:q16-y+q16-k@2026-09-11', 2)));

-- ==== Q17: TWO IDENTICAL REMOVED TRANSACTIONS in one removal. Two legs on the removed card with one amount and one
--      date (09-11), a payment (C, 09-10) that both fit, and the kept card's leg (Y, 09-12), which fits less well.
--      The two tie: the payment is unresolved before. The removal writes TWO holds on (Y's leg, the payment) dated
--      09-11, one for each removed leg, each naming its own transaction — the same account, amount and date.
--      They withhold as one (1 day against 2). Then the kept card's leg is re-dated to the payment's own day:
--      strictly closer than either removed leg was, so neither hold withholds and the pair forms. Re-dated back,
--      it is withheld again, by both.
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q17-k', 510, '2026-09-10'), pg_temp.txr('q17-r1', -510, '2026-09-11'), pg_temp.txr('q17-r2', -510, '2026-09-11'),
       pg_temp.tx('Y', 'q17-y', -510, '2026-09-12');
select pg_temp.evaluate();
select 'S|Q17|1-before|' || pg_temp.srx(array['q17-k', 'q17-r1', 'q17-r2', 'q17-y']);
set role service_role;
select pg_temp.remove_item('Q17', '2-remove', pg_temp.item_r());
insert into pg_temp.own values ('Q17', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q17|3-rows|' || pg_temp.src() || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q17', '4-own', 'Q17');
select 'S|Q17|5-after|' || pg_temp.srx(array['q17-k', 'q17-y']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q17', 'after-removal');
update public.transactions set date = '2026-09-10' where plaid_transaction_id = 'q17-y';
select pg_temp.evaluate();
select 'S|Q17|6-closer|' || pg_temp.srx(array['q17-k', 'q17-y']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q17', 'closer');
update public.transactions set date = '2026-09-12' where plaid_transaction_id = 'q17-y';
select pg_temp.evaluate();
select 'S|Q17|7-back|' || pg_temp.srx(array['q17-k', 'q17-y']) || ';' || pg_temp.dst();
select pg_temp.dump('Q17', jsonb_build_object(
  'steps', jsonb_build_array(
    'q17-k=unresolved/ambiguous/null[-51000..0]/->-@-,q17-r1=unresolved/ambiguous/0[0..0]/->-@-,'
      || 'q17-r2=unresolved/ambiguous/0[0..0]/->-@-,q17-y=unresolved/ambiguous/0[0..0]/->-@-',
    'removed:fresh',
    'hold_removed_card:q17-y+q17-k@2026-09-11<=rpc-item-a2:rpc-r:q17-r1[removed_candidate/row],'
      || 'hold_removed_card:q17-y+q17-k@2026-09-11<=rpc-item-a2:rpc-r:q17-r2[removed_candidate/row];removals=1:rpc-item-a2:recorded',
    'own-states:same',
    'q17-k=unresolved/ambiguous/null[-51000..0]/->-@-,q17-y=unresolved/ambiguous/0[0..0]/->-@-;'
      || 'ambiguity_hold_removed_card:q17-y=active,ambiguity_hold_removed_card:q17-y=active',
    'q17-k=tracked/auto_pair/0[0..0]/->q17-y@-,q17-y=paired/auto_pair/0[0..0]/->q17-k@-;'
      || 'ambiguity_hold_removed_card:q17-y=active,ambiguity_hold_removed_card:q17-y=active',
    'q17-k=unresolved/ambiguous/null[-51000..0]/->-@-,q17-y=unresolved/ambiguous/0[0..0]/->-@-;'
      || 'ambiguity_hold_removed_card:q17-y=active,ambiguity_hold_removed_card:q17-y=active'),
  'checkpoints', jsonb_build_array('after-removal', 'closer'),
  'legs', jsonb_build_object('q17-k', 'unresolved/ambiguous', 'q17-y', 'unresolved/ambiguous'),
  'liveDecisions', 2,
  'sameKeyRows', jsonb_build_object('ambiguity_hold_removed_card:q17-y+q17-k@2026-09-11', 2)));

-- ==== Q18: A SECOND REMOVAL AFTER A RELINK. A payment (C, 09-10) matched automatically to the removed card's leg
--      (09-11), while the kept card's leg (Y, 09-13) also fitted. The first removal keeps the known destination
--      (a record on the payment) and writes a hold on (Y's leg, the payment), both because of that leg. The card
--      is linked again with new ids and re-imports the leg: the payment matches it again, and the rows of the
--      first removal lie dormant. That institution is removed too: it writes its OWN record and its OWN hold,
--      because of the re-imported leg — although a live record with that key and a live hold with that pair and
--      date exist. Two records and two holds, each pair alike but for the id. They read as one: the payment is
--      untracked / removed_card, a figure, and names the record with the lesser id; the kept card does not take
--      it. Then the bank corrects the payment: all four rows are inactive alike, and none of them is proof.
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q18-k', 520, '2026-09-10'), pg_temp.txr('q18-r', -520, '2026-09-11'), pg_temp.tx('Y', 'q18-b', -520, '2026-09-13');
select pg_temp.evaluate();
select 'S|Q18|1-before|' || pg_temp.srx(array['q18-b', 'q18-k', 'q18-r']);
set role service_role;
select pg_temp.remove_item('Q18', '2-remove-r', pg_temp.item_r());
insert into pg_temp.own values ('Q18/r', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q18|3-rows|' || pg_temp.src() || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q18', '4-own', 'Q18/r');
select 'S|Q18|5-after-r|' || pg_temp.srx(array['q18-b', 'q18-k']) || ';named=' || pg_temp.named_record('q18-k') || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q18', 'after-first-removal');
select pg_temp.relink_card_r();
select pg_temp.txa(pg_temp.card_r2(), 'q18-r2', -520, '2026-09-11');
select pg_temp.evaluate();
select 'S|Q18|6-relinked|' || pg_temp.srx(array['q18-b', 'q18-k', 'q18-r2']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q18', 'relinked');
set role service_role;
select pg_temp.remove_item('Q18', '7-remove-r2', pg_temp.item_r2());
insert into pg_temp.own values ('Q18/r2', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q18|8-rows|' || pg_temp.src() || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q18', '9-own', 'Q18/r2');
select 'S|Q18|10-after-r2|' || pg_temp.srx(array['q18-b', 'q18-k']) || ';named=' || pg_temp.named_record('q18-k') || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q18', 'after-second-removal');
update public.transactions set amount = 518 where plaid_transaction_id = 'q18-k';
select pg_temp.evaluate();
select 'S|Q18|11-corrected|' || pg_temp.srx(array['q18-b', 'q18-k']) || ';' || pg_temp.dst();
select pg_temp.dump('Q18', jsonb_build_object(
  'steps', jsonb_build_array(
    'q18-b=unresolved/ambiguous/0[0..0]/->-@-,q18-k=tracked/auto_pair/0[0..0]/->q18-r@-,q18-r=paired/auto_pair/0[0..0]/->q18-k@-',
    'removed:fresh',
    'hold_removed_card:q18-b+q18-k@2026-09-11<=rpc-item-a2:rpc-r:q18-r[automatic_partner/row],'
      || 'record:q18-k<=rpc-item-a2:rpc-r:q18-r[automatic_partner/row];removals=1:rpc-item-a2:recorded',
    'own-states:same',
    'q18-b=unresolved/ambiguous/0[0..0]/->-@-,q18-k=untracked/removed_card/-52000[-52000..-52000]/->-@destination_removed_card;'
      || 'named=least-of-1;ambiguity_hold_removed_card:q18-b=active,destination_removed_card:q18-k=active',
    'q18-b=unresolved/ambiguous/0[0..0]/->-@-,q18-k=tracked/auto_pair/0[0..0]/->q18-r2@-,q18-r2=paired/auto_pair/0[0..0]/->q18-k@-;'
      || 'ambiguity_hold_removed_card:q18-b=active,destination_removed_card:q18-k=active',
    'removed:fresh',
    'hold_removed_card:q18-b+q18-k@2026-09-11<=rpc-item-a2:rpc-r:q18-r[automatic_partner/row],'
      || 'hold_removed_card:q18-b+q18-k@2026-09-11<=rpc-item-a3:rpc-r2:q18-r2[automatic_partner/row],'
      || 'record:q18-k<=rpc-item-a2:rpc-r:q18-r[automatic_partner/row],'
      || 'record:q18-k<=rpc-item-a3:rpc-r2:q18-r2[automatic_partner/row];removals=1:rpc-item-a2:recorded,2:rpc-item-a3:recorded',
    'own-states:same',
    'q18-b=unresolved/ambiguous/0[0..0]/->-@-,q18-k=untracked/removed_card/-52000[-52000..-52000]/->-@destination_removed_card;'
      || 'named=least-of-2;ambiguity_hold_removed_card:q18-b=active,ambiguity_hold_removed_card:q18-b=active,'
      || 'destination_removed_card:q18-k=active,destination_removed_card:q18-k=active',
    'q18-b=unresolved/amount_differs/0[0..0]/->-@-,q18-k=unresolved/amount_differs/null[-51800..0]/->-@-;'
      || 'ambiguity_hold_removed_card:q18-b=inactive/amount_changed,ambiguity_hold_removed_card:q18-b=inactive/amount_changed,'
      || 'destination_removed_card:q18-k=inactive/amount_changed,destination_removed_card:q18-k=inactive/amount_changed'),
  'checkpoints', jsonb_build_array('after-first-removal', 'relinked', 'after-second-removal'),
  'legs', jsonb_build_object('q18-k', 'unresolved/amount_differs', 'q18-b', 'unresolved/amount_differs'),
  'liveDecisions', 4,
  'sameKeyRows', jsonb_build_object('destination_removed_card:q18-k', 2, 'ambiguity_hold_removed_card:q18-b+q18-k@2026-09-11', 2)));

-- ==== Q19: A USER PAIR WHOSE REMOVED LEG IS WAITING TO POST. The user confirms a payment (C, 09-10) with the removed
--      card's PENDING leg (09-11); the kept card's leg (Y, 09-12) also fits. A sync withdraws the pending leg, and
--      its carry-over waits for the posted row: the confirmation is inactive (waiting to post) and holds the
--      payment. The removal keeps it as the USER's decision on the payment, frozen as waiting to post — which
--      invalidates nothing — and its provenance row records what was there: no row, the carry-over's date and
--      amount. It writes no system row. The payment reads untracked / removed_card by the user's decision; the
--      kept card's leg is not matched to it. Then the card is linked again and re-imports the leg, posted: a
--      suggestion at most, never applied. That institution is removed too: it writes nothing for the payment —
--      a user's decision is never written a second time, and never becomes a system row.
select pg_temp.reset();
select pg_temp.add_card_r();
select pg_temp.tx('C', 'q19-k', 530, '2026-09-10'), pg_temp.txa(pg_temp.card_r(), 'q19-r', -530, '2026-09-11', true),
       pg_temp.tx('Y', 'q19-y', -530, '2026-09-12');
select pg_temp.evaluate();
set role service_role;
select pg_temp.step('Q19', '1-link-pending', pg_temp.link('q19-k', 'q19-r', 0));
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['q19-r']) is not null as withdrawn;
reset role;
select pg_temp.evaluate();
select 'S|Q19|2-waiting|' || pg_temp.srx(array['q19-k', 'q19-y']) || ';' || pg_temp.dst();
set role service_role;
select pg_temp.remove_item('Q19', '3-remove-r', pg_temp.item_r());
insert into pg_temp.own values ('Q19', public.get_card_payment_states(pg_temp.aa()));
reset role;
select 'S|Q19|4-rows|' || pg_temp.src()
       || ';kept=' || (select string_agg(d.a_plaid_transaction_id || '/' || d.b_plaid_transaction_id || ':' || d.b_cents || '=' || d.counterpart_status, ',')
                       from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed')
       || ';observed=' || pg_temp.pv($q$ select string_agg(coalesce(s.source_plaid_transaction_id, 'no-row') || '@' || coalesce(s.source_date::text, 'no-date') || ':'
                                                           || coalesce(s.source_cents::text, 'no-amount'), ',')
                                         from public.card_payment_removal_sources s $q$)
       || ';carry-overs=' || (select count(*) from public.transaction_carryovers)
       || ';decisions=' || (select count(*) from public.card_payment_decisions)
       || ';removals=' || pg_temp.gens();
select pg_temp.own_states('Q19', '5-own', 'Q19');
select 'S|Q19|6-after|' || pg_temp.srx(array['q19-k', 'q19-y']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q19', 'after-removal');
select pg_temp.relink_card_r();
select pg_temp.txa(pg_temp.card_r2(), 'q19-r2', -530, '2026-09-11');
select pg_temp.evaluate();
select 'S|Q19|7-relinked|' || pg_temp.srx(array['q19-k', 'q19-r2', 'q19-y']) || ';' || pg_temp.dst();
select pg_temp.checkpoint('Q19', 'relinked');
set role service_role;
select pg_temp.remove_item('Q19', '8-remove-r2', pg_temp.item_r2());
reset role;
select 'S|Q19|9-rows|' || pg_temp.src() || ';decisions=' || (select count(*) from public.card_payment_decisions)
       || ';sources=' || pg_temp.pv($q$ select count(*)::text from public.card_payment_removal_sources $q$) || ';removals=' || pg_temp.gens();
select 'S|Q19|10-after-r2|' || pg_temp.srx(array['q19-k', 'q19-y']) || ';' || pg_temp.dst();
select pg_temp.dump('Q19', jsonb_build_object(
  'steps', jsonb_build_array(
    'saved:fresh',
    'q19-k=unresolved/matched_leg_not_posted/null[-53000..0]/waiting_to_post>-@pair,q19-y=unresolved/no_candidate/0[0..0]/->-@-;'
      || 'pair:q19-k=inactive/waiting_to_post',
    'removed:fresh',
    'pair_counterpart_removed:q19-k<=rpc-item-a2:rpc-r:-[confirmed_counterpart/waiting_to_post];kept=q19-k/q19-r:-53000=waiting_to_post;'
      || 'observed=no-row@2026-09-11:-53000;carry-overs=0;decisions=1;removals=1:rpc-item-a2:recorded',
    'own-states:same',
    'q19-k=untracked/removed_card/-53000[-53000..-53000]/->-@pair_counterpart_removed,q19-y=unresolved/no_candidate/0[0..0]/->-@-;'
      || 'pair_counterpart_removed:q19-k=active',
    'q19-k=untracked/removed_card/-53000[-53000..-53000]/->-@pair_counterpart_removed,q19-r2=unresolved/no_candidate/0[0..0]/->-@-,'
      || 'q19-y=unresolved/no_candidate/0[0..0]/->-@-;pair_counterpart_removed:q19-k=active',
    'removed:fresh',
    'pair_counterpart_removed:q19-k<=rpc-item-a2:rpc-r:-[confirmed_counterpart/waiting_to_post];decisions=1;sources=1;'
      || 'removals=1:rpc-item-a2:recorded,2:rpc-item-a3:recorded',
    'q19-k=untracked/removed_card/-53000[-53000..-53000]/->-@pair_counterpart_removed,q19-y=unresolved/no_candidate/0[0..0]/->-@-;'
      || 'pair_counterpart_removed:q19-k=active'),
  'checkpoints', jsonb_build_array('after-removal', 'relinked'),
  'legs', jsonb_build_object('q19-k', 'untracked/removed_card', 'q19-y', 'unresolved/no_candidate'),
  'liveDecisions', 1));
