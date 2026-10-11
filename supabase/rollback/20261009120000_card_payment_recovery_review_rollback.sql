-- Rollback of 20261009120000_card_payment_recovery_review.sql (Phase B, I3A-R packet 2-A).
--
-- Run it BEFORE the rollback of 20261008120000 (that script, and the two older ones, refuse while this file's
-- bodies are installed).
--
-- WHAT IT RESTORES: the three function bodies this migration replaced, verbatim and checksum-verified —
-- evaluate_card_payments (20261006110000), remove_plaid_item_local (20261008120000) and
-- get_card_payment_states (20260930120000). It drops the functions and triggers the migration added.
--
-- WHAT IT KEEPS: every table and every row — review obligations, their sources and known edges, receipts,
-- annotations, the refresh queue. Dropping them would destroy what the migration exists to keep, and the
-- migration can be applied again on top of them.
--
-- WHY IT REFUSES BY DEFAULT. The restored evaluator has no relink-review guard. For an owner who has review
-- obligations it would pair an unreviewed transaction automatically and publish "tracked, 0" as a fresh
-- figure (packet 2 errata E7). So this script REFUSES while any review obligation exists.
--
-- THE OPERATOR'S OVERRIDE. If the rollback must happen anyway:
--     set card_payment.recovery_review_rollback = 'fence_affected_owners';
-- in the session that runs this file. The script then proceeds AND installs a fence: a trigger on
-- card_payment_eval_versions that keeps evaluated_version NULL for every owner who has a review obligation.
-- The restored reader then never returns states for such an owner, the decision RPCs refuse them as stale, and
-- every role-aware figure of theirs is unavailable — explicitly, not silently wrong. Owners with no obligation
-- are unaffected. The fence is removed by applying the migration again, and by nothing else here.
--   * While rolled back, a removal still preserves decisions and their provenance (20261008120000's body) but
--     captures no review obligation. Applying the migration again seeds obligations for those decisions from
--     what is retained (a hold's own edge only) and re-evaluates everyone.
--   * Receipts stay readable in the table; no function reads them while rolled back.

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6a8f92136f769ccd91fbd7fa57f3a519'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> '5b3cb3fdc0ab9570a345cf1ace387481'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '8ec18bc2b27acc658fdb5a42c7251e8e' then
    raise exception 'the installed functions are not the 20261009120000 definitions; refusing to roll back';
  end if;
  if exists (select 1 from public.card_payment_review_obligations)
     and current_setting('card_payment.recovery_review_rollback', true) is distinct from 'fence_affected_owners' then
    raise exception 'review obligations exist: the previous evaluator would publish unreviewed automatic pairs as fresh figures. '
                    'Refusing to roll back. To proceed and make every affected owner''s figures unavailable instead, run: '
                    'set card_payment.recovery_review_rollback = ''fence_affected_owners''';
  end if;
end
$$;

-- ---- The fence (only when obligations exist; the guard above has required the operator's setting) ----------
create or replace function public.card_payment_recovery_downgrade_fence() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.evaluated_version is not null
     and exists (select 1 from public.card_payment_review_obligations o where o.user_id = new.user_id) then
    new.evaluated_version := null;
  end if;
  return new;
end;
$$;
revoke all on function public.card_payment_recovery_downgrade_fence() from public, anon, authenticated, service_role;

drop trigger if exists card_payment_recovery_downgrade_fence on public.card_payment_eval_versions;
do $$
begin
  if exists (select 1 from public.card_payment_review_obligations) then
    create trigger card_payment_recovery_downgrade_fence
      before insert or update on public.card_payment_eval_versions
      for each row execute function public.card_payment_recovery_downgrade_fence();
    -- What is stored now was published by the guarded evaluator, but the restored reader could not tell a
    -- later unguarded result from it: make every affected owner unreadable from this moment.
    update public.card_payment_eval_versions v set evaluated_version = null
    where exists (select 1 from public.card_payment_review_obligations o where o.user_id = v.user_id);
  else
    drop function public.card_payment_recovery_downgrade_fence();
  end if;
end
$$;

-- No stamp survives the evaluator that wrote it.
delete from public.card_payment_evaluator_contracts;

-- ---- What the migration added ------------------------------------------------------------------------------
drop trigger if exists card_payment_recovery_enqueue on public.card_payment_eval_versions;
drop trigger if exists card_payment_review_obligations_changed on public.card_payment_review_obligations;
drop trigger if exists card_payment_review_memberships_changed on public.card_payment_review_memberships;
drop trigger if exists card_payment_review_obligation_sources_changed on public.card_payment_review_obligation_sources;
drop trigger if exists card_payment_review_annotations_changed on public.card_payment_review_annotations;

drop function if exists public.get_card_payment_recovery_reviews(uuid, text, integer);
drop function if exists public.refresh_card_payment_recovery_owner(uuid, uuid);
drop function if exists public.claim_card_payment_recovery_refresh(uuid, integer);
drop function if exists public.request_card_payment_recovery_refresh(uuid, uuid);
drop function if exists public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb);
drop function if exists public.get_card_payment_recovery_action(uuid, uuid);
drop function if exists public.card_payment_recovery_receipt(uuid, uuid);
drop function if exists public.card_payment_recovery_freshness(uuid);
drop function if exists public.card_payment_recovery_enqueue();
drop function if exists public.card_payment_review_inputs_changed();
drop function if exists public.card_payment_review_notes_changed();
drop function if exists public.card_payment_review_seed_retained();

-- ---- The three previous bodies, verbatim ------------------------------------------------------------------
create or replace function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
  v_item_status text;
  v_institution_id text;
  v_planned bigint;
  v_written bigint;
  v_recorded bigint;
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

  select pi.status, pi.institution_id into v_item_status, v_institution_id from public.plaid_items pi
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

  -- Preserve what is known before anything is deleted (20261006120000's header, step 3; this file's header,
  -- THE FUNCTION): three statements plan it, and the plan is written with its provenance.
  begin
    -- Provenance (20261008120000). First, every EARLIER removal of this user that finished without recording
    -- any — before this body existed, or while it was rolled back — gets its MARKER now, under the user's
    -- advisory lock. Such a removal merged by pair and date: it may have left what it knew on a row an older
    -- removal wrote. The marker's place in the user's order (its ordinal, assigned by the table's trigger)
    -- says which rows those can be: every one that was written before it.
    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
    select pr.id, pr.user_id, false
    from public.plaid_item_removals pr
    where pr.user_id = p_user_id and pr.status = 'cleaned'
      and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = pr.id)
    order by pr.cleaned_at, pr.id;

    -- Then the GENERATION of this removal, once. Its primary key is the removal's id, so a second execution
    -- for one removal cannot write a second set of rows: it would fail here, and the handler below turns that
    -- into the refusal that removes nothing.
    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)
    values (v_removal.id, p_user_id, true, v_institution_id);

    -- The PLAN: one row per decision this removal is about to write, with the id that decision will have and
    -- the removed transaction it depends on (its source). (a), (b) and (c) below fill it; then it is written
    -- twice: the decisions, and one provenance row for each. A scratch table of this transaction, like the
    -- evaluator's.
    create temporary table if not exists pg_temp.rpp_plan (
      decision_id uuid primary key,
      step text not null,
      kind text not null,
      a_account uuid not null, a_plaid text not null, a_cents bigint not null,
      b_account uuid, b_plaid text, b_cents bigint,
      accepted_difference_cents bigint, counterpart_status text, counterpart_date date,
      decided_seq bigint, created_at timestamp with time zone,
      source_relation text not null,
      source_account uuid not null, source_txn uuid, source_plaid text not null,
      ord uuid not null
    ) on commit drop;
    truncate pg_temp.rpp_plan;

    -- (a) USER-CONFIRMED pairs with one leg on an account of THIS item and the other on an account of
    -- another item of this user. The cascade below deletes the pair; the user's confirmation is kept first,
    -- as a USER decision on the leg that survives — whichever side that is, and whether the pair is active
    -- or not. counterpart_status freezes what was true of the removed side: 'valid' when the evaluation
    -- above found the pair active; otherwise the removed leg's own status, and, if that leg is valid,
    -- whether the two legs still relate as recorded (sides, direction, accepted difference).
    -- NOT a pair one of whose legs the USER re-classified away from card payment: that newer explicit
    -- action supersedes the confirmation, which is not carried forward.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, b_plaid, b_cents,
       accepted_difference_cents, counterpart_status, decided_seq, created_at,
       source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'a', 'pair_counterpart_removed', o.sv_account, o.sv_plaid, o.sv_cents, o.rm_plaid, o.rm_cents,
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
           d.decided_seq, d.created_at,
           'confirmed_counterpart', o.rm_account, public.card_payment_lineage_row(o.rm_account, o.rm_plaid), o.rm_plaid, d.id
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
    -- ONE RECORD PER REMOVED PARTNER (20261008120000). The record depends on THAT transaction, and its
    -- provenance row says so. A live record that an earlier removal wrote for this leg is not reused and does
    -- not suppress this one: it depends on another source. Several live records on one leg read as one.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'b', 'destination_removed_card', t.account_id, t.plaid_transaction_id, s.amount_cents,
           'automatic_partner', pt.account_id, pt.id, pt.plaid_transaction_id, t.id
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
    -- candidate — on the hold only its date is kept — would still have been at least as close to o (the evaluator decides
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
    -- ONE HOLD PER (o, rc, y) (20261008120000). Each removed candidate is a dependency of its own: two removed
    -- candidates with the same date are two holds, and a hold that an earlier removal wrote on the same pair
    -- with the same date is neither reused nor a reason to write none. Identical live holds withhold as one.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, b_account, b_plaid, b_cents, counterpart_date,
       source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'c', h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date,
           h.source_relation, h.source_account, h.source_txn, h.source_plaid, h.source_txn
    from (
      select case when not o.credit then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,
             case when o.credit then o.account_id else y.account_id end as a_account,
             case when o.credit then ot.plaid else yt.plaid end as a_plaid,
             case when o.credit then o.cents else y.cents end as a_cents,
             case when o.credit then y.account_id else o.account_id end as b_account,
             case when o.credit then yt.plaid else ot.plaid end as b_plaid,
             case when o.credit then y.cents else o.cents end as b_cents,
             case when t1.partner = rc.id then 'automatic_partner' else 'removed_candidate' end as source_relation,
             rc.account_id as source_account, rc.id as source_txn, rt.plaid as source_plaid,
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
    ) h;

    -- Write the plan. First the decisions, with the columns and in the order each statement used before; each
    -- gets the id the plan gave it. (Holds that differ only in their source are ordered by its Plaid id.)
    insert into public.card_payment_decisions
      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,
       accepted_difference_cents, counterpart_status, decided_seq, created_at)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents, p.b_plaid, p.b_cents,
           p.accepted_difference_cents, p.counterpart_status, p.decided_seq, p.created_at
    from pg_temp.rpp_plan p
    where p.step = 'a'
    order by p.ord;
    get diagnostics v_written = row_count;
    insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents
    from pg_temp.rpp_plan p
    where p.step = 'b'
    order by p.ord;
    get diagnostics v_recorded = row_count;
    v_written := v_written + v_recorded;
    insert into public.card_payment_decisions
      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,
       counterpart_date)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents, p.b_account, p.b_plaid, p.b_cents,
           p.counterpart_date
    from pg_temp.rpp_plan p
    where p.step = 'c'
    order by p.kind, p.a_account, p.a_plaid, p.b_account, p.b_plaid, p.counterpart_date, p.source_plaid collate "C";
    get diagnostics v_recorded = row_count;
    v_written := v_written + v_recorded;

    -- Then, for every one of them, its provenance: this removal, the removed account and the removed
    -- transaction. ALL of it is read HERE, in this one statement, from the rows that are still there — so rows
    -- that share a source describe it identically. The delete below takes those rows; this is what remains of
    -- them. For a confirmed pair whose reference resolved to no single row, what was there instead is
    -- recorded: several rows (ambiguous), an unconsumed carry-over of the removed pending row (its date and
    -- amount), or nothing. For a system row there is no such case: the table's trigger refuses it.
    insert into public.card_payment_removal_sources
      (decision_id, user_id, removal_id, source_relation, source_resolution, source_plaid_account_id,
       source_plaid_transaction_id, source_pending_transaction_id, source_pending, source_date, source_cents,
       source_iso_currency_code, source_account_type, source_account_subtype, source_account_mask)
    select p.decision_id, p_user_id, v_removal.id, p.source_relation,
           case when st.id is not null then 'row'
                when named.n > 0 then 'ambiguous'
                when co.id is not null then 'waiting_to_post'
                else 'gone' end,
           sa.plaid_account_id,
           st.plaid_transaction_id, st.pending_transaction_id,
           case when st.id is not null then coalesce(st.pending, false) end,
           case when st.id is not null then st.date when named.n = 0 then co.pending_date end,
           case when st.id is not null then (st.amount * 100)::bigint when named.n = 0 then (co.pending_amount * 100)::bigint end,
           st.iso_currency_code, sa.type, sa.subtype, sa.mask
    from pg_temp.rpp_plan p
    join public.accounts sa on sa.id = p.source_account
    left join public.transactions st on st.id = p.source_txn
    cross join lateral (select count(*) as n from public.transactions x
                        where st.id is null and x.account_id = p.source_account
                          and p.source_plaid in (x.plaid_transaction_id, x.pending_transaction_id)) named
    left join public.transaction_carryovers co
      on st.id is null and co.account_id = p.source_account and co.pending_plaid_transaction_id = p.source_plaid
     and co.consumed_at is null and co.expires_at > now();
    get diagnostics v_recorded = row_count;
    -- No decision without its provenance, and no planned decision unwritten: anything else removes nothing.
    select count(*) into v_planned from pg_temp.rpp_plan;
    if v_written <> v_planned or v_recorded <> v_planned then
      raise exception 'remove_plaid_item_local: % decisions were planned, % written, % given a provenance row',
        v_planned, v_written, v_recorded;
    end if;
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

create or replace function public.evaluate_card_payments(p_user_id uuid, p_as_of timestamp with time zone default now())
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_version bigint;
  v_included_credit boolean;
  v_as_of_day integer := ((p_as_of at time zone 'UTC')::date - date '1970-01-01');
  d record;
  v_accs uuid[];
  v_plaids text[];
  v_kinds text[];
  v_rows uuid[];
  v_i integer;
  v_n integer;
  v_row uuid;
  v_conflict boolean;
  v_inactive text;
  v_ra record;
  v_rb record;
  v_cash record;
  v_credit record;
  l record;
  v_claim record;
  v_has_claim boolean;
  v_t1_partner uuid;
  v_state text;
  v_reason text;
  v_detail text;
  v_partner uuid;
  v_decision uuid;
  v_effect bigint;
  v_cash_excess bigint;
  v_card_excess bigint;
  v_contra boolean;
  v_pair_partner uuid;
  v_pair_reason text;
  v_p record;
  v_matched bigint;
  s record;
  v_cands jsonb;
  v_low bigint;
  v_high bigint;
begin
  -- Step 1: READ COMMITTED, so every statement after the L2 lock sees every commit before it.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'card_payment_evaluation_requires_read_committed (got %)', current_setting('transaction_isolation')
      using errcode = '25001';
  end if;
  -- Step 2: L1.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  -- Step 3: L2, and the version these states will be stamped with. Never re-read.
  insert into public.card_payment_eval_versions (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select ev.input_version into v_version from public.card_payment_eval_versions ev where ev.user_id = p_user_id for update;
  -- Step 3a: from this capture on, every input write this transaction makes must bump again, so clear the
  -- user's bump-coalescing marker (card_payment_bump, 20261002120000). Otherwise a write after the capture,
  -- by a transaction that had already bumped this user, would be coalesced, and the publication below would
  -- stamp states that miss it as fresh.
  perform set_config('card_payment.bumped_' || replace(p_user_id::text, '-', ''), '', true);

  -- Step 4: inputs (every statement from here takes a fresh snapshot, after L2).
  -- The scratch tables below are this function's own, with ONE outside reader: remove_plaid_item_local
  -- (20261006120000) reads cpe_pool, cpe_txn, cpe_tier1 and cpe_dismissed — these names and columns — in its
  -- own transaction, right after its strict call of this function, to derive the ambiguity holds from the
  -- complete pool. A migration that replaces this function must replace, or guard on, that one in the same file.
  create temporary table if not exists cpe_accounts (id uuid primary key, credit boolean not null, included boolean not null) on commit drop;
  create temporary table if not exists cpe_txn (
    id uuid primary key, account_id uuid not null, plaid text not null, pending_of text, pending boolean not null,
    day integer not null, date date not null, cents bigint not null, role text, credit boolean not null,
    included boolean not null, superseded boolean not null default false, conflict boolean not null default false,
    is_leg boolean not null default false, in_pool boolean not null default false) on commit drop;
  -- Lineage lookups (replacements by pending id; rows by Plaid id) over every row: non-card rows are kept
  -- because lineage and role-change handling need them.
  create index if not exists cpe_txn_pending_of_idx on pg_temp.cpe_txn (account_id, pending_of);
  create index if not exists cpe_txn_plaid_idx on pg_temp.cpe_txn (account_id, plaid);
  create temporary table if not exists cpe_pool (
    id uuid primary key, account_id uuid not null, day integer not null, cents bigint not null, credit boolean not null) on commit drop;
  create temporary table if not exists cpe_named (decision_id uuid not null, row_id uuid not null) on commit drop;
  create temporary table if not exists cpe_dismissed (lo uuid not null, hi uuid not null, primary key (lo, hi)) on commit drop;
  create temporary table if not exists cpe_removed (row_id uuid primary key, decision_id uuid not null) on commit drop;
  create temporary table if not exists cpe_udec (
    decision_id uuid primary key, kind text not null, row_a uuid, row_b uuid, a_cents bigint not null, inactive text) on commit drop;
  create temporary table if not exists cpe_dec_result (
    decision_id uuid primary key, kind text not null, status text not null, detail text) on commit drop;
  create temporary table if not exists cpe_claim (leg_id uuid not null, decision_id uuid not null, primary key (leg_id, decision_id)) on commit drop;
  create temporary table if not exists cpe_tier1 (id uuid primary key, partner uuid not null) on commit drop;
  create temporary table if not exists cpe_hold (owner_id uuid not null, other_id uuid not null, day integer not null) on commit drop;
  create temporary table if not exists cpe_tracked (
    cash_account uuid not null, credit_account uuid not null, abs_cents bigint not null, cash_day integer not null,
    credit_day integer not null) on commit drop;
  create temporary table if not exists cpe_state (
    id uuid primary key, state text not null, reason text, detail text, partner uuid, decision_id uuid, effect bigint,
    cash_excess bigint not null, card_excess bigint not null, contradictions boolean not null) on commit drop;
  truncate pg_temp.cpe_accounts, pg_temp.cpe_txn, pg_temp.cpe_pool, pg_temp.cpe_named, pg_temp.cpe_dismissed, pg_temp.cpe_removed,
           pg_temp.cpe_udec, pg_temp.cpe_dec_result, pg_temp.cpe_claim, pg_temp.cpe_tier1, pg_temp.cpe_tracked,
           pg_temp.cpe_state, pg_temp.cpe_hold;

  -- The user's accounts (credit side iff type = 'credit'; NULL type is cash side) and rows.
  insert into pg_temp.cpe_accounts (id, credit, included)
  select a.id, coalesce(a.type = 'credit', false), not a.exclude_from_cash_flow
  from public.accounts a join public.plaid_items i on i.id = a.item_id
  where i.user_id = p_user_id;

  insert into pg_temp.cpe_txn (id, account_id, plaid, pending_of, pending, day, date, cents, role, credit, included)
  select t.id, t.account_id, t.plaid_transaction_id, t.pending_transaction_id, coalesce(t.pending, false),
         t.date - date '1970-01-01', t.date, (t.amount * 100)::bigint, t.effective_role, a.credit, a.included
  from public.transactions t join pg_temp.cpe_accounts a on a.id = t.account_id;

  analyze pg_temp.cpe_txn;

  -- §3.6 step 1: superseded pending rows; conflicting replacement groups (approved rule 2026-09-30).
  -- Grouped once over every row: a correlated per-row count was quadratic in the history size.
  update pg_temp.cpe_txn t set superseded = true
  from (select distinct r.account_id, r.pending_of from pg_temp.cpe_txn r where r.pending_of is not null) rep
  where rep.account_id = t.account_id and rep.pending_of = t.plaid;
  update pg_temp.cpe_txn t set conflict = true
  from (select r.account_id, r.pending_of from pg_temp.cpe_txn r where r.pending_of is not null
        group by r.account_id, r.pending_of having count(*) > 1) grp
  where grp.account_id = t.account_id and grp.pending_of = t.pending_of;
  update pg_temp.cpe_txn set is_leg = true where role = 'credit_card_payment' and cents <> 0 and not superseded;

  -- Decisions (§3.5, §3.6): every decision of the user or naming one of the user's accounts.
  for d in
    select c.* from public.card_payment_decisions c
    where c.user_id = p_user_id
       or c.a_account_id in (select a.id from pg_temp.cpe_accounts a)
       or c.b_account_id in (select a.id from pg_temp.cpe_accounts a)
    order by c.id
  loop
    if d.user_id <> p_user_id then
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, 'rejected', 'foreign_user');
      continue;
    end if;
    if not exists (select 1 from pg_temp.cpe_accounts a where a.id = d.a_account_id)
       or (d.b_account_id is not null and not exists (select 1 from pg_temp.cpe_accounts a where a.id = d.b_account_id)) then
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, 'rejected', 'foreign_account');
      continue;
    end if;
    if d.superseded_by is not null then
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, 'superseded', null);
      continue;
    end if;

    -- resolveLineage for each leg reference.
    if d.b_account_id is null then
      v_accs := array[d.a_account_id];
      v_plaids := array[d.a_plaid_transaction_id];
    else
      v_accs := array[d.a_account_id, d.b_account_id];
      v_plaids := array[d.a_plaid_transaction_id, d.b_plaid_transaction_id];
    end if;
    v_kinds := '{}';
    v_rows := '{}';
    for v_i in 1 .. array_length(v_accs, 1) loop
      select count(*) into v_n from pg_temp.cpe_txn t where t.account_id = v_accs[v_i] and t.pending_of = v_plaids[v_i];
      if v_n = 1 then
        select t.id into v_row from pg_temp.cpe_txn t where t.account_id = v_accs[v_i] and t.pending_of = v_plaids[v_i];
        v_kinds[v_i] := 'row';
        v_rows[v_i] := v_row;
      elsif v_n > 1 then
        v_kinds[v_i] := 'ambiguous';
        v_rows[v_i] := null;
        if d.kind not in ('not_this_pair', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
          insert into pg_temp.cpe_named (decision_id, row_id)
          select d.id, t.id from pg_temp.cpe_txn t where t.account_id = v_accs[v_i] and t.pending_of = v_plaids[v_i];
        end if;
      else
        select t.id, t.conflict into v_row, v_conflict from pg_temp.cpe_txn t
        where t.account_id = v_accs[v_i] and t.plaid = v_plaids[v_i];
        if found and v_conflict then
          -- naming one conflicting replacement by its own posted id is just as ambiguous
          v_kinds[v_i] := 'ambiguous';
          v_rows[v_i] := null;
          if d.kind not in ('not_this_pair', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
            insert into pg_temp.cpe_named (decision_id, row_id) values (d.id, v_row);
          end if;
        elsif found then
          v_kinds[v_i] := 'row';
          v_rows[v_i] := v_row;
        elsif exists (select 1 from public.transaction_carryovers c
                      where c.account_id = v_accs[v_i] and c.pending_plaid_transaction_id = v_plaids[v_i]
                        and c.consumed_at is null and c.expires_at > p_as_of) then
          v_kinds[v_i] := 'waiting';
          v_rows[v_i] := null;
        else
          v_kinds[v_i] := 'gone';
          v_rows[v_i] := null;
        end if;
      end if;
    end loop;

    v_inactive := case when 'ambiguous' = any (v_kinds) then 'lineage_ambiguous'
                       when 'gone' = any (v_kinds) then 'partner_gone'
                       when 'waiting' = any (v_kinds) then 'waiting_to_post' end;

    if d.kind = 'not_this_pair' then
      -- Suppresses one candidate whenever both legs have current rows, whatever the amounts.
      if v_kinds[1] = 'row' and v_kinds[2] = 'row' then
        insert into pg_temp.cpe_dismissed values (least(v_rows[1], v_rows[2]), greatest(v_rows[1], v_rows[2]))
        on conflict do nothing;
        insert into pg_temp.cpe_dec_result values (d.id, d.kind, 'active', null);
      else
        insert into pg_temp.cpe_dec_result values (d.id, d.kind, 'inactive', v_inactive);
      end if;
      continue;
    end if;

    if d.kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
      -- A system ambiguity hold (§4.7), written by institution removal on ONE possible pair of two legs that
      -- both survive. Not a user decision: it claims nothing. It applies while both references resolve to
      -- current card legs on opposite sides with the recorded cents; anything else is new evidence, and the
      -- ordinary rules decide alone.
      if v_inactive is null then
        select * into v_ra from pg_temp.cpe_txn t where t.id = v_rows[1];
        select * into v_rb from pg_temp.cpe_txn t where t.id = v_rows[2];
        if v_ra.cents <> d.a_cents or v_rb.cents <> d.b_cents then
          v_inactive := 'amount_changed';
        elsif not v_ra.is_leg or not v_rb.is_leg then
          v_inactive := 'role_changed';
        elsif v_ra.credit = v_rb.credit then
          v_inactive := 'sides_not_opposite';
        end if;
      end if;
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, case when v_inactive is null then 'active' else 'inactive' end, v_inactive);
      if v_inactive is null then
        -- owner: the leg the removed candidate competed for — the cash-side leg when a card leg was removed,
        -- the card-side leg when a cash leg was.
        insert into pg_temp.cpe_hold (owner_id, other_id, day)
        select case when v_ra.credit = (d.kind = 'ambiguity_hold_removed_card') then v_rows[2] else v_rows[1] end,
               case when v_ra.credit = (d.kind = 'ambiguity_hold_removed_card') then v_rows[1] else v_rows[2] end,
               d.counterpart_date - date '1970-01-01';
      end if;
      continue;
    end if;

    if v_inactive is null then
      -- shapeDetail: a preserved pair's frozen disqualifier first (it is about the side that is gone); then, as
      -- for every decision, amount first, then role, then sides / direction / accepted difference.
      select * into v_ra from pg_temp.cpe_txn t where t.id = v_rows[1];
      if d.kind = 'pair' then
        select * into v_rb from pg_temp.cpe_txn t where t.id = v_rows[2];
      else
        v_rb := v_ra; -- keeps the record assigned; only read when kind = pair
      end if;
      if d.kind = 'pair_counterpart_removed' and d.counterpart_status not in ('valid', 'waiting_to_post', 'amount_changed') then
        -- A preserved pair (§4.7) whose REMOVED side was invalid for a reason other than its amount. That is
        -- frozen in the decision, and it is the decision's reason whatever the amount or role of the leg that
        -- survived is now: a later correction of the surviving leg resolves nothing about the side that is
        -- gone. Checked BEFORE the amount, so that it can never be reported as 'amount_changed' — the one
        -- inactive reason the known-effect exception below accepts.
        v_inactive := d.counterpart_status;
      elsif v_ra.cents <> d.a_cents or (d.kind = 'pair' and v_rb.cents <> d.b_cents) then
        v_inactive := 'amount_changed';
      elsif not v_ra.is_leg or (d.kind = 'pair' and not v_rb.is_leg) then
        v_inactive := 'role_changed';
      elsif d.kind = 'pair_counterpart_removed' then
        -- A preserved pair holds the leg that survived, on either side, and that leg is valid. Of the frozen
        -- statuses only the removed side's own amount change is left to keep it inactive.
        v_inactive := case when d.counterpart_status = 'amount_changed' then 'amount_changed' end;
      elsif d.kind <> 'pair' then
        v_inactive := case when v_ra.credit then 'not_cash_side' end;
      elsif v_ra.credit = v_rb.credit then
        v_inactive := 'sides_not_opposite';
      else
        if not v_ra.credit then v_cash := v_ra; v_credit := v_rb; else v_cash := v_rb; v_credit := v_ra; end if;
        if sign(v_cash.cents::numeric) <> -sign(v_credit.cents::numeric) then
          v_inactive := 'direction_mismatch';
        elsif abs(v_cash.cents) - abs(v_credit.cents) <> d.accepted_difference_cents then
          v_inactive := 'difference_not_accepted';
        end if;
      end if;
    end if;

    if d.kind = 'destination_removed_card' then
      -- System-written (§4.7): ranks below tier 1 and holds nothing; inactive → simply not applied.
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, case when v_inactive is null then 'active' else 'inactive' end, v_inactive);
      if v_inactive is null then
        insert into pg_temp.cpe_removed values (v_rows[1], d.id)
        on conflict (row_id) do update set decision_id = least(pg_temp.cpe_removed.decision_id, excluded.decision_id);
      end if;
      continue;
    end if;
    insert into pg_temp.cpe_udec values (d.id, d.kind, v_rows[1], v_rows[2], d.a_cents, v_inactive);
  end loop;

  -- Claims: a user decision holds its current card rows, active or not; a row held twice is a conflict.
  insert into pg_temp.cpe_claim (leg_id, decision_id)
  select distinct x.row_id, u.decision_id
  from pg_temp.cpe_udec u cross join lateral (values (u.row_a), (u.row_b)) x(row_id)
  join pg_temp.cpe_txn t on t.id = x.row_id and t.is_leg
  where x.row_id is not null;
  update pg_temp.cpe_udec u set inactive = 'conflicting_decisions'
  where exists (select 1 from pg_temp.cpe_claim c where c.decision_id = u.decision_id
                  and (select count(*) from pg_temp.cpe_claim c2 where c2.leg_id = c.leg_id) > 1);
  insert into pg_temp.cpe_dec_result
  select u.decision_id, u.kind, case when u.inactive is null then 'active' else 'inactive' end, u.inactive from pg_temp.cpe_udec u;

  -- Tier 1 (§3.3) over unclaimed, non-conflicting legs of the whole pool (excluded accounts included).
  update pg_temp.cpe_txn t set in_pool = true
  where t.is_leg and not t.conflict and not exists (select 1 from pg_temp.cpe_claim c where c.leg_id = t.id);
  insert into pg_temp.cpe_pool (id, account_id, day, cents, credit)
  select t.id, t.account_id, t.day, t.cents, t.credit from pg_temp.cpe_txn t where t.in_pool;
  analyze pg_temp.cpe_pool;
  insert into pg_temp.cpe_tier1 (id, partner)
  with e as (
    select x.id as x_id, y.id as y_id, abs(x.day - y.day) as dist
    from pg_temp.cpe_pool x join pg_temp.cpe_pool y
      on y.id <> x.id and y.credit <> x.credit and y.cents = -x.cents and abs(x.day - y.day) <= 5
    where not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(x.id, y.id) and dd.hi = greatest(x.id, y.id))
  ), ranked as (
    -- closest candidate wins; a tie at the closest distance is ambiguous (no best)
    select e.x_id, e.y_id, e.dist, min(e.dist) over (partition by e.x_id) as dmin,
           count(*) over (partition by e.x_id, e.dist) as n_at_dist
    from e
  ), best as (
    select r.x_id, r.y_id from ranked r where r.dist = r.dmin and r.n_at_dist = 1
  )
  select b1.x_id, b1.y_id from best b1 join best b2 on b2.x_id = b1.y_id and b2.y_id = b1.x_id;

  -- Ambiguity holds (§4.7): institution removal is not evidence. The automatic pair of a hold's own two legs
  -- is withheld while the candidate that was removed would still be at least as close to the leg it competed
  -- for (the owner) as that leg's partner is, on the dates as they are now. Only that pair: both legs stay in
  -- the pool as candidates, no other pair is formed in its place, and a pair with any other leg is untouched.
  delete from pg_temp.cpe_tier1 t1
  using pg_temp.cpe_hold h
    join pg_temp.cpe_txn o on o.id = h.owner_id
    join pg_temp.cpe_txn x on x.id = h.other_id
  where ((t1.id = h.owner_id and t1.partner = h.other_id) or (t1.id = h.other_id and t1.partner = h.owner_id))
    and abs(h.day - o.day) <= abs(o.day - x.day);
  -- Institution removal (20261006120000) reads cpe_pool, cpe_txn, cpe_dismissed and cpe_tier1 AS THEY ARE FROM
  -- HERE ON, in its own transaction, right after its strict call of this function: the complete pool and its
  -- automatic pairs, before any presentation rule (a leg on an excluded account is published not_counted, with
  -- no candidates, but it is in the pool). Nothing below this line writes any of the four.

  v_included_credit := exists (select 1 from pg_temp.cpe_accounts a where a.credit and a.included);

  -- First pass: every leg's state (precedence §3.2).
  for l in select * from pg_temp.cpe_txn t where t.is_leg order by t.id loop
    v_state := 'unresolved'; v_reason := null; v_detail := null; v_partner := null; v_decision := null;
    v_effect := null; v_cash_excess := 0; v_card_excess := 0; v_contra := false; v_pair_partner := null;
    select u.* into v_claim from pg_temp.cpe_claim c join pg_temp.cpe_udec u on u.decision_id = c.decision_id
    where c.leg_id = l.id order by c.decision_id limit 1;
    v_has_claim := found;
    select t1.partner into v_t1_partner from pg_temp.cpe_tier1 t1 where t1.id = l.id;

    if l.conflict then
      -- 0. Conflicting replacement: unresolved, unmatched, whatever decision exists.
      v_reason := 'ambiguous_replacement';
      v_detail := 'lineage_ambiguous';
      select n.decision_id into v_decision from pg_temp.cpe_named n where n.row_id = l.id order by n.decision_id limit 1;
    elsif v_has_claim then
      v_decision := v_claim.decision_id;
      if v_claim.inactive is null then
        -- 1. An active user decision.
        v_contra := true;
        if v_claim.kind = 'destination_unlinked' then
          v_state := 'untracked'; v_reason := 'user_confirmed_unlinked'; v_effect := -l.cents;
        elsif v_claim.kind = 'pair_counterpart_removed' then
          -- A user-confirmed pair whose other account was removed: the confirmed counterpart is outside the
          -- tracked set. A cash leg counts in full; a card leg is funded from outside (effect 0, as always).
          if l.credit then
            v_state := 'funded_from_excluded'; v_reason := 'removed_cash_account'; v_effect := 0;
          else
            v_state := 'untracked'; v_reason := 'removed_card'; v_effect := -l.cents;
          end if;
        else
          v_pair_partner := case when v_claim.row_a is not null and v_claim.row_a <> l.id then v_claim.row_a else v_claim.row_b end;
          v_pair_reason := 'user_pair';
        end if;
      else
        -- Held by an inactive user decision: reserved, the decision attached (needs review).
        v_detail := v_claim.inactive;
        if v_claim.inactive = 'amount_changed' and v_claim.kind in ('destination_unlinked', 'pair_counterpart_removed') and not l.credit
           and not v_included_credit and sign(l.cents::numeric) = sign(v_claim.a_cents::numeric) then
          -- The one approved exception (2026-09-30): the corrected effect is known independently. Extended
          -- (2026-10-06) to a preserved pair: the absence of any included card establishes it, not the old
          -- confirmation, which stays inactive.
          v_state := 'untracked'; v_reason := 'no_included_card'; v_effect := -l.cents;
        else
          v_reason := case when v_claim.inactive = 'waiting_to_post' then 'matched_leg_not_posted' else 'decision_invalidated' end;
        end if;
      end if;
    elsif v_t1_partner is not null then
      -- 2. Tier 1.
      v_pair_partner := v_t1_partner;
      v_pair_reason := 'auto_pair';
    elsif not l.credit and exists (select 1 from pg_temp.cpe_removed r where r.row_id = l.id) then
      -- 3. Known destination preserved through institution removal (§4.7, T9).
      select r.decision_id into v_decision from pg_temp.cpe_removed r where r.row_id = l.id;
      v_state := 'untracked'; v_reason := 'removed_card'; v_effect := -l.cents;
    elsif not l.credit and not v_included_credit then
      -- 4. Proof: no included card exists.
      v_state := 'untracked'; v_reason := 'no_included_card'; v_effect := -l.cents;
    end if;

    if v_pair_partner is not null then
      -- applyPair (§4.3 fee rules).
      v_partner := v_pair_partner;
      select * into v_p from pg_temp.cpe_txn t where t.id = v_pair_partner;
      if not l.credit then v_cash := l; v_credit := v_p; else v_cash := v_p; v_credit := l; end if;
      v_matched := least(abs(v_cash.cents), abs(v_credit.cents));
      v_cash_excess := abs(v_cash.cents) - v_matched;
      v_card_excess := abs(v_credit.cents) - v_matched;
      if not l.credit then
        if not v_credit.included then
          v_state := 'untracked'; v_reason := 'partner_excluded'; v_effect := -v_cash.cents;
        else
          v_state := 'tracked'; v_reason := v_pair_reason;
          v_effect := case when v_cash_excess = 0 then 0 when v_cash.cents > 0 then -v_cash_excess else v_cash_excess end;
        end if;
        if v_credit.included and v_cash.included then
          insert into pg_temp.cpe_tracked values (v_cash.account_id, v_credit.account_id, abs(v_cash.cents), v_cash.day, v_credit.day);
        end if;
      else
        v_state := case when not v_cash.included then 'funded_from_excluded' else 'paired' end;
        v_reason := v_pair_reason;
        v_effect := 0;
      end if;
    end if;

    -- Legs on excluded accounts are evidence only; credit-side legs never move cash flow.
    if not l.included then
      v_state := 'not_counted'; v_reason := 'excluded_account'; v_effect := 0; v_detail := null;
    elsif l.credit then
      v_effect := 0;
    end if;

    insert into pg_temp.cpe_state values (l.id, v_state, v_reason, v_detail, v_partner, v_decision, v_effect,
                                          v_cash_excess, v_card_excess, v_contra);
  end loop;

  -- Step 5: second pass — candidates, unresolved reasons, bounds — and replace the derived rows.
  delete from public.card_payment_leg_states where user_id = p_user_id;
  delete from public.card_payment_auto_pairs where user_id = p_user_id;
  delete from public.card_payment_decision_states where user_id = p_user_id;

  for s in select st.*, t.account_id, t.date, t.cents, t.pending, t.credit, t.included, t.day, t.conflict
           from pg_temp.cpe_state st join pg_temp.cpe_txn t on t.id = st.id order by st.id loop
    v_cands := '[]'::jsonb;
    if (s.state = 'unresolved' and not s.conflict) or (s.state <> 'unresolved' and s.contradictions) then
      select coalesce(jsonb_agg(jsonb_build_object(
               'transactionId', q.id, 'kind', q.kind, 'distanceDays', q.dist, 'differenceCents', q.diff,
               'contradictsDecision', s.state <> 'unresolved') order by q.dist, q.id), '[]'::jsonb)
      into v_cands
      from (
        select o.id, abs(s.day - o.day) as dist,
          case
            when o.cents = -s.cents and abs(s.day - o.day) <= 5 then 'tier1_competitor'
            when exists (select 1 from pg_temp.cpe_tier1 t1 where t1.id = o.id) then null
            when o.cents = -s.cents and abs(s.day - o.day) <= 60 then
              case when exists (
                select 1 from pg_temp.cpe_tracked p
                where (case when s.credit then o.cents else s.cents end) < 0
                  and (case when s.credit then s.cents else o.cents end) > 0
                  and p.cash_account = (case when s.credit then o.account_id else s.account_id end)
                  and p.credit_account = (case when s.credit then s.account_id else o.account_id end)
                  and p.abs_cents = abs(case when s.credit then o.cents else s.cents end)
                  and p.cash_day < (case when s.credit then o.day else s.day end)
                  and p.credit_day < (case when s.credit then s.day else o.day end))
              then 'return_of_pair' else 'exact_amount' end
            when sign(o.cents::numeric) = -sign(s.cents::numeric) and abs(abs(s.cents) - abs(o.cents)) between 1 and 500
                 and abs(s.day - o.day) <= 5 then 'near_amount'
          end as kind,
          case when o.cents = -s.cents then 0 else abs(s.cents) - abs(o.cents) end as diff
        from pg_temp.cpe_pool o
        where o.id <> s.id and o.credit <> s.credit
          and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(s.id, o.id) and dd.hi = greatest(s.id, o.id))
      ) q
      where q.kind is not null;
    end if;

    v_reason := s.reason;
    if s.state = 'unresolved' and v_reason is null then
      v_reason := case
        when exists (select 1 from jsonb_array_elements(v_cands) e where e->>'kind' = 'tier1_competitor') then 'ambiguous'
        when exists (select 1 from jsonb_array_elements(v_cands) e where e->>'kind' in ('exact_amount', 'return_of_pair')) then 'possible_match'
        when exists (select 1 from jsonb_array_elements(v_cands) e where e->>'kind' = 'near_amount') then 'amount_differs'
        else 'no_candidate' end;
    end if;

    v_effect := s.effect;
    if s.credit or not s.included then
      v_low := 0; v_high := 0; v_effect := 0;
    elsif s.state = 'unresolved' then
      v_low := least(0, -s.cents); v_high := greatest(0, -s.cents); v_effect := null;
    else
      v_low := v_effect; v_high := v_effect;
    end if;

    insert into public.card_payment_leg_states (user_id, transaction_id, account_id, date, amount_cents, pending, side,
      direction, account_included, state, reason, detail, partner_transaction_id, decision_id, candidates, effect_cents,
      low_cents, high_cents, cash_excess_cents, card_excess_cents, recent, computed_at_version)
    values (p_user_id, s.id, s.account_id, s.date, s.cents, s.pending, case when s.credit then 'credit' else 'cash' end,
      case when s.credit then (case when s.cents < 0 then 'payment' else 'return' end)
           else (case when s.cents > 0 then 'payment' else 'return' end) end,
      s.included, s.state, v_reason, s.detail, s.partner, s.decision_id, v_cands, v_effect, v_low, v_high,
      s.cash_excess, s.card_excess, v_as_of_day - s.day < 10, v_version);
  end loop;

  insert into public.card_payment_auto_pairs (user_id, cash_transaction_id, credit_transaction_id, computed_at_version)
  select p_user_id, t1.id, t1.partner, v_version
  from pg_temp.cpe_tier1 t1 join pg_temp.cpe_txn t on t.id = t1.id where not t.credit;
  insert into public.card_payment_decision_states (user_id, decision_id, kind, status, detail, computed_at_version)
  select p_user_id, r.decision_id, r.kind, r.status, r.detail, v_version from pg_temp.cpe_dec_result r;

  -- Steps 6–7: publish exactly the version read under L2 (committed together with the states).
  update public.card_payment_eval_versions
  set evaluated_version = v_version,
      evaluated_as_of = p_as_of,
      superseded_transaction_ids = coalesce((select array_agg(t.id order by t.id) from pg_temp.cpe_txn t where t.superseded), '{}'),
      last_error_code = null,
      last_attempt_at = clock_timestamp()
  where user_id = p_user_id;
  return v_version;
end;
$$;

create or replace function public.get_card_payment_states(p_user_id uuid, p_from date default null, p_to date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when v.user_id is null or v.evaluated_version is distinct from v.input_version then
      jsonb_build_object('fresh', false, 'inputVersion', v.input_version, 'evaluatedVersion', v.evaluated_version,
                         'lastErrorCode', v.last_error_code)
    else jsonb_build_object(
      'fresh', true,
      'inputVersion', v.input_version,
      'evaluatedVersion', v.evaluated_version,
      'asOf', v.evaluated_as_of,
      'legs', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'transactionId', s.transaction_id, 'accountId', s.account_id, 'date', to_char(s.date, 'YYYY-MM-DD'),
                 'amountCents', s.amount_cents, 'pending', s.pending, 'side', s.side, 'direction', s.direction,
                 'accountIncluded', s.account_included, 'state', s.state, 'reason', s.reason, 'detail', s.detail,
                 'partnerTransactionId', s.partner_transaction_id, 'decisionId', s.decision_id,
                 'candidates', s.candidates, 'effectCents', s.effect_cents, 'lowCents', s.low_cents,
                 'highCents', s.high_cents, 'cashExcessCents', s.cash_excess_cents,
                 'cardExcessCents', s.card_excess_cents, 'recent', s.recent) order by s.transaction_id), '[]'::jsonb)
        from public.card_payment_leg_states s
        where s.user_id = p_user_id and s.computed_at_version = v.evaluated_version
          and (p_from is null or s.date >= p_from) and (p_to is null or s.date < p_to)),
      'decisions', (
        select coalesce(jsonb_agg(jsonb_build_object('decisionId', ds.decision_id, 'kind', ds.kind, 'status', ds.status,
                                                     'detail', ds.detail) order by ds.decision_id), '[]'::jsonb)
        from public.card_payment_decision_states ds
        where ds.user_id = p_user_id and ds.computed_at_version = v.evaluated_version),
      'supersededTransactionIds', to_jsonb(v.superseded_transaction_ids))
  end
  from (select 1) one
  left join public.card_payment_eval_versions v on v.user_id = p_user_id
$$;

-- The removal no longer calls them.
drop function if exists public.card_payment_review_capture(uuid, uuid);
drop function if exists public.card_payment_review_record_gaps(uuid);
drop function if exists public.card_payment_review_touch(uuid);

-- ---- Postcondition ----------------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'cc12b7a12c6510924781b93c658ee854'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '446e7a46e2774d52ef995cd55a79d5ed' then
    raise exception 'a restored function is not the previous definition';
  end if;
  foreach v_fn in array array['public.evaluate_card_payments(uuid, timestamp with time zone)',
                              'public.remove_plaid_item_local(uuid, uuid)',
                              'public.get_card_payment_states(uuid, date, date)'] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      raise exception '% lost a security or definition property', v_fn;
    end if;
  end loop;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and (p.proname like '%card\_payment\_recovery%' or p.proname like 'card\_payment\_review\_%')
               and p.proname <> 'card_payment_recovery_downgrade_fence') then
    raise exception 'a recovery function was left installed';
  end if;
  -- Either no obligation exists and no fence is needed, or the fence is installed and every affected owner is
  -- unreadable.
  if exists (select 1 from public.card_payment_review_obligations) then
    if not exists (select 1 from pg_trigger t
                   where t.tgrelid = 'public.card_payment_eval_versions'::regclass
                     and t.tgname = 'card_payment_recovery_downgrade_fence' and t.tgenabled = 'O') then
      raise exception 'review obligations exist and the downgrade fence is not installed';
    end if;
    if exists (select 1 from public.card_payment_eval_versions v
               where v.evaluated_version is not null
                 and exists (select 1 from public.card_payment_review_obligations o where o.user_id = v.user_id)) then
      raise exception 'an affected owner is still readable';
    end if;
  end if;
  -- Nothing was dropped.
  if to_regclass('public.card_payment_review_obligations') is null
     or to_regclass('public.card_payment_review_obligation_sources') is null
     or to_regclass('public.card_payment_review_memberships') is null
     or to_regclass('public.card_payment_recovery_actions') is null
     or to_regclass('public.card_payment_recovery_refresh_queue') is null then
    raise exception 'a review table was dropped';
  end if;
end
$$;
