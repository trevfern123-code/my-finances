-- What institution removal must be able to preserve (Phase B integration slice I3A;
-- CARD_PAYMENT_PAIRING_DESIGN.md §3.2, §3.5, §3.6, §4.7; Trevor's decisions of 2026-10-06). Builds on
-- 20260930120000 (matching state), 20261001120000 (decision RPCs) and 20261002120000 (the evaluator).
--
-- It teaches the decision model, the evaluator and three decision RPCs THREE new decision kinds: one USER
-- kind (a confirmed pair whose other account was removed) and two SYSTEM kinds (an ambiguity that a removal
-- must not resolve). BY ITSELF IT CHANGES NO BEHAVIOUR: nothing in this file writes a new kind.
-- 20261006120000 (institution removal) does.
--
-- WHY.
--   * A `pair` decision references both of its accounts ON DELETE CASCADE. Removing an institution
--     therefore deleted every user-confirmed pair that named one of its accounts: the user's explicit
--     confirmation, and with it the hold on the leg that survived — which a tier 1 pair with ANOTHER card
--     could then take. The system record destination_removed_card cannot stand in for a user's
--     confirmation: by approved design it ranks below tier 1 and holds nothing.
--   * A leg that was UNRESOLVED because of two candidates — one on the removed institution, one on an
--     institution that stays — became uniquely matchable the moment the removed candidate's rows were
--     deleted, and tier 1 paired it with the candidate that was left. Deleting one candidate is not evidence
--     that the other was the destination (Trevor's decision of 2026-10-06 on design §4.7).
--
-- WHAT IS ADDED (additive: nothing that exists changes meaning).
--   * Decision kind 'pair_counterpart_removed' — a USER decision: the user's `pair`, after the account of
--     ONE of its two legs was permanently removed.
--       a_account_id, a_plaid_transaction_id, a_cents
--           the SURVIVING leg, exactly as the pair recorded it (the Plaid id and cents at decision time). It
--           can be on either side: a cash leg whose card was removed, or a card leg whose cash account was
--           removed. Pending -> posted lineage and "the surviving leg's amount changed" keep working
--           through the existing rules.
--       b_plaid_transaction_id, b_cents
--           the REMOVED leg's reference as the pair recorded it. History only; the evaluator does not read
--           it. b_account_id is NULL: that account is gone and nothing references it — no dangling
--           reference, no foreign key weakened.
--       accepted_difference_cents
--           the pair's.
--       counterpart_status   (THE FIRST NEW COLUMN)
--           what was true of the removed side when its account was deleted. FROZEN: that side can never
--           change again. 'valid' and 'waiting_to_post' invalidate nothing. Every other value is the reason
--           the confirmation was invalid because of that side — amount_changed, lineage_ambiguous,
--           partner_gone, role_changed, sides_not_opposite, direction_mismatch, difference_not_accepted,
--           conflicting_decisions — and keeps the decision inactive.
--   * Decision kinds 'ambiguity_hold_removed_card' and 'ambiguity_hold_removed_cash_account' — SYSTEM
--     records, written only by institution removal: an AMBIGUITY HOLD on ONE POSSIBLE PAIR of two legs that
--     both survive. It records that, immediately before the removal, this pair was not the automatic match
--     because a candidate on the removed institution was in the way — and that the removal changed nothing
--     about that. The candidate in the way either left the leg with no automatic match at all (a tie, or any
--     other ambiguity in the pool), or WAS the leg's automatic match (a cash leg then also has its
--     destination_removed_card record, and keeps reading untracked / removed_card).
--       a_account_id, a_plaid_transaction_id, a_cents     the CARD-side leg of the possible pair
--       b_account_id, b_plaid_transaction_id, b_cents     its CASH-side leg
--           as they were at the removal. Both accounts exist, so both are the ordinary references
--           (ON DELETE CASCADE): the hold goes when either account goes.
--       counterpart_date   (THE SECOND NEW COLUMN)
--           the date of the removed candidate. Nothing else of it is kept, and nothing references it.
--       the kind says which leg the removed candidate competed for:
--           ambiguity_hold_removed_card            a CARD leg was removed; it competed for the CASH leg (b)
--           ambiguity_hold_removed_cash_account    a CASH leg was removed; it competed for the CARD leg (a)
--     Why the date: whether a later date change breaks the old tie depends on where the removed candidate
--     was, and no existing column can hold a date. Why two kinds and not the order of the legs: the card leg
--     is written first on purpose — an evaluator that does not know these kinds (after this file's rollback)
--     then reads the row as an inactive decision that holds both legs, and not as a confirmed pair (as long
--     as the card leg's account is a credit account). That misreading is not harmless — both legs leave
--     automatic matching — which is why the rollback refuses to run while live holds exist unless the
--     operator acknowledges it: see the rollback file.
--     A hold is not a user decision and not evidence of a destination. It claims no leg, publishes no
--     effect, names no destination and ranks below every user decision. The user cannot undo it (it is not
--     theirs); they decide the payment, and their decision wins.
--   * Three CHECK constraints are widened for the new kinds and two are added. For the four existing kinds
--     they accept exactly the rows they accepted before.
--   * card_payment_reference_status(account, Plaid id, cents, as_of): the evaluator's lineage rule and its
--     amount-then-role check for ONE leg reference. The removal uses it to freeze counterpart_status.
--
-- HOW THE EVALUATOR READS THE NEW KINDS (evaluate_card_payments; every other line is the 20261002120000
-- text, verbatim).
-- pair_counterpart_removed:
--   1. It is a single-leg USER decision. Leg A resolves through the lineage rule like any other reference
--      (waiting, gone, ambiguous). There is no cash-side requirement.
--   2. Then, in this order:
--        a. a frozen counterpart_status other than 'valid', 'waiting_to_post' and 'amount_changed' keeps the
--           decision inactive with that frozen reason, WHATEVER the surviving leg's amount or role is now.
--           What was wrong with the side that is gone was never resolved, and a later correction of the leg
--           that survived does not resolve it: it must not be reported, or treated, as a mere amount change;
--        b. the surviving leg's own amount, then its role, as for every decision;
--        c. a frozen 'amount_changed' (the removed leg's amount had changed) keeps it inactive as
--           amount_changed.
--      A confirmation that is invalid only by b (the leg that survived) is valid again, by itself, when
--      that leg has the recorded amount and the card-payment role again. One that is invalid by a or c
--      (the side that is gone) stays invalid until the user undoes or replaces it. A removal never makes it
--      valid again, and neither does a relink.
--   3. Like every user decision it CLAIMS its current row, active or inactive. A claimed leg is outside the
--      tier 1 pool, so no other card (or cash leg) can take it automatically.
--   4. Active, on the cash side:   untracked / removed_card, effect −cents (payment −, return +).
--      Active, on the credit side: funded_from_excluded / removed_cash_account, effect 0. A credit-side leg
--      never moves cash flow (D5); the state says its funding is outside the tracked set, as it does for a
--      pair with an excluded cash account.
--      Either way contradicting candidates are listed, as for every active user decision: a re-imported
--      leg of a relinked card is a suggestion, never applied.
--   5. Inactive: reserved and unresolved (decision_invalidated, the reason in `detail`). One exception, the
--      existing one, extended to this kind: an amount change in the same direction on a cash leg of a user
--      with NO included card is untracked / no_included_card. That effect is established by the absence of
--      any card, not by the old confirmation, which stays inactive. It applies only when the decision's
--      inactive reason is an AMOUNT change — the surviving leg's, the removed leg's, or both. By 2a no
--      other frozen status can ever read as amount_changed, so none of them reaches it. (What is frozen
--      follows the amount-first order of every reference check: a removed leg whose amount AND role had
--      both changed is frozen as amount_changed.)
-- An ambiguity hold:
--   6. It APPLIES while both of its references resolve, by the lineage rule, to current card-payment legs on
--      opposite sides with the recorded cents. Otherwise it is inactive and does nothing: a changed amount,
--      a withdrawn row or a re-classified leg is new evidence, and the ordinary rules decide alone.
--   7. Tier 1 is computed exactly as before, holds or no holds. Then ONE thing is withheld: the automatic
--      pair of the hold's own two legs, while the removed candidate would still be AT LEAST AS CLOSE to the
--      leg it competed for as that leg's partner is, on the dates as they are now:
--          |counterpart_date − the leg's date|  <=  |the leg's date − its partner's date|
--      A later date change that brings the partner strictly closer releases the pair; one that does not,
--      does not. A posted row with the same amount is the same leg (the lineage rule), not new evidence.
--   8. Nothing else changes. Both legs stay in the pool, as each other's candidates and as anyone else's; no
--      other pair is formed in the withheld pair's place; a pair with any OTHER leg — a new transaction, the
--      re-imported leg of a relinked card — is not the hold's concern and is evaluated as always. (The
--      hold's OWN pair stays judged by rule 7, against the stored date, after a relink too; what that
--      leaves a held leg reading is recorded as open, not decided: PHASE_B_I3A_LIM_REMOVAL_MATCHING.md
--      §9.3, question 7.) The two legs, with their pair withheld, read according to what each of them had
--      immediately before the removal. A hold is written for a leg in case a or in case b; its other leg
--      can be in any of the three.
--        a. NO automatic match (a tie, or any other ambiguity in the pool). The leg reads what it read
--           then: unresolved, with its candidates, a cash leg with its range. A hold is written from the
--           pool and not from what was published, so that can also be not_counted (a leg on an excluded
--           account) or untracked (a cash leg that an earlier removal's record or the "no included card"
--           rule decides). One reading changes through the removal itself: if it took the user's last
--           included card, an included cash leg that was unresolved reads untracked / no_included_card.
--        b. An automatic match with a leg of the REMOVED institution, while a leg that stays also fitted.
--           The leg no longer reads that match. A cash leg reads its destination_removed_card record:
--           untracked / removed_card, effect −cents, a definite figure and not a range. A card leg never
--           gets a record: it reads unresolved, with its candidates. On an excluded account either still
--           reads not_counted.
--        c. An automatic match with a leg that STAYS. The leg keeps it.
--      A hold is never a leg's decision, and never a reason.
--   Precedence: conflicting replacements -> user decisions (pair, destination_unlinked,
--   pair_counterpart_removed) -> tier 1, less the pairs a hold withholds -> destination_removed_card -> no
--   included card.
--
-- DECISION RPCS.
--   * link_card_payment, mark_card_payment_destination: one predicate each widened. pair_counterpart_removed
--     counts among the affirmative user decisions that hold a leg. So a NEWER explicit user action wins:
--     confirming another match, or "a card I haven't linked", on that leg supersedes the preserved pair; a
--     counterpart it holds is refused until it is undone. undo_card_payment_decision accepts it (it is the
--     user's) and releases the leg.
--   * undo_card_payment_decision: refuses the two hold kinds as it refuses destination_removed_card
--     (system_decision). Nothing else reads a hold: the user can confirm either leg's destination, say it
--     went to an unlinked card, or dismiss the candidate, exactly as if no hold existed, and that decision
--     takes the legs out of automatic matching. The hold is left where it is: if the user later undoes
--     their own decision, the pair is withheld again, as it was before they decided.
--   No signature, grant or result changes.
--
-- NOT CHANGED. destination_removed_card: still system-written, below tier 1, non-reserving, dormant behind
-- stronger evidence, not proof once invalid. The readers (get_card_payment_states,
-- get_financial_read_snapshot): `removed_card` is an existing reason, `funded_from_excluded` an existing
-- credit-side state; the one new reason value, removed_cash_account, appears only on a credit-side leg,
-- whose reason no reader interprets.
--
-- COMPATIBILITY. A backend that predates this file is unaffected: it never sends or reads a decision kind.
-- Apply BEFORE 20261006120000 (the guard below refuses otherwise; filename order does it).
--
-- ROLLBACK. supabase/rollback/20261006110000_card_payment_pair_counterpart_removed_rollback.sql, after the
-- rollback of 20261006120000 (it refuses otherwise). It restores the four previous function bodies
-- verbatim and drops the helper. IT DELIBERATELY LEAVES THE COLUMNS AND THE WIDENED CHECKS, and every row
-- of the new kinds: narrowing them would require deleting every preserved user decision and every hold,
-- which is exactly what this file exists to keep. What the previous evaluator and RPCs then do with such
-- rows is stated in that file — it is not harmless, and while live ambiguity holds exist the rollback
-- refuses to run unless the operator acknowledges that. This file can be applied again afterwards: its
-- DDL is written to be repeatable.
--
-- Guard: applies only on top of the exact previous bodies (checksums of the LF-normalised source), and
-- only while institution removal is still the 20260926120000 body.

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'f620515feaee49b382965cc8b73f02e2' then
    raise exception 'evaluate_card_payments is not the 20261002120000 definition; refusing to replace it';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '72676208bb4c33cf3d801ddf294f2543'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'b3a105575539bf30e306e68511258bfc' then
    raise exception 'link_card_payment / mark_card_payment_destination are not the 20261001120000 definitions; refusing to replace them';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> '8b3e51df8455a7ac93a423ea174eb3f8' then
    raise exception 'undo_card_payment_decision is not the 20261001120000 definition; refusing to replace it';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'a8f567d397b9dae5b777497317985ab7' then
    raise exception 'remove_plaid_item_local is not the 20260926120000 definition: this file must be applied before 20261006120000 (roll that one back first)';
  end if;
  if not exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.card_payment_decisions'::regclass and c.conname = 'card_payment_decisions_kind_check'
                   and pg_get_constraintdef(c.oid) like '%destination_removed_card%') then
    raise exception 'card_payment_decisions is not the 20260930120000 table';
  end if;
end
$$;

-- ---- The decision model -------------------------------------------------------------------------------
-- Repeatable (this file may be applied again after its rollback, which leaves the schema in place).
alter table public.card_payment_decisions add column if not exists counterpart_status text null;

comment on column public.card_payment_decisions.counterpart_status is
  'pair_counterpart_removed only: what was true of the removed side of the user''s pair when its account was '
  'deleted. Frozen. valid / waiting_to_post invalidate nothing; any other value is why the confirmation was '
  'invalid on that side and keeps the decision inactive.';

alter table public.card_payment_decisions add column if not exists counterpart_date date null;

comment on column public.card_payment_decisions.counterpart_date is
  'The two ambiguity_hold kinds only: the date of the candidate that was removed with its institution. The '
  'automatic pair of the hold''s two legs is withheld while that candidate would still be at least as close '
  'to the leg it competed for as that leg''s partner is.';

alter table public.card_payment_decisions drop constraint if exists card_payment_decisions_kind_check;
alter table public.card_payment_decisions add constraint card_payment_decisions_kind_check
  check (kind in ('pair', 'not_this_pair', 'destination_unlinked', 'destination_removed_card', 'pair_counterpart_removed',
                  'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account'));

-- A second leg WITH an account: the two-leg kinds, as before, and the ambiguity holds (two legs that both
-- survive). A second leg's reference without an account (the removed leg): exactly the preserved pair. No
-- second leg at all: the two destination kinds.
alter table public.card_payment_decisions drop constraint if exists card_payment_decisions_legs_check;
alter table public.card_payment_decisions add constraint card_payment_decisions_legs_check
  check ((kind in ('pair', 'not_this_pair', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) = (b_account_id is not null)
         and (kind in ('pair', 'not_this_pair', 'pair_counterpart_removed',
                       'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) = (b_plaid_transaction_id is not null)
         and (b_plaid_transaction_id is null) = (b_cents is null));

alter table public.card_payment_decisions drop constraint if exists card_payment_decisions_difference_check;
alter table public.card_payment_decisions add constraint card_payment_decisions_difference_check
  check ((kind in ('pair', 'pair_counterpart_removed')) = (accepted_difference_cents is not null));

alter table public.card_payment_decisions drop constraint if exists card_payment_decisions_counterpart_check;
alter table public.card_payment_decisions add constraint card_payment_decisions_counterpart_check
  check ((kind = 'pair_counterpart_removed') = (counterpart_status is not null)
         and (counterpart_status is null
              or counterpart_status in ('valid', 'waiting_to_post', 'amount_changed', 'lineage_ambiguous', 'partner_gone',
                                        'role_changed', 'sides_not_opposite', 'direction_mismatch',
                                        'difference_not_accepted', 'conflicting_decisions')));

alter table public.card_payment_decisions drop constraint if exists card_payment_decisions_counterpart_date_check;
alter table public.card_payment_decisions add constraint card_payment_decisions_counterpart_date_check
  check ((kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')) = (counterpart_date is not null));

-- ---- One leg reference, as the evaluator resolves it ------------------------------------------------------
-- The status of ONE decision leg reference (account, Plaid id, cents at decision time) against the rows as
-- they are now: design §3.6 resolveLineage, then the evaluator's amount-first, role-second check, for this
-- leg alone. It must stay the same rule as evaluate_card_payments (resolveLineage and shapeDetail there);
-- the removal tests compare what it returns with what the evaluator published for the same pair.
--   lineage_ambiguous   more than one row names it as their pending id, or it names one of such a group
--   waiting_to_post     no row, and a carry-over that is neither consumed nor expired at p_as_of
--   partner_gone        no row and no such carry-over
--   amount_changed      its current row has other cents
--   role_changed        its current row is no longer a card-payment leg (role, zero amount, or replaced)
--   valid               its current row is a card-payment leg with the recorded cents
-- Reads only; takes no lock. The relation BETWEEN two legs (sides, direction, accepted difference) is not
-- its concern.
create or replace function public.card_payment_reference_status(p_account_id uuid, p_plaid text, p_cents bigint,
                                                                 p_as_of timestamp with time zone)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_n integer;
  v_plaid text;
  v_pending_of text;
  v_cents bigint;
  v_role text;
begin
  select count(*) into v_n from public.transactions t
  where t.account_id = p_account_id and t.pending_transaction_id = p_plaid;
  if v_n > 1 then
    return 'lineage_ambiguous';
  elsif v_n = 1 then
    select t.plaid_transaction_id, (t.amount * 100)::bigint, t.effective_role into v_plaid, v_cents, v_role
    from public.transactions t
    where t.account_id = p_account_id and t.pending_transaction_id = p_plaid;
  else
    select t.plaid_transaction_id, t.pending_transaction_id, (t.amount * 100)::bigint, t.effective_role
    into v_plaid, v_pending_of, v_cents, v_role
    from public.transactions t
    where t.account_id = p_account_id and t.plaid_transaction_id = p_plaid;
    if not found then
      if exists (select 1 from public.transaction_carryovers c
                 where c.account_id = p_account_id and c.pending_plaid_transaction_id = p_plaid
                   and c.consumed_at is null and c.expires_at > p_as_of) then
        return 'waiting_to_post';
      end if;
      return 'partner_gone';
    end if;
    -- naming one conflicting replacement by its own posted id is just as ambiguous
    if v_pending_of is not null
       and (select count(*) from public.transactions r
            where r.account_id = p_account_id and r.pending_transaction_id = v_pending_of) > 1 then
      return 'lineage_ambiguous';
    end if;
  end if;
  if v_cents <> p_cents then
    return 'amount_changed';
  end if;
  -- A card-payment leg: that role, a non-zero amount, and not replaced by a posted row.
  if v_role is distinct from 'credit_card_payment' or v_cents = 0
     or exists (select 1 from public.transactions r
                where r.account_id = p_account_id and r.pending_transaction_id = v_plaid) then
    return 'role_changed';
  end if;
  return 'valid';
end;
$$;

revoke all on function public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone) from public, anon, authenticated;
grant execute on function public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone) to service_role;

-- ---- The evaluator: 20261002120000, with the hunks described above ---------------------------------------
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

-- ---- Three decision RPCs: 20261001120000, with one predicate widened in each -----------------------------
create or replace function public.link_card_payment(
  p_user_id uuid,
  p_transaction_id uuid,               -- the leg the user is resolving (either side)
  p_counterpart_transaction_id uuid,   -- the leg they chose
  p_accepted_difference_cents bigint,  -- |cash cents| − |credit cents|, accepted explicitly; 0 when exact
  p_expected_version bigint            -- the evaluatedVersion of the states the user saw
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_s record;
  v_c record;
  v_cash record;
  v_credit record;
  v_existing record;
  v_claims_s uuid[];
  v_claims_c uuid[];
  v_dismissals uuid[];
  v_superseded uuid[];
  v_rows uuid[];
  v_new uuid;
begin
  perform public.card_payment_decision_begin(p_user_id, p_expected_version, 'link_card_payment');
  -- Ownership of both targets before any target-specific detail.
  select * into v_s from public.card_payment_decision_target(p_user_id, p_transaction_id, 'link_card_payment');
  select * into v_c from public.card_payment_decision_target(p_user_id, p_counterpart_transaction_id, 'link_card_payment');

  if v_s.id = v_c.id then
    raise exception 'card_payment_invalid: link_card_payment: same_transaction';
  end if;
  perform public.card_payment_decision_check_leg(v_s.superseded, v_s.conflict, v_s.effective_role, v_s.cents, 'link_card_payment');
  perform public.card_payment_decision_check_leg(v_c.superseded, v_c.conflict, v_c.effective_role, v_c.cents, 'link_card_payment');
  if v_s.credit = v_c.credit then
    raise exception 'card_payment_invalid: link_card_payment: sides_not_opposite';
  end if;
  if v_s.credit then v_cash := v_c; v_credit := v_s; else v_cash := v_s; v_credit := v_c; end if;
  if sign(v_cash.cents::numeric) <> -sign(v_credit.cents::numeric) then
    raise exception 'card_payment_invalid: link_card_payment: direction_mismatch (a payment pairs with a payment, a return with a return)';
  end if;
  if p_accepted_difference_cents is distinct from abs(v_cash.cents) - abs(v_credit.cents) then
    raise exception 'card_payment_invalid: link_card_payment: difference_not_accepted (the accepted difference must equal |cash| - |credit| exactly)';
  end if;

  -- One pass over the user's live decisions, each leg resolved once by lineage: the affirmative user
  -- decisions holding each leg (active or inactive), and the dismissals of exactly this edge (superseded
  -- by the confirmation; every other dismissal stays).
  select coalesce(array_agg(x.decision_id order by x.decision_id)
                    filter (where x.kind in ('pair', 'destination_unlinked', 'pair_counterpart_removed') and v_s.id in (x.row_a, x.row_b)), '{}'),
         coalesce(array_agg(x.decision_id order by x.decision_id)
                    filter (where x.kind in ('pair', 'destination_unlinked', 'pair_counterpart_removed') and v_c.id in (x.row_a, x.row_b)), '{}'),
         coalesce(array_agg(x.decision_id order by x.decision_id)
                    filter (where x.kind = 'not_this_pair'
                              and ((x.row_a = v_s.id and x.row_b = v_c.id) or (x.row_a = v_c.id and x.row_b = v_s.id))), '{}')
  into v_claims_s, v_claims_c, v_dismissals
  from public.card_payment_live_decisions(p_user_id) x;
  if exists (select 1 from unnest(v_claims_c) c(id) where c.id <> all (v_claims_s)) then
    raise exception 'card_payment_counterpart_reserved: link_card_payment: the chosen transaction belongs to another confirmed match or destination; undo that decision first';
  end if;

  -- The same match already saved, at the current amounts: nothing to change.
  if cardinality(v_claims_s) = 1 and v_claims_c = v_claims_s then
    select d.kind, d.accepted_difference_cents, d.a_cents, d.b_cents,
           public.card_payment_lineage_row(d.a_account_id, d.a_plaid_transaction_id) as row_a
    into v_existing from public.card_payment_decisions d where d.id = v_claims_s[1];
    if v_existing.kind = 'pair' and v_existing.accepted_difference_cents = p_accepted_difference_cents
       and ((v_existing.row_a = v_s.id and v_existing.a_cents = v_s.cents and v_existing.b_cents = v_c.cents)
            or (v_existing.row_a = v_c.id and v_existing.a_cents = v_c.cents and v_existing.b_cents = v_s.cents)) then
      return public.card_payment_decision_result(p_user_id, 'unchanged', 'already_confirmed', v_claims_s[1],
                                                 '{}', array[v_s.id, v_c.id], false);
    end if;
  end if;

  v_superseded := v_claims_s || v_dismissals;
  v_rows := array(select distinct r from unnest(array[v_s.id, v_c.id] || public.card_payment_decision_rows(p_user_id, v_superseded)) r);

  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents,
                                             b_account_id, b_plaid_transaction_id, b_cents, accepted_difference_cents)
  values (p_user_id, 'pair', v_cash.account_id, v_cash.plaid, v_cash.cents,
          v_credit.account_id, v_credit.plaid, v_credit.cents, p_accepted_difference_cents)
  returning id into v_new;
  update public.card_payment_decisions set superseded_by = v_new
  where user_id = p_user_id and id = any (v_superseded) and superseded_by is null;

  return public.card_payment_decision_result(p_user_id, 'saved', null, v_new, v_superseded, v_rows, true);
end;
$$;

create or replace function public.mark_card_payment_destination(
  p_user_id uuid,
  p_transaction_id uuid,     -- a cash-side card-payment leg
  p_expected_version bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_s record;
  v_existing record;
  v_claims uuid[];
  v_rows uuid[];
  v_new uuid;
begin
  perform public.card_payment_decision_begin(p_user_id, p_expected_version, 'mark_card_payment_destination');
  select * into v_s from public.card_payment_decision_target(p_user_id, p_transaction_id, 'mark_card_payment_destination');
  perform public.card_payment_decision_check_leg(v_s.superseded, v_s.conflict, v_s.effective_role, v_s.cents, 'mark_card_payment_destination');
  if v_s.credit then
    raise exception 'card_payment_invalid: mark_card_payment_destination: not_cash_side';
  end if;

  -- One pass: the affirmative user decisions holding this leg (active or inactive), by lineage.
  select coalesce(array_agg(x.decision_id order by x.decision_id), '{}') into v_claims
  from public.card_payment_live_decisions(p_user_id) x
  where x.kind in ('pair', 'destination_unlinked', 'pair_counterpart_removed') and v_s.id in (x.row_a, x.row_b);
  if cardinality(v_claims) = 1 then
    select d.kind, d.a_cents into v_existing from public.card_payment_decisions d where d.id = v_claims[1];
    if v_existing.kind = 'destination_unlinked' and v_existing.a_cents = v_s.cents then
      return public.card_payment_decision_result(p_user_id, 'unchanged', 'already_confirmed', v_claims[1],
                                                 '{}', array[v_s.id], false);
    end if;
  end if;

  v_rows := array(select distinct r from unnest(array[v_s.id] || public.card_payment_decision_rows(p_user_id, v_claims)) r);

  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
  values (p_user_id, 'destination_unlinked', v_s.account_id, v_s.plaid, v_s.cents)
  returning id into v_new;
  update public.card_payment_decisions set superseded_by = v_new
  where user_id = p_user_id and id = any (v_claims) and superseded_by is null;

  return public.card_payment_decision_result(p_user_id, 'saved', null, v_new, v_claims, v_rows, true);
end;
$$;

create or replace function public.undo_card_payment_decision(
  p_user_id uuid,
  p_decision_id uuid,
  p_expected_version bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_d public.card_payment_decisions;
  v_rows uuid[];
begin
  perform public.card_payment_decision_begin(p_user_id, p_expected_version, 'undo_card_payment_decision');
  select d.* into v_d from public.card_payment_decisions d where d.id = p_decision_id and d.user_id = p_user_id;
  if not found then
    raise exception 'card_payment_not_found: undo_card_payment_decision: decision not found';
  end if;
  if v_d.kind in ('destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
    raise exception 'card_payment_invalid: undo_card_payment_decision: system_decision (written by an institution removal, not by the user)';
  end if;
  -- Works whatever the decision's legs are now (waiting, gone, no longer card payments, or on an account
  -- that moved to another user): no leg checks. The response names only the user's own current rows.
  v_rows := public.card_payment_decision_rows(p_user_id, array[v_d.id]);
  if v_d.superseded_by = v_d.id then
    return public.card_payment_decision_result(p_user_id, 'unchanged', 'already_undone', v_d.id, '{}', v_rows, false);
  end if;
  if v_d.superseded_by is not null then
    -- Never undo the newer replacement because an older id was supplied, and never move the pointer.
    raise exception 'card_payment_decision_replaced: undo_card_payment_decision: the decision was replaced by a later one; reload and undo that one instead';
  end if;

  update public.card_payment_decisions set superseded_by = id
  where id = v_d.id and user_id = p_user_id and superseded_by is null;
  if not found then
    raise exception 'card_payment_stale_version: undo_card_payment_decision: the decision changed; reload it and retry';
  end if;

  return public.card_payment_decision_result(p_user_id, 'undone', null, v_d.id, '{}', v_rows, true);
end;
$$;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '1ddf83f559f5179975ef52a08b7f2063'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'c2c5368d749e490ed8f7e062ded261cd'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> 'dfcba4535ba1087928185d14cc978c10'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)'::regprocedure) <> '6f8add9a971061e1eaefc872d85ba74a' then
    raise exception 'a function is not the definition this migration installs';
  end if;
  foreach v_fn in array array['public.evaluate_card_payments(uuid, timestamp with time zone)',
                              'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)',
                              'public.mark_card_payment_destination(uuid, uuid, bigint)',
                              'public.undo_card_payment_decision(uuid, uuid, bigint)',
                              'public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)'] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
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
  if pg_get_function_result('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'bigint'
     or pg_get_function_arguments('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure)
        <> 'p_user_id uuid, p_as_of timestamp with time zone DEFAULT now()'
     or pg_get_function_result('public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> 'jsonb'
     or pg_get_function_result('public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'jsonb'
     or pg_get_function_result('public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> 'jsonb'
     or (select provolatile from pg_proc
         where oid = 'public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)'::regprocedure) <> 's'
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('evaluate_card_payments', 'link_card_payment', 'mark_card_payment_destination',
                             'undo_card_payment_decision', 'card_payment_reference_status')) <> 5 then
    raise exception 'a card-payment function signature changed, or an overload exists';
  end if;
  -- The decision model: the two new columns, the five checks (validated), and still exactly two foreign keys
  -- to accounts, both ON DELETE CASCADE — nothing was weakened, and a removed leg references nothing.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'card_payment_decisions' and column_name = 'counterpart_status'
                   and data_type = 'text' and is_nullable = 'YES') then
    raise exception 'card_payment_decisions.counterpart_status is missing or has the wrong type';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'card_payment_decisions' and column_name = 'counterpart_date'
                   and data_type = 'date' and is_nullable = 'YES') then
    raise exception 'card_payment_decisions.counterpart_date is missing or has the wrong type';
  end if;
  if (select count(*) from pg_constraint c
      where c.conrelid = 'public.card_payment_decisions'::regclass and c.contype = 'c' and c.convalidated
        and c.conname in ('card_payment_decisions_kind_check', 'card_payment_decisions_legs_check',
                          'card_payment_decisions_difference_check', 'card_payment_decisions_counterpart_check',
                          'card_payment_decisions_counterpart_date_check')) <> 5 then
    raise exception 'a card_payment_decisions check is missing or not validated';
  end if;
  if (select count(*) from pg_constraint c
      where c.conrelid = 'public.card_payment_decisions'::regclass and c.contype = 'f'
        and c.confrelid = 'public.accounts'::regclass and c.confdeltype = 'c') <> 2
     or exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = 'public.card_payment_decisions'::regclass
                and c.confrelid = 'public.transactions'::regclass) then
    raise exception 'card_payment_decisions must reference accounts twice (ON DELETE CASCADE) and never transactions';
  end if;
  -- No client role gained anything.
  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
             where has_table_privilege(r.role, 'public.card_payment_decisions'::regclass, p.priv)) then
    raise exception 'card_payment_decisions is accessible to a client role';
  end if;
  if (select count(*) from pg_trigger
      where tgname in ('card_payment_bump_decisions', 'card_payment_decisions_same_user') and tgenabled = 'O') <> 2 then
    raise exception 'a card_payment_decisions trigger is missing or disabled';
  end if;
end
$$;
