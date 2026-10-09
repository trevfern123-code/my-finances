-- After the overlap of one lock-comparison case (run.sh). psql variables: body = the timestamp of the migration
-- that installed the body under test (20260926120000 | 20261006120000 | 20261008120000); scenario.
-- Asserts what must hold whatever PostgreSQL decided (who waited, whether a deadlock was reported, which side
-- lost), retries the removal when it lost, and prints the facts as RESULT / WAIT / DETAIL / PROVENANCE lines;
-- run.sh compares those with what is documented for each body.
\set ON_ERROR_STOP 1
-- What the body does: from 20261006120000 on it evaluates; from 20261008120000 on it records provenance.
select :'body' in ('20261006120000', '20261008120000') as evaluates, :'body' = '20261008120000' as records_provenance \gset
select th.assert(:'body' in ('20260926120000', '20261006120000', '20261008120000'), 'the body under test is one this file knows');
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.item1() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.balance() returns numeric language sql as $$
  select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000c10f1' $$;
create function pg_temp.iv() returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = pg_temp.aa() $$;
create function pg_temp.ev() returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = pg_temp.aa() $$;

select th.assert((select count(*) from public.th_lc_outcome) = 2, 'both sessions recorded an outcome');
create temporary table o as
  select (select outcome from public.th_lc_outcome where who = 'removal') as r,
         (select sqlstate from public.th_lc_outcome where who = 'removal') as r_state,
         (select outcome from public.th_lc_outcome where who = 'writer') as w,
         (select sqlstate from public.th_lc_outcome where who = 'writer') as w_state;
select th.assert((select r in ('removed', 'error') and w in ('updated', 'error') and not (r = 'error' and w = 'error') from o),
  'each side either finished or failed, and at most one failed');
select th.assert((select (r <> 'error' or r_state = '40P01') and (w <> 'error' or w_state = '40P01') from o),
  'the only error either side saw is a deadlock detected by PostgreSQL (40P01)');

-- The waits a third session saw.
select th.assert(exists (select 1 from public.th_lc_waits where waiter = 'removal' and blocker = 'writer'),
  'observed: the removal waited for the row the writer held');
select th.assert((select r = 'error' or w = 'error' from o) = exists (select 1 from public.th_lc_waits where waiter = 'writer' and blocker = 'removal'),
  'observed: a deadlock was reported exactly when the writer also waited for the removal (the cycle)');

-- A removal that lost the deadlock rolled back COMPLETELY: nothing of it is left, and only the writer's
-- committed change (its row, one version bump) is there.
select th.assert((select r <> 'error' from o) or (
      (select status from public.plaid_items where id = pg_temp.item1()) = 'removing'
  and (select to_jsonb(x) from public.plaid_item_removals x where x.item_id = pg_temp.item1()) = (select removal from public.th_lc_seed)
  and (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id where a.item_id = pg_temp.item1())
      = (select item_txns + case when :'scenario' = 'S5' then 1 else 0 end from public.th_lc_seed)
  and (select count(*) from public.accounts where item_id = pg_temp.item1()) = (select item_accounts from public.th_lc_seed)
  and pg_temp.balance() = (select loan from public.th_lc_seed)
  and (select coalesce(jsonb_agg(to_jsonb(d) order by d.id), '[]'::jsonb) from public.card_payment_decisions d) = (select decisions from public.th_lc_seed)
  and (select coalesce(jsonb_agg(to_jsonb(s) order by s.transaction_id), '[]'::jsonb) from public.card_payment_leg_states s) = (select leg_states from public.th_lc_seed)
  and pg_temp.ev() = (select ev from public.th_lc_seed)
  and pg_temp.iv() = (select iv + 1 from public.th_lc_seed)
  and (select amount from public.transactions where plaid_transaction_id = 'lc-held')
      = (select held_amount - case when :'scenario' in ('S4', 'S5') then 0 else 1 end from public.th_lc_seed)
  and (select exclude_from_cash_flow from public.accounts where id = '00000000-0000-0000-0000-0000000c1002') = (:'scenario' = 'S4')),
  'the removal that lost rolled back completely: item, accounts, rows, removal operation, loan balance, decisions, stored states and evaluated version are as before; only the writer''s change and its one bump are there');
select th.assert((select w <> 'error' or r = 'removed' from o), 'when the writer lost, the removal completed');

-- Provenance (20261008120000), before the retry. A removal that lost the deadlock left NONE:
-- no generation row and no source row. (Where the delete is what lost — S1 to S3 — it had written both.) The
-- seed emptied both tables, and this removal is the only one that ran.
\if :records_provenance
create temporary table lost as
  select (select count(*) from public.card_payment_removal_generations) as generations,
         (select count(*) from public.card_payment_removal_sources) as sources;
select th.assert((select r <> 'error' from o) or (select generations = 0 and sources = 0 from lost),
  'the removal that lost left no generation row and no source row');
\else
select th.assert(to_regclass('public.card_payment_removal_generations') is null and to_regclass('public.card_payment_removal_sources') is null,
  'this body is measured without the provenance tables: the migration that creates them is not applied yet');
\endif

-- The retry of a removal that lost: the same call.
create temporary table retry as
  select case when (select r from o) = 'error' then public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1()) end as v;
select th.assert((select r <> 'error' from o)
                 or (select (v->>'replayed')::boolean = false and jsonb_array_length(v->'loan_adjustments') = 1
                            and (v->'loan_adjustments'->0->>'restored')::numeric = 100 from retry),
  'the removal that lost is retryable: the same call then runs and restores the loan');

-- At the end, in every case: removed once, restored once.
select th.assert(not exists (select 1 from public.plaid_items where id = pg_temp.item1())
                 and not exists (select 1 from public.accounts where item_id = pg_temp.item1())
                 and not exists (select 1 from public.transactions where plaid_transaction_id in ('lc-held', 'lc-x', 'lc-loanpay', 'lc-new'))
                 and (select status = 'cleaned' and jsonb_array_length(loan_adjustments) = 1 from public.plaid_item_removals where item_id = pg_temp.item1())
                 and pg_temp.balance() = 1000,
  'at the end the item is removed, the operation is cleaned, and the loan was restored exactly once (900 -> 1000)');
select th.assert((public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1())->>'replayed')::boolean and pg_temp.balance() = 1000,
  'and a replay restores nothing again');

-- The final matching state: fresh, or unreadable. Never states of an older version.
create temporary table fin as select public.get_card_payment_states(pg_temp.aa()) as s;
select th.assert((select coalesce((s->>'fresh')::boolean, false) or not (s ? 'legs') from fin), 'final state: fresh, or no states at all');
select th.assert((select not coalesce((s->>'fresh')::boolean, false)
                         or (pg_temp.iv() = pg_temp.ev()
                             and not exists (select 1 from public.card_payment_leg_states ls
                                             where ls.user_id = pg_temp.aa() and not exists (select 1 from public.transactions t where t.id = ls.transaction_id))
                             and (select (l->>'state') || '/' || (l->>'reason') || '/' || (l->>'effectCents') from jsonb_array_elements(s->'legs') l
                                  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'lc-k'))
                                 = 'untracked/removed_card/-6000')
                  from fin),
  'when fresh: at the current version, no state of a deleted row, and the surviving payment reads removed_card −60');
\if :evaluates
select th.assert((select (s->>'fresh')::boolean from fin), 'a body that evaluates: the removal that completed committed fresh states');
\else
select th.assert((select not coalesce((s->>'fresh')::boolean, false) from fin) and pg_temp.iv() > pg_temp.ev(),
  'the 20260926120000 body: the removal does not evaluate, so the user is stale (unreadable) after it');
\endif

-- Provenance (20261008120000), at the end, whichever side lost. The removal that completed is the user's first
-- and only generation — a lost attempt left no gap in the order — and the ONE decision it wrote has its ONE
-- source: the removed card leg lc-x (−60, 2026-09-04) on card X. In S1, S4 and S5 that leg was the surviving
-- payment's automatic partner (a system record); in S2 and S3 the counterpart the user confirmed (the user's
-- preserved pair). The fixture has no kept card leg, so no hold is written in any case.
\if :records_provenance
select :'scenario' in ('S2', 'S3') as confirmed \gset
select th.assert((select count(*) = 1
                         and bool_and(g.removal_id = (select x.id from public.plaid_item_removals x where x.item_id = pg_temp.item1())
                                      and g.user_id = pg_temp.aa() and g.ordinal = 1 and g.sources_recorded and g.institution_id is null)
                  from public.card_payment_removal_generations g),
  'the removal that completed has the user''s one generation: its own ledger row, recorded, first in the order, no institution id (the item had none)');
select th.assert((select count(*) = 1 from public.card_payment_decisions)
                 and (select count(*) = 1
                             and bool_and(d.user_id = pg_temp.aa() and d.superseded_by is null
                                          and d.kind = case when :'confirmed' then 'pair_counterpart_removed' else 'destination_removed_card' end
                                          and d.a_account_id = '00000000-0000-0000-0000-0000000c1004' and d.a_plaid_transaction_id = 'lc-k' and d.a_cents = 6000
                                          and d.b_account_id is null
                                          and d.b_plaid_transaction_id is not distinct from case when :'confirmed' then 'lc-x' end
                                          and d.b_cents is not distinct from case when :'confirmed' then -6000 end
                                          and d.counterpart_status is not distinct from case when :'confirmed' then 'valid' end
                                          and s.user_id = pg_temp.aa()
                                          and s.removal_id = (select x.id from public.plaid_item_removals x where x.item_id = pg_temp.item1())
                                          and s.source_relation = case when :'confirmed' then 'confirmed_counterpart' else 'automatic_partner' end
                                          and s.source_resolution = 'row'
                                          and s.source_plaid_account_id = 'lc-x-card' and s.source_plaid_transaction_id = 'lc-x'
                                          and s.source_pending_transaction_id is null and s.source_pending = false
                                          and s.source_date = date '2026-09-04' and s.source_cents = -6000 and s.source_iso_currency_code = 'USD'
                                          and s.source_account_type = 'credit' and s.source_account_subtype is null and s.source_account_mask is null)
                      from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id),
  'the one decision the removal wrote — on the surviving payment lc-k — has its one source: this removal, card X, the removed leg lc-x, and what that leg was to the payment');
\endif

\pset tuples_only on
\pset format unaligned
select 'RESULT removal=' || r || coalesce('(' || r_state || ')', '') || ' writer=' || w || coalesce('(' || w_state || ')', '')
       || ' deadlock=' || case when r = 'error' or w = 'error' then 'yes' else 'no' end
       || ' victim=' || case when r = 'error' then 'removal' when w = 'error' then 'writer' else 'none' end
       || ' removal_retried=' || case when r = 'error' then 'yes' else 'no' end
       || ' final=' || (select case when coalesce((s->>'fresh')::boolean, false) then 'fresh' else 'stale-unreadable' end from fin)
       || ' loan=' || pg_temp.balance()
from o;
select 'WAIT ' || waiter || ' waited for ' || blocker || ' (' || string_agg(wait_event, ', ' order by wait_event) || ')'
from public.th_lc_waits group by waiter, blocker order by waiter;
select 'DETAIL ' || who || ' saw: ' || replace(detail, E'\n', ' | ') from public.th_lc_outcome where detail is not null order by who;
\if :records_provenance
select 'PROVENANCE ' || case when r = 'error' then 'after the removal lost: generations=' || (select generations from lost) || ' sources=' || (select sources from lost) || '; ' else '' end
       || 'at the end: generation ' || (select string_agg(g.ordinal || case when g.sources_recorded then ' (recorded)' else ' (marker)' end, ', ' order by g.ordinal)
                                         from public.card_payment_removal_generations g)
       || '; ' || (select string_agg(d.kind || '(' || d.a_plaid_transaction_id || ')<=' || s.source_plaid_account_id || ':' || s.source_plaid_transaction_id
                                     || '[' || s.source_relation || ']', ', ' order by d.id)
                   from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id)
from o;
\endif
