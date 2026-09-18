select th.assert(exists (select 1 from public.transactions where plaid_transaction_id = 'ph-c'), 'precondition: phantom committed');
select th.assert((select count(*) from public.transactions
                  where plaid_transaction_id in ('ph-a', 'ph-b') and role_source = 'transfer_like_unconfirmed'
                    and user_role_override is null) = 2,
  'A and B were not confirmed as a pair');
