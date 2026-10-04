-- RPC-written decision sequences (Phase B slice 2b-1). Each scenario drives the decision RPCs
-- (link / mark / dismiss / undo, each with the version the caller saw), plus the sync-shaped input changes
-- between them, then evaluates at a fixed time and prints, per user:
--   S|<scenario>|<step>|<status>   each RPC's outcome (refusals as refused:<code>)
--   I|<scenario>|<user>|<json>      the database inputs in the TypeScript reference evaluator's input shape
--   R|<scenario>|<user>|<json>      get_card_payment_states
--   E|<scenario>|<json>             the expected reference outcome of the sequence
-- compare_rpc.cjs runs the reference evaluator on each I line (so on exactly the decisions the RPCs wrote,
-- superseded ones included), requires it to equal R, and checks E against it.
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
                    'supersededBy', d.superseded_by) order by d.id), '[]'::jsonb)
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
