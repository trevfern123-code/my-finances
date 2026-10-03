-- A transaction open ACROSS the rollback. It bumps under the new body, which sets its marker. Once the
-- rollback has committed, it picks up the previous body, which ignores the marker and bumps per row.
-- The user ends stale with every write counted.
set role service_role;
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-1';
select th.assert(current_setting('card_payment.bumped_' || replace('00000000-0000-0000-0000-0000000000ee', '-', ''), true) = pg_current_xact_id()::text,
  'straddler: the new body set its marker');
select set_config('application_name', 'rehearsal-straddler-open', false);
do $$ begin loop exit when exists (select 1 from rehearsal.signal where s = 'rolled_back'); perform pg_sleep(0.05); end loop; end $$;
select count(*) from rehearsal.touch2;
create temporary table straddle_probe as select rehearsal.iv('00000000-0000-0000-0000-0000000000ee') as v;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-2';
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-3';
select th.assert(rehearsal.iv('00000000-0000-0000-0000-0000000000ee') - (select v from straddle_probe) = 2,
  'straddler: after the rollback committed, the previous body bumps per row in the same transaction');
commit;
