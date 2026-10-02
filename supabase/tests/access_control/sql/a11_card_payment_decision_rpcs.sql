-- The card-payment decision RPCs (migration 20261001120000; CARD_PAYMENT_PAIRING_DESIGN.md §3.2–§3.7,
-- acceptance tests 20–21 single-session). psql runs every statement below in its own transaction
-- (autocommit), so each assertion reads the DURABLE outcome of the RPC call before it, from a new
-- transaction after that call committed. Concurrent cases are concurrency/c16–c22; agreement of
-- RPC-written decisions with the TypeScript reference evaluator is supabase/tests/card_payment_evaluator.
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-00000000aac1', '00000000-0000-0000-0000-000000000001', 'dr-c', 'Checking', 'depository', false),
  ('00000000-0000-0000-0000-00000000aac3', '00000000-0000-0000-0000-000000000001', 'dr-c2', 'Savings', 'depository', false),
  ('00000000-0000-0000-0000-00000000aac2', '00000000-0000-0000-0000-000000000001', 'dr-x', 'Card X', 'credit', false),
  ('00000000-0000-0000-0000-00000000aac4', '00000000-0000-0000-0000-000000000001', 'dr-y', 'Card Y', 'credit', false),
  ('00000000-0000-0000-0000-00000000bbc1', '00000000-0000-0000-0000-000000000002', 'dr-bc', 'BB Checking', 'depository', false),
  ('00000000-0000-0000-0000-00000000bbc2', '00000000-0000-0000-0000-000000000002', 'dr-bx', 'BB Card', 'credit', false);

-- C = aac1, C2 = aac3 (cash side); X = aac2, Y = aac4 (cards). Dates keep every intended manual pair more
-- than 5 days apart (or of different amounts), so no unintended tier 1 pair forms.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override) values
  -- replacement, reservation, validation
  ('00000000-0000-0000-0000-00000000aac1', 'r-pay',  100, '2026-09-01', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-x',   -100, '2026-09-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac4', 'r-y',    -98, '2026-09-02', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac3', 'r-pay2',  98, '2026-09-25', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-ret',  -50, '2026-09-05', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-exp',   30, '2026-09-06', false, null, 'expense'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-zero',   0, '2026-09-07', false, null, 'credit_card_payment'),
  -- manual matching limits
  ('00000000-0000-0000-0000-00000000aac1', 'r-m1',    55, '2026-09-10', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-mfar', -55, '2026-12-30', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-m2',    81, '2026-09-12', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac4', 'r-mbig', -90, '2026-09-14', false, null, 'credit_card_payment'),
  -- conflicting replacements and a superseded pending row
  ('00000000-0000-0000-0000-00000000aac1', 'r-amb1',  70, '2026-10-01', false, 'r-amb-p', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-amb2',  70, '2026-10-03', false, 'r-amb-p', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-amb-x', -70, '2026-10-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-sup-p', 60, '2026-10-05', true,  null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-sup-t', 60, '2026-10-06', false, 'r-sup-p', 'credit_card_payment'),
  -- dismissals
  ('00000000-0000-0000-0000-00000000aac1', 'r-dz',    77, '2026-10-10', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-dzx',  -77, '2026-10-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac4', 'r-dzy',  -77, '2026-10-25', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-dd',    66, '2026-10-12', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-ddx',  -66, '2026-10-22', false, null, 'credit_card_payment'),
  -- lineage aliases (pending → posted)
  ('00000000-0000-0000-0000-00000000aac1', 'r-pc',    40, '2026-11-01', true,  null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-kx',   -40, '2026-11-15', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac4', 'r-ky',   -40, '2026-11-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-pk',   -45, '2026-11-05', true,  null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac3', 'r-c45',   45, '2026-11-12', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-c45b',  45, '2026-11-20', false, null, 'credit_card_payment'),
  -- undo cases
  ('00000000-0000-0000-0000-00000000aac1', 'r-pw',    33, '2026-12-01', true,  null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-wx',   -33, '2026-12-10', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-rc',    22, '2026-12-05', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac4', 'r-rx',   -22, '2026-12-15', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-ac',    11, '2026-12-07', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-ax',   -11, '2026-12-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac3', 'r-ac2',   11, '2026-12-31', false, null, 'credit_card_payment'),
  -- evaluation failure and outer rollback
  ('00000000-0000-0000-0000-00000000aac1', 'r-ef',     7, '2026-08-01', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-efx',   -7, '2026-08-20', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac1', 'r-ro',     8, '2026-08-03', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-rox',   -8, '2026-08-25', false, null, 'credit_card_payment'),
  -- the other user
  ('00000000-0000-0000-0000-00000000bbc1', 'rb-pay', 100, '2026-09-01', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000bbc2', 'rb-card', -100, '2026-09-21', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000bbc1', 'rb-exp',   5, '2026-09-03', false, null, 'expense');

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.t(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- The evaluated version the user's states carry (what a client would send back).
create function pg_temp.v(p_user uuid default '00000000-0000-0000-0000-0000000000aa') returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.iv(p_user uuid default '00000000-0000-0000-0000-0000000000aa') returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.ndec() returns bigint language sql as $$ select count(*) from public.card_payment_decisions $$;
-- A leg's current state; raises (failing the test) when the states are not fresh or the leg is missing, so
-- an assertion on a field (e.g. decisionId is null) can never pass vacuously.
create function pg_temp.leg(p_plaid text) returns jsonb language plpgsql as $$
declare
  v_states jsonb := public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa');
  v_leg jsonb;
begin
  if not coalesce((v_states->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  select l into v_leg from jsonb_array_elements(v_states->'legs') l where (l->>'transactionId')::uuid = pg_temp.t(p_plaid);
  if v_leg is null then
    raise exception 'ASSERTION FAILED: no state for leg %', p_plaid;
  end if;
  return v_leg;
end $$;
create function pg_temp.sup(p_id uuid) returns uuid language sql as $$
  select superseded_by from public.card_payment_decisions where id = p_id $$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlerrm;
  end;
  return null;
end $$;
-- RPC wrappers naming legs by Plaid id (as user aa unless given).
create function pg_temp.link(p_s text, p_c text, p_diff bigint, p_ver bigint, p_user uuid default '00000000-0000-0000-0000-0000000000aa')
returns jsonb language sql as $$ select public.link_card_payment(p_user, pg_temp.t(p_s), pg_temp.t(p_c), p_diff, p_ver) $$;
create function pg_temp.mark(p_s text, p_ver bigint) returns jsonb language sql as $$
  select public.mark_card_payment_destination('00000000-0000-0000-0000-0000000000aa', pg_temp.t(p_s), p_ver) $$;
create function pg_temp.dismiss(p_s text, p_c text, p_ver bigint) returns jsonb language sql as $$
  select public.dismiss_card_payment_candidate('00000000-0000-0000-0000-0000000000aa', pg_temp.t(p_s), pg_temp.t(p_c), p_ver) $$;
create function pg_temp.undo(p_id uuid, p_ver bigint, p_user uuid default '00000000-0000-0000-0000-0000000000aa') returns jsonb
language sql as $$ select public.undo_card_payment_decision(p_user, p_id, p_ver) $$;
-- Results kept by name for later statements.
create temporary table res (name text primary key, r jsonb not null);
create function pg_temp.r(p_name text) returns jsonb language sql as $$ select r from pg_temp.res where name = p_name $$;
create function pg_temp.did(p_name text) returns uuid language sql as $$ select (r->>'decisionId')::uuid from pg_temp.res where name = p_name $$;

-- ==== 1. The version check ============================================================================
-- Never evaluated: no version authorizes a write — not 0, not NULL.
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, 0) $q$, 'card_payment_stale_version: link_card_payment:%');
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, null) $q$, 'card_payment_stale_version: link_card_payment:%');
select public.evaluate_card_payments(pg_temp.aa());
select public.evaluate_card_payments(pg_temp.bb());
create temporary table snap as select pg_temp.v() as v, pg_temp.iv() as iv;
select th.assert((select v = iv from pg_temp.snap), 'fresh after evaluation');
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, null) $q$, 'card_payment_stale_version:%');
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, pg_temp.v() - 1) $q$, 'card_payment_stale_version:%');
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, pg_temp.v() + 1) $q$, 'card_payment_stale_version:%');
select th.expect_error($q$ select pg_temp.mark('r-pay', null) $q$, 'card_payment_stale_version: mark_card_payment_destination:%');
select th.expect_error($q$ select pg_temp.dismiss('r-pay', 'r-x', pg_temp.v() - 1) $q$, 'card_payment_stale_version: dismiss_card_payment_candidate:%');
-- An input change (here a direct, lock-free amount edit) refuses the version the user saw, AND the new
-- input version too, because it is not evaluated: the server's latest version is never substituted.
update public.transactions set amount = 31 where plaid_transaction_id = 'r-exp';
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, (select v from pg_temp.snap)) $q$, 'card_payment_stale_version:%');
select th.expect_error($q$ select pg_temp.link('r-pay', 'r-x', 0, pg_temp.iv()) $q$, 'card_payment_stale_version:%');
select th.assert(pg_temp.ndec() = 0, 'no refused call wrote a decision');
select th.assert(pg_temp.iv() = (select iv from pg_temp.snap) + 1, 'no refused call bumped the version (only the edit did)');
select public.evaluate_card_payments(pg_temp.aa());
-- What does NOT invalidate the action: a sync that changes nothing, and an edit of a non-input column.
update pg_temp.snap set v = pg_temp.v(), iv = pg_temp.iv();
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, '{}'::text[]);
update public.transactions set name = 'renamed' where plaid_transaction_id = 'r-pay';
select th.assert(pg_temp.iv() = (select iv from pg_temp.snap), 'an empty sync batch and a name edit change no input');
insert into pg_temp.res select 'first', pg_temp.link('r-pay', 'r-x', 0, (select v from pg_temp.snap));
select th.assert(pg_temp.r('first')->>'status' = 'saved', 'the version seen before the no-op sync still authorizes the write');

-- ==== 2. The response contract and the durable write ===================================================
select th.assert(pg_temp.r('first')->>'matching' = 'fresh', 'evaluated in the same call: fresh');
select th.assert((pg_temp.r('first')->>'evaluatedVersion')::bigint = (pg_temp.r('first')->>'inputVersion')::bigint
                 and (pg_temp.r('first')->>'evaluatedVersion')::bigint = pg_temp.v()
                 and pg_temp.v() > (select v from pg_temp.snap), 'the response carries the new published version');
select th.assert(jsonb_array_length(pg_temp.r('first')->'legs') = 2
                 and exists (select 1 from jsonb_array_elements(pg_temp.r('first')->'legs') l
                             where (l->>'transactionId')::uuid = pg_temp.t('r-pay') and l->>'state' = 'tracked' and l->>'reason' = 'user_pair'
                               and (l->>'decisionId')::uuid = pg_temp.did('first')),
  'the named legs come back with their fresh states: the payment is tracked by the user pair');
select th.assert((select kind = 'pair' and a_account_id = '00000000-0000-0000-0000-00000000aac1' and a_plaid_transaction_id = 'r-pay'
                         and a_cents = 10000 and b_account_id = '00000000-0000-0000-0000-00000000aac2'
                         and b_plaid_transaction_id = 'r-x' and b_cents = -10000 and accepted_difference_cents = 0
                         and superseded_by is null and user_id = pg_temp.aa()
                  from public.card_payment_decisions where id = pg_temp.did('first')),
  'durably stored by lineage key: cash leg (account, Plaid id, cents) as a, card leg as b');
select th.assert((public.get_card_payment_states(pg_temp.aa())->>'fresh')::boolean, 'a fresh read after commit');

-- ==== 3. Ownership: unknown and foreign targets are refused identically, before any validation ===========
select th.assert(pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), pg_temp.t('r-pay2'), pg_temp.t('rb-card'), 0, pg_temp.v()) $q$)
                 = pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), pg_temp.t('r-pay2'), gen_random_uuid(), 0, pg_temp.v()) $q$),
  'a foreign counterpart and an unknown one give the same message');
select th.assert(pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), pg_temp.t('r-pay2'), pg_temp.t('rb-card'), 0, pg_temp.v()) $q$)
                 like 'card_payment_not_found: link_card_payment:%', 'and it is card_payment_not_found');
-- A foreign row that would also fail validation (not a card payment) still only gets not_found.
select th.expect_error($q$ select public.link_card_payment(pg_temp.aa(), pg_temp.t('r-pay2'), pg_temp.t('rb-exp'), 0, pg_temp.v()) $q$,
  'card_payment_not_found: link_card_payment:%');
-- bb, freshly evaluated, naming aa's rows.
select th.assert(pg_temp.err($q$ select public.link_card_payment(pg_temp.bb(), pg_temp.t('rb-pay'), pg_temp.t('r-y'), 0, pg_temp.v(pg_temp.bb())) $q$)
                 = pg_temp.err($q$ select public.link_card_payment(pg_temp.bb(), pg_temp.t('rb-pay'), gen_random_uuid(), 0, pg_temp.v(pg_temp.bb())) $q$)
                 and pg_temp.err($q$ select public.link_card_payment(pg_temp.bb(), pg_temp.t('rb-pay'), gen_random_uuid(), 0, pg_temp.v(pg_temp.bb())) $q$)
                     like 'card_payment_not_found: link_card_payment:%',
  'for bb, aa''s card leg looks exactly like an unknown id (not_found)');
-- A foreign SUBJECT (not only a foreign counterpart) is refused the same way.
select th.assert(pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), pg_temp.t('rb-pay'), pg_temp.t('r-x'), 0, pg_temp.v()) $q$)
                 = pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), gen_random_uuid(), pg_temp.t('r-x'), 0, pg_temp.v()) $q$)
                 and pg_temp.err($q$ select public.link_card_payment(pg_temp.aa(), gen_random_uuid(), pg_temp.t('r-x'), 0, pg_temp.v()) $q$)
                     like 'card_payment_not_found: link_card_payment:%',
  'a foreign subject looks exactly like an unknown one');
select th.expect_error($q$ select public.mark_card_payment_destination(pg_temp.bb(), pg_temp.t('r-pay2'), pg_temp.v(pg_temp.bb())) $q$,
  'card_payment_not_found: mark_card_payment_destination:%');
select th.expect_error($q$ select public.dismiss_card_payment_candidate(pg_temp.bb(), pg_temp.t('rb-pay'), pg_temp.t('r-x'), pg_temp.v(pg_temp.bb())) $q$,
  'card_payment_not_found: dismiss_card_payment_candidate:%');
select th.assert(pg_temp.err($q$ select pg_temp.undo(pg_temp.did('first'), pg_temp.v(pg_temp.bb()), pg_temp.bb()) $q$)
                 = pg_temp.err($q$ select pg_temp.undo(gen_random_uuid(), pg_temp.v(pg_temp.bb()), pg_temp.bb()) $q$)
                 and pg_temp.err($q$ select pg_temp.undo(gen_random_uuid(), pg_temp.v(pg_temp.bb()), pg_temp.bb()) $q$)
                     like 'card_payment_not_found: undo_card_payment_decision:%',
  'undoing another user''s decision looks exactly like undoing an unknown one');
select th.assert(pg_temp.sup(pg_temp.did('first')) is null, 'aa''s decision is untouched');

-- ==== 4. Validation at write time (each refusal writes nothing) ===========================================
create temporary table before4 as select pg_temp.ndec() as n, pg_temp.iv() as iv;
select th.expect_error($q$ select pg_temp.link('r-pay2', 'r-pay2', 0, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: same_transaction%');
select th.expect_error($q$ select pg_temp.link('r-exp', 'r-y', 0, pg_temp.v()) $q$, 'card_payment_ineligible: link_card_payment: not_card_payment%');
select th.expect_error($q$ select pg_temp.link('r-zero', 'r-y', 0, pg_temp.v()) $q$, 'card_payment_ineligible: link_card_payment: zero_amount%');
-- r-amb-x matches r-amb1 exactly (−70, 0 difference), so only the ambiguity can refuse this one.
select th.expect_error($q$ select pg_temp.link('r-amb1', 'r-amb-x', 0, pg_temp.v()) $q$, 'card_payment_ineligible: link_card_payment: lineage_ambiguous%');
select th.expect_error($q$ select pg_temp.link('r-y', 'r-amb2', 0, pg_temp.v()) $q$, 'card_payment_ineligible: link_card_payment: lineage_ambiguous%');
select th.expect_error($q$ select pg_temp.link('r-sup-p', 'r-y', 0, pg_temp.v()) $q$, 'card_payment_ineligible: link_card_payment: superseded%');
select th.expect_error($q$ select pg_temp.link('r-pay2', 'r-ret', 0, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: sides_not_opposite%');
select th.expect_error($q$ select pg_temp.link('r-ret', 'r-y', 0, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: direction_mismatch%');
select th.expect_error($q$ select pg_temp.link('r-m2', 'r-mbig', null, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: difference_not_accepted%');
select th.expect_error($q$ select pg_temp.link('r-m2', 'r-mbig', 0, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: difference_not_accepted%');
select th.expect_error($q$ select pg_temp.link('r-m2', 'r-mbig', 900, pg_temp.v()) $q$, 'card_payment_invalid: link_card_payment: difference_not_accepted%');
select th.expect_error($q$ select pg_temp.mark('r-x', pg_temp.v()) $q$, 'card_payment_invalid: mark_card_payment_destination: not_cash_side%');
select th.expect_error($q$ select pg_temp.mark('r-exp', pg_temp.v()) $q$, 'card_payment_ineligible: mark_card_payment_destination: not_card_payment%');
select th.expect_error($q$ select pg_temp.mark('r-amb1', pg_temp.v()) $q$, 'card_payment_ineligible: mark_card_payment_destination: lineage_ambiguous%');
select th.expect_error($q$ select pg_temp.dismiss('r-pay2', 'r-ret', pg_temp.v()) $q$, 'card_payment_invalid: dismiss_card_payment_candidate: sides_not_opposite%');
select th.expect_error($q$ select pg_temp.dismiss('r-ret', 'r-y', pg_temp.v()) $q$, 'card_payment_invalid: dismiss_card_payment_candidate: direction_mismatch%');
select th.expect_error($q$ select pg_temp.dismiss('r-sup-p', 'r-y', pg_temp.v()) $q$, 'card_payment_ineligible: dismiss_card_payment_candidate: superseded%');
select th.assert(pg_temp.ndec() = (select n from pg_temp.before4) and pg_temp.iv() = (select iv from pg_temp.before4),
  'no refusal wrote a decision or advanced the version');

-- ==== 5. Manual matching keeps no distance or $5 limit; a difference needs exact acceptance ==============
insert into pg_temp.res select 'far', pg_temp.link('r-m1', 'r-mfar', 0, pg_temp.v());
select th.assert(pg_temp.leg('r-m1')->>'reason' = 'user_pair' and (pg_temp.leg('r-m1')->>'effectCents')::bigint = 0,
  '111 days apart: matched manually, tracked');
insert into pg_temp.res select 'big', pg_temp.link('r-m2', 'r-mbig', -900, pg_temp.v());
select th.assert(pg_temp.leg('r-m2')->>'state' = 'tracked' and (pg_temp.leg('r-m2')->>'effectCents')::bigint = 0
                 and (pg_temp.leg('r-mbig')->>'cardExcessCents')::bigint = 900,
  'a $9.00 difference (beyond the $5 suggestion limit) accepted exactly: card larger → 0, 9.00 externally funded');

-- ==== 6. Replacement ======================================================================================
-- A. Replacing A–B with A–C supersedes the whole A–B decision and re-evaluates B.
insert into pg_temp.res select 'replace', pg_temp.link('r-pay', 'r-y', 200, pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('first')) = pg_temp.did('replace'), 'the old pair points at its replacement');
select th.assert(pg_temp.r('replace')->'supersededDecisionIds' = jsonb_build_array(pg_temp.did('first')), 'and the response names it');
select th.assert(exists (select 1 from jsonb_array_elements(pg_temp.r('replace')->'legs') l where (l->>'transactionId')::uuid = pg_temp.t('r-x')),
  'the freed leg B is among the returned legs');
select th.assert(pg_temp.leg('r-x')->>'state' = 'unresolved' and pg_temp.leg('r-x')->>'decisionId' is null, 'B is re-evaluated: unresolved, no decision');
select th.assert(pg_temp.leg('r-pay')->>'reason' = 'user_pair' and (pg_temp.leg('r-pay')->>'effectCents')::bigint = -200,
  'A is paired with C, cash larger by 2.00 → −2.00');
-- B. A counterpart held by another affirmative decision is refused, active or inactive.
select th.expect_error($q$ select pg_temp.link('r-pay2', 'r-y', 0, pg_temp.v()) $q$, 'card_payment_counterpart_reserved: link_card_payment:%');
select th.assert(pg_temp.sup(pg_temp.did('replace')) is null, 'the protected pair is untouched');
insert into pg_temp.res select 'ac', pg_temp.link('r-ac', 'r-ax', 0, pg_temp.v());
update public.transactions set amount = 12 where plaid_transaction_id = 'r-ac';
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.leg('r-ax')->>'detail' = 'amount_changed', 'the r-ac/r-ax confirmation is now inactive (amount changed)');
select th.expect_error($q$ select pg_temp.link('r-ac2', 'r-ax', 0, pg_temp.v()) $q$, 'card_payment_counterpart_reserved:%');
select th.assert(pg_temp.sup(pg_temp.did('ac')) is null, 'an inactive confirmation still protects its leg');
-- ... and a destination confirmation protects its cash leg from becoming another match's counterpart.
insert into pg_temp.res select 'dd', pg_temp.mark('r-dd', pg_temp.v());
select th.expect_error($q$ select pg_temp.link('r-ddx', 'r-dd', 0, pg_temp.v()) $q$, 'card_payment_counterpart_reserved:%');
-- D. A dismissal against a destination confirmation leaves the confirmation intact.
insert into pg_temp.res select 'dd-dismiss', pg_temp.dismiss('r-dd', 'r-ddx', pg_temp.v());
select th.assert(pg_temp.r('dd-dismiss')->>'status' = 'saved' and pg_temp.r('dd-dismiss')->'supersededDecisionIds' = '[]'::jsonb,
  'the dismissal is saved and supersedes nothing');
select th.assert(pg_temp.sup(pg_temp.did('dd')) is null and pg_temp.leg('r-dd')->>'reason' = 'user_confirmed_unlinked',
  'the destination confirmation is still live and still applies');
-- C. Two dismissals on one leg coexist.
insert into pg_temp.res select 'dz-x', pg_temp.dismiss('r-dz', 'r-dzx', pg_temp.v());
insert into pg_temp.res select 'dz-y', pg_temp.dismiss('r-dz', 'r-dzy', pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('dz-x')) is null and pg_temp.sup(pg_temp.did('dz-y')) is null, 'both dismissals are live');
select th.assert(pg_temp.leg('r-dz')->>'reason' = 'no_candidate' and pg_temp.leg('r-dz')->'candidates' = '[]'::jsonb,
  'both candidates are suppressed; the leg stays unresolved (never untracked)');
-- E. Confirming one dismissed pair supersedes exactly that dismissal.
insert into pg_temp.res select 'dz-link', pg_temp.link('r-dz', 'r-dzx', 0, pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('dz-x')) = pg_temp.did('dz-link'), 'the dismissal of this exact edge is replaced by the match');
select th.assert(pg_temp.sup(pg_temp.did('dz-y')) is null, 'the other dismissal is preserved');
select th.assert(pg_temp.r('dz-link')->'supersededDecisionIds' = jsonb_build_array(pg_temp.did('dz-x')), 'only that dismissal is named');
-- A dismissal never supersedes a confirmation: refused on the exact edge of a saved match.
select th.expect_error($q$ select pg_temp.dismiss('r-dz', 'r-dzx', pg_temp.v()) $q$, 'card_payment_pair_confirmed: dismiss_card_payment_candidate:%');
select th.expect_error($q$ select pg_temp.dismiss('r-dzx', 'r-dz', pg_temp.v()) $q$, 'card_payment_pair_confirmed:%');
-- F. Lineage aliases: a match saved on a pending row is found (and replaced) through its posted row.
insert into pg_temp.res select 'pc', pg_temp.link('r-pc', 'r-kx', 0, pg_temp.v());
select th.assert((select a_plaid_transaction_id from public.card_payment_decisions where id = pg_temp.did('pc')) = 'r-pc',
  'saved with the pending row''s Plaid id');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override)
values ('00000000-0000-0000-0000-00000000aac1', 'r-tc', 40, '2026-11-02', false, 'r-pc', 'credit_card_payment');
delete from public.transactions where plaid_transaction_id = 'r-pc';
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.leg('r-tc')->>'reason' = 'user_pair' and (pg_temp.leg('r-tc')->>'decisionId')::uuid = pg_temp.did('pc'),
  'after posting, the saved match applies to the posted row');
insert into pg_temp.res select 'tc', pg_temp.link('r-tc', 'r-ky', 0, pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('pc')) = pg_temp.did('tc'), 'naming the posted row replaces the match saved under the pending id');
select th.assert(pg_temp.leg('r-kx')->>'decisionId' is null, 'and frees its old counterpart');
--    The same for a counterpart: a card leg matched while pending stays protected after it posts.
insert into pg_temp.res select 'pk', pg_temp.link('r-c45', 'r-pk', 0, pg_temp.v());
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override)
values ('00000000-0000-0000-0000-00000000aac2', 'r-tk', -45, '2026-11-06', false, 'r-pk', 'credit_card_payment');
delete from public.transactions where plaid_transaction_id = 'r-pk';
select public.evaluate_card_payments(pg_temp.aa());
select th.expect_error($q$ select pg_temp.link('r-c45b', 'r-tk', 0, pg_temp.v()) $q$, 'card_payment_counterpart_reserved:%');
select th.assert(pg_temp.sup(pg_temp.did('pk')) is null, 'the protected match (saved under the pending card id) is untouched');

-- ==== 7. Already-saved decisions: explicit no-ops with nothing written =====================================
create temporary table before7 as select pg_temp.ndec() as n, pg_temp.iv() as iv;
insert into pg_temp.res select 'same-link', pg_temp.link('r-pay', 'r-y', 200, pg_temp.v());
insert into pg_temp.res select 'same-mark', pg_temp.mark('r-dd', pg_temp.v());
insert into pg_temp.res select 'same-dismiss', pg_temp.dismiss('r-dzy', 'r-dz', pg_temp.v());
select th.assert(pg_temp.r('same-link')->>'status' = 'unchanged' and pg_temp.r('same-link')->>'reason' = 'already_confirmed'
                 and pg_temp.did('same-link') = pg_temp.did('replace'), 'the same match again: unchanged, the saved decision named');
select th.assert(pg_temp.r('same-mark')->>'reason' = 'already_confirmed' and pg_temp.did('same-mark') = pg_temp.did('dd'), 'the same destination again: unchanged');
select th.assert(pg_temp.r('same-dismiss')->>'reason' = 'already_dismissed' and pg_temp.did('same-dismiss') = pg_temp.did('dz-y'),
  'the same dismissal (either order): unchanged');
select th.assert(pg_temp.ndec() = (select n from pg_temp.before7) and pg_temp.iv() = (select iv from pg_temp.before7),
  'no-ops write nothing and advance nothing');
-- A changed amount is not "the same": re-confirming the inactive r-ac/r-ax match replaces it.
insert into pg_temp.res select 'ac-again', pg_temp.link('r-ac', 'r-ax', 100, pg_temp.v());
select th.assert(pg_temp.r('ac-again')->>'status' = 'saved' and pg_temp.sup(pg_temp.did('ac')) = pg_temp.did('ac-again'),
  'correcting an invalidated confirmation replaces it');
select th.assert(pg_temp.leg('r-ac')->>'reason' = 'user_pair' and pg_temp.leg('r-ac')->>'detail' is null, 'and the corrected match is active');

-- ==== 8. Undo =============================================================================================
-- An inactive decision whose leg is waiting to post.
insert into pg_temp.res select 'pw', pg_temp.link('r-pw', 'r-wx', 0, pg_temp.v());
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id, pending_amount,
                                           pending_date, needs_review, expires_at)
values (pg_temp.aa(), '00000000-0000-0000-0000-00000000aac1', 'r-pw', pg_temp.t('r-pw'), 33, '2026-12-01', false, '2099-01-01');
delete from public.transactions where plaid_transaction_id = 'r-pw';
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.leg('r-wx')->>'reason' = 'matched_leg_not_posted', 'the match waits for its pending leg to post');
insert into pg_temp.res select 'pw-undo', pg_temp.undo(pg_temp.did('pw'), pg_temp.v());
select th.assert(pg_temp.r('pw-undo')->>'status' = 'undone' and pg_temp.sup(pg_temp.did('pw')) = pg_temp.did('pw'),
  'a waiting decision is undone: superseded_by = its own id');
select th.assert(pg_temp.leg('r-wx')->>'decisionId' is null and pg_temp.leg('r-wx')->>'state' = 'unresolved', 'its card leg is released');
-- A decision whose leg is no longer a card payment.
insert into pg_temp.res select 'rc', pg_temp.link('r-rc', 'r-rx', 0, pg_temp.v());
update public.transactions set user_role_override = 'expense' where plaid_transaction_id = 'r-rc';
select public.evaluate_card_payments(pg_temp.aa());
insert into pg_temp.res select 'rc-undo', pg_temp.undo(pg_temp.did('rc'), pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('rc')) = pg_temp.did('rc'), 'a decision on a row that is no longer a card payment is undone');
-- Repeated undo: with the current version, an explicit no-op; with the stale one, the standard refusal.
create temporary table before8 as select pg_temp.ndec() as n, pg_temp.iv() as iv;
insert into pg_temp.res select 'rc-undo-again', pg_temp.undo(pg_temp.did('rc'), pg_temp.v());
select th.assert(pg_temp.r('rc-undo-again')->>'status' = 'unchanged' and pg_temp.r('rc-undo-again')->>'reason' = 'already_undone',
  'a repeated undo is an explicit no-op');
select th.expect_error(format('select pg_temp.undo(%L, %s)', pg_temp.did('rc'), (pg_temp.r('rc')->>'evaluatedVersion')::bigint),
  'card_payment_stale_version: undo_card_payment_decision:%');
select th.assert(pg_temp.ndec() = (select n from pg_temp.before8) and pg_temp.iv() = (select iv from pg_temp.before8)
                 and pg_temp.sup(pg_temp.did('rc')) = pg_temp.did('rc'), 'neither repeat wrote anything');
-- An older, replaced decision: refused; the newer replacement stays live and the pointer is not moved.
select th.expect_error(format('select pg_temp.undo(%L, %s)', pg_temp.did('first'), pg_temp.v()),
  'card_payment_decision_replaced: undo_card_payment_decision:%');
select th.assert(pg_temp.sup(pg_temp.did('first')) = pg_temp.did('replace') and pg_temp.sup(pg_temp.did('replace')) is null,
  'the replacement stays live; the old pointer is unchanged');
-- Undoing the replacement never reactivates the decision it replaced.
insert into pg_temp.res select 'replace-undo', pg_temp.undo(pg_temp.did('replace'), pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('replace')) = pg_temp.did('replace') and pg_temp.sup(pg_temp.did('first')) = pg_temp.did('replace'),
  'undone; the older decision stays superseded (by the replacement), not reactivated');
select th.assert(pg_temp.leg('r-pay')->>'decisionId' is null and pg_temp.leg('r-x')->>'decisionId' is null,
  'neither the replacement nor the old match applies');
-- Undo of a dismissal.
insert into pg_temp.res select 'dz-y-undo', pg_temp.undo(pg_temp.did('dz-y'), pg_temp.v());
select th.assert(pg_temp.sup(pg_temp.did('dz-y')) = pg_temp.did('dz-y'), 'a dismissal can be undone');
-- A later match on r-pay leaves the undo marker alone: the undone decision is not live, so nothing selects
-- it for superseding. (The update's own "superseded_by is null" predicate is defense in depth that this
-- path cannot reach under the locks; for undo it is exercised by mutation M7b, see the handoff.)
insert into pg_temp.res select 'after-undo', pg_temp.link('r-pay', 'r-x', 0, pg_temp.v());
select th.assert(pg_temp.r('after-undo')->'supersededDecisionIds' = '[]'::jsonb
                 and pg_temp.sup(pg_temp.did('replace')) = pg_temp.did('replace'), 'undo markers are never overwritten');
-- The system-only kind can neither be created nor undone here.
insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
values ('00000000-0000-0000-0000-00000000dd99', pg_temp.aa(), 'destination_removed_card', '00000000-0000-0000-0000-00000000aac3', 'r-pay2', 9800);
select public.evaluate_card_payments(pg_temp.aa());
select th.expect_error(format('select pg_temp.undo(%L, %s)', '00000000-0000-0000-0000-00000000dd99', pg_temp.v()),
  'card_payment_invalid: undo_card_payment_decision: system_decision%');
select th.assert((select count(*) from public.card_payment_decisions where kind = 'destination_removed_card') = 1,
  'the only destination_removed_card is the one written directly; no RPC created one');

-- ==== 9. A caught evaluation failure: the decision is saved, no stale state is returned, a later evaluation recovers
-- Fault injection: a session temp table shadowing the evaluator's scratch table makes its index creation
-- fail inside try_evaluate's subtransaction.
create temporary table cpe_txn (x integer);
insert into pg_temp.res select 'ef', pg_temp.link('r-ef', 'r-efx', 0, pg_temp.v());
select th.assert(pg_temp.r('ef')->>'status' = 'saved' and pg_temp.r('ef')->>'matching' = 'pending', 'saved, matching pending');
select th.assert(not (pg_temp.r('ef') ? 'legs') and pg_temp.r('ef')->>'lastErrorCode' is not null, 'no leg states returned; the error code is');
select th.assert((pg_temp.r('ef')->>'inputVersion')::bigint > (pg_temp.r('ef')->>'evaluatedVersion')::bigint, 'and the versions show it is stale');
select th.assert((select superseded_by is null and kind = 'pair' from public.card_payment_decisions where id = pg_temp.did('ef')),
  'the decision is durable after commit');
select th.assert(not (public.get_card_payment_states(pg_temp.aa())->>'fresh')::boolean
                 and public.get_card_payment_states(pg_temp.aa())->'legs' is null, 'the reader returns no states: stale, never falsely fresh');
select th.expect_error($q$ select pg_temp.link('r-ro', 'r-rox', 0, pg_temp.iv()) $q$, 'card_payment_stale_version:%');
drop table pg_temp.cpe_txn;
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), 'a later evaluation succeeds');
select th.assert(pg_temp.leg('r-ef')->>'reason' = 'user_pair' and (pg_temp.leg('r-ef')->>'decisionId')::uuid = pg_temp.did('ef'),
  'and applies the saved decision');

-- ==== 10. An outer rollback is not a save; REPEATABLE READ is refused ====================================
create temporary table before10 as select pg_temp.ndec() as n, pg_temp.iv() as iv;
begin;
insert into pg_temp.res select 'ro', pg_temp.link('r-ro', 'r-rox', 0, pg_temp.v());
select th.assert(pg_temp.r('ro')->>'status' = 'saved', '(inside the transaction the call reports saved)');
rollback;
select th.assert(pg_temp.ndec() = (select n from pg_temp.before10) and pg_temp.iv() = (select iv from pg_temp.before10)
                 and pg_temp.leg('r-ro')->>'decisionId' is null, 'after the rollback nothing persists');
begin isolation level repeatable read;
select th.expect_error($q$ select pg_temp.link('r-ro', 'r-rox', 0, pg_temp.v()) $q$, 'card_payment_requires_read_committed: link_card_payment:%');
commit;
select th.assert(pg_temp.ndec() = (select n from pg_temp.before10), 'nothing written under REPEATABLE READ');

-- ==== 11. Same-user lineage and ownership edge cases (acceptance test 20) ===================================
-- A colliding pending id on ANOTHER user's account neither supersedes aa's pending row nor captures aa's match.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, pending, pending_transaction_id, user_role_override) values
  ('00000000-0000-0000-0000-00000000aac1', 'r-col-p',  44, '2026-11-25', true,  null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-col-x', -44, '2026-12-10', false, null, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000bbc1', 'rb-col-t', 44, '2026-11-26', false, 'r-col-p', 'credit_card_payment');
select public.evaluate_card_payments(pg_temp.aa());
insert into pg_temp.res select 'col', pg_temp.link('r-col-p', 'r-col-x', 0, pg_temp.v());
select th.assert(pg_temp.r('col')->>'status' = 'saved' and pg_temp.leg('r-col-p')->>'reason' = 'user_pair',
  'aa''s pending row is not superseded by bb''s posted row naming the same pending id, and is matched');
select public.evaluate_card_payments(pg_temp.bb());
select th.assert(not exists (select 1 from jsonb_array_elements(public.get_card_payment_states(pg_temp.bb())->'legs') l
                             where (l->>'decisionId')::uuid = pg_temp.did('col')),
  'bb''s row never carries aa''s decision');
-- Undo of aa's own decision after one of its accounts moved to another user: allowed (it is aa's decision),
-- and the response names only aa's own rows.
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-00000000aac9', '00000000-0000-0000-0000-000000000001', 'dr-mv', 'Moving', 'depository', false);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000aac9', 'r-mv',   27, '2026-07-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000aac2', 'r-mvx', -27, '2026-07-20', 'credit_card_payment');
select public.evaluate_card_payments(pg_temp.aa());
insert into pg_temp.res select 'mv', pg_temp.link('r-mv', 'r-mvx', 0, pg_temp.v());
reset role;
update public.accounts set item_id = '00000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-00000000aac9';
set role service_role;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(exists (select 1 from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'decisions') d
                         where (d->>'decisionId')::uuid = pg_temp.did('mv') and d->>'status' = 'rejected' and d->>'detail' = 'foreign_account'),
  'after the move the decision names a foreign account: rejected by the evaluator');
insert into pg_temp.res select 'mv-undo', pg_temp.undo(pg_temp.did('mv'), pg_temp.v());
select th.assert(pg_temp.r('mv-undo')->>'status' = 'undone' and pg_temp.sup(pg_temp.did('mv')) = pg_temp.did('mv'), 'aa can still undo its own decision');
select th.assert(not exists (select 1 from jsonb_array_elements(pg_temp.r('mv-undo')->'legs') l where (l->>'transactionId')::uuid = pg_temp.t('r-mv'))
                 and exists (select 1 from jsonb_array_elements(pg_temp.r('mv-undo')->'legs') l where (l->>'transactionId')::uuid = pg_temp.t('r-mvx')),
  'the response names aa''s own card leg, never the moved row');
