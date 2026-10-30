-- c06_refresh_lock_budget: A refresh that cannot get the user's lock within its 10 s budget fails in the ordinary way: the work is kept, the failure recorded, nothing published.
-- Fixture of c06: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
select rrh.cardleg('n', '00000000-0000-0000-0000-00000001f0c1', 9, '2026-09-25');
reset role;
create table public.th_c06_outcome (who text primary key, result text not null);
create table public.th_c06_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c06_outcome, public.th_c06_seen to service_role;
create table public.th_c06_lease as select (public.claim_card_payment_recovery_refresh(rrh.op(1), 10)->'claims'->0->>'leaseToken')::uuid as token;
grant all on public.th_c06_lease to service_role;
