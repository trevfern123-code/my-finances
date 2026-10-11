-- c08_lookup_while_action_open: A receipt lookup made while the action's transaction is still OPEN sees no receipt; that is not "not saved". When it commits, the same operation id is one receipt and one action.
-- Fixture of c08: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
reset role;
create table public.th_c08_outcome (step text primary key, result text not null);
create table public.th_c08_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c08_outcome, public.th_c08_seen to service_role;
