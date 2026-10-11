-- c05_two_workers_claim: Two workers claim at once: the second does not wait and gets nothing.
-- Fixture of c05: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
select rrh.cardleg('n', '00000000-0000-0000-0000-00000001f0c1', 9, '2026-09-25');
reset role;
create table public.th_c05_outcome (who text primary key, result text not null);
create table public.th_c05_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c05_outcome, public.th_c05_seen to service_role;
