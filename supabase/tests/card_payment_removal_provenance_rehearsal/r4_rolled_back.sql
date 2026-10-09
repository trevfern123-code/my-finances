-- R4. Right after the rollback script of 20261008120000 ran.
\pset format unaligned
\pset tuples_only on
select rehearsal.take('r4');
select rehearsal.take_catalog('r4');
select rehearsal.eq_list(rehearsal.diff('r3', 'r4'), '{}',
  'R4: no row of any table changed — the two provenance tables and every row in them included');
select th.assert((select s.n = 5 from rehearsal.snap s where s.label = 'r4' and s.tbl = 'public.card_payment_removal_generations')
                 and (select s.n = 14 from rehearsal.snap s where s.label = 'r4' and s.tbl = 'public.card_payment_removal_sources'),
  'R4: five generation rows and fourteen provenance rows are there, as before');
-- The body: the checksum 20261006120000's own postcondition names, and the very source that migration had
-- installed in this database (kept in R0), carriage returns aside — which is how every guard compares it.
select th.assert(rehearsal.body_md5() = :'revision5_body', 'R4: remove_plaid_item_local has the checksum of the 20261006120000 body');
select th.assert(rehearsal.body_source() = rehearsal.recall('revision 5 body'),
  'R4: and its source is, byte for byte, the source 20261006120000 installed');
select rehearsal.eq_list(rehearsal.catalog_diff('r1', 'r4'),
  array['function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) changed'],
  'R4: of every definition only the removal function changed — both tables keep their columns, constraints, indexes, triggers, trigger functions, row security and grants');
select rehearsal.eq_list(rehearsal.catalog_diff('r0', 'r4', 'function public.remove\_plaid\_item\_local(%'), '{}',
  'R4: and the removal function is as 20261006120000 left it: body, signature, result, security, settings, owner, grants');
-- The number its NOTICE gave: the live system rows that have a provenance row. Eleven of aa (three records, eight
-- holds) and two of bb; the user's preserved pair has a provenance row too and is not a system row.
select th.assert((select count(*) from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
                  where d.superseded_by is null and s.source_relation <> 'confirmed_counterpart') = 13
                 and (select count(*) from public.card_payment_removal_sources s where s.source_relation = 'confirmed_counterpart') = 1,
  'R4: thirteen live system rows keep their provenance, as the NOTICE of the script said');

-- Neither evaluator is touched: an evaluation as of the instant used in R2 publishes exactly what it published
-- then, for both users.
set role service_role;
select public.evaluate_card_payments(rehearsal.aa(), timestamp with time zone '2026-10-01 00:00:00+00');
select public.evaluate_card_payments(rehearsal.bb(), timestamp with time zone '2026-10-01 00:00:00+00');
reset role;
select rehearsal.keep_readings('r4_as_of');
select th.assert((select count(*) = 2 and bool_and(a.doc = b.doc and a.listed = b.listed)
                  from rehearsal.readings a join rehearsal.readings b using (usr) where a.moment = 'as_of' and b.moment = 'r4_as_of'),
  'R4: every published reading is what it was before the rollback, and the reader lists the same decisions');
select rehearsal.take('r4_evaluated');
select 'REPORT  body ' || rehearsal.body_md5() || ' (20261006120000); rows: ' || coalesce(nullif(array_to_string(rehearsal.diff('r3', 'r4'), '; '), ''), 'no difference')
       || '; generations ' || (select count(*) from public.card_payment_removal_generations) || ', provenance rows ' || (select count(*) from public.card_payment_removal_sources);
