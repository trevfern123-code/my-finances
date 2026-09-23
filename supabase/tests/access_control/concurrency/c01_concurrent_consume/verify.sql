select th.assert(not exists (select 1 from public.plaid_link_attempts where id = '00000000-0000-0000-0000-00000000c001'),
  'the attempt is gone');
