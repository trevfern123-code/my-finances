-- Card-payment matching state (migration 20260930120000; CARD_PAYMENT_PAIRING_DESIGN.md §3.5,
-- acceptance test 22): no client role can read or write any card-payment table or call any of its
-- functions; service_role can; the trigger functions are executable by no role. The migration's own
-- postcondition checks the catalog; this test exercises it at runtime, exactly as PostgREST would.

-- ---- Catalog: exact function properties -------------------------------------------------------------
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('card_payment_bump', 'evaluate_card_payments',
                    'try_evaluate_card_payments', 'get_card_payment_states')
                    and not p.prosecdef and p.proconfig = array['search_path=""']
                    and has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and not has_function_privilege('public', p.oid, 'execute')) = 4,
  'the four callable functions are SECURITY INVOKER, search_path pinned, service_role only');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('card_payment_decisions_same_user', 'card_payment_bump_transactions',
                    'card_payment_bump_accounts', 'card_payment_bump_plaid_items', 'card_payment_bump_decisions',
                    'card_payment_bump_carryovers')
                    and not p.prosecdef and p.proconfig = array['search_path=""']
                    and not has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')) = 6,
  'the six trigger functions are executable by no role');
select th.assert(not exists (select 1 from pg_policies where tablename like 'card\_payment\_%'),
  'no RLS policy on any card-payment table');
select th.assert((select count(*) from pg_class where relname in ('card_payment_eval_versions', 'card_payment_decisions',
                    'card_payment_leg_states', 'card_payment_auto_pairs', 'card_payment_decision_states')
                    and relrowsecurity) = 5, 'row level security is on for all five tables');

-- ---- Runtime: a client request (anon key + the owner's JWT) --------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select * from public.card_payment_eval_versions $q$, '%permission denied for table card_payment_eval_versions%');
select th.expect_error($q$ select * from public.card_payment_decisions $q$, '%permission denied for table card_payment_decisions%');
select th.expect_error($q$ select * from public.card_payment_leg_states $q$, '%permission denied for table card_payment_leg_states%');
select th.expect_error($q$ select * from public.card_payment_auto_pairs $q$, '%permission denied for table card_payment_auto_pairs%');
select th.expect_error($q$ select * from public.card_payment_decision_states $q$, '%permission denied for table card_payment_decision_states%');
select th.expect_error($q$ insert into public.card_payment_eval_versions (user_id, input_version, evaluated_version)
                          values ('00000000-0000-0000-0000-0000000000aa', 0, 0) $q$, '%permission denied for table card_payment_eval_versions%');
select th.expect_error($q$ update public.card_payment_eval_versions set evaluated_version = input_version $q$,
                       '%permission denied for table card_payment_eval_versions%');
select th.expect_error($q$ select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function evaluate_card_payments%');
select th.expect_error($q$ select public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function try_evaluate_card_payments%');
select th.expect_error($q$ select public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function get_card_payment_states%');
select th.expect_error($q$ select public.card_payment_bump('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function card_payment_bump%');
select th.expect_error($q$ select nextval('public.card_payment_decisions_seq') $q$, '%permission denied for sequence card_payment_decisions_seq%');
rollback;

begin;
set local role anon;
select th.expect_error($q$ select * from public.card_payment_leg_states $q$, '%permission denied for table card_payment_leg_states%');
select th.expect_error($q$ select public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function get_card_payment_states%');
rollback;

-- ---- service_role: the backend can evaluate and read ---------------------------------------------------
begin;
set local role service_role;
select th.assert(public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa') >= 0, 'service_role evaluates');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'service_role reads a fresh result');
-- service_role cannot update the derived tables in place (only the evaluator's delete + insert).
select th.expect_error($q$ update public.card_payment_leg_states set state = 'tracked' $q$, '%permission denied for table card_payment_leg_states%');
rollback;
