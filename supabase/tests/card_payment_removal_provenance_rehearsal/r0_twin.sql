-- The twin: a copy of the baseline database, made right after R0. 20261008120000 is never applied to it.
select rehearsal.take('twin');
select rehearsal.take_catalog('twin');
select th.assert(current_database() = 'rehearsal_twin' and rehearsal.body_md5() = :'revision5_body',
  'twin: another database, with the 20261006120000 body (Revision 5)');
select rehearsal.eq_list(rehearsal.diff('r0', 'twin'), '{}', 'twin: every row of every table is the baseline''s');
select rehearsal.eq_list(rehearsal.catalog_diff('r0', 'twin'), '{}', 'twin: every definition is the baseline''s');
