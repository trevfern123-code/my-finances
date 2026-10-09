-- The second confirmation (p–y), with the same expected version.
select th.wait_for_application('c16-holder');
select set_config('application_name', 'c16-contender', false);
begin;
set local role service_role;
do $$
begin
  begin
    perform public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select id from public.transactions where plaid_transaction_id = 'c16-p'), (select id from public.transactions where plaid_transaction_id = 'c16-y'), 0, (select v from public.th_c16_state));
    insert into public.th_c16_outcome values ('contender', 'saved');
  exception when others then
    if sqlerrm not like 'card_payment_stale_version:%' then raise; end if;
    insert into public.th_c16_outcome values ('contender', 'stale');
  end;
end $$;
commit;
