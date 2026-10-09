-- ROLLBACK for 20261008120000_card_payment_removal_provenance.sql. NOT a migration; run by an operator only
-- after approval, as the same role that applies migrations. The file is ONE explicit transaction
-- (begin … commit), so run it without psql's -1:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/rollback/20261008120000_card_payment_removal_provenance_rollback.sql
-- Any failure, including a guard or postcondition, aborts it; nothing is half-applied.
--
-- WHAT IT DOES. It re-creates remove_plaid_item_local(uuid, uuid) exactly as
-- 20261006120000_lim_removal_card_payment_matching.sql defined it: verbatim, and checksum-verified below.
-- The signature, SECURITY INVOKER, the pinned search_path and the grants are preserved by CREATE OR REPLACE.
-- Nothing else. No backend change is needed in either direction.
--
-- WHAT IT DOES NOT DO — it deletes nothing and reinterprets nothing.
--   * Both provenance tables stay, with every row, their triggers and their grants: card_payment_removal_generations
--     and card_payment_removal_sources. The postcondition below compares both tables, row for row, with what
--     they held when this file began. Nothing reads them in either state (no settlement exists), so keeping
--     them changes no figure; dropping them would destroy the only record of which removed transaction each
--     surviving protection depends on, and that cannot be rebuilt once the removed rows are gone.
--   * Every decision a removal wrote stays as it is, and reads as it did: neither evaluator is touched.
--     Several live holds on one pair, or several live records on one leg — which the forward function writes
--     where 20261006120000 wrote one — read exactly as one does under the 20261006110000 evaluator.
--     (Under the evaluator BEFORE 20261006110000 — its own rollback script, case iii — two holds on one pair
--     read conflicting_decisions where one reads not_cash_side, and an undo there must be repeated per hold.
--     With this packet's rows present, every pair with two same-date removed candidates or a second removal
--     is such a pair; that script's rehearsal covers single-hold pairs only.)
--
-- AFTER IT, institution removal behaves as 20261006120000 defines it:
--   * A removal writes NO provenance and NO generation row: it is in plaid_item_removals, cleaned, and not in
--     card_payment_removal_generations.
--   * A removal again merges by pair and date, and by leg: it writes no second hold where a live hold with
--     the same legs and date exists, and no second record where a live record with the same key exists —
--     including where that live row carries ANOTHER removal's provenance. Such a row then also stands for a
--     source it does not name. Nothing is wrong with what is published. What is lost is the certainty that an
--     attributed row depends on its recorded source alone.
--   * That loss is recorded, not silent. When the migration is applied again, the first removal of a user
--     gives each of that user's removals made in between a MARKER in the user's order
--     (card_payment_removal_generations.ordinal, sources_recorded = false). The rule the migration's header
--     states — a row is known to depend on its recorded source alone only if the user has no marker with a
--     greater ordinal than the row's generation and no cleaned removal without a generation row — then
--     excludes exactly the rows a removal made in between can have merged into. Until then, such a removal is
--     a cleaned removal without a generation row, which the same rule excludes.
--   * So the supported path is: roll back, and apply the migration again before any feature that settles by
--     source is enabled. Removals made in between are safe; they are unattributed, and they are known.
--
-- ORDER. This file must be run BEFORE the rollback of 20261006120000, whose guard requires the 20261006120000
-- body: it refuses while this migration's body is installed, with "remove_plaid_item_local is not the
-- 20261006120000 definition; refusing to roll back". That script in turn precedes the rollback of
-- 20261006110000, which says "roll back 20261006120000 first". Three steps: this file, then those two.
--
-- RE-APPLYING. The migration's ledger row in supabase_migrations.schema_migrations is deliberately left
-- alone. Re-applying means running the migration file's SQL again (its guard accepts exactly this restored
-- body; its DDL is repeatable, keeps existing rows and verifies the tables' exact shape), not `supabase db push`.
--
-- Guard: refuses unless the current body is exactly the one 20261008120000 installs.

begin;

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'cc12b7a12c6510924781b93c658ee854' then
    raise exception 'remove_plaid_item_local is not the 20261008120000 definition; refusing to roll back';
  end if;
  if to_regclass('public.card_payment_removal_generations') is null
     or to_regclass('public.card_payment_removal_sources') is null then
    raise exception 'a provenance table is missing; refusing to roll back';
  end if;
end
$$;

-- What both tables hold now, to be compared at the end: this file must not change a row of them. Writers are
-- kept out until it commits (the removal function inserts into both; nothing else writes them).
lock table public.card_payment_removal_generations, public.card_payment_removal_sources in share mode;
create temporary table rpp_rollback_before on commit drop as
select 'generations' as tbl, count(*) as n, coalesce(md5(string_agg(md5(g::text), '' order by g.removal_id)), '') as digest
from public.card_payment_removal_generations g
union all
select 'sources', count(*), coalesce(md5(string_agg(md5(s::text), '' order by s.decision_id)), '')
from public.card_payment_removal_sources s;

create or replace function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
  v_item_status text;
  v_adjustments jsonb;
  v_counts jsonb;
  v_evaluated bigint;
  r record;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select * into v_removal from public.plaid_item_removals where item_id = p_item_id and user_id = p_user_id for update;
  if not found then
    raise exception 'remove_plaid_item_local: no removal operation for this user/item';
  end if;
  if v_removal.status = 'cleaned' then
    return jsonb_build_object('replayed', true, 'loan_adjustments', v_removal.loan_adjustments,
                              'deleted_counts', v_removal.deleted_counts);
  end if;
  if v_removal.status <> 'plaid_removed' then
    raise exception 'remove_plaid_item_local: Plaid removal is not confirmed for item % (status %)', p_item_id, v_removal.status;
  end if;

  select pi.status into v_item_status from public.plaid_items pi
  where pi.id = p_item_id and pi.user_id = p_user_id
  for update;
  if not found then
    raise exception 'remove_plaid_item_local: item % is missing while its removal is only plaid_removed', p_item_id;
  end if;
  if v_item_status <> 'removing' then
    raise exception 'remove_plaid_item_local: item % is not removing (status %)', p_item_id, v_item_status;
  end if;

  -- Lock the item's complete linked set; nothing can link, unlink or re-price one of them now (every
  -- such writer takes the advisory lock above), so the set restored below is exactly the set deleted.
  perform 1 from public.transactions t join public.accounts a on a.id = t.account_id
  where a.item_id = p_item_id and t.manual_loan_id is not null
  for update of t;

  if exists (select 1 from public.transactions t join public.accounts a on a.id = t.account_id
             where a.item_id = p_item_id and t.manual_loan_id is not null and t.loan_balance_applied is null) then
    raise exception 'manual-loan reconciliation required: remove_plaid_item_local: item % has a linked transaction with no recorded applied delta',
      p_item_id;
  end if;

  -- Defense in depth: begin already refused this (plaid_item_removal_blocker), and no write path
  -- creates it, but cleanup must never touch another user's loan even if it somehow appeared.
  if exists (select 1 from public.transactions t join public.accounts a on a.id = t.account_id
             left join public.manual_loans ml on ml.id = t.manual_loan_id
             where a.item_id = p_item_id and t.manual_loan_id is not null
               and (ml.id is null or ml.user_id is distinct from p_user_id)) then
    raise exception 'manual_loan_ownership_mismatch: remove_plaid_item_local: item % has a transaction linked to a loan that is not this user''s', p_item_id;
  end if;

  -- The item's ACCOUNT rows, locked now, in id order, with the lock their delete will take — BEFORE the
  -- evaluation below takes the user's version row. The body this one replaces reached these rows (its
  -- cascade's delete) before its first version bump; taking them first keeps that order. A direct statement
  -- that holds one of them and then bumps the version (the account-settings update; an insert that
  -- references the account) therefore makes this function wait, as it always did, instead of closing a cycle.
  perform 1 from public.accounts a where a.item_id = p_item_id order by a.id for update;

  -- Card-payment matching, part 1 (design §4.7, T9): BEFORE anything is deleted.
  -- The matching states of the rows as they are now, computed here: never the stored ones, which may be
  -- stale or may not exist. STRICT: if matching cannot be evaluated, what is known about the destinations
  -- of the surviving payments cannot be preserved, so nothing is removed. From here to the end of this
  -- transaction the evaluator's lock on the user's version row keeps every other writer's input change
  -- from committing.
  begin
    v_evaluated := public.evaluate_card_payments(p_user_id);
  exception when others then
    raise exception 'remove_plaid_item_local: card-payment matching could not be evaluated before the removal (SQLSTATE %); nothing was removed', sqlstate
      using errcode = sqlstate;
  end;

  -- Preserve what is known, in three statements, before anything is deleted (this file's header, step 3).
  begin
    -- (a) USER-CONFIRMED pairs with one leg on an account of THIS item and the other on an account of
    -- another item of this user. The cascade below deletes the pair; the user's confirmation is kept first,
    -- as a USER decision on the leg that survives — whichever side that is, and whether the pair is active
    -- or not. counterpart_status freezes what was true of the removed side: 'valid' when the evaluation
    -- above found the pair active; otherwise the removed leg's own status, and, if that leg is valid,
    -- whether the two legs still relate as recorded (sides, direction, accepted difference).
    -- NOT a pair one of whose legs the USER re-classified away from card payment: that newer explicit
    -- action supersedes the confirmation, which is not carried forward.
    insert into public.card_payment_decisions
      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,
       accepted_difference_cents, counterpart_status, decided_seq, created_at)
    select p_user_id, 'pair_counterpart_removed', o.sv_account, o.sv_plaid, o.sv_cents, o.rm_plaid, o.rm_cents,
           d.accepted_difference_cents,
           case
             when ds.status = 'active' then 'valid'
             when ds.detail = 'conflicting_decisions' then 'conflicting_decisions'
             else coalesce(
               nullif(public.card_payment_reference_status(o.rm_account, o.rm_plaid, o.rm_cents, now()), 'valid'),
               case
                 when coalesce(sa.type = 'credit', false) = coalesce(ra.type = 'credit', false) then 'sides_not_opposite'
                 when sign(o.sv_cents::numeric) <> -sign(o.rm_cents::numeric) then 'direction_mismatch'
                 when (case when coalesce(sa.type = 'credit', false) then abs(o.rm_cents) - abs(o.sv_cents)
                            else abs(o.sv_cents) - abs(o.rm_cents) end) <> d.accepted_difference_cents then 'difference_not_accepted'
                 else 'valid'
               end)
           end,
           d.decided_seq, d.created_at
    from public.card_payment_decisions d
    cross join lateral (values
      (d.a_account_id, d.a_plaid_transaction_id, d.a_cents, d.b_account_id, d.b_plaid_transaction_id, d.b_cents),
      (d.b_account_id, d.b_plaid_transaction_id, d.b_cents, d.a_account_id, d.a_plaid_transaction_id, d.a_cents)
    ) as o(sv_account, sv_plaid, sv_cents, rm_account, rm_plaid, rm_cents)
    join public.accounts sa on sa.id = o.sv_account
    join public.plaid_items si on si.id = sa.item_id
    join public.accounts ra on ra.id = o.rm_account
    join public.plaid_items ri on ri.id = ra.item_id
    left join public.card_payment_decision_states ds
      on ds.user_id = p_user_id and ds.decision_id = d.id and ds.computed_at_version = v_evaluated
    where d.user_id = p_user_id and d.kind = 'pair' and d.superseded_by is null
      and si.user_id = p_user_id and si.id <> p_item_id
      and ri.user_id = p_user_id and ri.id = p_item_id
      and not exists (select 1 from public.transactions t
                      where ((t.account_id = d.a_account_id and d.a_plaid_transaction_id in (t.plaid_transaction_id, t.pending_transaction_id))
                          or (t.account_id = d.b_account_id and d.b_plaid_transaction_id in (t.plaid_transaction_id, t.pending_transaction_id)))
                        and t.user_role_override is not null and t.user_role_override <> 'credit_card_payment')
    order by d.id;

    -- (b) AUTOMATIC pairs. A cash-side leg of ANOTHER item of this user that the evaluation above paired by
    -- tier 1 (a partner, and no decision) with a leg on an account of THIS item: the pair was the evidence
    -- of where that money went, and it is about to be deleted. Record the known destination on the surviving
    -- leg, by its lineage key (its account, its own Plaid id, its cents), as the system decision the
    -- evaluator ranks below every user decision and every tier 1 pair. A leg with no partner gets no
    -- destination: removal is not evidence ((c) keeps the removal from resolving it the other way either).
    -- A leg held by a user decision is (a)'s, or stays as it is.
    insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
    select p_user_id, 'destination_removed_card', t.account_id, t.plaid_transaction_id, s.amount_cents
    from public.card_payment_leg_states s
    join public.transactions t on t.id = s.transaction_id
    join public.accounts ca on ca.id = t.account_id
    join public.plaid_items ci on ci.id = ca.item_id
    join public.transactions pt on pt.id = s.partner_transaction_id
    join public.accounts pa on pa.id = pt.account_id
    join public.plaid_items pi on pi.id = pa.item_id
    where s.user_id = p_user_id
      and s.computed_at_version = v_evaluated
      and s.side = 'cash'
      and s.partner_transaction_id is not null
      and s.decision_id is null
      and ci.user_id = p_user_id and ci.id <> p_item_id
      and pi.user_id = p_user_id and pi.id = p_item_id
      and not exists (select 1 from public.card_payment_decisions d
                      where d.user_id = p_user_id and d.kind = 'destination_removed_card' and d.superseded_by is null
                        and d.a_account_id = t.account_id and d.a_plaid_transaction_id = t.plaid_transaction_id
                        and d.a_cents = s.amount_cents)
    order by t.id;

    -- (c) AMBIGUITY HOLDS. Removal is not evidence, and deleting a candidate is not evidence either. Read from
    -- the evaluator's COMPLETE POOL, as the evaluation above left it in its scratch tables in this transaction
    -- (pg_temp.cpe_pool, cpe_txn, cpe_tier1, cpe_dismissed) — NOT from the published states. The published
    -- states are a presentation: a leg on an account that is excluded from cash flow takes part in tier 1
    -- like any other but is published not_counted with no candidates, and a payment that an earlier removal's
    -- record or the "no included card" rule decides is published untracked. Any of them can have candidates
    -- on both sides of this removal.
    --   o   the OWNER: a pool leg on an account of ANOTHER item of this user whose automatic match is NOT with
    --       a leg that stays — it has no tier 1 partner at all, or its tier 1 partner is on an account of THIS
    --       item (it was matched automatically to what is being removed);
    --   rc  a tier 1 candidate of o on an account of THIS item — every one of them, also when o has a partner
    --       (which is then the closest of them). At the dates of the removal the partner's hold alone would
    --       do; but the evaluator judges a hold on the dates as they THEN are, and if o itself is later
    --       re-dated (a pending payment that posts on another day) a second removed candidate can be the one
    --       that would still have been closer;
    --   y   a tier 1 candidate of o on an account of another item of this user: a competitor that is already
    --       there, and stays.
    -- For each (o, rc, y): record that the pair (o, y) is not to be formed automatically while the removed
    -- candidate — only its date is kept — would still have been at least as close to o (the evaluator decides
    -- that, from the dates as they then are). Card-side leg first; the kind says which side the removed
    -- candidate was on. A SYSTEM record: it claims nothing, publishes no effect and names no destination.
    --   * o had no partner: its ambiguity is kept. It stays without an automatic match, as it was.
    --   * o's partner was on THIS item: (b) recorded the known destination of a cash-side o, and this keeps a
    --     card that was already there from taking the payment merely because that destination disappeared.
    --     With tier 1 withheld, the leg reads its record: untracked / removed_card.
    -- A leg whose candidates are all on one side of the removal, or whose automatic match stays, gets nothing.
    -- The candidate test is the evaluator's tier 1 edge and must stay that rule: both legs in the pool,
    -- opposite sides, exactly opposite cents, at most 5 days apart, not dismissed by the user.
    -- (The alias is rc, not r: r is this function's loop record, and PL/pgSQL would read r.id as its field.)
    insert into public.card_payment_decisions
      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,
       counterpart_date)
    select distinct p_user_id, h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date
    from (
      select case when not o.credit then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,
             case when o.credit then o.account_id else y.account_id end as a_account,
             case when o.credit then ot.plaid else yt.plaid end as a_plaid,
             case when o.credit then o.cents else y.cents end as a_cents,
             case when o.credit then y.account_id else o.account_id end as b_account,
             case when o.credit then yt.plaid else ot.plaid end as b_plaid,
             case when o.credit then y.cents else o.cents end as b_cents,
             rt.date as removed_date
      from pg_temp.cpe_pool o
      join pg_temp.cpe_txn ot on ot.id = o.id
      join public.accounts oa on oa.id = o.account_id
      join public.plaid_items oi on oi.id = oa.item_id
      left join pg_temp.cpe_tier1 t1 on t1.id = o.id
      left join pg_temp.cpe_pool tp on tp.id = t1.partner
      left join public.accounts pa on pa.id = tp.account_id
      join pg_temp.cpe_pool rc on rc.id <> o.id and rc.credit <> o.credit and rc.cents = -o.cents and abs(o.day - rc.day) <= 5
      join pg_temp.cpe_txn rt on rt.id = rc.id
      join public.accounts ra on ra.id = rc.account_id
      join public.plaid_items ri on ri.id = ra.item_id
      join pg_temp.cpe_pool y on y.id <> o.id and y.credit <> o.credit and y.cents = -o.cents and abs(o.day - y.day) <= 5
      join pg_temp.cpe_txn yt on yt.id = y.id
      join public.accounts ya on ya.id = y.account_id
      join public.plaid_items yi on yi.id = ya.item_id
      where oi.user_id = p_user_id and oi.id <> p_item_id
        and ri.user_id = p_user_id and ri.id = p_item_id
        and yi.user_id = p_user_id and yi.id <> p_item_id
        and (t1.partner is null or pa.item_id = p_item_id)
        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id))
        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, y.id) and dd.hi = greatest(o.id, y.id))
    ) h
    where not exists (select 1 from public.card_payment_decisions d
                      where d.user_id = p_user_id and d.kind = h.kind and d.superseded_by is null
                        and d.a_account_id = h.a_account and d.a_plaid_transaction_id = h.a_plaid and d.a_cents = h.a_cents
                        and d.b_account_id = h.b_account and d.b_plaid_transaction_id = h.b_plaid and d.b_cents = h.b_cents
                        and d.counterpart_date = h.removed_date)
    order by 2, 3, 4, 6, 7, 9;
  exception when others then
    raise exception 'remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE %); nothing was removed', sqlstate
      using errcode = sqlstate;
  end;

  v_adjustments := '[]'::jsonb;
  for r in
    select x.loan_id, x.linked, x.restore, ml.name, ml.current_balance
    from (select t.manual_loan_id as loan_id, count(*) as linked, sum(t.loan_balance_applied) as restore
          from public.transactions t join public.accounts a on a.id = t.account_id
          where a.item_id = p_item_id and t.manual_loan_id is not null
          group by t.manual_loan_id) x
    join public.manual_loans ml on ml.id = x.loan_id
    order by x.loan_id
    for update of ml
  loop
    update public.manual_loans
    set current_balance = current_balance + r.restore,
        updated_at = now()
    where id = r.loan_id;

    v_adjustments := v_adjustments || jsonb_build_object(
      'loan_id', r.loan_id, 'loan_name', r.name, 'linked_transactions', r.linked, 'restored', r.restore,
      'balance_before', r.current_balance, 'balance_after', r.current_balance + r.restore);
  end loop;

  v_counts := jsonb_build_object(
    'accounts', (select count(*) from public.accounts a where a.item_id = p_item_id),
    'transactions', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                     where a.item_id = p_item_id),
    'linked_transactions', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                            where a.item_id = p_item_id and t.manual_loan_id is not null),
    'splits', (select count(*) from public.transaction_splits s join public.transactions t on t.id = s.transaction_id
               join public.accounts a on a.id = t.account_id where a.item_id = p_item_id),
    'recurring_streams', (select count(*) from public.recurring_streams rs where rs.item_id = p_item_id),
    'liabilities', (select count(*) from public.loans l where l.item_id = p_item_id));

  -- Cascades: accounts -> transactions -> transaction_splits; recurring_streams; loans. The encrypted
  -- access token goes with this row. Card-payment decisions that reference one of its accounts go too
  -- (their account cascade): the pairs converted above, and anything else decided about its legs.
  delete from public.plaid_items where id = p_item_id and user_id = p_user_id;

  update public.plaid_item_removals
  set status = 'cleaned', cleaned_at = now(), loan_adjustments = v_adjustments, deleted_counts = v_counts
  where id = v_removal.id;

  -- Card-payment matching, part 2: the states of what is left, published with the version that includes
  -- every write above — so a removal normally commits fresh states. BEST-EFFORT, in a subtransaction, and
  -- the LAST statement, so nothing after it can make the publication stale. The evidence is preserved and
  -- the removal is done: if this evaluation fails, only it is rolled back. The removal commits, the
  -- version stays ahead of the evaluated one, the SQLSTATE alone is recorded, and the reader returns no
  -- states until a later evaluation succeeds (Trevor's decision, 2026-10-06).
  perform public.try_evaluate_card_payments(p_user_id);

  return jsonb_build_object('replayed', false, 'loan_adjustments', v_adjustments, 'deleted_counts', v_counts);
end;
$$;

do $$
declare
  v_oid oid := 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure;
  v_live bigint;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_oid) <> '7997a757408fa888aa44bdbc9d85f89d' then
    raise exception 'rollback did not restore the 20261006120000 definition exactly';
  end if;
  perform 1 from pg_proc p
  where p.oid = v_oid
    and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
    and not p.prosecdef
    and p.provolatile = 'v'
    and p.proconfig = array['search_path=""']
    and not has_function_privilege('public', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute');
  if not found then
    raise exception 'remove_plaid_item_local lost a security or definition property';
  end if;
  if pg_get_function_result(v_oid) <> 'jsonb'
     or pg_get_function_arguments(v_oid) <> 'p_user_id uuid, p_item_id uuid'
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'remove_plaid_item_local') <> 1 then
    raise exception 'the remove_plaid_item_local signature changed, or an overload exists';
  end if;
  -- The provenance tables are kept, with everything in them: the same rows, unchanged.
  if to_regclass('public.card_payment_removal_generations') is null
     or to_regclass('public.card_payment_removal_sources') is null then
    raise exception 'a provenance table is missing: this rollback must not drop them';
  end if;
  if exists (
       select 1
       from (select 'generations' as tbl, count(*) as n, coalesce(md5(string_agg(md5(g::text), '' order by g.removal_id)), '') as digest
             from public.card_payment_removal_generations g
             union all
             select 'sources', count(*), coalesce(md5(string_agg(md5(s::text), '' order by s.decision_id)), '')
             from public.card_payment_removal_sources s) now_
       join pg_temp.rpp_rollback_before b using (tbl)
       where now_.n <> b.n or now_.digest <> b.digest) then
    raise exception 'a provenance row changed during this rollback: it must not delete or rewrite any';
  end if;
  -- Said aloud, because it is the one consequence an operator must know of (this file's header).
  select count(*) into v_live
  from public.card_payment_removal_sources s
  join public.card_payment_decisions d on d.id = s.decision_id
  where d.superseded_by is null and s.source_relation <> 'confirmed_counterpart';
  raise notice 'remove_plaid_item_local is the 20261006120000 definition again. % live system row(s) keep their provenance. Removals made until 20261008120000 is applied again record none, and may merge into those rows; they are marked when it is applied again.', v_live;
end
$$;

commit;
