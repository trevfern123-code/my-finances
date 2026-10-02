-- A transaction open ACROSS the upgrade. It bumps under the previous body, which sets no marker. Once the
-- upgrade has committed, it takes its first lock on a new relation, which makes it process the catalog
-- invalidations, and from then on it runs the new body. Either body only ever bumps, or skips on a marker
-- the new body set in this same transaction, so the user ends stale with every write counted.
set role service_role;
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-1';
select th.assert(coalesce(current_setting('card_payment.bumped_' || replace('00000000-0000-0000-0000-0000000000ee', '-', ''), true), '') = '',
  'straddler: the previous body sets no marker');
select set_config('application_name', 'rehearsal-straddler-open', false);
do $$ begin loop exit when exists (select 1 from rehearsal.signal where s = 'migrated'); perform pg_sleep(0.05); end loop; end $$;
select count(*) from rehearsal.touch1;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-2';
select th.assert(current_setting('card_payment.bumped_' || replace('00000000-0000-0000-0000-0000000000ee', '-', ''), true) = pg_current_xact_id()::text,
  'straddler: after the upgrade committed, the new body is in effect in the same transaction');
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'rh-ss-3';
commit;
