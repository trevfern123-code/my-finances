-- Prints, for each seed user whose states are fresh, ONE line
--     REF|<test name>|<user id>|<json>
-- holding the reference evaluator's complete INPUT, read from the rows as they are (accounts, transactions,
-- carry-overs, decisions, review obligations with their known edges), and what the SQL evaluator published for it.
-- reference/compare.cjs feeds the input to backend/src/services/cardPaymentMatching.ts and compares.
-- Run as postgres at the end of a test, with  -v test=<name>.  Reads only.
\pset format unaligned
\pset tuples_only on
select 'REF|' || :'test' || '|' || u.id::text || '|' || jsonb_build_object(
  'input', jsonb_build_object(
    'userId', u.id,
    'asOf', (select to_char(v.evaluated_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             from public.card_payment_eval_versions v where v.user_id = u.id),
    'accounts', (
      select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'userId', i.user_id, 'type', a.type,
                                                   'excludeFromCashFlow', a.exclude_from_cash_flow) order by a.id), '[]'::jsonb)
      from public.accounts a join public.plaid_items i on i.id = a.item_id where i.user_id = u.id),
    'transactions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', t.id, 'accountId', t.account_id, 'plaidTransactionId', t.plaid_transaction_id,
               'pendingTransactionId', t.pending_transaction_id, 'pending', coalesce(t.pending, false),
               'date', to_char(t.date, 'YYYY-MM-DD'), 'amountCents', (t.amount * 100)::bigint,
               'effectiveRole', t.effective_role) order by t.id), '[]'::jsonb)
      from public.transactions t join public.accounts a on a.id = t.account_id
      join public.plaid_items i on i.id = a.item_id where i.user_id = u.id),
    'carryovers', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'accountId', c.account_id, 'pendingPlaidTransactionId', c.pending_plaid_transaction_id,
               'expiresAt', to_char(c.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'consumed', c.consumed_at is not null) order by c.pending_plaid_transaction_id), '[]'::jsonb)
      from public.transaction_carryovers c where c.user_id = u.id),
    'decisions', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', d.id, 'userId', d.user_id, 'kind', d.kind,
               'a', jsonb_build_object('accountId', d.a_account_id, 'plaidTransactionId', d.a_plaid_transaction_id, 'cents', d.a_cents),
               'b', case when d.b_account_id is null then null
                         else jsonb_build_object('accountId', d.b_account_id, 'plaidTransactionId', d.b_plaid_transaction_id, 'cents', d.b_cents) end,
               'acceptedDifferenceCents', d.accepted_difference_cents, 'decidedSeq', d.decided_seq,
               'supersededBy', d.superseded_by,
               'counterpart', case when d.kind = 'pair_counterpart_removed'
                                   then jsonb_build_object('plaidTransactionId', d.b_plaid_transaction_id, 'cents', d.b_cents,
                                                           'status', d.counterpart_status) end,
               'counterpartDate', to_char(d.counterpart_date, 'YYYY-MM-DD')) order by d.id), '[]'::jsonb)
      from public.card_payment_decisions d where d.user_id = u.id),
    'reviewObligations', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', o.id, 'userId', o.user_id,
               'anchor', jsonb_build_object('accountId', o.anchor_account_id, 'plaidTransactionId', o.anchor_plaid_transaction_id,
                                            'cents', o.anchor_cents),
               'gap', o.origin = 'gap',
               'members', (
                 select coalesce(jsonb_agg(jsonb_build_object('accountId', m.member_account_id,
                                                              'plaidTransactionId', m.member_plaid_transaction_id,
                                                              'cents', m.member_cents)
                                           order by m.member_account_id, m.member_plaid_transaction_id), '[]'::jsonb)
                 from public.card_payment_review_memberships m where m.obligation_id = o.id)) order by o.id), '[]'::jsonb)
      from public.card_payment_review_obligations o where o.user_id = u.id)),
  'sql', public.get_card_payment_states(u.id))::text
from (values ('00000000-0000-0000-0000-0000000000aa'::uuid), ('00000000-0000-0000-0000-0000000000bb'::uuid)) u(id)
where exists (select 1 from auth.users x where x.id = u.id)
  and coalesce((public.get_card_payment_states(u.id)->>'fresh')::boolean, false);
