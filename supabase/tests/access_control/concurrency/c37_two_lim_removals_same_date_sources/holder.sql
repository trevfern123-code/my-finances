-- The first removal (item 1). It runs to its end inside this transaction, which then stays open — holding L1 —
-- until the second removal is observed blocked by this backend; it records WHAT that removal is waiting on,
-- leaves the row by which the second removal later tells that this one had committed, and commits.
begin;
do $$
declare
  v_result jsonb;
  v_contender integer;
  v_seen text;
begin
  perform set_config('role', 'service_role', true);
  v_result := public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');
  insert into public.th_c37_outcome values ('holder', case when (v_result->>'replayed')::boolean then 'replayed' else 'removed' end);
  -- The two holds this removal wrote for its candidate x1q, by id: on the pair with the kept card, and on the
  -- pair with the OTHER removal's card — which names X2's account and will go with it.
  insert into public.th_c37_outcome
  select 'holder-hold-' || d.a_plaid_transaction_id, string_agg(d.id::text, ',')
  from public.card_payment_decisions d
  where d.kind = 'ambiguity_hold_removed_card' and d.b_plaid_transaction_id = 'c37-q' and d.superseded_by is null
  group by d.a_plaid_transaction_id;
  -- (Read with dynamic SQL so that this file also runs where the provenance tables do not exist.)
  if to_regclass('public.card_payment_removal_sources') is null then
    v_seen := 'no provenance tables';
  else
    execute $q$ select coalesce(string_agg(r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || s.source_plaid_transaction_id, ','), 'none')
                from public.card_payment_removal_sources s
                join public.card_payment_decisions d on d.id = s.decision_id
                join public.plaid_item_removals r on r.id = s.removal_id
                where d.a_plaid_transaction_id = 'c37-x2q' and d.b_plaid_transaction_id = 'c37-q' $q$ into v_seen;
  end if;
  insert into public.th_c37_outcome values ('holder-source-of-hold-c37-x2q', v_seen);

  perform set_config('role', 'none', true);
  perform set_config('application_name', 'c37-holder', false);
  v_contender := th.wait_for_application('c37-contender');
  perform th.wait_until_blocked_by(v_contender, pg_backend_pid());
  -- What the contender is waiting on, recorded while it waits: the lock types of its ungranted requests.
  insert into public.th_c37_outcome values ('contender-waits-on',
    (select coalesce(string_agg(l.locktype, ',' order by l.locktype), 'nothing') from pg_locks l where l.pid = v_contender and not l.granted));
  perform set_config('role', 'service_role', true);
  insert into public.th_c37_outcome values ('holder-saw', 'contender_blocked');
  if to_regclass('public.card_payment_removal_generations') is null then
    v_seen := 'no provenance tables';
  else
    execute $q$ select case when exists (select 1 from public.card_payment_removal_generations g
                                          join public.plaid_item_removals r on r.id = g.removal_id
                                          where r.item_id = '00000000-0000-0000-0000-000000000004')
                            then 'generation_exists' else 'no_generation' end $q$ into v_seen;
  end if;
  insert into public.th_c37_outcome values ('probe', v_seen);
end $$;
commit;
