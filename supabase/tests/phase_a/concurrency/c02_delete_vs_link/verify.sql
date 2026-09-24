set role service_role;
select th.assert(exists (select 1 from public.manual_loans where id = '00000000-0000-0000-0000-0000000000d8'), 'loan survives the rejected deletion');
select th.assert((select count(*) from public.transactions
                  where manual_loan_id = '00000000-0000-0000-0000-0000000000d8' and role_source = 'manual_loan_link') = 2,
  'both rows still linked with their loan role');

-- The retry, with the re-read set, converges.
select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d8', '[
  {"id":"00000000-0000-0000-0000-0000000000f5","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
   "exp_amount":60,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null},
  {"id":"00000000-0000-0000-0000-0000000000f4","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
   "exp_amount":50,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null}]');
select th.assert((select count(*) from public.transactions
                  where id in ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000f5')
                    and manual_loan_id is null and principal_portion is null and role_source = 'sign_default') = 2,
  'retry unlinked and reclassified both rows');
select th.assert((select cardinality(affected_transaction_ids) from public.manual_loan_deletions
                  where loan_id = '00000000-0000-0000-0000-0000000000d8') = 2, 'tombstone records both');
