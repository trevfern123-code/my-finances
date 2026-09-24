-- Long-expired attempts for the holder's sweep to remove.
select th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '3 hours', now() - interval '2 hours' - make_interval(secs => g))
  from generate_series(1, 10) g;
