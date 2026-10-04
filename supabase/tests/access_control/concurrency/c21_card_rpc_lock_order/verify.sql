set role service_role;
select th.assert((select outcome from public.th_c21_outcome where who = 'holder') = 'l2_free',
  'while waiting on L1, the RPC held no lock on the version row (L1 strictly before L2)');
select th.assert((select outcome from public.th_c21_outcome where who = 'contender') = 'saved',
  'the RPC then proceeded and saved (the holder changed no input)');
