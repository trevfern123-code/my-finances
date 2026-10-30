-- Owner isolation, grants, forged owners, foreign ids, pagination and what an answer may contain
-- (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §6). The backend derives the owner from the verified session and calls
-- these functions as the service role; no client role can reach any of them, or any of the tables.
--
-- User aa: item 1 "Card Bank" (card X) is removed; item 3 stays (checking C, card Y); item 8 brings card W
-- afterwards. Three affected payments, on the 8th, 9th and 10th, each with an unrelated w leg on its own day
-- afterwards, so each is guarded. User bb: the same shape with one payment (item 2 removed, item 5 kept, item 9).
set role service_role;

update public.plaid_items set institution_name = 'Card Bank' where id = '00000000-0000-0000-0000-000000000001';
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r04-item-kept', 'Kept Bank');
select rrh.item('00000000-0000-0000-0000-000000000005', rrh.bb(), 'r04-item-bb-kept', 'BB Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000104a1', '00000000-0000-0000-0000-000000000001', 'r04-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000104b1', '00000000-0000-0000-0000-000000000003', 'r04-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000104b2', '00000000-0000-0000-0000-000000000003', 'r04-y', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000104c1', '00000000-0000-0000-0000-000000000002', 'r04-bx', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000104d1', '00000000-0000-0000-0000-000000000005', 'r04-bc', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000104d2', '00000000-0000-0000-0000-000000000005', 'r04-by', 'credit');
select rrh.cardleg('k-' || n, '00000000-0000-0000-0000-0000000104b1', 100 + 10 * n, date '2026-09-07' + n),
       rrh.cardleg('x-' || n, '00000000-0000-0000-0000-0000000104a1', -(100 + 10 * n), date '2026-09-08' + n),
       rrh.cardleg('y-' || n, '00000000-0000-0000-0000-0000000104b2', -(100 + 10 * n), date '2026-09-09' + n)
from generate_series(1, 3) n;
select rrh.cardleg('bk', '00000000-0000-0000-0000-0000000104d1', 200, '2026-09-10'), rrh.cardleg('bx', '00000000-0000-0000-0000-0000000104c1', -200, '2026-09-11'),
       rrh.cardleg('by', '00000000-0000-0000-0000-0000000104d2', -200, '2026-09-12');
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001'), rrh.remove(rrh.bb(), '00000000-0000-0000-0000-000000000002');
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'r04-item-other', 'Other Bank');
select rrh.item('00000000-0000-0000-0000-000000000009', rrh.bb(), 'r04-item-bb-other', 'BB Other Bank');
select rrh.account('00000000-0000-0000-0000-0000000104e1', '00000000-0000-0000-0000-000000000008', 'r04-w', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000104e2', '00000000-0000-0000-0000-000000000009', 'r04-bw', 'credit');
select rrh.cardleg('w-' || n, '00000000-0000-0000-0000-0000000104e1', -(100 + 10 * n), date '2026-09-07' + n) from generate_series(1, 3) n;
select rrh.cardleg('bw', '00000000-0000-0000-0000-0000000104e2', -200, '2026-09-10');
select public.evaluate_card_payments(rrh.aa()), public.evaluate_card_payments(rrh.bb());
select th.assert(rrh.review('k-1') = 'withheld=w-1 obligations=1 gap=f' and rrh.review('bk', rrh.bb()) = 'withheld=bw obligations=1 gap=f', 'fixture: both users have guarded payments');

-- ==== 1. Catalog ==============================================================================================
create temporary table new_tables (t text primary key);
insert into pg_temp.new_tables values ('card_payment_review_obligations'), ('card_payment_review_obligation_sources'),
  ('card_payment_review_memberships'), ('card_payment_review_states'), ('card_payment_evaluator_contracts'),
  ('card_payment_review_revisions'), ('card_payment_review_annotations'), ('card_payment_recovery_actions'),
  ('card_payment_recovery_refresh_queue');
select th.assert(not exists (select 1 from pg_temp.new_tables n cross join unnest(array['anon', 'authenticated', 'public']) r
                             cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain']) p
                             where has_table_privilege(r, ('public.' || n.t)::regclass, p)),
                 'catalog: no client role has any privilege on any new table');
select th.assert((select bool_and(c.relrowsecurity) from pg_temp.new_tables n join pg_class c on c.oid = ('public.' || n.t)::regclass)
                 and not exists (select 1 from pg_policies p join pg_temp.new_tables n on n.t = p.tablename where p.schemaname = 'public'),
                 'catalog: row level security is on for all nine, with no policy');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                             where ns.nspname = 'public' and (p.proname like '%card\_payment\_recovery%' or p.proname like 'card\_payment\_review\_%')
                               and (p.prosecdef or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                                    or has_function_privilege('public', p.oid, 'execute'))),
                 'catalog: no recovery or review function is SECURITY DEFINER or executable by a client role');
select th.assert((select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and (p.proname like '%card\_payment\_recovery%' or p.proname like 'card\_payment\_review\_%')) = 15,
                 'catalog: fifteen recovery and review functions exist (a new one must be added to this test deliberately)');
-- The obligations, their sources, the known edges, the annotations and the receipts are append-only for the
-- application: the service role itself cannot change or delete one.
select th.expect_error($$update public.card_payment_review_obligations set origin = 'gap'$$, '%permission denied%');
select th.expect_error($$delete from public.card_payment_review_obligations$$, '%permission denied%');
select th.expect_error($$delete from public.card_payment_review_memberships$$, '%permission denied%');
select th.expect_error($$delete from public.card_payment_review_obligation_sources$$, '%permission denied%');
select th.expect_error($$update public.card_payment_recovery_actions set outcome = 'undone'$$, '%permission denied%');
select th.expect_error($$delete from public.card_payment_recovery_actions$$, '%permission denied%');
select th.expect_error($$delete from public.card_payment_review_annotations$$, '%permission denied%');

-- ==== 2. A client request (anon key and the owner's JWT), and anon ==============================================
create function pg_temp.client_attempts() returns table (what text, statement text) language sql as $$
  select 'read ' || n.t, format('select count(*) from public.%I', n.t) from pg_temp.new_tables n
  union all select 'write ' || n.t, format('delete from public.%I', n.t) from pg_temp.new_tables n
  union all values
    ('reviews', $q$select public.get_card_payment_recovery_reviews('00000000-0000-0000-0000-0000000000aa')$q$),
    ('receipt', $q$select public.get_card_payment_recovery_action('00000000-0000-0000-0000-0000000000aa', gen_random_uuid())$q$),
    ('action', $q$select public.apply_card_payment_recovery_action('00000000-0000-0000-0000-0000000000aa', gen_random_uuid(), 1, 1, '{"action":"defer"}')$q$),
    ('refresh request', $q$select public.request_card_payment_recovery_refresh('00000000-0000-0000-0000-0000000000aa', gen_random_uuid())$q$),
    ('claim', $q$select public.claim_card_payment_recovery_refresh(gen_random_uuid(), 10)$q$),
    ('refresh', $q$select public.refresh_card_payment_recovery_owner('00000000-0000-0000-0000-0000000000aa', gen_random_uuid())$q$),
    ('capture', $q$select public.card_payment_review_capture('00000000-0000-0000-0000-0000000000aa', gen_random_uuid())$q$),
    ('seed', $q$select public.card_payment_review_seed_retained()$q$),
    ('freshness', $q$select public.card_payment_recovery_freshness('00000000-0000-0000-0000-0000000000aa')$q$),
    ('states', $q$select public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')$q$) $$;
grant execute on function pg_temp.client_attempts() to anon, authenticated;
grant select on pg_temp.new_tables to anon, authenticated;
reset role;
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
select th.expect_error(a.statement, '%permission denied%') from pg_temp.client_attempts() a;
commit;
begin;
set local role anon;
select th.expect_error(a.statement, '%permission denied%') from pg_temp.client_attempts() a;
commit;
set role service_role;

-- ==== 3. A forged or foreign owner ===============================================================================
-- The same refusal for bb naming aa's payment as for an id that does not exist: nothing is disclosed.
create temporary table counts_before as
  select (select count(*) from public.card_payment_recovery_actions) as receipts, (select count(*) from public.card_payment_decisions) as decisions,
         (select count(*) from public.card_payment_review_annotations) as notes, rrh.iv() as aa_iv, rrh.iv(rrh.bb()) as bb_iv;
create temporary table refusals (name text primary key, answer jsonb not null);
insert into pg_temp.refusals values
  ('foreign subject', rrh.act(rrh.op(1), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k-1')), rrh.bb())),
  ('unknown subject', rrh.act(rrh.op(2), jsonb_build_object('action', 'defer', 'transactionId', gen_random_uuid()), rrh.bb())),
  ('foreign counterpart', rrh.act(rrh.op(3), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('bk'), 'counterpartTransactionId', rrh.tid('w-1'), 'acceptedDifferenceCents', 9900), rrh.bb())),
  ('unknown counterpart', rrh.act(rrh.op(4), jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('bk'), 'counterpartTransactionId', gen_random_uuid(), 'acceptedDifferenceCents', 9900), rrh.bb())),
  ('foreign decision', rrh.act(rrh.op(5), jsonb_build_object('action', 'undo_decision', 'decisionId', (select d.id from public.card_payment_decisions d where d.user_id = rrh.aa() limit 1)), rrh.bb())),
  ('unknown decision', rrh.act(rrh.op(6), jsonb_build_object('action', 'undo_decision', 'decisionId', gen_random_uuid()), rrh.bb()));
select th.assert((select answer->>'refused' from pg_temp.refusals where name = 'foreign subject') = (select answer->>'refused' from pg_temp.refusals where name = 'unknown subject')
                 and (select answer->>'refused' from pg_temp.refusals where name = 'foreign subject') like 'card_payment_recovery_not_reviewable:%',
                 'another user''s payment is refused exactly like an unknown id: ' || (select answer->>'refused' from pg_temp.refusals where name = 'foreign subject'));
select th.assert((select answer->>'refused' from pg_temp.refusals where name = 'foreign counterpart') = (select answer->>'refused' from pg_temp.refusals where name = 'unknown counterpart')
                 and (select answer->>'refused' from pg_temp.refusals where name = 'foreign counterpart') like 'card_payment_not_found:%',
                 'another user''s transaction as the counterpart is refused exactly like an unknown id: ' || (select answer->>'refused' from pg_temp.refusals where name = 'foreign counterpart'));
select th.assert((select answer->>'refused' from pg_temp.refusals where name = 'foreign decision') = (select answer->>'refused' from pg_temp.refusals where name = 'unknown decision')
                 and (select answer->>'refused' from pg_temp.refusals where name = 'foreign decision') like 'card_payment_not_found:%',
                 'another user''s decision is refused exactly like an unknown id: ' || (select answer->>'refused' from pg_temp.refusals where name = 'foreign decision'));
select th.assert(not exists (select 1 from pg_temp.refusals r where r.answer->>'refused' ~ '[0-9a-f]{8}-[0-9a-f]{4}'), 'no refusal message carries an identifier');
select th.assert((select (receipts, decisions, notes, aa_iv, bb_iv) from pg_temp.counts_before)
                 = ((select count(*) from public.card_payment_recovery_actions), (select count(*) from public.card_payment_decisions),
                    (select count(*) from public.card_payment_review_annotations), rrh.iv(), rrh.iv(rrh.bb())),
                 'the six refusals wrote nothing and moved no version, for either user');

-- An operation id belongs to its user: bb's use of an id does not collide with aa's, and bb cannot read aa's receipt.
select th.assert(rrh.outcome(rrh.act(rrh.op(7), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k-1')))) = 'committed_fresh', 'aa defers under operation 7');
select th.assert((public.get_card_payment_recovery_action(rrh.bb(), rrh.op(7))->>'found')::boolean = false and public.get_card_payment_recovery_action(rrh.bb(), rrh.op(7))->'receipt' = 'null'::jsonb,
                 'bb asking for aa''s operation id finds nothing');
select th.assert(rrh.outcome(rrh.act(rrh.op(7), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('bk')), rrh.bb())) = 'committed_fresh', 'bb may use the same operation id for its own request');
select th.assert((public.get_card_payment_recovery_action(rrh.aa(), rrh.op(7))->'receipt'->'intent'->>'transactionId')::uuid = rrh.tid('k-1')
                 and (public.get_card_payment_recovery_action(rrh.bb(), rrh.op(7))->'receipt'->'intent'->>'transactionId')::uuid = rrh.tid('bk'), 'each user reads its own receipt');

-- ==== 4. The review reader: scope, pagination, cursor, content ====================================================
create function pg_temp.page(p_user uuid, p_cursor text default null, p_limit integer default null) returns jsonb language sql as $$
  select public.get_card_payment_recovery_reviews(p_user, p_cursor, coalesce(p_limit, 20)) $$;
create function pg_temp.ids(p_page jsonb) returns text language sql as $$
  select coalesce(string_agg(rrh.pid((r->>'transactionId')::uuid), ',' order by ord), '') from jsonb_array_elements(p_page->'reviews') with ordinality x(r, ord) $$;
-- aa has six legs under review (three payments, three withheld card legs); newest first, then by id.
select th.assert((pg_temp.page(rrh.aa())->>'affectedPaymentCount')::integer = 6 and jsonb_array_length(pg_temp.page(rrh.aa())->'reviews') = 6 and pg_temp.page(rrh.aa())->>'nextCursor' is null,
                 'aa: six legs under review on one page: ' || pg_temp.ids(pg_temp.page(rrh.aa())));
select th.assert(not exists (select 1 from jsonb_array_elements(pg_temp.page(rrh.aa())->'reviews') r where rrh.pid((r->>'transactionId')::uuid) in ('bk', 'bw', 'by')), 'aa''s list holds nothing of bb');
select th.assert(pg_temp.ids(pg_temp.page(rrh.bb())) in ('bk,bw', 'bw,bk'), 'bb''s list holds exactly bb''s two legs: ' || pg_temp.ids(pg_temp.page(rrh.bb())));
create temporary table pages as
  with p1 as (select pg_temp.page(rrh.aa(), null, 4) as p), p2 as (select pg_temp.page(rrh.aa(), (select p->>'nextCursor' from p1), 4) as p)
  select (select p from p1) as first, (select p from p2) as second;
select th.assert((select jsonb_array_length(first->'reviews') = 4 and first->>'nextCursor' is not null and jsonb_array_length(second->'reviews') = 2 and second->>'nextCursor' is null from pg_temp.pages),
                 'a page of four, then the remaining two, then no cursor');
select th.assert((select string_to_array(pg_temp.ids(first) || ',' || pg_temp.ids(second), ',') = string_to_array(pg_temp.ids(pg_temp.page(rrh.aa())), ',') from pg_temp.pages),
                 'the two pages are the one-page list in the same order: nothing skipped, nothing repeated');
select th.assert((select (r->>'date') from jsonb_array_elements(pg_temp.page(rrh.aa())->'reviews') with ordinality x(r, o) where o = 1) = '2026-09-10', 'newest first');
select th.assert(jsonb_array_length(pg_temp.page(rrh.aa(), null, 0)->'reviews') = 1 and jsonb_array_length(pg_temp.page(rrh.aa(), null, 100000)->'reviews') = 6, 'the limit is clamped to 1..50');
select th.expect_error($$select public.get_card_payment_recovery_reviews('00000000-0000-0000-0000-0000000000aa', 'x''; drop table public.accounts; --', 5)$$, 'card_payment_recovery_invalid:%invalid_cursor%');
select th.expect_error($$select public.get_card_payment_recovery_reviews('00000000-0000-0000-0000-0000000000aa', '2026-13-45|00000000-0000-0000-0000-000000000000', 5)$$, 'card_payment_recovery_invalid:%invalid_cursor%');
-- A cursor is only a position: another user's cursor shows this user's rows, never the other's.
select th.assert(not exists (select 1 from jsonb_array_elements(pg_temp.page(rrh.bb(), (select first->>'nextCursor' from pg_temp.pages), 50)->'reviews') r
                             where rrh.pid((r->>'transactionId')::uuid) not in ('bk', 'bw')), 'a cursor taken from aa''s list shows bb only bb''s rows');
-- What a review says: the history, the suggestion (unverified), the figures of THIS evaluation; and what it
-- never carries: a token, a Plaid account or transaction id, an account mask or name.
create temporary table one_review as
  select r from jsonb_array_elements(pg_temp.page(rrh.aa())->'reviews') r where (r->>'transactionId')::uuid = rrh.tid('k-3');
select th.assert((select r->>'reason' = 'relink_review_required' and (r->>'guardWithheld')::boolean and (r->>'lowCents')::bigint = -13000 and (r->>'highCents')::bigint = 0
                         and r->>'effectCents' is null and (r->>'withheldPartnerTransactionId')::uuid = rrh.tid('w-3') and r->'controllingDecision' = 'null'::jsonb
                  from pg_temp.one_review), 'the review carries the guarded reading: ' || (select r::text from pg_temp.one_review));
select th.assert((select jsonb_array_length(r->'obligations') = 1 and r->'obligations'->0->>'origin' = 'captured' and r->'obligations'->0->>'completeness' = 'complete'
                         and r->'obligations'->0->>'institutionName' = 'Card Bank' and r->'obligations'->0->>'removedOn' is not null and r->'obligations'->0->>'gapReason' is null
                  from pg_temp.one_review), 'the review carries its obligation, with the removed institution''s name and the removal date');
select th.assert((select jsonb_array_length(r->'obligations'->0->'sources') = 2 and (r->'obligations'->0->>'knownSurvivingEdgeCount')::integer = 1
                         and (select bool_and((s->>'sourceKnown')::boolean and s->>'sourceDate' = '2026-09-11' and (s->>'sourceCents')::bigint = -13000)
                              from jsonb_array_elements(r->'obligations'->0->'sources') s)
                  from pg_temp.one_review), 'its two sources, each with the removed transaction''s date and amount, and its one known edge');
select th.assert((select (select count(*) from jsonb_array_elements(r->'candidates') c where (c->>'suggestionOnly')::boolean) = jsonb_array_length(r->'candidates')
                         and (select count(*) from jsonb_array_elements(r->'candidates') c where (c->>'withheldByGuard')::boolean and (c->>'transactionId')::uuid = rrh.tid('w-3')) = 1
                         and jsonb_array_length(r->'candidates') = 2
                  from pg_temp.one_review), 'both candidates are suggestions only; the withheld one is marked');
select th.assert(pg_temp.page(rrh.aa())::text !~ '(placeholder-token|access_token|r04-|harness-item|plaid|mask|k-3|w-3)', 'the answer carries no token, no Plaid identifier and no account detail');
