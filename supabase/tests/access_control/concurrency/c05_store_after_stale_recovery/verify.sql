select th.assert((select status = 'exchange_unknown' and failure_reason = 'stale_exchange' and plaid_item_id is null
                  from public.plaid_link_attempts where id = '00000000-0000-0000-0000-00000000c005'), 'the attempt stays exchange_unknown');
select th.assert(not exists (select 1 from public.plaid_items where plaid_item_id = 'harness-item-c05'), 'no item row was inserted');
