-- R1. Right after 20261008120000 was applied to the populated Revision 5 database.
\pset format unaligned
\pset tuples_only on
select rehearsal.take('r1');
select rehearsal.take_catalog('r1');
select rehearsal.eq_list(rehearsal.diff('r0', 'r1'),
  array['public.card_payment_removal_generations added (0 rows)', 'public.card_payment_removal_sources added (0 rows)'],
  'R1: no row of any existing table changed, and the two new tables exist, empty');
select th.assert(rehearsal.body_md5() = :'new_body' and :'new_body' <> :'revision5_body',
  'R1: remove_plaid_item_local is the body the migration''s postcondition names');
-- Additive. Of every definition that existed — functions, tables, columns, constraints, indexes, triggers,
-- policies, with their grants — exactly one changed, and in its body alone.
select rehearsal.eq_list(array(select x from unnest(rehearsal.catalog_diff('r0', 'r1')) x where x not like '% public.card\_payment\_removal\_% added'),
  array['function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) changed'],
  'R1: nothing that existed was dropped or changed, except the removal function');
select rehearsal.eq((select replace(c.definition, :'revision5_body', :'new_body') from rehearsal.catalog c
                     where c.label = 'r0' and c.object = 'function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid)'),
                    (select c.definition from rehearsal.catalog c
                     where c.label = 'r1' and c.object = 'function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid)'),
  'R1: of the removal function only the body changed: the same signature, result, security, settings, owner and grants');
-- What was added: two tables (6 and 15 columns; 7 and 7 constraints; 4 and 3 indexes; one trigger each) and
-- the two trigger functions.
select rehearsal.eq_list(array(select q.kind || ' x' || q.n
                               from (select split_part(x, ' ', 1) as kind, count(*) as n from unnest(rehearsal.catalog_diff('r0', 'r1')) x
                                     where x like '% public.card\_payment\_removal\_% added' group by 1) q),
  array['table x2', 'column x21', 'constraint x14', 'index x7', 'trigger x2', 'function x2'],
  'R1: what was added is the two provenance tables with their constraints, indexes and triggers, and the two trigger functions');
select th.assert(not exists (select 1 from rehearsal.catalog c where c.label = 'r0' and c.object like '% public.card\_payment\_removal\_%'),
  'R1: none of those names existed before');

set role service_role;
-- Nothing was evaluated and nothing reads the new tables: the stored states are the baseline's, still fresh.
select rehearsal.eq(rehearsal.reading('k-b'), 'tracked/auto_pair/0 partner=x3-b range=0..0 decision=- detail=- candidates=-',
  'R1: freshness and states are as they were');
select rehearsal.eq_list(rehearsal.deps(), array['ambiguity_hold_removed_card(x3-a/k-a@2026-09-11) <= NO SOURCE',
                                               'ambiguity_hold_removed_card(y-a/k-a@2026-09-11) <= NO SOURCE', 'destination_removed_card(k-b) <= NO SOURCE'],
  'R1: the rows Revision 5 wrote have no provenance — applying the migration backfills none');
select rehearsal.eq_list(rehearsal.generations() || rehearsal.generations(rehearsal.bb()), '{}',
  'R1: and no removal is known to the provenance yet: the two Revision 5 removals have no marker until the next removal runs');
reset role;
select 'REPORT  body ' || rehearsal.body_md5() || ' (20261008120000); rows: ' || coalesce(nullif(array_to_string(rehearsal.diff('r0', 'r1'), '; '), ''), 'no difference');
select 'REPORT  definitions: ' || x from unnest(rehearsal.catalog_diff('r0', 'r1')) x where x not like '% added';
select 'REPORT  definitions added: ' || string_agg(q.kind || ' x' || q.n, ', ' order by q.kind)
from (select split_part(x, ' ', 1) as kind, count(*) as n from unnest(rehearsal.catalog_diff('r0', 'r1')) x where x like '% added' group by 1) q;
