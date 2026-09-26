select th.assert((select current_balance from public.manual_loans where id = '00000000-0000-0000-0000-0000000009b1') = 1000,
  'restored exactly once: 900 + 100, never 1100');
