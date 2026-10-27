-- R3. While the body of 20261008120000 is installed, the rollback scripts of 20261006120000 and of
-- 20261006110000 were each just refused by their guards — the second also with its acknowledgement set. A
-- refused script is one rolled-back transaction: nothing changed.
\pset format unaligned
\pset tuples_only on
select rehearsal.take('r3');
select rehearsal.take_catalog('r3');
select rehearsal.eq_list(rehearsal.diff('r2', 'r3'), '{}', 'R3: no row of any table changed');
select rehearsal.eq_list(rehearsal.catalog_diff('r2', 'r3'), '{}', 'R3: no definition changed');
select th.assert(rehearsal.body_md5() = :'new_body', 'R3: the body of 20261008120000 is still installed');
