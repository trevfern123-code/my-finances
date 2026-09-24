-- The retry: T re-read after the sync and re-classified by the real classifier (psql variable
-- `payload`). It must succeed and persist the role the CURRENT category implies.
set role service_role;

select th.assert(:'payload'::jsonb -> 0 ->> 'auto_role' = 'debt_payment'
                 and :'payload'::jsonb -> 0 ->> 'role_source' = 'category_primary_fallback'
                 and :'payload'::jsonb -> 0 ->> 'exp_category' = 'LOAN_PAYMENTS',
  'precondition: the fresh payload reflects the synced LOAN_PAYMENTS category');

select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d5', :'payload'::jsonb) as result \gset
select th.assert(not (:'result'::jsonb ->> 'replayed')::boolean, 'retry performed the deletion');

select th.assert((select manual_loan_id is null and principal_portion is null
                    and auto_role = 'debt_payment' and role_source = 'category_primary_fallback'
                    and role_confidence = 'low' and category = 'LOAN_PAYMENTS'
                  from public.transactions where id = '00000000-0000-0000-0000-0000000000f1'),
  'T persisted as debt_payment/category_primary_fallback');
select th.assert(not exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d5'), 'loan deleted');
select th.assert((select affected_transaction_ids = array['00000000-0000-0000-0000-0000000000f1'::uuid]
                  from public.manual_loan_deletions where loan_id = '00000000-0000-0000-0000-0000000000d5'),
  'tombstone records T');
