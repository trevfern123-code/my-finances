-- c01_same_operation_twice: Two requests with the SAME operation id at once: one logical action, one receipt; the second sees the first.
-- Fixture of c01: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
reset role;
create table public.th_c01_outcome (who text primary key, result text not null);
create table public.th_c01_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c01_outcome, public.th_c01_seen to service_role;
