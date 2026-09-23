-- An exchange that began three minutes ago (stale), claim token fixed for the test.
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes',
                         'exchanging', '00000000-0000-0000-0000-00000000c006', now() - interval '3 minutes');
update public.plaid_link_attempts set claim_token = '00000000-0000-0000-0000-0000000c0c06' where id = '00000000-0000-0000-0000-00000000c006';
