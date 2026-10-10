-- c07_lockfree_account_delete_then_action: A lock-free DELETE of the paired card's account holds that row and the version row. The action takes its account locks BEFORE the version row, so it waits without holding L2: no cycle. It is then refused; nothing is written.
-- Fixture of c07: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
reset role;
create table public.th_c07_outcome (who text primary key, result text not null);
create table public.th_c07_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c07_outcome, public.th_c07_seen to service_role;
