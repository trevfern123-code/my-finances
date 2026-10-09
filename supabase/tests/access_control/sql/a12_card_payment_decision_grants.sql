-- Card-payment decision RPCs (migration 20261001120000; acceptance test 22): every new function is
-- SECURITY INVOKER with search_path pinned, executable by service_role only; no client role can call
-- any of them; the decision table's privileges are unchanged. The migration's postcondition checks the
-- catalog; this test also exercises it at runtime, exactly as PostgREST would.

-- ---- Catalog --------------------------------------------------------------------------------------------
create temporary table fns (sig text primary key);
insert into pg_temp.fns values
  ('public.card_payment_decision_begin(uuid, bigint, text)'),
  ('public.card_payment_decision_target(uuid, uuid, text)'),
  ('public.card_payment_decision_check_leg(boolean, boolean, text, bigint, text)'),
  ('public.card_payment_lineage_row(uuid, text)'),
  ('public.card_payment_live_decisions(uuid)'),
  ('public.card_payment_decision_rows(uuid, uuid[])'),
  ('public.card_payment_decision_result(uuid, text, text, uuid, uuid[], uuid[], boolean)'),
  ('public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'),
  ('public.mark_card_payment_destination(uuid, uuid, bigint)'),
  ('public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint)'),
  ('public.undo_card_payment_decision(uuid, uuid, bigint)');
select th.assert((select count(*) from pg_temp.fns f join pg_proc p on p.oid = f.sig::regprocedure
                  where not p.prosecdef and p.proconfig = array['search_path=""']
                    and has_function_privilege('service_role', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and not has_function_privilege('public', p.oid, 'execute')) = 11,
  'all eleven functions are SECURITY INVOKER, search_path pinned, service_role only');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and (p.proname like 'card\_payment\_%' or p.proname like '%\_card\_payment%')
                    and p.prosecdef) = 0, 'no card-payment function is SECURITY DEFINER');
select th.assert(not exists (select 1 from information_schema.role_table_grants
                             where table_name = 'card_payment_decisions' and grantee in ('anon', 'authenticated', 'PUBLIC')),
  'no client grant on the decision table');
select th.assert(col_description('public.card_payment_decisions'::regclass,
                   (select attnum from pg_attribute where attrelid = 'public.card_payment_decisions'::regclass and attname = 'superseded_by'))
                 like 'NULL: live.%own id: explicitly undone%', 'the superseded_by convention is documented on the column');

-- ---- Runtime: a client request (anon key + the owner's JWT), and anon ------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.link_card_payment('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), gen_random_uuid(), 0, 1) $q$,
                       '%permission denied for function link_card_payment%');
select th.expect_error($q$ select public.mark_card_payment_destination('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), 1) $q$,
                       '%permission denied for function mark_card_payment_destination%');
select th.expect_error($q$ select public.dismiss_card_payment_candidate('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), gen_random_uuid(), 1) $q$,
                       '%permission denied for function dismiss_card_payment_candidate%');
select th.expect_error($q$ select public.undo_card_payment_decision('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), 1) $q$,
                       '%permission denied for function undo_card_payment_decision%');
select th.expect_error($q$ select public.card_payment_decision_begin('00000000-0000-0000-0000-0000000000aa', 1, 'x') $q$,
                       '%permission denied for function card_payment_decision_begin%');
select th.expect_error($q$ select * from public.card_payment_live_decisions('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%permission denied for function card_payment_live_decisions%');
select th.expect_error($q$ select public.card_payment_lineage_row(gen_random_uuid(), 'x') $q$,
                       '%permission denied for function card_payment_lineage_row%');
rollback;

begin;
set local role anon;
select th.expect_error($q$ select public.link_card_payment('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), gen_random_uuid(), 0, 1) $q$,
                       '%permission denied for function link_card_payment%');
select th.expect_error($q$ select public.undo_card_payment_decision('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), 1) $q$,
                       '%permission denied for function undo_card_payment_decision%');
rollback;

-- ---- service_role: callable (refused here only by the version check: aa was never evaluated) --------------
begin;
set local role service_role;
select th.expect_error($q$ select public.link_card_payment('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), gen_random_uuid(), 0, 1) $q$,
                       'card_payment_stale_version: link_card_payment:%');
rollback;
