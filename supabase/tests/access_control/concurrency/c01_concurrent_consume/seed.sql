-- One live attempt, owned by user aa in login session sid-a.
insert into public.plaid_link_attempts (id, user_id, session_id, expires_at) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000000aa', 'sid-a', now() + interval '10 minutes');
