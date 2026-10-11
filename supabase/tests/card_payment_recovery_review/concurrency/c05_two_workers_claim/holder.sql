-- Worker 1 claims and keeps its claim transaction open until worker 2 has answered.
begin;
do $$
declare
  v jsonb;
  v_waited integer := 0;
begin
  perform set_config('role', 'service_role', true);
  v := public.claim_card_payment_recovery_refresh(rrh.op(1), 10);
  insert into public.th_c05_outcome values ('holder', jsonb_array_length(v->'claims')::text);
  perform set_config('application_name', 'c05-holder', false);
  while not exists (select 1 from public.th_c05_outcome where who = 'contender') loop
    perform pg_sleep(0.1);
    v_waited := v_waited + 1;
    if v_waited > 300 then raise exception 'ASSERTION FAILED: worker 2 did not answer within 30 s: its claim waited for worker 1'; end if;
  end loop;
end $$;
commit;
