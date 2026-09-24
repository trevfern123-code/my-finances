select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000008d1') = 900, 'L1 decremented once');
select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000008d2') = 1000, 'L2 untouched');
select th.assert((select manual_loan_id from public.transactions where id = '00000000-0000-0000-0000-0000000008e1') = '00000000-0000-0000-0000-0000000008d1',
  'T stays linked to L1');
