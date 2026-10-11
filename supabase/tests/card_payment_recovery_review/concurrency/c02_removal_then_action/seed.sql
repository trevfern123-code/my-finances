-- c02_removal_then_action: A removal is in flight; an action planned before it waits, then is refused as stale: it never acts on rows the removal changed.
-- Fixture of c02: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
select th.assert(public.begin_plaid_item_removal(rrh.aa(), '00000000-0000-0000-0000-000000000004', public.plaid_item_removal_digest(rrh.aa(), '00000000-0000-0000-0000-000000000004'))->>'outcome' = 'started', 'fixture: the second removal begins');
select public.record_plaid_item_removal_attempt(rrh.aa(), '00000000-0000-0000-0000-000000000004', 'removed', null);
reset role;
create table public.th_c02_outcome (who text primary key, result text not null);
create table public.th_c02_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c02_outcome, public.th_c02_seen to service_role;
