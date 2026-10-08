-- The confirmation, with the version from before the write.
select th.wait_for_application('c20-holder');
select set_config('application_name', 'c20-contender', false);
begin;
set local role service_role;
do $$
begin
  begin
    perform public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select id from public.transactions where plaid_transaction_id = 'c20-p'), (select id from public.transactions where plaid_transaction_id = 'c20-x'), 0, (select v from public.th_c20_state));
    insert into public.th_c20_outcome values ('contender', 'saved');
  exception when others then
    if sqlerrm not like 'card_payment_stale_version:%' then raise; end if;
    insert into public.th_c20_outcome values ('contender', 'stale');
  end;
end $$;
commit;
