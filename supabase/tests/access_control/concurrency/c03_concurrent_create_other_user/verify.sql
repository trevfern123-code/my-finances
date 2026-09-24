select th.assert((select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000aa') = 1, 'aa has its attempt');
select th.assert((select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000bb') = 1,
  'bb has only its new live attempt (the holder swept the long-expired ones)');
