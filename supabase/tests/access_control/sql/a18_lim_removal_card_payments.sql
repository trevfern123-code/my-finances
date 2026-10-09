-- 20261006120000_lim_removal_card_payment_matching.sql: institution removal preserves the known
-- destinations of surviving card payments (CARD_PAYMENT_PAIRING_DESIGN.md §4.7, T9; acceptance test 18),
-- through the real removal state machine, the real decision RPCs, the real sync batch and the real evaluator.
--
-- User aa. Item 1 "Card Bank" is REMOVED: card X, card E (excluded from cash flow), checking RC.
-- Item 3 "Kept Bank" survives: checking C, savings F (excluded), card Y. User bb (item 2) mirrors one pair.
--
--   k-auto     C +100  /  x-auto     X −100   1 day    tier 1                      -> removed_card −100
--   k-user     C +250  /  x-user     X −250  14 days   user pair (RPC)             -> removed_card −250, as the
--                                                                                     USER's preserved decision
--   k-diff     C  +80  /  x-diff     X  −78   1 day    user pair, difference 2.00  -> removed_card  −80, the same
--   k-excl     C  +60  /  e-excl     E  −60   1 day    tier 1, excluded card       -> removed_card  −60
--   k-return   C  −35  /  x-return   X  +35   1 day    tier 1, a return            -> removed_card  +35
--   f-excl     F  +45  /  x-fexcl    X  −45   1 day    tier 1, excluded cash acct  -> record kept; not counted
--   k-pend     C +120  /  x-pend     X −120   1 day    tier 1, cash leg PENDING    -> record on the pending id
--   k-pend2    C +130  /  x-pend2    X −130   1 day    the same; posts at 128 later
--   k-pcard    C +150  /  x-pcard    X −150   1 day    tier 1, CARD leg pending           -> removed_card −150
--   k-rev-*    C +140 pending AND its posted row / x-rev X −140: the posted row is the leg
--   k-open     C  +40  /  x-open     X  −40  20 days   only a possible match       -> stays unresolved
--   k-unlinked C  +30  /  x-unlinked X  −30   1 day    user said "unlinked card"   -> the user decision stays
--   k-kept     C +500  /  y-kept     Y −500   1 day    tier 1 with the KEPT card   -> unchanged
--   r-both     RC +70  /  x-both     X  −70             both legs removed          -> nothing to preserve
--   r-cash     RC +90  /  y-cash     Y  −90             the CASH leg is removed    -> nothing to preserve
--
-- The SECOND removal (the relinked card, at the end) is read against
-- 20261008120000_card_payment_removal_provenance.sql: a removal writes one system record per removed partner and
-- reuses none that an earlier removal wrote, so a leg that was matched again to the relinked card has two live
-- records on its unchanged key afterwards, each with a provenance row naming the leg its own removal deleted, and
-- reads as with one. Against 20261006120000 alone (EXCLUDE=20261008120000_card_payment_removal_provenance.sql) the
-- file stops at the list of live records after that removal: that body wrote no second record.
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.item1() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.states(p_user uuid default pg_temp.aa()) returns jsonb language sql as $$ select public.get_card_payment_states(p_user) $$;
create function pg_temp.fresh(p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select coalesce((pg_temp.states(p_user)->>'fresh')::boolean, false) $$;
create function pg_temp.iv(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.ev(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- A leg's state. Raises when the states are not fresh, so no assertion can pass on a stale read.
create function pg_temp.leg(p_plaid text, p_user uuid default pg_temp.aa()) returns jsonb language plpgsql as $$
declare
  v jsonb := pg_temp.states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select l from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = pg_temp.tid(p_plaid));
end $$;
-- state / reason / effect of a leg, as one comparable text ("state/reason/effect", effect "null" when unknown).
create function pg_temp.sre(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') from pg_temp.leg(p_plaid, p_user) l $$;
-- The live system record on a lineage key, if any. With several (a second removal writes its own), the one
-- with the least id: the one a leg names while they all apply.
create function pg_temp.record(p_plaid text) returns uuid language sql as $$
  select d.id from public.card_payment_decisions d
  where d.kind = 'destination_removed_card' and d.superseded_by is null and d.a_plaid_transaction_id = p_plaid
  order by d.id limit 1 $$;
-- Every decision a removal wrote on a surviving leg's own Plaid id — live or superseded — with the source its
-- provenance row names (20261008120000), sorted:
--   kind(leg cents[/removed leg])[ superseded]<=removed item:removed account:removed transaction[relation]
-- (the relation is confirmed, partner or candidate). "NO SOURCE" for a decision without a provenance row;
-- "NO PROVENANCE TABLES" where that migration is not applied.
create function pg_temp.sources(p_plaid text) returns text language plpgsql as $$
declare
  v text;
begin
  if to_regclass('public.card_payment_removal_sources') is null then return 'NO PROVENANCE TABLES'; end if;
  execute $q$
    select coalesce(string_agg(q.x, ' ; ' order by q.x collate "C"), 'none')
    from (select replace(d.kind, 'destination_removed_card', 'record') || '(' || d.a_plaid_transaction_id || ' ' || d.a_cents
                 || coalesce('/' || d.b_plaid_transaction_id, '') || ')' || case when d.superseded_by is null then '' else ' superseded' end || '<='
                 || coalesce(r.plaid_item_id || ':' || s.source_plaid_account_id || ':' || coalesce(s.source_plaid_transaction_id, '-')
                             || '[' || replace(replace(replace(s.source_relation, 'confirmed_counterpart', 'confirmed'),
                                                       'automatic_partner', 'partner'), 'removed_candidate', 'candidate') || ']',
                             'NO SOURCE') as x
          from public.card_payment_decisions d
          left join public.card_payment_removal_sources s on s.decision_id = d.id
          left join public.plaid_item_removals r on r.id = s.removal_id
          where d.user_id = pg_temp.aa() and d.kind in ('pair_counterpart_removed', 'destination_removed_card')
            and d.a_plaid_transaction_id = $1) q $q$
  into v using p_plaid;
  return v;
end $$;
create function pg_temp.dstatus(p_decision uuid) returns text language sql as $$
  select (d->>'status') || coalesce('/' || (d->>'detail'), '')
  from jsonb_array_elements(pg_temp.states()->'decisions') d where (d->>'decisionId')::uuid = p_decision $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false,
                                p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
-- One sync-shaped insert object (the batch RPC's own input format).
create function pg_temp.syncrow(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending_of text) returns jsonb language sql as $$
  select jsonb_build_object('plaid_transaction_id', p_plaid, 'account_id', p_account::uuid, 'amount', p_amount,
    'iso_currency_code', 'USD', 'date', p_date, 'name', 'Synthetic', 'merchant_name', null, 'category', null,
    'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null,
    'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', 'credit_card_payment',
    'role_source', 'category_detailed', 'role_confidence', 'high', 'classifier_version', 1, 'pending_transaction_id', p_pending_of) $$;

-- ---- Fixture -------------------------------------------------------------------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank');
update public.plaid_items set institution_name = 'Card Bank' where id = pg_temp.item1();
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000018a1', '00000000-0000-0000-0000-000000000001', 'a18-x', 'Card X', 'credit', false),
  ('00000000-0000-0000-0000-0000000018a2', '00000000-0000-0000-0000-000000000001', 'a18-e', 'Card E', 'credit', true),
  ('00000000-0000-0000-0000-0000000018a3', '00000000-0000-0000-0000-000000000001', 'a18-rc', 'Removed Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000018b1', '00000000-0000-0000-0000-000000000003', 'a18-c', 'Kept Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000018b2', '00000000-0000-0000-0000-000000000003', 'a18-f', 'Kept Savings', 'depository', true),
  ('00000000-0000-0000-0000-0000000018b3', '00000000-0000-0000-0000-000000000003', 'a18-y', 'Kept Card Y', 'credit', false),
  ('00000000-0000-0000-0000-0000000018c1', '00000000-0000-0000-0000-000000000002', 'a18-bc', 'BB Checking', 'depository', false),
  ('00000000-0000-0000-0000-0000000018c2', '00000000-0000-0000-0000-000000000002', 'a18-bx', 'BB Card', 'credit', false);
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018a1' $$;
create function pg_temp.e() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018a2' $$;
create function pg_temp.rc() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018a3' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018b1' $$;
create function pg_temp.f() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018b2' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018b3' $$;

select pg_temp.cardleg('k-auto', pg_temp.c(), 100, '2026-09-01'),      pg_temp.cardleg('x-auto', pg_temp.x(), -100, '2026-09-02');
select pg_temp.cardleg('k-user', pg_temp.c(), 250, '2026-09-01'),      pg_temp.cardleg('x-user', pg_temp.x(), -250, '2026-09-15');
select pg_temp.cardleg('k-diff', pg_temp.c(), 80, '2026-09-03'),       pg_temp.cardleg('x-diff', pg_temp.x(), -78, '2026-09-04');
select pg_temp.cardleg('k-excl', pg_temp.c(), 60, '2026-09-05'),       pg_temp.cardleg('e-excl', pg_temp.e(), -60, '2026-09-06');
select pg_temp.cardleg('k-return', pg_temp.c(), -35, '2026-09-23'),    pg_temp.cardleg('x-return', pg_temp.x(), 35, '2026-09-24');
select pg_temp.cardleg('f-excl', pg_temp.f(), 45, '2026-09-15'),       pg_temp.cardleg('x-fexcl', pg_temp.x(), -45, '2026-09-16');
select pg_temp.cardleg('k-pend', pg_temp.c(), 120, '2026-09-17', true), pg_temp.cardleg('x-pend', pg_temp.x(), -120, '2026-09-18');
select pg_temp.cardleg('k-pend2', pg_temp.c(), 130, '2026-09-19', true), pg_temp.cardleg('x-pend2', pg_temp.x(), -130, '2026-09-20');
select pg_temp.cardleg('k-pcard', pg_temp.c(), 150, '2026-09-12'),      pg_temp.cardleg('x-pcard', pg_temp.x(), -150, '2026-09-13', true);
select pg_temp.cardleg('k-rev-pending', pg_temp.c(), 140, '2026-09-21', true),
       pg_temp.cardleg('k-rev-posted', pg_temp.c(), 140, '2026-09-22', false, 'k-rev-pending'),
       pg_temp.cardleg('x-rev', pg_temp.x(), -140, '2026-09-22');
select pg_temp.cardleg('k-open', pg_temp.c(), 40, '2026-09-01'),       pg_temp.cardleg('x-open', pg_temp.x(), -40, '2026-09-21');
select pg_temp.cardleg('k-unlinked', pg_temp.c(), 30, '2026-09-07');
select pg_temp.cardleg('k-kept', pg_temp.c(), 500, '2026-09-09'),      pg_temp.cardleg('y-kept', pg_temp.y(), -500, '2026-09-10');
select pg_temp.cardleg('r-both', pg_temp.rc(), 70, '2026-09-11'),      pg_temp.cardleg('x-both', pg_temp.x(), -70, '2026-09-12');
select pg_temp.cardleg('r-cash', pg_temp.rc(), 90, '2026-09-13'),      pg_temp.cardleg('y-cash', pg_temp.y(), -90, '2026-09-14');
select pg_temp.cardleg('b-pay', '00000000-0000-0000-0000-0000000018c1', 100, '2026-09-01'),
       pg_temp.cardleg('b-card', '00000000-0000-0000-0000-0000000018c2', -100, '2026-09-02');
-- An ordinary surviving row and an ordinary removed one (not card legs).
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  (pg_temp.c()::uuid, 'k-groceries', 12.34, '2026-09-02', 'Groceries', 'expense', 'sign_default', 'low', 1),
  (pg_temp.x()::uuid, 'x-purchase', 55, '2026-09-03', 'Purchase', 'expense', 'sign_default', 'low', 1);

select public.evaluate_card_payments(pg_temp.aa());
select public.evaluate_card_payments(pg_temp.bb());

-- The user's own decisions, through the RPCs: "unlinked card" first (the card leg appears afterwards),
-- then the two confirmed pairs.
select th.assert(public.mark_card_payment_destination(pg_temp.aa(), pg_temp.tid('k-unlinked'), pg_temp.iv())->>'status' = 'saved',
  'fixture: the user confirms an unlinked destination');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-user'), pg_temp.tid('x-user'), 0, pg_temp.iv())->>'status' = 'saved',
  'fixture: the user confirms a late pair');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-diff'), pg_temp.tid('x-diff'), 200, pg_temp.iv())->>'status' = 'saved',
  'fixture: the user confirms a pair with a 2.00 difference');
select pg_temp.cardleg('x-unlinked', pg_temp.x(), -30, '2026-09-08');
select public.evaluate_card_payments(pg_temp.aa());

-- The fixture is what the header says (so the "after" assertions mean something).
select th.assert(pg_temp.sre('k-auto') = 'tracked/auto_pair/0' and (pg_temp.leg('k-auto')->>'partnerTransactionId')::uuid = pg_temp.tid('x-auto'), 'before: k-auto is a tier 1 pair');
select th.assert(pg_temp.sre('k-user') = 'tracked/user_pair/0', 'before: k-user is a user pair');
select th.assert(pg_temp.sre('k-diff') = 'tracked/user_pair/-200', 'before: k-diff is a user pair whose 2.00 excess left checking');
select th.assert(pg_temp.sre('k-excl') = 'untracked/partner_excluded/-6000', 'before: k-excl is paired with the excluded card');
select th.assert(pg_temp.sre('k-return') = 'tracked/auto_pair/0', 'before: the return is a tier 1 pair');
select th.assert(pg_temp.sre('f-excl') = 'not_counted/excluded_account/0' and (pg_temp.leg('f-excl')->>'partnerTransactionId')::uuid = pg_temp.tid('x-fexcl'),
  'before: the excluded account''s leg is paired but not counted');
select th.assert(pg_temp.sre('k-pend') = 'tracked/auto_pair/0' and (pg_temp.leg('k-pend')->>'pending')::boolean, 'before: the pending cash leg is paired');
select th.assert(pg_temp.sre('k-pcard') = 'tracked/auto_pair/0' and (pg_temp.leg('x-pcard')->>'pending')::boolean, 'before: a payment is paired with a card leg that is still pending');
select th.assert(pg_temp.sre('k-rev-posted') = 'tracked/auto_pair/0' and pg_temp.leg('k-rev-pending') is null,
  'before: the posted row is the leg; the pending row it replaced has no state');
select th.assert(pg_temp.sre('k-open') = 'unresolved/possible_match/null', 'before: k-open is unresolved (a possible match only)');
select th.assert(pg_temp.sre('k-unlinked') = 'untracked/user_confirmed_unlinked/-3000', 'before: the user''s unlinked confirmation holds');
select th.assert(pg_temp.sre('k-kept') = 'tracked/auto_pair/0', 'before: k-kept is paired with the kept card');
select th.assert(pg_temp.sre('r-cash') = 'tracked/auto_pair/0', 'before: the removed checking''s payment is paired with the kept card');
select th.assert(pg_temp.sre('b-pay', pg_temp.bb()) = 'tracked/auto_pair/0', 'before: bb''s own pair');
select th.assert((select count(*) from public.card_payment_decisions where kind = 'destination_removed_card') = 0, 'before: no system record');

-- ---- The removal, through its state machine ------------------------------------------------------
create temporary table before_removal as
  select pg_temp.iv() as aa_iv, pg_temp.iv(pg_temp.bb()) as bb_iv, pg_temp.ev(pg_temp.bb()) as bb_ev,
         pg_temp.states(pg_temp.bb()) as bb_states,
         (select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t
           join public.accounts a on a.id = t.account_id where a.item_id <> pg_temp.item1()) as kept_txns,
         (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d where d.kind = 'destination_unlinked') as unlinked_decision,
         (select count(*) from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null) as live_pairs,
         (select jsonb_object_agg(d.a_plaid_transaction_id, jsonb_build_array(d.decided_seq, d.created_at))
          from public.card_payment_decisions d where d.kind = 'pair' and d.superseded_by is null) as pair_times;
select th.assert((select live_pairs from before_removal) = 2, 'before: two live user pairs');

select th.assert(public.begin_plaid_item_removal(pg_temp.aa(), pg_temp.item1(),
                 public.plaid_item_removal_digest(pg_temp.aa(), pg_temp.item1()))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt(pg_temp.aa(), pg_temp.item1(), 'removed', null);
select th.assert(pg_temp.iv() = (select aa_iv from before_removal) and pg_temp.fresh(),
  'beginning the removal and recording Plaid''s answer change no matching input');

create temporary table removal as select public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1()) as v;

-- The result and the stored operation keep their exact shape.
select th.assert((select array_agg(k order by k) from removal, jsonb_object_keys(v) k) = array['deleted_counts', 'loan_adjustments', 'replayed'],
  'the result has exactly the same keys as before');
select th.assert((select (v->>'replayed')::boolean = false and v->'loan_adjustments' = '[]'::jsonb from removal), 'cleanup ran; no loan to restore');
select th.assert((select v->'deleted_counts' = '{"accounts":3,"transactions":16,"linked_transactions":0,"splits":0,"recurring_streams":0,"liabilities":0}'::jsonb from removal),
  'deleted counts: the item''s 3 accounts and 16 transactions, and no new key');
select th.assert((select status = 'cleaned' and deleted_counts = (select v->'deleted_counts' from removal) from public.plaid_item_removals where item_id = pg_temp.item1()),
  'the operation is cleaned and records the same counts');
select th.assert(not exists (select 1 from public.plaid_items where id = pg_temp.item1())
                 and not exists (select 1 from public.accounts where item_id = pg_temp.item1())
                 and not exists (select 1 from public.transactions where plaid_transaction_id like 'x-%' or plaid_transaction_id like 'e-%' or plaid_transaction_id like 'r-%'),
  'the item, its accounts and its transactions are gone');

-- 1. The known pairs were preserved — exactly these, each on its surviving cash leg's own lineage key.
-- (a) The AUTOMATIC pairs: the system record.
select th.assert(
  (select jsonb_agg(jsonb_build_array(d.a_plaid_transaction_id, d.a_account_id, d.a_cents) order by d.a_plaid_transaction_id)
   from public.card_payment_decisions d where d.kind = 'destination_removed_card')
  = jsonb_build_array(
      jsonb_build_array('f-excl', pg_temp.f(), 4500),
      jsonb_build_array('k-auto', pg_temp.c(), 10000),
      jsonb_build_array('k-excl', pg_temp.c(), 6000),
      jsonb_build_array('k-pcard', pg_temp.c(), 15000),
      jsonb_build_array('k-pend', pg_temp.c(), 12000),
      jsonb_build_array('k-pend2', pg_temp.c(), 13000),
      jsonb_build_array('k-return', pg_temp.c(), -3500),
      jsonb_build_array('k-rev-posted', pg_temp.c(), 14000)),
  'exactly the eight surviving cash legs that were paired AUTOMATICALLY with a removed card leg have a system record, keyed by account, own Plaid id and cents');
-- (b) The USER-confirmed pairs: the user's own decision, kept on the surviving leg.
select th.assert(
  (select jsonb_agg(jsonb_build_array(d.a_plaid_transaction_id, d.a_account_id, d.a_cents, d.b_plaid_transaction_id, d.b_cents,
                                      d.accepted_difference_cents, d.counterpart_status, d.b_account_id, d.superseded_by)
                    order by d.a_plaid_transaction_id)
   from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed')
  = jsonb_build_array(
      jsonb_build_array('k-diff', pg_temp.c(), 8000, 'x-diff', -7800, 200, 'valid', null, null),
      jsonb_build_array('k-user', pg_temp.c(), 25000, 'x-user', -25000, 0, 'valid', null, null)),
  'exactly the two USER-confirmed pairs became user decisions on their surviving legs: the removed leg''s reference, the accepted difference, a valid counterpart, no account reference to the removed card, live');
select th.assert((select jsonb_object_agg(d.a_plaid_transaction_id, jsonb_build_array(d.decided_seq, d.created_at))
                  from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed') = (select pair_times from before_removal),
  'and each keeps the moment and the sequence of the user''s own confirmation');
select th.assert(not exists (select 1 from public.card_payment_decisions d
                             where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id in ('k-user', 'k-diff')),
  'a user-confirmed pair is NOT downgraded to the non-reserving system record');
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.kind = 'destination_removed_card'
                             and (d.user_id <> pg_temp.aa() or d.b_account_id is not null or d.b_plaid_transaction_id is not null or d.b_cents is not null
                                  or d.accepted_difference_cents is not null or d.superseded_by is not null)),
  'every record is this user''s, single-legged and live');
select th.assert(pg_temp.record('k-open') is null and pg_temp.record('k-unlinked') is null and pg_temp.record('k-kept') is null
                 and pg_temp.record('r-both') is null and pg_temp.record('r-cash') is null and pg_temp.record('y-cash') is null
                 and pg_temp.record('k-rev-pending') is null,
  'no record for an unresolved leg, a leg under another user decision, a pair with the kept card, a deleted cash leg, a card leg, or a replaced pending row');

-- 3–4. The version moved, and the removal committed fresh states for the rows that are left.
select th.assert(pg_temp.iv() > (select aa_iv from before_removal), 'the matching input version advanced');
select th.assert(pg_temp.fresh() and pg_temp.ev() = pg_temp.iv(), 'the removal published fresh states at exactly the final input version');
select th.assert((select count(*) from public.card_payment_leg_states where user_id = pg_temp.aa() and computed_at_version <> pg_temp.iv()) = 0
                 and (select count(*) from public.card_payment_leg_states s where s.user_id = pg_temp.aa()
                      and not exists (select 1 from public.transactions t where t.id = s.transaction_id)) = 0,
  'no state row of an earlier version, and none for a deleted transaction');
select th.assert((select count(*) from jsonb_array_elements(pg_temp.states()->'legs')) = 15,
  'one state per surviving leg (12 on checking C, 1 on savings F, 2 on card Y)');
-- The financial read path can consume the result at once: its one-statement snapshot (20261004120000) gets
-- fresh states that describe exactly the transactions beside them.
create temporary table snapshot as
  select public.get_financial_read_snapshot(pg_temp.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01') as v;
select th.assert((select (v->'cardPayments'->>'fresh')::boolean and not (v->>'tooLarge')::boolean from snapshot),
  'the read snapshot taken right after the removal has fresh card-payment states');
select th.assert((select not exists (select 1 from jsonb_array_elements(v->'transactions') t
                                     where t->>'effective_role' = 'credit_card_payment' and t->>'plaid_transaction_id' <> 'k-rev-pending'
                                       and not exists (select 1 from jsonb_array_elements(v->'cardPayments'->'legs') l where l->>'transactionId' = t->>'id'))
                         and not exists (select 1 from jsonb_array_elements(v->'cardPayments'->'legs') l
                                         where (l->>'accountIncluded')::boolean
                                           and not exists (select 1 from jsonb_array_elements(v->'transactions') t where t->>'id' = l->>'transactionId'))
                  from snapshot),
  'in that snapshot every card-payment row has its state and every counted state has its row (the replaced pending row has none, by design)');
select th.assert((select exists (select 1 from jsonb_array_elements(v->'cardPayments'->'legs') l
                                 where (l->>'transactionId')::uuid = pg_temp.tid('k-auto') and l->>'reason' = 'removed_card' and (l->>'effectCents')::bigint = -10000)
                  from snapshot),
  'and the preserved destination is what the read path sees');

-- 2. The surviving cash legs evaluate as untracked / removed_card, at the D5 effect of the whole leg.
select th.assert(pg_temp.sre('k-auto') = 'untracked/removed_card/-10000' and (pg_temp.leg('k-auto')->>'decisionId')::uuid = pg_temp.record('k-auto')
                 and pg_temp.leg('k-auto')->>'partnerTransactionId' is null,
  'a tier 1 pair with the removed card: removed_card, −100, carrying its record and no partner');
select th.assert(pg_temp.sre('k-user') = 'untracked/removed_card/-25000'
                 and (select d.kind = 'pair_counterpart_removed' from public.card_payment_decisions d where d.id = (pg_temp.leg('k-user')->>'decisionId')::uuid)
                 and pg_temp.leg('k-user')->>'partnerTransactionId' is null,
  'a user pair with the removed card: removed_card, −250, held by the user''s preserved decision');
select th.assert(pg_temp.sre('k-diff') = 'untracked/removed_card/-8000', 'a pair with a difference: the whole cash leg now leaves the tracked accounts (−80, not −2)');
select th.assert((select bool_and(pg_temp.dstatus(d.id) = 'active') from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed'),
  'both preserved user decisions are active');
select th.assert(pg_temp.sre('k-excl') = 'untracked/removed_card/-6000', 'a pair with an excluded card stays −60, now as removed_card');
select th.assert(pg_temp.sre('k-return') = 'untracked/removed_card/3500', 'a return from the removed card counts +35');
select th.assert(pg_temp.sre('k-pend') = 'untracked/removed_card/-12000' and pg_temp.sre('k-pend2') = 'untracked/removed_card/-13000',
  'pending cash legs are preserved too');
select th.assert(pg_temp.sre('k-pcard') = 'untracked/removed_card/-15000', 'a payment whose card leg was still pending when the card was removed is preserved');
select th.assert(pg_temp.sre('k-rev-posted') = 'untracked/removed_card/-14000' and pg_temp.leg('k-rev-pending') is null,
  'a posted row that arrived before its pending row was removed carries the record; the pending row still has no state');
select th.assert(pg_temp.sre('f-excl') = 'not_counted/excluded_account/0', 'a leg on an excluded account is still not counted (its record waits)');
select th.assert((select bool_and(pg_temp.dstatus(d.id) = 'active') from public.card_payment_decisions d where d.kind = 'destination_removed_card'),
  'every record is active');

-- 6. A leg that was unresolved stays unresolved: removal is not evidence.
select th.assert(pg_temp.sre('k-open') = 'unresolved/no_candidate/null' and pg_temp.leg('k-open')->>'decisionId' is null
                 and (pg_temp.leg('k-open')->>'lowCents')::bigint = -4000 and (pg_temp.leg('k-open')->>'highCents')::bigint = 0,
  'the unresolved payment is still unresolved, now with no candidate, and still a range');
-- 7. A protected user decision is preserved, byte for byte.
select th.assert(pg_temp.sre('k-unlinked') = 'untracked/user_confirmed_unlinked/-3000'
                 and (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d where d.kind = 'destination_unlinked')
                     = (select unlinked_decision from before_removal),
  'the user''s unlinked confirmation still decides its leg and its row is unchanged');
-- The pairs themselves went with the card''s account; nothing else of the user''s was touched.
select th.assert(not exists (select 1 from public.card_payment_decisions d where d.kind = 'pair'),
  'the two pair rows that named the removed card are gone (the account cascade); the user''s confirmations are in the preserved decisions, written before it');
select th.assert(pg_temp.sre('k-kept') = 'tracked/auto_pair/0' and (pg_temp.leg('k-kept')->>'partnerTransactionId')::uuid = pg_temp.tid('y-kept'),
  'the pair with the kept card is untouched');
select th.assert(pg_temp.sre('y-cash') = 'unresolved/no_candidate/0', 'the kept card''s leg whose cash leg was removed is unresolved on the credit side, effect 0');
select th.assert((select jsonb_agg(to_jsonb(t) order by t.id) from public.transactions t join public.accounts a on a.id = t.account_id) = (select kept_txns from before_removal),
  'every surviving transaction row is byte-for-byte unchanged');

-- 10. Same-user ownership: nothing of the other user moved.
select th.assert(pg_temp.iv(pg_temp.bb()) = (select bb_iv from before_removal) and pg_temp.ev(pg_temp.bb()) = (select bb_ev from before_removal)
                 and pg_temp.states(pg_temp.bb()) = (select bb_states from before_removal),
  'the other user''s versions and states are identical');
select th.assert(not exists (select 1 from public.card_payment_decisions where user_id = pg_temp.bb()), 'and no decision was written for them');
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-000000000001') $q$,
  '%no removal operation%');

-- Replay: the stored result, nothing written, nothing evaluated.
create temporary table after_removal as
  select pg_temp.iv() as iv, pg_temp.ev() as ev, pg_temp.states() as states,
         (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d) as decisions;
select th.assert((select (r->>'replayed')::boolean and r->'deleted_counts' = (select v->'deleted_counts' from removal)
                  from (select public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1()) as r) x), 'a replay returns the recorded result');
select th.assert(pg_temp.iv() = (select iv from after_removal) and pg_temp.ev() = (select ev from after_removal)
                 and pg_temp.states() = (select states from after_removal)
                 and (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d) = (select decisions from after_removal),
  'and changes no version, state or decision');

-- ---- 11. Pending -> posted after the removal (the released continuity mechanism) --------------------
-- k-pend: its pending row is removed in one sync, and the posted row arrives in a later one.
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['k-pend']);
select th.assert(not pg_temp.fresh(), 'a sync after the removal makes the user stale again (never falsely fresh)');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.tid('k-pend') is null and pg_temp.dstatus(pg_temp.record('k-pend')) = 'inactive/waiting_to_post'
                 and exists (select 1 from public.card_payment_decisions where id = pg_temp.record('k-pend')),
  'while the pending row is gone and its posted row has not arrived, the record waits (kept, not applied)');
select public.apply_synced_transaction_batch_v2(pg_temp.aa(),
  jsonb_build_array(pg_temp.syncrow('k-pend-posted', pg_temp.c(), 120, '2026-09-18', 'k-pend')), '[]'::jsonb, '{}'::text[]);
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('k-pend-posted') = 'untracked/removed_card/-12000'
                 and (pg_temp.leg('k-pend-posted')->>'decisionId')::uuid = pg_temp.record('k-pend') and pg_temp.dstatus(pg_temp.record('k-pend')) = 'active',
  'the posted replacement inherits the record through its lineage (same cents): removed_card');
-- k-pend2: the posted row arrives with a different amount, in the same batch that removes the pending row.
select public.apply_synced_transaction_batch_v2(pg_temp.aa(),
  jsonb_build_array(pg_temp.syncrow('k-pend2-posted', pg_temp.c(), 128, '2026-09-20', 'k-pend2')), '[]'::jsonb, array['k-pend2']);
select public.evaluate_card_payments(pg_temp.aa());
-- 9. An invalidated record is not proof: the leg is evaluated from current bank evidence.
select th.assert(pg_temp.dstatus(pg_temp.record('k-pend2')) = 'inactive/amount_changed', 'an amount-changed replacement invalidates the record');
select th.assert(pg_temp.sre('k-pend2-posted') = 'unresolved/no_candidate/null' and pg_temp.leg('k-pend2-posted')->>'decisionId' is null
                 and pg_temp.leg('k-pend2-posted')->>'detail' is null,
  'its leg is unresolved (an included card exists and nothing matches), carries no record, and is not reserved');
-- The bank corrects a posted, converted leg.
update public.transactions set amount = 98 where plaid_transaction_id = 'k-auto';
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.dstatus(pg_temp.record('k-auto')) = 'inactive/amount_changed' and pg_temp.sre('k-auto') = 'unresolved/no_candidate/null',
  'a later amount correction invalidates the record of a posted leg as well: unresolved, not −100 and not −98');

-- The conflicting-replacement guard is not bypassed by a record: a second posted row naming the same pending id.
select pg_temp.cardleg('k-pend-posted-dup', pg_temp.c(), 120, '2026-09-18', false, 'k-pend');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('k-pend-posted') = 'unresolved/ambiguous_replacement/null' and pg_temp.sre('k-pend-posted-dup') = 'unresolved/ambiguous_replacement/null'
                 and pg_temp.dstatus(pg_temp.record('k-pend')) = 'inactive/lineage_ambiguous',
  'two posted rows claiming one pending payment stay unresolved whatever the record says');
delete from public.transactions where plaid_transaction_id = 'k-pend-posted-dup';
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('k-pend-posted') = 'untracked/removed_card/-12000', 'and once a single replacement is left the record applies again');

-- An excluded account that is later included: the preserved destination now counts.
select th.assert(pg_temp.sre('f-excl') = 'not_counted/excluded_account/0', 'f-excl: still not counted while its account is excluded');
update public.accounts set exclude_from_cash_flow = false where id = pg_temp.f()::uuid;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('f-excl') = 'untracked/removed_card/-4500', 'f-excl: once its account is included, the known destination counts −45');

-- ---- 8. Relinking: new item, new account, new Plaid ids; the history re-imports ------------------------
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000004', pg_temp.aa(), 'harness-item-a4', 'placeholder-token-a4', 'Card Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values
  ('00000000-0000-0000-0000-0000000018d1', '00000000-0000-0000-0000-000000000004', 'a18-x2', 'Card X (relinked)', 'credit', false);
create function pg_temp.x2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000018d1' $$;
select pg_temp.cardleg('x2-auto', pg_temp.x2(), -98, '2026-09-02'),   -- matches the CORRECTED k-auto (98)
       pg_temp.cardleg('x2-user', pg_temp.x2(), -250, '2026-09-15'),  -- 14 days from k-user: not tier 1
       pg_temp.cardleg('x2-diff', pg_temp.x2(), -78, '2026-09-04'),   -- 2.00 from k-diff: not tier 1
       pg_temp.cardleg('x2-excl', pg_temp.x2(), -60, '2026-09-06'),
       pg_temp.cardleg('x2-return', pg_temp.x2(), 35, '2026-09-24'),
       pg_temp.cardleg('x2-rev', pg_temp.x2(), -140, '2026-09-22'),
       pg_temp.cardleg('x2-unlinked', pg_temp.x2(), -30, '2026-09-08'),
       pg_temp.cardleg('x2-open', pg_temp.x2(), -40, '2026-09-21');
create temporary table before_relink_eval as
  select (select count(*) from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) as records;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.sre('k-excl') = 'tracked/auto_pair/0' and (pg_temp.leg('k-excl')->>'partnerTransactionId')::uuid = pg_temp.tid('x2-excl'),
  'relinked: a re-imported matching leg re-tracks its payment through tier 1 (which outranks the record)');
select th.assert(pg_temp.sre('k-return') = 'tracked/auto_pair/0' and pg_temp.sre('k-rev-posted') = 'tracked/auto_pair/0', 'relinked: the return and the posted leg re-track too');
select th.assert(pg_temp.sre('k-auto') = 'tracked/auto_pair/0' and pg_temp.dstatus(pg_temp.record('k-auto')) = 'inactive/amount_changed',
  'relinked: the leg whose record was invalidated pairs automatically with a clear tier 1 match');
select th.assert(pg_temp.sre('k-user') = 'untracked/removed_card/-25000' and pg_temp.sre('k-diff') = 'untracked/removed_card/-8000',
  'relinked: legs with no tier 1 match (14 days apart; 2.00 different) keep the preserved destination — no automatic window is widened');
select th.assert(pg_temp.sre('k-open') = 'unresolved/possible_match/null', 'relinked: the payment that was never resolved is unresolved again with its candidate');
select th.assert((select count(*) from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null) = (select records from before_relink_eval)
                 and pg_temp.dstatus(pg_temp.record('k-excl')) = 'active',
  'relinked: every record stays as dormant history (none deleted or superseded)');
-- A protected user decision is never overridden by the re-imported evidence: it is shown as a suggestion.
select th.assert(pg_temp.sre('k-unlinked') = 'untracked/user_confirmed_unlinked/-3000'
                 and exists (select 1 from jsonb_array_elements(pg_temp.leg('k-unlinked')->'candidates') c
                             where (c->>'transactionId')::uuid = pg_temp.tid('x2-unlinked') and (c->>'contradictsDecision')::boolean),
  'relinked: the user''s unlinked confirmation still stands; the re-imported card leg is only a contradicting suggestion');
-- The user can confirm a match by hand again. That newer explicit action supersedes the preserved decision.
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-user'), pg_temp.tid('x2-user'), 0, pg_temp.iv())->>'matching' = 'fresh',
  'relinked: the user confirms the late pair again');
select th.assert(pg_temp.sre('k-user') = 'tracked/user_pair/0'
                 and (select count(*) = 1 and bool_and(d.superseded_by = (select p.id from public.card_payment_decisions p
                                                                           where p.kind = 'pair' and p.superseded_by is null and p.a_plaid_transaction_id = 'k-user'))
                      from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.a_plaid_transaction_id = 'k-user'),
  'relinked: the new user pair decides the leg, and the preserved decision is superseded by it (kept as history, not deleted)');
select th.assert(pg_temp.sre('k-diff') = 'untracked/removed_card/-8000'
                 and (select superseded_by is null from public.card_payment_decisions where kind = 'pair_counterpart_removed' and a_plaid_transaction_id = 'k-diff'),
  'relinked: the other preserved decision, which the user did not touch, still stands');
select th.expect_error(format($q$ select public.undo_card_payment_decision(%L, %L, %s) $q$, pg_temp.aa(), pg_temp.record('k-excl'), pg_temp.iv()),
  '%system_decision%');

-- A second removal of the relinked card: converted again. Each removal records what IT removed (20261008120000):
-- a leg that was matched again to the relinked card gets a record of this removal's own, beside the one the first
-- removal wrote on the same key. Nothing a reader is shown changes: several live records on a leg read as one.
select th.assert(public.begin_plaid_item_removal(pg_temp.aa(), '00000000-0000-0000-0000-000000000004',
                 public.plaid_item_removal_digest(pg_temp.aa(), '00000000-0000-0000-0000-000000000004'))->>'outcome' = 'started', 'second removal begins');
select public.record_plaid_item_removal_attempt(pg_temp.aa(), '00000000-0000-0000-0000-000000000004', 'already_removed', 'ITEM_NOT_FOUND');
select public.remove_plaid_item_local(pg_temp.aa(), '00000000-0000-0000-0000-000000000004');
select th.assert(pg_temp.fresh(), 'second removal: fresh again');
select th.assert(
  (select jsonb_agg(jsonb_build_array(d.a_plaid_transaction_id, d.a_cents) order by d.a_plaid_transaction_id collate "C", d.a_cents)
   from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.superseded_by is null)
  = jsonb_build_array(
      jsonb_build_array('f-excl', 4500),
      jsonb_build_array('k-auto', 9800), jsonb_build_array('k-auto', 10000),
      jsonb_build_array('k-excl', 6000), jsonb_build_array('k-excl', 6000),
      jsonb_build_array('k-pcard', 15000),
      jsonb_build_array('k-pend', 12000),
      jsonb_build_array('k-pend2', 13000),
      jsonb_build_array('k-return', -3500), jsonb_build_array('k-return', -3500),
      jsonb_build_array('k-rev-posted', 14000), jsonb_build_array('k-rev-posted', 14000)),
  'second removal: a leg whose key is unchanged gets a second record, this removal''s own (k-excl, k-return, k-rev-posted); no other leg gets one, and none is retired');
select th.assert(pg_temp.sources('k-excl') = 'record(k-excl 6000)<=harness-item-a4:a18-x2:x2-excl[partner] ; record(k-excl 6000)<=harness-item-a:a18-e:e-excl[partner]'
                 and pg_temp.sources('k-return') = 'record(k-return -3500)<=harness-item-a4:a18-x2:x2-return[partner] ; record(k-return -3500)<=harness-item-a:a18-x:x-return[partner]'
                 and pg_temp.sources('k-rev-posted') = 'record(k-rev-posted 14000)<=harness-item-a4:a18-x2:x2-rev[partner] ; record(k-rev-posted 14000)<=harness-item-a:a18-x:x-rev[partner]',
  'second removal: of the two records on such a leg, each names the leg its own removal deleted, the payment''s automatic match both times: the first card''s (card E for k-excl), and the relinked card''s');
select th.assert(pg_temp.sources('f-excl') = 'record(f-excl 4500)<=harness-item-a:a18-x:x-fexcl[partner]'
                 and pg_temp.sources('k-pcard') = 'record(k-pcard 15000)<=harness-item-a:a18-x:x-pcard[partner]'
                 and pg_temp.sources('k-pend') = 'record(k-pend 12000)<=harness-item-a:a18-x:x-pend[partner]'
                 and pg_temp.sources('k-pend2') = 'record(k-pend2 13000)<=harness-item-a:a18-x:x-pend2[partner]',
  'second removal: the four legs it left alone keep their one record, each still naming the leg the FIRST removal deleted on card X, the payment''s automatic match then');
select th.assert((select bool_and(pg_temp.sre(v.p) = 'untracked/removed_card/' || v.effect and pg_temp.leg(v.p)->>'partnerTransactionId' is null
                                  and (pg_temp.leg(v.p)->>'decisionId')::uuid = pg_temp.record(v.p))
                  from (values ('k-excl', '-6000'), ('k-return', '3500'), ('k-rev-posted', '-14000')) v(p, effect)),
  'second removal: two live records on a leg read as one — removed_card, the same effect, no partner — and the leg names the one with the lesser id');
select th.assert((select array_agg(a_cents order by a_cents) from public.card_payment_decisions
                  where kind = 'destination_removed_card' and superseded_by is null and a_plaid_transaction_id = 'k-auto') = array[9800::bigint, 10000::bigint],
  'second removal: the corrected leg gets a record at its current amount; the invalidated one stays as history');
select th.assert(pg_temp.sources('k-auto') = 'record(k-auto 10000)<=harness-item-a:a18-x:x-auto[partner] ; record(k-auto 9800)<=harness-item-a4:a18-x2:x2-auto[partner]'
                 and (select pg_temp.dstatus(d.id) = 'active' and d.id = (pg_temp.leg('k-auto')->>'decisionId')::uuid
                      from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-auto' and d.a_cents = 9800)
                 and (select pg_temp.dstatus(d.id) = 'inactive/amount_changed'
                      from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.a_plaid_transaction_id = 'k-auto' and d.a_cents = 10000),
  'second removal: the record at the current amount is this removal''s, from the relinked card''s leg, and it is the one that applies and that the leg names; the invalidated one is the first removal''s');
select th.assert(pg_temp.sre('k-excl') = 'untracked/removed_card/-6000' and pg_temp.sre('k-auto') = 'untracked/removed_card/-9800'
                 and pg_temp.sre('k-user') = 'untracked/removed_card/-25000' and pg_temp.sre('k-unlinked') = 'untracked/user_confirmed_unlinked/-3000'
                 and pg_temp.sre('k-open') = 'unresolved/no_candidate/null',
  'second removal: preserved destinations again, the user pair preserved, the user''s unlinked confirmation and the unresolved leg as before');
select th.assert((select count(*) filter (where superseded_by is null) = 1 and count(*) filter (where superseded_by is not null) = 1
                         and bool_and(b_plaid_transaction_id = case when superseded_by is null then 'x2-user' else 'x-user' end)
                  from public.card_payment_decisions where kind = 'pair_counterpart_removed' and a_plaid_transaction_id = 'k-user')
                 and pg_temp.sre('k-diff') = 'untracked/removed_card/-8000'
                 and (select count(*) = 1 from public.card_payment_decisions where kind = 'pair_counterpart_removed' and a_plaid_transaction_id = 'k-diff'),
  'second removal: the re-confirmed pair is preserved anew (its removed leg is the relinked card''s); the earlier, superseded one stays superseded; the untouched one is unchanged');
select th.assert(pg_temp.sources('k-user') = 'pair_counterpart_removed(k-user 25000/x-user) superseded<=harness-item-a:a18-x:x-user[confirmed] ; pair_counterpart_removed(k-user 25000/x2-user)<=harness-item-a4:a18-x2:x2-user[confirmed]'
                 and pg_temp.sources('k-diff') = 'pair_counterpart_removed(k-diff 8000/x-diff)<=harness-item-a:a18-x:x-diff[confirmed]',
  'second removal: each preserved user decision names the leg the user had confirmed, under the removal that deleted it; the superseded one keeps its source');
