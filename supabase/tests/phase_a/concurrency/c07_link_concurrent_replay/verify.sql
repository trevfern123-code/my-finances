select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000007d1') = 900,
  'loan L decremented exactly once (1000 -> 900), not twice (800)');
select th.assert((select manual_loan_id = '00000000-0000-0000-0000-0000000007d1' and principal_portion = 100 from public.transactions
                  where id = '00000000-0000-0000-0000-0000000007e1'), 'T linked once to L');
