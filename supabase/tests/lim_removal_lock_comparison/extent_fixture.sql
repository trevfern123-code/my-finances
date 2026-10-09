-- Fixture of the lock-EXTENT probe (run.sh): which rows a removal still holds a lock on when its function has
-- returned, apart from the item's own.
--
-- User aa has NO card-payment leg and no decision: a removal of this user evaluates nothing into a state and
-- preserves nothing. Item 3 "Earlier Bank" was removed before, start to finish (a cleaned removal). Item 1 is
-- about to be removed: begun, and confirmed at Plaid. User bb is not involved.
\set ON_ERROR_STOP 1
drop table if exists public.th_lx_probe;
set role service_role;
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000aa', 'harness-item-a3', 'placeholder-token-a3', 'Earlier Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c2001', '00000000-0000-0000-0000-000000000001', 'lx-r', 'Removed Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c2002', '00000000-0000-0000-0000-000000000003', 'lx-e', 'Earlier Checking', 'depository');
insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000c2001', 'lx-row', 12.34, '2026-09-10', 'Purchase', 'expense', 'sign_default', 'low', 1),
  ('00000000-0000-0000-0000-0000000c2002', 'lx-earlier', 23.45, '2026-09-11', 'Purchase', 'expense', 'sign_default', 'low', 1);

select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003'))->>'outcome' = 'started', 'fixture: the earlier removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003', 'removed', null);
select th.assert((public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003')->>'replayed')::boolean = false,
  'fixture: the earlier removal runs');
select th.assert((select status = 'cleaned' from public.plaid_item_removals where item_id = '00000000-0000-0000-0000-000000000003'), 'fixture: the earlier removal is cleaned');

select th.assert(public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
                 public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'))->>'outcome' = 'started', 'removal begins');
select public.record_plaid_item_removal_attempt('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'removed', null);
select th.assert(not exists (select 1 from public.card_payment_decisions) and not exists (select 1 from public.card_payment_leg_states),
  'fixture: no decision and no matching state exists');
select th.assert(exists (select 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa'),
  'fixture: the user''s version row exists (a later bump updates it and inserts nothing)');
reset role;

-- Where the provenance tables exist (20261008120000), the earlier removal recorded its generation. It is taken
-- away — only the tables' owner can — so that the earlier removal is what a removal that ran without provenance
-- is: cleaned, with no generation row. The removal under test must then give it a marker.
do $$
begin
  if to_regclass('public.card_payment_removal_generations') is not null then
    execute 'delete from public.card_payment_removal_generations';
  end if;
end $$;

create table public.th_lx_probe (what text primary key, outcome text not null);
