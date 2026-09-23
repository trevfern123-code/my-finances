select th.assert((select status = 'completed' and plaid_item_id = '00000000-0000-0000-0000-00000000c6c6'
                  from public.plaid_link_attempts where id = '00000000-0000-0000-0000-00000000c006'), 'the attempt is completed');
select th.assert(exists (select 1 from public.plaid_items where id = '00000000-0000-0000-0000-00000000c6c6'), 'the item is stored');
