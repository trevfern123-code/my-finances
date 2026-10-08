-- Rehearsal step 1–2: a populated database on the supported baseline (every migration before
-- 20261006110000), and what the PREVIOUS remove_plaid_item_local does to a known destination.
--   aa  item 1 "Card Bank 1" (card X1), item 4 "Card Bank 2" (card X2, checking R2 with a loan-linked
--       payment), item 6 "Card Bank 3" (card X3), item 3 "Kept Bank" (checking C, card Y);
--       payments from C to each card (tier 1 pairs), a USER-confirmed pair with card X2 (ku2 / x2u) that
--       has a competing leg on the kept card Y (yu), one "unlinked" decision, everything evaluated;
--       and, for each of the three card institutions, an UNRESOLVED payment that its card and the kept card Y
--       both fit (kt1 / kt / kt3, 610 / 600 / 620): a tie that removing the institution must not resolve.
--       Revision 5 (Option B), all at 200, on days of 2026-09 (item 3 also has a second kept card, Z):
--         k2 +200 C 03 — x2 −200 X2 04 (1 day): the automatic match, with the institution removal 2 removes;
--         y2 −200 Y 07 (4 days from k2): a kept card leg that is ALREADY THERE and merely fits less well. The
--            revision 5 removal writes a hold on (y2, k2) next to k2's record; k2 must not be switched to it;
--         kb +200 C 12 and zb −200 Z 17: a payment that is on NO held pair. It is 5 days from y2 and 5 days
--            from zb — a tie, unresolved — and 8 days from x2, so it has no candidate on the removed
--            institution and gets no hold. y2 is closer to k2 (4) than to kb (5), so after removal 2 tier 1
--            does form (k2, y2) and only the hold withholds it. kb is the leg the 20261006110000 rollback
--            gives a figure the evidence does not support (rolled_back_schema.sql).
--   bb  item 2: its own pair, evaluated.
create schema rehearsal;
create table rehearsal.snap (label text, tbl text, digest text, n bigint, primary key (label, tbl));
grant usage on schema rehearsal to service_role;
grant select, insert on all tables in schema rehearsal to service_role;
-- A digest of every row of every table a removal, a decision or an evaluation can touch.
create function rehearsal.take(p_label text) returns void language plpgsql as $$
declare
  v_tbl text;
  v_digest text;
  v_n bigint;
begin
  foreach v_tbl in array array['card_payment_eval_versions', 'card_payment_decisions', 'card_payment_leg_states',
                               'card_payment_auto_pairs', 'card_payment_decision_states', 'transactions', 'accounts',
                               'plaid_items', 'plaid_item_removals', 'manual_loans', 'transaction_carryovers', 'transaction_splits'] loop
    -- Rows as JSON without counterpart_status and counterpart_date: those columns are added by 20261006110000,
    -- and a digest taken before it must equal one taken after it when no row changed. (Their content is
    -- asserted separately.)
    execute format('select md5(coalesce(string_agg(x, ''|'' order by x), '''')), count(*) from (select (to_jsonb(t) - ''counterpart_status'' - ''counterpart_date'')::text as x from public.%I t) q', v_tbl)
      into v_digest, v_n;
    insert into rehearsal.snap values (p_label, v_tbl, v_digest, v_n);
  end loop;
end $$;
create function rehearsal.same(p_a text, p_b text) returns boolean language sql as $$
  select count(*) = 12 and bool_and(a.digest = b.digest and a.n = b.n)
  from rehearsal.snap a join rehearsal.snap b on b.tbl = a.tbl and b.label = p_b where a.label = p_a $$;
create function rehearsal.body_md5() returns text language sql as $$
  select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure $$;
create function rehearsal.fn_md5(p_signature text) returns text language sql as $$
  select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = to_regprocedure(p_signature) $$;
create function rehearsal.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function rehearsal.fresh(p uuid default rehearsal.aa()) returns boolean language sql as $$
  select coalesce((public.get_card_payment_states(p)->>'fresh')::boolean, false) $$;
-- "state/reason/effect" of a leg; NULL when the states are not fresh.
create function rehearsal.sre(p_plaid text, p uuid default rehearsal.aa()) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null')
  from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
create function rehearsal.records() returns text[] language sql as $$
  select coalesce(array_agg(a_plaid_transaction_id order by a_plaid_transaction_id), '{}')
  from public.card_payment_decisions where kind = 'destination_removed_card' and superseded_by is null $$;
-- The live preserved user decisions, as "surviving leg=frozen status". (to_jsonb: the column does not exist
-- on the baseline, where this function is created.)
create function rehearsal.preserved() returns text[] language sql as $$
  select coalesce(array_agg(d.a_plaid_transaction_id || '=' || (to_jsonb(d)->>'counterpart_status') order by d.a_plaid_transaction_id), '{}')
  from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.superseded_by is null $$;
-- The live system ambiguity holds, as "cash leg=kind:card leg@removed candidate's date".
create function rehearsal.holds() returns text[] language sql as $$
  select coalesce(array_agg(d.b_plaid_transaction_id || '=' || d.kind || ':' || d.a_plaid_transaction_id || '@' || (to_jsonb(d)->>'counterpart_date')
                            order by d.b_plaid_transaction_id), '{}')
  from public.card_payment_decisions d where d.kind like 'ambiguity_hold_%' and d.superseded_by is null $$;
-- The kind of the live decision a leg's state names ('none' when it names none), and the leg's partner.
create function rehearsal.holder(p_plaid text, p uuid default rehearsal.aa()) returns text language sql as $$
  select coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid and d.superseded_by is null), 'none')
  from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
create function rehearsal.partner(p_plaid text, p uuid default rehearsal.aa()) returns text language sql as $$
  select l->>'partnerTransactionId'
  from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
-- A leg's published cash-flow bounds, as "low..high" (equal when it is a figure, a range when it is not).
create function rehearsal.bounds(p_plaid text, p uuid default rehearsal.aa()) returns text language sql as $$
  select (l->>'lowCents') || '..' || (l->>'highCents')
  from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
-- A leg's `detail` (the reason an inactive decision that holds it is inactive).
create function rehearsal.detail(p_plaid text, p uuid default rehearsal.aa()) returns text language sql as $$
  select l->>'detail'
  from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
-- A transaction's id, as text (what rehearsal.partner returns).
create function rehearsal.tid(p_plaid text) returns text language sql as $$
  select id::text from public.transactions where plaid_transaction_id = p_plaid $$;
create function rehearsal.to_plaid_removed(p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(rehearsal.aa(), p_item, public.plaid_item_removal_digest(rehearsal.aa(), p_item))->>'outcome' = 'started',
    'removal begins');
  perform public.record_plaid_item_removal_attempt(rehearsal.aa(), p_item, 'removed', null);
end $$;
grant execute on all functions in schema rehearsal to service_role;

select th.assert(rehearsal.body_md5() = 'a8f567d397b9dae5b777497317985ab7', 'baseline: remove_plaid_item_local is the 20260926120000 body');

set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', rehearsal.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000004', rehearsal.aa(), 'harness-item-a4', 'placeholder-token-a4', 'Card Bank 2'),
  ('00000000-0000-0000-0000-000000000006', rehearsal.aa(), 'harness-item-a6', 'placeholder-token-a6', 'Card Bank 3');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-000000000001', 'rh-x1', 'Card X1', 'credit'),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-000000000004', 'rh-x2', 'Card X2', 'credit'),
  ('00000000-0000-0000-0000-0000000e0012', '00000000-0000-0000-0000-000000000004', 'rh-r2', 'Checking R2', 'depository'),
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-000000000006', 'rh-x3', 'Card X3', 'credit'),
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-000000000003', 'rh-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000e00c2', '00000000-0000-0000-0000-000000000003', 'rh-y', 'Kept Card Y', 'credit'),
  ('00000000-0000-0000-0000-0000000e00c3', '00000000-0000-0000-0000-000000000003', 'rh-z', 'Kept Card Z', 'credit'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-000000000002', 'rh-bc', 'BB Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000e00b2', '00000000-0000-0000-0000-000000000002', 'rh-bx', 'BB Card', 'credit');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000e00c1', 'k1', 100, '2026-09-01', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0001', 'x1', -100, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'k2', 200, '2026-09-03', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0002', 'x2', -200, '2026-09-04', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c2', 'y2', -200, '2026-09-07', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'kb', 200, '2026-09-12', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e00c3', 'zb', -200, '2026-09-17', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'k3', 300, '2026-09-05', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0003', 'x3', -300, '2026-09-06', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'ky', 50, '2026-09-07', 'credit_card_payment'),  ('00000000-0000-0000-0000-0000000e00c2', 'y', -50, '2026-09-08', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'ku', 25, '2026-09-09', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'ku2', 400, '2026-09-11', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0002', 'x2u', -400, '2026-09-12', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c2', 'yu', -400, '2026-09-13', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'kt1', 610, '2026-09-17', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0001', 'x1t', -610, '2026-09-18', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c2', 'yt1', -610, '2026-09-18', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'kt', 600, '2026-09-15', 'credit_card_payment'),  ('00000000-0000-0000-0000-0000000e0002', 'x2t', -600, '2026-09-16', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c2', 'yt', -600, '2026-09-16', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c1', 'kt3', 620, '2026-09-19', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e0003', 'x3t', -620, '2026-09-20', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00c2', 'yt3', -620, '2026-09-20', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000e00b1', 'b-pay', 100, '2026-09-01', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000e00b2', 'b-card', -100, '2026-09-02', 'credit_card_payment');
insert into public.manual_loans (id, user_id, name, current_balance) values
  ('00000000-0000-0000-0000-0000000e00f1', rehearsal.aa(), 'L1', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000e00d1', '00000000-0000-0000-0000-0000000e0012', 'r2-loanpay', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);
select th.assert(public.link_transaction_to_manual_loan(rehearsal.aa(), '00000000-0000-0000-0000-0000000e00d1', '00000000-0000-0000-0000-0000000e00f1', 100, 1::smallint) = 'linked',
  'populated: a loan-linked payment on the second institution');
select public.evaluate_card_payments(rehearsal.aa());
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');
select th.assert(public.mark_card_payment_destination(rehearsal.aa(), (select id from public.transactions where plaid_transaction_id = 'ku'),
                 (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'saved', 'populated: a user decision');
select th.assert(public.link_card_payment(rehearsal.aa(), (select id from public.transactions where plaid_transaction_id = 'ku2'),
                 (select id from public.transactions where plaid_transaction_id = 'x2u'), 0,
                 (select input_version from public.card_payment_eval_versions where user_id = rehearsal.aa()))->>'status' = 'saved',
  'populated: a user-confirmed pair with a card of the second institution');
select th.assert(rehearsal.sre('k1') = 'tracked/auto_pair/0' and rehearsal.sre('k2') = 'tracked/auto_pair/0' and rehearsal.sre('k3') = 'tracked/auto_pair/0'
                 and rehearsal.sre('ku') = 'untracked/user_confirmed_unlinked/-2500' and rehearsal.sre('b-pay', '00000000-0000-0000-0000-0000000000bb') = 'tracked/auto_pair/0'
                 and rehearsal.sre('ku2') = 'tracked/user_pair/0' and rehearsal.sre('yu') = 'unresolved/no_candidate/0',
  'populated: three payments paired with three cards, a user-confirmed pair with a competing card leg, a user decision, and the other user''s pair');
select th.assert(rehearsal.sre('kt1') = 'unresolved/ambiguous/null' and rehearsal.sre('kt') = 'unresolved/ambiguous/null' and rehearsal.sre('kt3') = 'unresolved/ambiguous/null',
  'populated: three payments each tied between a card of one institution and the kept card');
select th.assert(rehearsal.partner('k2') = rehearsal.tid('x2') and rehearsal.holder('k2') = 'none'
                 and rehearsal.sre('y2') = 'unresolved/ambiguous/0' and rehearsal.partner('y2') is null,
  'populated (revision 5 shape): k2 is matched AUTOMATICALLY to the card leg of the second institution; the kept card''s leg y2 also fits it, less well, and is unmatched');
select th.assert(rehearsal.sre('kb') = 'unresolved/ambiguous/null' and rehearsal.bounds('kb') = '-20000..0' and rehearsal.partner('kb') is null and rehearsal.holder('kb') = 'none'
                 and rehearsal.sre('zb') = 'unresolved/ambiguous/0' and rehearsal.partner('zb') is null,
  'populated (revision 5 shape): the bystander payment kb is tied between y2 and zb (five days each) — unresolved, a range');
select rehearsal.to_plaid_removed('00000000-0000-0000-0000-000000000001');
select rehearsal.to_plaid_removed('00000000-0000-0000-0000-000000000004');
select rehearsal.to_plaid_removed('00000000-0000-0000-0000-000000000006');
select rehearsal.take('populated');

-- ---- Step 2: the previous function ---------------------------------------------------------------
select th.assert((public.remove_plaid_item_local(rehearsal.aa(), '00000000-0000-0000-0000-000000000001')->>'replayed')::boolean = false, 'previous body: removal 1 runs');
select th.assert(rehearsal.records() = '{}', 'previous body: no destination is preserved');
select th.assert(not rehearsal.fresh(), 'previous body: the user is stale after the removal (its deletes bumped; nothing evaluated)');
select public.evaluate_card_payments(rehearsal.aa());
select th.assert(rehearsal.sre('k1') = 'unresolved/no_candidate/null', 'previous body: the payment to the removed card has lost its destination');
select th.assert(rehearsal.sre('kt1') = 'tracked/auto_pair/0' and rehearsal.partner('kt1') = (select id from public.transactions where plaid_transaction_id = 'yt1')::text and rehearsal.holds() = '{}',
  'previous body: the tie between the removed card and the kept card was RESOLVED by the deletion — the payment is now matched to the kept card');
select th.assert(rehearsal.partner('k2') = rehearsal.tid('x2') and rehearsal.sre('y2') = 'unresolved/ambiguous/0' and rehearsal.sre('kb') = 'unresolved/ambiguous/null',
  'previous body: removal 1 does not touch the 200 legs (none of them is on the first institution)');
select rehearsal.take('old_removed');
