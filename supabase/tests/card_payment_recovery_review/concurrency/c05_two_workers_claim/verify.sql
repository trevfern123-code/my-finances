set role service_role;
select th.assert((select result from public.th_c05_outcome where who = 'holder') = '1' and (select result from public.th_c05_outcome where who = 'contender') = '0', 'worker 1 has the row; worker 2 got nothing, without waiting');
reset role;
select th.assert((select q.lease_owner = rrh.op(1) and q.lease_token is not null from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()), 'one lease, worker 1''s');
