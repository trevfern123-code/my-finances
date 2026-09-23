-- A claim abandoned three minutes ago (its process died before beginning the exchange).
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes',
                         'claimed', '00000000-0000-0000-0000-00000000c004', now() - interval '3 minutes');
