-- The confirmation, with the pre-sync version.
select th.wait_for_application('c17-holder');
select set_config('application_name', 'c17-contender', false);
begin;
set local role service_role;
do $$
begin
  begin
    perform public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select id from public.transactions where plaid_transaction_id = 'c17-p'), (select id from public.transactions where plaid_transaction_id = 'c17-x'), 0, (select v from public.th_c17_state));
    insert into public.th_c17_outcome values ('contender', 'saved');
  exception when others then
    if sqlerrm not like 'card_payment_stale_version:%' then raise; end if;
    insert into public.th_c17_outcome values ('contender', 'stale');
  end;
end $$;
commit;
