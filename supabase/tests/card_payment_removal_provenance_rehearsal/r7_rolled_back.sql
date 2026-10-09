-- R7, after each of the first two scripts of the rollback chain. Run with
--   -v label=…      the label of the snapshot to take
--   -v body=…       the checksum remove_plaid_item_local must now have
--   -v same_as=…    the catalog snapshot every definition must equal, the removal function aside
\pset format unaligned
\pset tuples_only on
select rehearsal.take(:'label');
select rehearsal.take_catalog(:'label');
select rehearsal.eq_list(rehearsal.diff('r6_replayed', :'label'), '{}', 'R7: no row of any table changed');
select th.assert(rehearsal.body_md5() = :'body', 'R7: remove_plaid_item_local is the body the script restores');
select rehearsal.eq_list(array(select x from unnest(rehearsal.catalog_diff(:'same_as', :'label')) x
                               where x <> 'function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) changed'), '{}',
  'R7: no other definition changed');
select rehearsal.eq_list(rehearsal.catalog_diff('r1', :'label', '% public.card\_payment\_removal\_%'), '{}',
  'R7: both provenance tables are there with every column, constraint, index, trigger, trigger function and grant the migration gave them');
select th.assert((select count(*) = 7 from public.card_payment_removal_generations) and (select count(*) = 15 from public.card_payment_removal_sources),
  'R7: seven generation rows and fifteen provenance rows are there');
select 'REPORT  body ' || rehearsal.body_md5() || '; rows: ' || coalesce(nullif(array_to_string(rehearsal.diff('r6_replayed', :'label'), '; '), ''), 'no difference')
       || '; generations ' || (select count(*) from public.card_payment_removal_generations) || ', provenance rows ' || (select count(*) from public.card_payment_removal_sources);
