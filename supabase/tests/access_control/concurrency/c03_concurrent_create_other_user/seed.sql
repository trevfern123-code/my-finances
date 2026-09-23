-- Expired attempts for the holder's sweep to remove.
insert into public.plaid_link_attempts (user_id, session_id, created_at, expires_at)
  select '00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '2 hours', now() - interval '1 hour' - make_interval(secs => g)
  from generate_series(1, 10) g;
