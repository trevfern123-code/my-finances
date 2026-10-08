-- Institution removal preserves known card-payment destinations (Phase B integration slice I3A;
-- CARD_PAYMENT_PAIRING_DESIGN.md §3.2, §3.4, §3.5, §3.7, §4.7, T9, acceptance test 18 and the removal case
-- of 21; Trevor's decisions of 2026-10-06). Builds on 20260926120000_linked_institution_management.sql
-- (the removal state machine), the card-payment matching migrations 20260930120000 – 20261002120000 and
-- 20261006110000 (the decision kinds a removal writes). Changes no table, column, trigger, grant,
-- signature or row. It replaces ONE function body: remove_plaid_item_local(uuid, uuid).
--
-- WHY. remove_plaid_item_local deletes the item and, by cascade, its accounts and transactions. A
-- card_payment_decisions row references its accounts ON DELETE CASCADE, and tier 1 pairs are derived from
-- the rows themselves. So removing an institution destroyed what was known about the payments between it
-- and the user's OTHER institutions: an automatic match was simply gone, and a match the USER had confirmed
-- was deleted with the account — releasing the leg that survived to automatic matching with another card.
-- It also created knowledge that nobody had: a payment that was unresolved because a card of this item and
-- a card that stays both fitted it was matched to the card that stays, merely because the other was deleted.
-- And a payment that was matched automatically to a card of this item was switched to another card that had
-- been there all along and had fitted less well, merely because its destination was deleted.
--
-- WHAT THE FUNCTION DOES NOW, in its one transaction, in this order (everything not listed is unchanged,
-- statement for statement):
--   1. As before: the per-user advisory lock (L1), the removal row FOR UPDATE, the replay of a cleaned
--      operation (returns the stored result, writes nothing, evaluates nothing), the plaid_removed and
--      'removing' checks, the lock on the item's linked transactions, and both fail-closed loan checks.
--      NEW — then the item's ACCOUNT rows are locked, in id order, with the lock their delete takes (see
--      LOCK ORDER).
--   2. NEW — evaluate. evaluate_card_payments(user), STRICT (not try_evaluate_card_payments): the matching
--      states of the user's CURRENT rows are recomputed here, in this transaction. Stored states are never
--      used as they were found: they may be stale, or may not exist at all (a user who was never
--      evaluated). If this evaluation fails, nothing is removed (see FAILURES).
--   3. NEW — preserve, BEFORE any delete, in three statements.
--      (a) USER-CONFIRMED pairs. Every live `pair` decision of the user with ONE leg on an account of the
--          item being removed and the other on an account of a DIFFERENT item of this user becomes a
--          'pair_counterpart_removed' decision on the leg that survives (20261006110000): a USER decision,
--          keyed exactly as the pair recorded that leg, carrying the removed leg's reference, the accepted
--          difference, and the frozen status of the removed side.
--            * ACTIVE or INACTIVE alike. An explicit confirmation is not erased because it is waiting to
--              post, because an amount changed, or because a replacement lineage is ambiguous — and its
--              hold on the surviving leg is not released. Whether it currently PROVES an effect is a
--              separate question, answered by the evaluator from the surviving leg and the frozen status.
--            * EITHER side survives: a cash leg whose card was removed, or a card leg whose cash account
--              was removed (it must not become free to pair with another cash leg).
--            * counterpart_status: 'valid' when step 2 found the pair active; 'conflicting_decisions' when
--              it found it in conflict; otherwise what card_payment_reference_status says of the removed
--              leg (waiting_to_post, amount_changed, lineage_ambiguous, partner_gone, role_changed), and,
--              if that leg is valid, whether the two legs still relate as recorded (sides, direction,
--              accepted difference).
--            * NOT preserved: a pair the user already undid or replaced (it is not live), and a pair one of
--              whose legs the USER has since re-classified away from card payment (user_role_override). A
--              newer explicit user action supersedes an older confirmation; it is not resurrected.
--      (b) AUTOMATIC (tier 1) pairs. Every cash-side leg that step 2 paired automatically with a leg on an
--          account of the item being removed, and that is itself on an account of a DIFFERENT item of this
--          user, gets the system decision 'destination_removed_card' on its own lineage key — unchanged:
--          below tier 1, non-reserving. A leg held by a user decision gets none (it has (a)).
--      (c) AMBIGUITY HOLDS (Trevor's decisions of 2026-10-06). A leg with no automatic match gets no
--          destination: removal is not evidence. But deleting a candidate is not evidence either, and the
--          disappearance of a destination is not evidence for another one. So a surviving leg of the
--          matching pool whose automatic match is NOT with a leg that stays, and whose tier 1 candidates
--          were on BOTH sides of the removal — at least one on an account of this item, at least one on an
--          account of another item of this user — gets, for each of those surviving candidates, a SYSTEM
--          ambiguity hold on the pair of the two surviving legs (20261006110000): card leg first, the
--          removed candidate's date, and a kind that says which side the removed candidate was on. Either
--          side: a cash leg that a removed card and a kept card both fitted, or a card leg that a removed
--          cash leg and a kept cash leg both fitted. Two cases, which stay distinct:
--            * THE LEG HAD NO AUTOMATIC MATCH (a tie, or any other ambiguity of the pool). It keeps having
--              none: the evaluator withholds the automatic pair of exactly those two legs while the removed
--              candidate would still have been at least as close. The leg gets no destination.
--            * THE LEG WAS MATCHED AUTOMATICALLY TO A LEG OF THIS ITEM. On the cash side it has (b): its
--              known destination, which it keeps reading (untracked / removed_card). The holds, one for
--              each candidate of this item (that partner, the closest, among them), keep a card that was
--              ALREADY THERE and merely fitted less well from taking the payment by tier 1 solely because
--              the original destination disappeared. The
--              mirror — a kept card leg that was matched to a removed cash leg — is held the same way, so
--              that a kept cash leg is not read as a tracked payment it never was.
--          It is derived from the evaluator's COMPLETE POOL (the scratch tables step 2 left in this
--          transaction), not from the published states: a leg on an account that is excluded from cash
--          flow, or one that an earlier removal's record or the "no included card" rule decides, takes
--          part in tier 1 like any other and can have candidates on both sides of the removal, whatever a
--          reader is shown for it.
--            * It is not a destination and not the user's word: it claims nothing, publishes no effect,
--              and ends by itself when the evidence changes (an amount, a date that brings the partner
--              strictly closer, a withdrawn or re-classified leg) or when the user decides. A new
--              transaction, or the re-imported leg of a relinked card, is not its concern.
--            * NOT written for a leg whose candidates were all on one side of the removal (there is
--              nothing for the removal to resolve or to switch), for a leg whose automatic match stays,
--              or for a leg held by a user decision (it is outside the pool: it has (a), or stays as it
--              is).
--      Nothing else is written:
--        * an unresolved leg with no surviving candidate, or none on this item, gets nothing. It is
--          evaluated, like every leg, from the rows that are left;
--        * a leg held by another user decision (a confirmed unlinked destination) is not touched;
--        * a leg on the removed item itself is deleted with it;
--        * a surviving card leg whose cash leg was paired AUTOMATICALLY gets no destination record: a
--          credit-side leg never moves cash flow (D5), and no user intent holds it. It gets (c) where a
--          kept cash leg also fitted it;
--        * a leg that already has a live system record with exactly the same key gets no second one.
--      The pair rows themselves then go with the removed account (the existing cascade). The user's
--      confirmation is in (a), written before it.
--   4. As before: the exact manual-loan restoration, the deleted counts, the delete of the item (cascading
--      to accounts, transactions, splits, recurring streams, liability records and the decisions that
--      reference its accounts), and the removal row -> cleaned.
--   5. NEW — evaluate again, BEST-EFFORT (try_evaluate_card_payments: a subtransaction), as the last
--      statement. When it succeeds it captures the version after every write above and publishes the
--      states of the rows that are left, so the removal commits FRESH states: the converted legs read
--      untracked / removed_card with effect −cents (payment −, return +). When it fails, only that
--      evaluation is rolled back and the removal still commits, STALE (see FAILURES).
--
-- FAILURES (Trevor's decision, 2026-10-06). One function call is one transaction (PostgREST runs each RPC
-- call in its own). There are two kinds of failure, and they are treated differently.
--   * A failure of THE REMOVAL ITSELF raises, and the whole call rolls back: any of the existing checks,
--     the first evaluation (step 2), the conversion (step 3), a loan check or restoration, the delete and
--     the version bumps its triggers make, the write of the removal row. Then there is no decision, no
--     restored balance and no deleted row, and the removal is still plaid_removed and retryable. This is
--     what the design's acceptance test 18 means by "a failure rolls back the whole removal". A removal
--     that cannot learn, or cannot preserve, what is known about the surviving payments does not happen.
--       - So every institution removal depends on the evaluator succeeding ONCE, before anything is
--         deleted, for every user, whether or not the application reads matching states yet. The
--         evaluation needs READ COMMITTED (it raises 25001 otherwise) and the TEMP privilege (its scratch
--         tables), as it always has.
--   * A failure of THE FINAL EVALUATION (step 5) does not undo the removal. By then the evidence is
--     preserved and the removal is done; only the evaluation's own subtransaction rolls back. The call
--     returns its normal result and commits the decisions of step 3, the restored balances, the deletes
--     and the removal row (cleaned), with input_version AHEAD of evaluated_version and last_error_code set
--     to the SQLSTATE alone (no message, id or amount). The stored states are then the ones step 2 wrote,
--     stamped with the older version, so get_card_payment_states returns fresh = false and NO states:
--     nothing computed from the deleted rows is ever read as current. The user stays stale until a later
--     evaluation succeeds.
--       - RECOVERY is whatever evaluates this user next: the sync path's evaluation (only while
--         CARD_PAYMENT_SYNC_EVALUATION_ENABLED is on) or a standalone evaluation. Nothing else does it
--         yet: a replay of this function (Retry of a cleaned removal) returns the stored result and
--         evaluates nothing, the decision RPCs refuse a stale user, and retry-on-read is not built. That
--         is a release gate; this file does not close it.
--       - A cancelled statement or a statement timeout is not an evaluation failure a subtransaction can
--         absorb (PostgreSQL does not let WHEN OTHERS catch it): it ends the whole call, like any other
--         cancellation, and the removal stays retryable.
--
-- AFTER THE REMOVAL (the evaluator of 20261006110000; nothing here decides it).
--   * A preserved user pair that is valid: its cash leg reads untracked / removed_card, −cents; its card
--     leg (the cash account was removed) reads funded_from_excluded / removed_cash_account, 0. It stays a
--     user decision: a tier 1 match with another card, or with the same card after a relink, is listed as a
--     suggestion and never applied, until the user undoes or replaces it.
--   * A preserved user pair that is not valid (the surviving leg's amount changed, or the frozen status is
--     an invalid one): the leg stays reserved and unresolved. Neither the removal nor a relink makes it
--     valid. Only the "no included card" rule can still establish an effect, by itself — and only where the
--     decision's inactive reason is an amount change. A frozen status of any other kind is the decision's
--     reason whatever the surviving leg's amount later does, so it never reaches that rule.
--   * A system record: as before — below tier 1, dormant after a relink, not proof once invalid. It is not
--     promoted: a hold of (c) withholds one pair, with one card leg that was already there, and nothing else.
--   * An ambiguity hold on a leg that had no automatic match: that leg reads what it read before the
--     removal — unresolved, the other leg still its candidate, an included cash leg a range (a leg on an
--     excluded account not_counted, as always; a cash leg that an earlier removal's record or the "no
--     included card" rule decides, untracked). So does the hold's other leg, unless it was itself matched
--     automatically to the removed institution (the next case). One reading can change through the removal
--     itself: if it took the user's last included card, an included cash leg that was unresolved reads
--     untracked / no_included_card.
--   * An ambiguity hold on a leg that was matched automatically to the removed institution: a cash leg reads
--     its record, untracked / removed_card, −cents (on an excluded account it still reads not_counted, with
--     the record as its decision); the competitor that was already there is not paired with it. A kept card
--     leg whose cash leg was removed reads unresolved (effect 0, as for every credit-side leg), and the
--     kept cash competitor is not read as tracked.
--   * Either way a pair with any OTHER leg is evaluated as always: a new transaction, or the re-imported leg
--     of a relinked card, is new evidence and not the hold's concern. The user can confirm, mark or dismiss
--     as if no hold existed; that decision decides the legs it names.
--     A LIMIT, RECORDED AS OPEN AND NOT DECIDED (PHASE_B_I3A_LIM_REMOVAL_MATCHING.md §9.3, question 7): the
--     hold's own pair stays judged against the removed candidate's STORED date, after a relink too. A
--     re-imported leg that comes back farther away than the kept one, or that the user dismisses or confirms
--     elsewhere, does not release it; a cash leg of the second kind then keeps reading its record although
--     both cards are linked, until the user matches it.
--
-- FRESHNESS (§3.7). The evaluator of step 2 takes L2 (the user's version row, FOR UPDATE) and holds it to
-- the end of this transaction. Every input change bumps that row in its writer's own transaction, so from
-- step 2 on no other transaction can COMMIT a change to this user's matching inputs: what is converted
-- (step 3), deleted (step 4) and evaluated (step 5) is one consistent set of rows. The decisions of step 3
-- and the deletes of step 4 bump the version through the existing triggers (once: 20261002120000
-- coalesces them, and the evaluator of step 2 cleared the marker when it captured its version). Step 5,
-- when it succeeds, publishes exactly the version it captured; when it fails, nothing is published and
-- the version it would have published stays unevaluated. Any input this transaction wrote after step 5
-- would leave the user stale; there is none.
--
-- LOCK ORDER. L1 first, as before. Every writer that takes L1 (the sync batch, the decision RPCs, the loan
-- functions, the standalone evaluator) is serialized with the removal and is unaffected. What follows is
-- about LOCK-FREE writers (design §3.7: a direct statement with no advisory lock), which take a row lock and
-- then wait for L2 (the user's version row) in their trigger bump.
--   * The previous body took its locks in this order: the removal row, the item row, the linked
--     transactions, then — inside "delete from plaid_items" — the item's ACCOUNT rows (its cascade deletes
--     them at once), then L2 (the item's own delete trigger, which runs before the queued deletes of the
--     next level), then the transactions and the decisions.
--   * This body takes L2 earlier, in step 2. Left at that, a writer holding an account row of the item
--     would close a cycle that the previous body did not have. So step 1 now locks the item's account rows
--     FIRST, in id order, FOR UPDATE: the lock their delete takes, in the place it used to be taken
--     relative to L2. A lock-free statement that holds one of those rows — the account-settings update
--     (exclude from cash flow), or an insert that references the account — makes the removal WAIT, as it
--     did before, and then proceeds or finds the account gone.
--       - FOR UPDATE, not a weaker mode: the delete it stands in for conflicts with every row lock,
--         including the KEY SHARE lock of an insert's foreign-key check. FOR SHARE would let such an
--         insert through and leave that cycle new.
--   * A TRANSACTION row of the item is unchanged: the same detected deadlock (SQLSTATE 40P01) under both
--     bodies, because the previous body also held L2 before it deleted any transaction. One side is rolled
--     back completely; a removal that loses stays plaid_removed and succeeds when retried.
--   Measured on identical fixtures under both bodies: supabase/tests/lim_removal_lock_comparison; and
--   concurrency/c34, c35 keep the two account-row overlaps in the suite.
-- The preservation's inserts take the foreign-key KEY SHARE lock on the SURVIVING accounts they name, while
-- L2 is held: a lock-free DELETE of one of those accounts is the decision RPCs' existing class
-- (concurrency/c22). Nothing in the application deletes an account that way.
--
-- OWNERSHIP. The evaluator reads only this user's accounts and rows, and writes only this user's states.
-- The conversion additionally joins both legs' accounts to plaid_items and requires this user and this
-- item; card_payment_decisions_same_user re-checks the account on insert. Errors raised by steps 2 and 3
-- are replaced by a fixed message carrying only the step and the SQLSTATE: no id, amount or name. A
-- failure of step 5 raises nothing and stores only its SQLSTATE.
--
-- COMPATIBILITY. Same name, signature, security properties, grants and result:
--   { replayed, loan_adjustments, deleted_counts } — no key added, removed or changed, and the stored
--   plaid_item_removals row is written exactly as before. A backend that predates this file calls the same
--   function and gets the conversion and the evaluation too; nothing in the application has to change.
--   A removal already cleaned is replayed as before. A removal in progress is unaffected: each call is
--   one transaction and uses the body installed when it starts.
--
-- NOT DONE HERE. The backend's post-commit follow-ups (the relational repair sweep, forward
-- reconciliation) can change roles of surviving rows; the triggers then make the user stale again, safely,
-- until the next evaluation. Retry-on-read, background recovery and evaluation after other user actions
-- are later work. No preview, digest, state-machine, frontend or API change.
--
-- ROLLBACK. supabase/rollback/20261006120000_lim_removal_card_payment_matching_rollback.sql re-creates
-- the 20260926120000 body verbatim (checksum-verified). It restores no data: decisions this function
-- wrote stay (the evaluator keeps honouring them), and rows a removal deleted stay deleted.
--
-- Guard: applies only on top of the exact 20260926120000 body (checksum of the LF-normalised source), and
-- only where the matching objects it calls exist and the evaluator is the 20261006110000 definition (the
-- one that understands pair_counterpart_removed and the ambiguity holds).

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'a8f567d397b9dae5b777497317985ab7' then
    raise exception 'remove_plaid_item_local is not the 20260926120000 definition; refusing to replace it';
  end if;
  if to_regprocedure('public.evaluate_card_payments(uuid, timestamp with time zone)') is null
     or to_regclass('public.card_payment_decisions') is null
     or to_regclass('public.card_payment_leg_states') is null then
    raise exception 'the card-payment matching objects (20260930120000) are missing; apply them first';
  end if;
  -- The evaluator this body calls twice, whose locking and publication it relies on (§3.7), and which must
  -- understand the decisions this body writes.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' then
    raise exception 'evaluate_card_payments is not the 20261006110000 definition this function was written for; apply 20261006110000 first';
  end if;
  if to_regprocedure('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') is null
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)'::regprocedure) <> '6f8add9a971061e1eaefc872d85ba74a'
     or not exists (select 1 from pg_constraint c
                    where c.conrelid = 'public.card_payment_decisions'::regclass and c.conname = 'card_payment_decisions_kind_check'
                      and c.convalidated and pg_get_constraintdef(c.oid) like '%pair_counterpart_removed%'
                      and pg_get_constraintdef(c.oid) like '%ambiguity_hold_removed_card%'
                      and pg_get_constraintdef(c.oid) like '%ambiguity_hold_removed_cash_account%') then
    raise exception 'the decision kinds of 20261006110000 (pair_counterpart_removed, the ambiguity holds) are missing; apply it first';
  end if;
  -- The best-effort wrapper of the final evaluation: this body relies on it never raising for an
  -- evaluation failure, and on it recording only the SQLSTATE.
  if to_regprocedure('public.try_evaluate_card_payments(uuid, timestamp with time zone)') is null
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.try_evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'fac15fabe5470dd62a79a3a6c8630a89' then
    raise exception 'try_evaluate_card_payments is not the 20260930120000 definition this function was written for';
  end if;
end
$$;

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

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_oid oid := 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_oid) <> '7997a757408fa888aa44bdbc9d85f89d' then
    raise exception 'remove_plaid_item_local is not the definition this migration installs';
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
  -- What the new body relies on, unchanged by this file: the decision kind it writes, the account
  -- cascade that removes the converted pairs, and the triggers that invalidate.
  if not exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.card_payment_decisions'::regclass and c.conname = 'card_payment_decisions_kind_check'
                   and c.convalidated and pg_get_constraintdef(c.oid) like '%destination_removed_card%') then
    raise exception 'card_payment_decisions no longer accepts destination_removed_card';
  end if;
  if (select count(*) from pg_constraint c
      where c.conrelid = 'public.card_payment_decisions'::regclass and c.contype = 'f'
        and c.confrelid = 'public.accounts'::regclass and c.confdeltype = 'c') <> 2 then
    raise exception 'card_payment_decisions must reference accounts twice, ON DELETE CASCADE';
  end if;
  if (select count(*) from pg_trigger
      where tgname in ('card_payment_bump_transactions_ins_del', 'card_payment_bump_transactions_upd',
                       'card_payment_bump_accounts_ins_del', 'card_payment_bump_accounts_upd',
                       'card_payment_bump_plaid_items_del', 'card_payment_bump_plaid_items_upd',
                       'card_payment_bump_decisions', 'card_payment_bump_carryovers_ins_del',
                       'card_payment_bump_carryovers_upd', 'card_payment_decisions_same_user')
        and tgenabled = 'O') <> 10 then
    raise exception 'a card-payment trigger is missing or disabled';
  end if;
  -- No client role gained anything on the tables this function now touches.
  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join (values ('card_payment_decisions'), ('card_payment_leg_states'), ('card_payment_eval_versions'),
                                ('card_payment_auto_pairs'), ('card_payment_decision_states'), ('plaid_item_removals')) t(tbl)
             cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
             where has_table_privilege(r.role, ('public.' || t.tbl)::regclass, p.priv)) then
    raise exception 'a card-payment or removal table is accessible to a client role';
  end if;
end
$$;
