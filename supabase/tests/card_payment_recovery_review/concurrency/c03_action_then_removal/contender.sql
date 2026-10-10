-- The removal of the institution that holds w, arriving meanwhile.
set application_name = 'c03-contender';
set role service_role;
insert into public.th_c03_outcome
select 'contender', case when (public.remove_plaid_item_local(rrh.aa(), '00000000-0000-0000-0000-000000000008')->>'replayed')::boolean then 'replayed' else 'removed' end;
