-- R1, its first half, BY ORDERING: 20261008120000 was just offered to this database while its removal function
-- was still the 20260926120000 body — the migration history up to 20261006110000, before 20261006120000 — and
-- its guard refused it. A refused migration is one rolled-back transaction: it has left nothing.
select th.assert(rehearsal.body_md5() = :'original_body' and :'original_body' <> :'revision5_body',
  'R1: remove_plaid_item_local is still the 20260926120000 body');
select th.assert(to_regclass('public.card_payment_removal_generations') is null and to_regclass('public.card_payment_removal_sources') is null
                 and to_regprocedure('public.card_payment_removal_generations_guard()') is null
                 and to_regprocedure('public.card_payment_removal_sources_guard()') is null,
  'R1: the refused migration left no table and no trigger function');
