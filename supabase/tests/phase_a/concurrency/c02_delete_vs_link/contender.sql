set role service_role;
select pg_sleep(1.5);
select th.expect_error($q$
  select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d8', '[
    {"id":"00000000-0000-0000-0000-0000000000f4","auto_role":"expense","role_source":"sign_default","role_confidence":"low","classifier_version":1,
     "exp_amount":50,"exp_category":null,"exp_pfc_detailed":null,"exp_pfc_confidence":null}]')
$q$, '%set of transactions linked to this loan changed%');
