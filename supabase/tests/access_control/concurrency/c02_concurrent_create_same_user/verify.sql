select th.assert((select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000aa' and status = 'pending') = 5,
  format('two simultaneous creates leave exactly five live pending attempts (found %s)',
         (select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000aa' and status = 'pending')));
