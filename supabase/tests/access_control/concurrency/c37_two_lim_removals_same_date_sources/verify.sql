set role service_role;
select th.assert((select outcome from public.th_c37_outcome where who = 'holder') = 'removed' and (select outcome from public.th_c37_outcome where who = 'contender') = 'removed',
  'both removals ran: neither call was a replay');
select th.assert((select outcome from public.th_c37_outcome where who = 'holder-saw') = 'contender_blocked'
                 and (select outcome from public.th_c37_outcome where who = 'contender-saw') = 'holder_committed',
  'the second removal waited for the first: it was observed blocked by the first removal''s backend, and it finished after that transaction had committed');
select th.assert(not exists (select 1 from public.plaid_items where id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004'))
                 and (select count(*) = 2 and bool_and(status = 'cleaned') from public.plaid_item_removals
                      where item_id in ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004')),
  'both institutions are removed and both operations cleaned');
select th.assert((select count(*) = 2 and count(distinct d.id) = 2
                         and bool_and(d.kind = 'ambiguity_hold_removed_card' and d.a_account_id = '00000000-0000-0000-0000-000000037c03' and d.a_cents = -6000
                                      and d.b_account_id = '00000000-0000-0000-0000-000000037c01' and d.b_cents = 6000 and d.counterpart_date = '2026-09-04')
                  from public.card_payment_decisions d
                  where d.kind like 'ambiguity_hold_%' and d.superseded_by is null and d.a_plaid_transaction_id = 'c37-yq' and d.b_plaid_transaction_id = 'c37-q'),
  'TWO live holds on the pair (yq, q), both dated 09-04: the second removal wrote its own hold although the first removal''s hold on that pair and date was live');
select th.assert((select string_agg(g.ordinal || ':' || r.plaid_item_id || ':' || case when g.sources_recorded then 'recorded' else 'marker' end, ', ' order by g.ordinal)
                  from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
                  where g.user_id = '00000000-0000-0000-0000-0000000000aa' and r.user_id = g.user_id) = '1:harness-item-a:recorded, 2:harness-item-a4:recorded'
                 and (select count(*) from public.card_payment_removal_generations) = 2,
  'exactly two generations, both recorded, numbered in commit order: the removal of item 1, then the removal of item 4');
select th.assert((select outcome from public.th_c37_outcome where who = 'contender-waits-on') = 'advisory',
  'the second removal waited on the per-user advisory lock, the first thing the function takes, before any write of its own');
-- Each hold names its own source. The two sources are alike in everything a description holds (type, subtype,
-- mask, date, cents); the removal, the removed account and the removed transaction tell them apart.
select th.assert((select string_agg(case when d.id::text = (select outcome from public.th_c37_outcome where who = 'holder-hold-c37-yq') then 'first' else 'second' end
                                    || '<=' || r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || s.source_plaid_transaction_id || ':' || s.source_relation || ':' || s.source_resolution
                                    || ':' || s.source_pending || ':' || coalesce(s.source_pending_transaction_id, '-') || ':' || s.source_date || ':' || s.source_cents || ':' || s.source_iso_currency_code
                                    || ':' || s.source_account_type || '/' || s.source_account_subtype || '/' || s.source_account_mask, ' ; ' order by r.plaid_item_id collate "C")
                  from public.card_payment_removal_sources s
                  join public.card_payment_decisions d on d.id = s.decision_id
                  join public.plaid_item_removals r on r.id = s.removal_id
                  where s.user_id = '00000000-0000-0000-0000-0000000000aa' and d.user_id = s.user_id and r.user_id = s.user_id
                    and d.superseded_by is null and d.a_plaid_transaction_id = 'c37-yq' and d.b_plaid_transaction_id = 'c37-q')
                 = 'first<=harness-item-a:c37-x1:c37-x1q:removed_candidate:row:false:-:2026-09-04:-6000:USD:credit/credit card/1111 ; '
                   || 'second<=harness-item-a4:c37-x2:c37-x2q:removed_candidate:row:false:-:2026-09-04:-6000:USD:credit/credit card/1111',
  'the hold the first removal wrote names (removal of item 1, account X1, x1q); the hold the second wrote names (removal of item 4, account X2, x2q)');
select th.assert((select outcome from public.th_c37_outcome where who = 'holder-source-of-hold-c37-x2q') = 'harness-item-a:c37-x1:c37-x1q'
                 and not exists (select 1 from public.card_payment_decisions d
                                 where d.id::text = (select outcome from public.th_c37_outcome where who = 'holder-hold-c37-x2q') or d.a_plaid_transaction_id = 'c37-x2q')
                 and not exists (select 1 from public.card_payment_removal_sources s
                                 where s.decision_id::text = (select outcome from public.th_c37_outcome where who = 'holder-hold-c37-x2q'))
                 and (select count(*) from public.card_payment_decisions) = 2 and (select count(*) from public.card_payment_removal_sources) = 2
                 and exists (select 1 from public.card_payment_removal_generations g join public.plaid_item_removals r on r.id = g.removal_id
                             where r.item_id = '00000000-0000-0000-0000-000000000001'),
  'the first removal''s hold on the pair (x2q, q) went with X2''s account, and its provenance row with it; the first generation remains');
select th.assert(not exists (select 1 from public.card_payment_removal_sources s
                             where not exists (select 1 from public.card_payment_decisions d where d.id = s.decision_id))
                 and not exists (select 1 from public.card_payment_decisions d
                                 where d.superseded_by is null
                                   and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
                                   and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = d.id)),
  'no provenance row without its decision, and no live decision of a removal without its provenance row');
select th.assert((public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean
                 and (select evaluated_version = input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
  'fresh: the second removal was the last writer');
select th.assert((select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') || '/' || coalesce(l->>'partnerTransactionId', '-')
                         || '/' || (l->>'lowCents') || '..' || (l->>'highCents') || '/' || coalesce(l->>'decisionId', '-') || '/'
                         || (select coalesce(string_agg(t.plaid_transaction_id, ',' order by t.plaid_transaction_id collate "C"), '')
                             from jsonb_array_elements(l->'candidates') c join public.transactions t on t.id = (c->>'transactionId')::uuid
                             where c->>'kind' = 'tier1_competitor')
                  from jsonb_array_elements(public.get_card_payment_states('00000000-0000-0000-0000-0000000000aa')->'legs') l
                  where (l->>'transactionId')::uuid = (select id from public.transactions where plaid_transaction_id = 'c37-q'))
                 = (select replace(q, 'c37-x1q,c37-x2q,c37-yq', 'c37-yq') from public.th_c37_state)
                 and (select replace(q, 'c37-x1q,c37-x2q,c37-yq', 'c37-yq') from public.th_c37_state) = 'unresolved/ambiguous/null/-/-6000..0/-/c37-yq',
  'the payment reads what it read before either removal, the two removed candidates aside: unresolved, a range, the kept card its only candidate — two identical holds withhold as one');
