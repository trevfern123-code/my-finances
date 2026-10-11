-- c03_action_then_removal: An action commits while a removal of the PAIRED card's institution waits: the removal then preserves the user's new pair, captures its own obligation, and deletes nothing of the receipt.
-- Fixture of c03: the standard guarded payment, and what a client saw of it.
set role service_role;
select rrh.guarded_fixture();
select th.assert(public.begin_plaid_item_removal(rrh.aa(), '00000000-0000-0000-0000-000000000008', public.plaid_item_removal_digest(rrh.aa(), '00000000-0000-0000-0000-000000000008'))->>'outcome' = 'started', 'fixture: the removal of the Other Bank begins');
select public.record_plaid_item_removal_attempt(rrh.aa(), '00000000-0000-0000-0000-000000000008', 'removed', null);
reset role;
create table public.th_c03_outcome (who text primary key, result text not null);
create table public.th_c03_seen as select rrh.iv() as input, rrh.rev() as review;
grant all on public.th_c03_outcome, public.th_c03_seen to service_role;
