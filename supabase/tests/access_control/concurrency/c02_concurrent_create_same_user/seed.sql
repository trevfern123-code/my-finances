-- User aa already has four live pending attempts: one more fits, two more would exceed the cap of five.
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes')
  from generate_series(1, 4) g;
