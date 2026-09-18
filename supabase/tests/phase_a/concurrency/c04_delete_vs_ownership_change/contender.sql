-- aa deletes its loan with a payload that was correct when read. With `FOR UPDATE OF t, a, pi` the
-- RPC waits on the re-parented plaid_items row, re-evaluates `pi.user_id = aa` against the committed
-- version, finds G no longer in aa's linked set, and rejects. With only `FOR UPDATE OF t` (Round 10)
-- it neither waited nor re-checked, and deleted using the stale ownership snapshot.
set role service_role;
select pg_sleep(1.5);
select clock_timestamp() as started \gset
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d6', '[
    {"id":"00000000-0000-0000-0000-0000000000f2","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":30,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null}]')
$q$, '%set of transactions linked to this loan changed%');
select th.assert(clock_timestamp() - :'started'::timestamptz > interval '1.5 seconds',
  'the deletion must have waited on the ownership chain''s row lock');
