-- One capture-cost measurement (capture_cost.sh runs it; psql variables: shape, n, timeout_ms).
--   shape = ordinary  n payments, each with its OWN amount: k_i (+, C, the 10th), x_i (−, removed card X, the 11th),
--                     y_i (−, kept card Y, the 12th). One record and one hold per payment.
--                     By hand: n affected payments → n obligations, n known edges, 2n sources.
--   shape = dense     n payments of ONE amount on one day, n removed card legs and n kept card legs of that amount on
--                     the same day: every payment ties between all 2n cards. No automatic match, so no record; one hold
--                     per (payment, removed candidate, kept candidate).
--                     By hand: n obligations, n × n known edges, n × n × n sources (and as many holds).
--   shape = allremoved  the dense shape WITHOUT the kept card: n payments of one amount on one day and n removed card
--                     legs of that amount on the same day; nothing else. Every payment ties between n cards that are
--                     ALL removed: no automatic match (no record) and no surviving competitor (no hold) — the removal
--                     writes NO decision. The capture reads the payments from the eligible graph all the same.
--                     By hand: n obligations, 0 known edges, n × n graph-observed sources, 0 decisions.
-- The removal is then run inside one transaction with a statement timeout of :timeout_ms (0 = none). The script
-- prints one line "COST|…" with the row counts and the wall time of the removal call, and asserts that the capture is
-- COMPLETE — or, when the timeout cancelled it, that NOTHING was removed and nothing written.
\set ON_ERROR_STOP on
set role service_role;
select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'cost-item-kept', 'Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000cc0a1', '00000000-0000-0000-0000-000000000001', 'cost-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000cc0b1', '00000000-0000-0000-0000-000000000003', 'cost-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000cc0b2', '00000000-0000-0000-0000-000000000003', 'cost-y', 'credit');
select rrh.cardleg('k-' || i, '00000000-0000-0000-0000-0000000cc0b1', case :'shape' when 'ordinary' then 100 + i else 500 end, '2026-09-10'),
       rrh.cardleg('x-' || i, '00000000-0000-0000-0000-0000000cc0a1', -(case :'shape' when 'ordinary' then 100 + i else 500 end), case :'shape' when 'ordinary' then date '2026-09-11' else date '2026-09-10' end)
from generate_series(1, :n) i;
select rrh.cardleg('y-' || i, '00000000-0000-0000-0000-0000000cc0b2', -(case :'shape' when 'ordinary' then 100 + i else 500 end), case :'shape' when 'ordinary' then date '2026-09-12' else date '2026-09-10' end)
from generate_series(1, :n) i where :'shape' <> 'allremoved';
select th.assert(public.begin_plaid_item_removal(rrh.aa(), '00000000-0000-0000-0000-000000000001', public.plaid_item_removal_digest(rrh.aa(), '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'the removal begins');
select public.record_plaid_item_removal_attempt(rrh.aa(), '00000000-0000-0000-0000-000000000001', 'removed', null);

create temporary table expected as
  select :n::bigint as obligations,
         case :'shape' when 'dense' then :n::bigint * :n when 'allremoved' then 0 else :n end as edges,
         case :'shape' when 'dense' then :n::bigint * :n * :n when 'allremoved' then :n::bigint * :n else 2 * :n end as sources,
         case :'shape' when 'dense' then :n::bigint * :n * :n when 'allremoved' then 0 else 2 * :n end as decisions,
         case :'shape' when 'allremoved' then 2 * :n else 3 * :n end as legs;
create temporary table run (outcome text, ms numeric);
grant all on pg_temp.run to service_role;

-- The removal, timed, under the statement timeout. The timeout is set for the SESSION before the statement starts
-- (a timeout changed inside a running statement does not apply to it). A cancelled statement aborts the whole
-- removal call: PL/pgSQL's "when others" does not catch a cancellation, so the removal's own handlers cannot turn
-- it into a partial result; this block catches it only to record that it happened.
select set_config('statement_timeout', current_setting('cost.timeout_ms'), false);
do $$
declare
  v_start timestamptz := clock_timestamp();
begin
  begin
    perform public.remove_plaid_item_local(rrh.aa(), '00000000-0000-0000-0000-000000000001');
    insert into pg_temp.run values ('removed', round(extract(epoch from clock_timestamp() - v_start) * 1000, 1));
  exception when query_canceled then
    insert into pg_temp.run values ('cancelled', round(extract(epoch from clock_timestamp() - v_start) * 1000, 1));
  end;
end $$;
set statement_timeout = 0;

create temporary table counted as
  select (select count(*) from public.card_payment_review_obligations) as obligations,
         (select count(*) from public.card_payment_review_memberships) as edges,
         (select count(*) from public.card_payment_review_obligation_sources) as sources,
         (select count(*) from public.card_payment_decisions) as decisions,
         (select count(*) from public.card_payment_removal_sources) as provenance,
         (select count(*) from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') as item_rows,
         (select status from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000001') as removal_status;

select th.assert((select outcome from pg_temp.run) = 'removed'
                 and (select (c.obligations, c.edges, c.sources, c.decisions, c.provenance) = (e.obligations, e.edges, e.sources, e.decisions, e.decisions)
                             and c.item_rows = 0 and c.removal_status = 'cleaned' from pg_temp.counted c, pg_temp.expected e),
                 'COMPLETE CAPTURE: every obligation, known edge and source the hand count requires was written: ' || (select row(c.*)::text from pg_temp.counted c))
where (select outcome from pg_temp.run) = 'removed';
-- The all-removed shape: NO decision was written, and every source is a graph-observed one that names none.
select th.assert((select count(*) = (select e.sources from pg_temp.expected e) and bool_and(s.evidence_kind = 'graph_source' and s.decision_id is null)
                  from public.card_payment_review_obligation_sources s)
                 and (select count(*) from public.card_payment_decisions) = 0,
                 'COMPLETE CAPTURE WITHOUT A DECISION: every removed candidate of every payment is a graph-observed source; no hold and no record was written')
where (select outcome from pg_temp.run) = 'removed' and :'shape' = 'allremoved' and (select count(*) from public.card_payment_review_obligations) > 0;
-- Every obligation has all of its edges: none was truncated to fit a budget.
select th.assert((select bool_and(n = (select e.edges / e.obligations from pg_temp.expected e))
                  from (select count(m.*) as n from public.card_payment_review_obligations o
                        left join public.card_payment_review_memberships m on m.obligation_id = o.id group by o.id) q),
                 'COMPLETE CAPTURE: every obligation lists every surviving edge of its payment')
where (select outcome from pg_temp.run) = 'removed';
select th.assert((select (c.obligations, c.edges, c.sources, c.decisions, c.provenance, c.item_rows, c.removal_status) = (0, 0, 0, 0, 0, 1, 'plaid_removed') from pg_temp.counted c)
                 and (select count(*) from public.transactions) = (select e.legs from pg_temp.expected e),
                 'STRICT ROLLBACK: a removal cancelled by its timeout removed nothing and wrote nothing: ' || (select row(c.*)::text from pg_temp.counted c))
where (select outcome from pg_temp.run) = 'cancelled';

\pset format unaligned
\pset tuples_only on
select 'COST|' || :'shape' || '|n=' || :n || '|timeout_ms=' || current_setting('cost.timeout_ms') || '|' || r.outcome || '|removal_ms=' || r.ms
       || '|obligations=' || c.obligations || '|edges=' || c.edges || '|sources=' || c.sources || '|decisions=' || c.decisions
from pg_temp.run r, pg_temp.counted c;
