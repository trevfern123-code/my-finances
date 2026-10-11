set role service_role;
select th.assert((select (result::jsonb)->>'status' = 'pending' and ((result::jsonb)->>'attempts')::integer = 1 from public.th_c06_outcome where who = 'contender'),
                 'the refresh gave up within its lock budget and reports an ordinary failure: ' || (select result from public.th_c06_outcome where who = 'contender'));
reset role;
select th.assert((select q.attempts = 1 and q.last_error_code = '55P03' and q.lease_token is null and q.target_version = rrh.iv() from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()),
                 'the work is kept, with the lock timeout recorded and the lease released');
select th.assert(not rrh.fresh(), 'nothing was published');
