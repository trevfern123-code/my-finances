-- The confirmation, with the ids and the version the user saw before the removal.
select th.wait_for_application('c26-holder');
select set_config('application_name', 'c26-contender', false);
begin;
set local role service_role;
do $$
declare
  v_result jsonb;
begin
  begin
    v_result := public.link_card_payment('00000000-0000-0000-0000-0000000000aa', (select p from public.th_c26_state), (select x from public.th_c26_state), 0, (select v from public.th_c26_state));
    insert into public.th_c26_outcome values ('contender', v_result->>'status');
  exception when others then
    insert into public.th_c26_outcome values ('contender', 'refused:' || split_part(sqlerrm, ':', 1));
  end;
end $$;
commit;
