-- c04_lockfree_account_update_then_action: A lock-free writer (an account setting) holds the paired card's account row and the version row; the action takes the account KEY SHARE (compatible), waits for the version row, and is refused as stale. No deadlock.
-- Fixture of c04: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
reset role;
create table public.th_c04_outcome (who text primary key, result text not null);
create table public.th_c04_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c04_outcome, public.th_c04_seen to service_role;
