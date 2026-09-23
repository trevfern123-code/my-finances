-- User aa already has four live attempts: one more fits, two more would exceed the cap of five.
insert into public.plaid_link_attempts (user_id, session_id, created_at, expires_at)
  select '00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes'
  from generate_series(1, 4) g;
