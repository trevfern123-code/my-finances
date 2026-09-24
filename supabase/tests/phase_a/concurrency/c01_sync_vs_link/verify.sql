select th.assert((select amount = 100 and manual_loan_id = '00000000-0000-0000-0000-0000000000d7' and principal_portion = 80
                    and auto_role = 'debt_payment' and role_source = 'manual_loan_link'
                  from public.transactions where id = '00000000-0000-0000-0000-0000000000f3'),
  'T keeps the link, principal 80, amount 100 and its loan role');
select th.assert(not exists (select 1 from public.transactions where principal_portion > amount), 'no principal_portion > amount');
