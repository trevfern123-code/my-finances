-- ROLLBACK for 20261006110000_card_payment_pair_counterpart_removed.sql. NOT a migration; run by an operator
-- only after approval, as the same role that applies migrations. The file is ONE explicit transaction
-- (begin … commit), so run it without psql's -1:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/rollback/20261006110000_card_payment_pair_counterpart_removed_rollback.sql
-- Any failure, including a guard or postcondition, aborts it; nothing is half-applied.
--
-- ORDER. Roll back 20261006120000 FIRST (its own rollback script). This file refuses to run while institution
-- removal is still the body that writes pair_counterpart_removed decisions and ambiguity holds.
--
-- WHAT IT DOES. It re-creates evaluate_card_payments exactly as 20261002120000 defined it, and
-- link_card_payment, mark_card_payment_destination and undo_card_payment_decision exactly as 20261001120000
-- defined them — verbatim, checksum-verified below — and drops card_payment_reference_status.
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--   * It deletes NO decision. Every pair_counterpart_removed row and every ambiguity hold that a removal
--     wrote stays. Deleting them would destroy the user's confirmations, release their legs to automatic
--     matching, and let a removal that already happened resolve a tie after all: the defects the forward
--     migration exists to prevent.
--   * It does not narrow the schema. counterpart_status, counterpart_date and the widened checks stay,
--     because the old checks reject the preserved rows. They are additive: for the four older kinds they
--     accept exactly what the 20260930120000 checks accept. They can be narrowed again only when no row of
--     a new kind exists; that is a separate, deliberate step, not part of this file.
--
-- THIS ROLLBACK IS NOT TRANSPARENT WHILE PRESERVED ROWS EXIST. The previous functions do not know the kinds.
-- What they do with a pair_counterpart_removed row. The rehearsal (supabase/tests/lim_removal_matching_rehearsal)
-- checks this for ONE row: a cash-side leg whose confirmation was frozen valid — claimed, unresolved, and what
-- link_card_payment and undo_card_payment_decision do with it. The card-side leg, the frozen statuses, the
-- "no included card" exception and mark_card_payment_destination are NOT rehearsed: those statements are from
-- the functions' text below.
--   * The previous EVALUATOR still treats it as a user decision on its leg: the leg stays CLAIMED, so it
--     still cannot pair automatically with another card or cash leg. But it knows no effect for the kind:
--       - a cash leg that read untracked / removed_card (−amount) reads UNRESOLVED, with the range
--         {0, −amount}. Cash flow for that period becomes a range instead of a figure;
--       - a card leg that read funded_from_excluded reads unresolved / decision_invalidated;
--       - the frozen counterpart_status is ignored. A leg whose confirmation was frozen invalid keeps its
--         state and range (it read unresolved already), but not what is published with them. While the leg
--         still has its recorded amount and role: on the cash side the decision is published ACTIVE and the
--         leg loses decision_invalidated and its detail (its reason is then the one its candidates give); on
--         the card side the detail becomes not_cash_side instead of the frozen reason. And the "no included
--         card" exception does not apply to the kind: a cash leg that exception decided (untracked /
--         no_included_card, a figure) does not keep its state; it reads unresolved.
--     Taken by themselves these rows change only their OWN legs' readings, from a figure to "can't tell":
--     the same legs are claimed as under the forward evaluator, so no other leg's match changes. That is
--     NOT true of ambiguity holds (below).
--   * The previous link_card_payment / mark_card_payment_destination do not count it among the decisions
--     that hold a leg. A new confirmation on such a leg is saved WITHOUT superseding the preserved one;
--     both then claim the leg, both read conflicting_decisions, and the leg is unresolved until the user
--     undoes the preserved one. undo_card_payment_decision works on it (it refuses only the system kind).
-- What they do with an AMBIGUITY HOLD (a system row on two legs that both survive). The rehearsal checks (i)
-- on a tie and on an Option B hold, the example in (ii), (v), and the conflict with the user's own
-- confirmation of the held pair — with one hold on each held leg, every account included and an included card
-- present. (iii), (iv), the other cases of (ii), the excluded-account and no_included_card readings in (i),
-- and the sentence about date changes and amount corrections are NOT rehearsed: they are from the evaluator's
-- text below.
-- Since revision 5 a hold is no longer only on legs that were unresolved anyway. A removal also writes one
-- for a payment that was matched AUTOMATICALLY to a card of the removed institution and has a card leg on a
-- kept card that was already there (Option B: that payment reads untracked / removed_card, −amount, through
-- its system record), and for legs on accounts excluded from cash flow or decided by the "no included card"
-- rule. So a hold can stand on a payment whose figure is KNOWN, and next to payments that are correctly
-- matched to its other leg.
--   * The previous EVALUATOR reads any row of an unknown kind as a decision on its legs. A hold is written
--     with the CARD leg first, so — while that leg's account is a credit account, see (iv) — it reads the hold
--     as an INACTIVE two-leg decision (not_cash_side) that CLAIMS BOTH legs. A claimed leg is outside
--     automatic matching for every other leg, and the claim is read BEFORE the system record
--     (destination_removed_card) and before the "no included card" rule. What follows from that:
--     (i)   THE HELD LEGS read unresolved / decision_invalidated, whatever they read before (a leg on an
--           account excluded from cash flow keeps reading not_counted, but is claimed like the others). A
--           payment that read untracked / removed_card (system record plus Option B hold) or untracked /
--           no_included_card reads UNRESOLVED: its figure becomes the range {0, −amount}. A tie that was
--           unresolved stays unresolved. For the held legs themselves: a known figure becomes "can't tell",
--           none becomes wrong.
--     (ii)  OTHER PAYMENTS CAN GET A FIGURE THE EVIDENCE DOES NOT SUPPORT. Both held legs leave the pool of
--           automatic matching for EVERY leg, not only for each other. A payment (or card leg) that is on no
--           held pair, but had a held leg as a candidate or as its automatic partner, can therefore GAIN, LOSE
--           or SWITCH an automatic match. The example the rehearsal pins: payment K, +200 on 2026-09-03, was
--           matched automatically to a card that was then removed; card leg B, −200 on 2026-09-07 on a kept
--           card, was already there, so the removal wrote a hold on (B, K). Another payment K', +200 on
--           2026-09-12, is five days from B and five days from B', −200 on 2026-09-17 on another kept card: a
--           tie, so K' is unresolved, the range {0, −200}. After this rollback B is claimed by the misread
--           hold, B' is the only candidate K' has left, and the previous evaluator publishes K' as tracked /
--           auto_pair with B', effect 0 — although B is still there, unchanged, claimed by no user and exactly
--           as close. The rollback resolved a tie. (Were B' on an account excluded from cash flow, the same
--           evaluator's partner_excluded rule would publish −200 for K'; that variant is not rehearsed.) In
--           the same way a card leg that was tied between a held payment and another payment is paired with
--           the other one, and a leg whose automatic partner is a held leg loses its match, or is matched
--           instead to a farther leg that was already there.
--     (iii) TWO HOLDS ON ONE LEG (a payment with two kept competitors, or with two removed candidates; one
--           card leg that competes for two payments) both read conflicting_decisions instead of
--           not_cash_side. Their legs are claimed and unresolved all the same.
--     (iv)  NOT ALWAYS INACTIVE. For a hold whose two references still resolve to current rows, whose card leg
--           still has the recorded amount and role, and whose legs no other decision claims, not_cash_side
--           is the previous evaluator's only reason to keep the row inactive. If the account of the card leg
--           later stops being a credit account (accounts.type changes), it reads such a hold as an ACTIVE
--           CONFIRMED PAIR of its two legs: the payment reads tracked / user_pair, effect 0, with exactly the
--           leg the hold exists to keep it from. A wrong figure. (Not rehearsed; from the evaluator's text
--           below.)
--     And, more strongly than the forward evaluator withholds a pair: neither a date change nor an amount
--     correction releases it (an inactive row still claims its current legs, so a pair that formed
--     legitimately after the removal reads unresolved again); and a user decision on either leg claims that
--     leg too, so it reads conflicting_decisions with the hold and the leg stays unresolved until this
--     migration is applied again (or the hold is undone: (v)).
--   * (v) The previous undo_card_payment_decision does NOT refuse a hold's id (it refuses only
--     destination_removed_card), and an undone hold is undone FOR GOOD: superseded_by = its own id, and
--     nothing ever writes it again. After both migrations are applied again that protection is gone: the
--     pair is no longer withheld, so a payment with a known removed destination is matched automatically to
--     the card leg that was already there (its system record goes dormant behind that pair), and a tie that
--     the removal must not resolve is resolved. In the rolled-back state the hold is the decision shown on
--     a payment that "needs review", so undoing it is the obvious thing for a user to try.
-- So: THIS ROLLBACK IS NOT ROUTINE while a live ambiguity hold or a preserved user pair exists. PREFER
-- ROLLING BACK 20261006120000 ALONE: that stops new rows of these kinds and leaves in place the evaluator
-- that understands the existing ones — every record, preserved pair and hold keeps reading exactly as
-- before. Run this file in that state only if the 20261006110000 evaluator or RPCs themselves must go, and
-- apply the migration again as soon as possible: every evaluation in between publishes the readings above,
-- and every undo of a hold in between is permanent.
--
-- THE ACKNOWLEDGEMENT. While LIVE ambiguity holds exist (superseded_by is null) this file REFUSES to run
-- unless the operator has acknowledged the above in the SAME session, before this file's own BEGIN, with
-- exactly
--   set i3a.rollback_with_live_holds = 'acknowledged';
-- for example
--   psql -X -v ON_ERROR_STOP=1 -c "set i3a.rollback_with_live_holds = 'acknowledged'" -f supabase/rollback/20261006110000_card_payment_pair_counterpart_removed_rollback.sql
-- (psql runs -c and -f in one session, in that order; the setting is session-level, so the guard inside
-- this file's transaction sees it — the rehearsal applies it this way, the file given as -f - on standard
-- input. No value, or any other value, is a refusal.) Whenever it proceeds while
-- live holds or live preserved user pairs exist, it raises a WARNING with both counts. With neither, the guard
-- raises nothing.
-- ONE ACKNOWLEDGEMENT SERVES ONE RUN: the guard clears the setting inside this file's transaction, so a run
-- that commits leaves it empty and a later run in the same session is refused again until it is set again (a
-- run that fails keeps it). Run this file over a direct connection, not through a transaction-mode pooler,
-- where the setting and the file can reach different server sessions.
-- THE COUNT IS THE COUNT THAT IS ROLLED BACK. Before it counts, the guard locks card_payment_decisions in
-- SHARE ROW EXCLUSIVE mode and holds the lock to this file's COMMIT. It waits for every transaction that has
-- already written to that table — an institution removal still running the 20261006120000 body, whose holds
-- are then counted (at READ COMMITTED, the default: the counts take their snapshot after the lock is granted;
-- at a higher isolation level they would not see them) — and nothing writes a decision until the commit. A
-- removal running that body that has not yet written is not waited for: its first preserving statement calls
-- card_payment_reference_status, which this file drops, so it fails and removes nothing (from the function's
-- text; not rehearsed). Readers are not blocked. Writers queue behind the lock from the moment it is
-- requested; lock_timeout, set in the session, bounds that wait (a timeout aborts the run, like any failure).
--
-- The migration's ledger row in supabase_migrations.schema_migrations is deliberately left alone.
-- Re-applying means running the migration file's SQL again (its guard accepts exactly these restored
-- bodies, and its DDL is repeatable), not `supabase db push`, which would see the version as applied.
--
-- Guard: refuses unless the current bodies are exactly the ones 20261006110000 installs, and institution
-- removal is the 20260926120000 body; and, while live ambiguity holds exist, unless that was acknowledged.

begin;

do $$
declare
  v_live_holds bigint;
  v_live_pairs bigint;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '1ddf83f559f5179975ef52a08b7f2063'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'c2c5368d749e490ed8f7e062ded261cd'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> 'dfcba4535ba1087928185d14cc978c10' then
    raise exception 'the card-payment functions are not the 20261006110000 definitions; refusing to roll back';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'a8f567d397b9dae5b777497317985ab7' then
    raise exception 'remove_plaid_item_local is not the 20260926120000 definition: roll back 20261006120000 first';
  end if;
  -- Live ambiguity holds (this file's header, (i)–(v)): the previous evaluator misreads them. Refuse unless the
  -- operator acknowledged that in this session; warn whenever it proceeds over live rows of the new kinds.
  -- The lock makes the counts final for this transaction: SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE
  -- lock of every transaction that has written to the table, so this waits for a removal that is still
  -- writing holds (at READ COMMITTED, the default, the counts below then see them), and no decision is written
  -- from here to the commit. It does not block readers.
  lock table public.card_payment_decisions in share row exclusive mode;
  select count(*) into v_live_holds from public.card_payment_decisions
  where kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') and superseded_by is null;
  select count(*) into v_live_pairs from public.card_payment_decisions
  where kind = 'pair_counterpart_removed' and superseded_by is null;
  if v_live_holds > 0 and current_setting('i3a.rollback_with_live_holds', true) is distinct from 'acknowledged' then
    raise exception 'refusing to roll back 20261006110000: % live ambiguity hold(s) exist. The previous evaluator reads each of them as an inactive decision that claims both of its legs, so a held payment with a known figure reads unresolved and other payments can gain, lose or switch an automatic match. Prefer rolling back 20261006120000 alone; to proceed anyway, acknowledge it first in the same session with: set i3a.rollback_with_live_holds = ''acknowledged'';', v_live_holds;
  end if;
  -- One acknowledgement serves one run: clear it. set_config is transactional, so a run that fails after this
  -- line keeps the acknowledgement, and a run that commits leaves the session without one.
  perform set_config('i3a.rollback_with_live_holds', '', false);
  if v_live_holds > 0 or v_live_pairs > 0 then
    raise warning 'rolling back 20261006110000 over % live ambiguity hold(s) and % live pair_counterpart_removed decision(s): the previous evaluator and RPCs do not know these kinds (this file''s header says what they do with them) until the migration is applied again', v_live_holds, v_live_pairs;
  end if;
end
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
  create temporary table if not exists cpe_tracked (
    cash_account uuid not null, credit_account uuid not null, abs_cents bigint not null, cash_day integer not null,
    credit_day integer not null) on commit drop;
  create temporary table if not exists cpe_state (
    id uuid primary key, state text not null, reason text, detail text, partner uuid, decision_id uuid, effect bigint,
    cash_excess bigint not null, card_excess bigint not null, contradictions boolean not null) on commit drop;
  truncate pg_temp.cpe_accounts, pg_temp.cpe_txn, pg_temp.cpe_pool, pg_temp.cpe_named, pg_temp.cpe_dismissed, pg_temp.cpe_removed,
           pg_temp.cpe_udec, pg_temp.cpe_dec_result, pg_temp.cpe_claim, pg_temp.cpe_tier1, pg_temp.cpe_tracked,
           pg_temp.cpe_state;

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
        if d.kind <> 'not_this_pair' then
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
          if d.kind <> 'not_this_pair' then
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

    if v_inactive is null then
      -- shapeDetail: amount first, then role, then sides / direction / accepted difference.
      select * into v_ra from pg_temp.cpe_txn t where t.id = v_rows[1];
      if d.kind = 'pair' then
        select * into v_rb from pg_temp.cpe_txn t where t.id = v_rows[2];
      else
        v_rb := v_ra; -- keeps the record assigned; only read when kind = pair
      end if;
      if v_ra.cents <> d.a_cents or (d.kind = 'pair' and v_rb.cents <> d.b_cents) then
        v_inactive := 'amount_changed';
      elsif not v_ra.is_leg or (d.kind = 'pair' and not v_rb.is_leg) then
        v_inactive := 'role_changed';
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
        else
          v_pair_partner := case when v_claim.row_a is not null and v_claim.row_a <> l.id then v_claim.row_a else v_claim.row_b end;
          v_pair_reason := 'user_pair';
        end if;
      else
        -- Held by an inactive user decision: reserved, the decision attached (needs review).
        v_detail := v_claim.inactive;
        if v_claim.inactive = 'amount_changed' and v_claim.kind = 'destination_unlinked' and not l.credit
           and not v_included_credit and sign(l.cents::numeric) = sign(v_claim.a_cents::numeric) then
          -- The one approved exception (2026-09-30): the corrected effect is known independently.
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
                    filter (where x.kind in ('pair', 'destination_unlinked') and v_s.id in (x.row_a, x.row_b)), '{}'),
         coalesce(array_agg(x.decision_id order by x.decision_id)
                    filter (where x.kind in ('pair', 'destination_unlinked') and v_c.id in (x.row_a, x.row_b)), '{}'),
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
  where x.kind in ('pair', 'destination_unlinked') and v_s.id in (x.row_a, x.row_b);
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
  if v_d.kind = 'destination_removed_card' then
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

drop function public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone);

do $$
declare
  v_fn text;
  v_rows bigint;
  v_holds bigint;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'f620515feaee49b382965cc8b73f02e2'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '72676208bb4c33cf3d801ddf294f2543'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'b3a105575539bf30e306e68511258bfc'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> '8b3e51df8455a7ac93a423ea174eb3f8' then
    raise exception 'rollback did not restore the previous definitions exactly';
  end if;
  foreach v_fn in array array['public.evaluate_card_payments(uuid, timestamp with time zone)',
                              'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)',
                              'public.mark_card_payment_destination(uuid, uuid, bigint)',
                              'public.undo_card_payment_decision(uuid, uuid, bigint)'] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and p.prolang = (select oid from pg_language where lanname = 'plpgsql')
      and not p.prosecdef
      and p.provolatile = 'v'
      and p.proconfig = array['search_path=""']
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      raise exception '% lost a security or definition property', v_fn;
    end if;
  end loop;
  if to_regprocedure('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') is not null then
    raise exception 'card_payment_reference_status was not dropped';
  end if;
  select count(*) into v_rows from public.card_payment_decisions where kind = 'pair_counterpart_removed';
  select count(*) into v_holds from public.card_payment_decisions where kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account');
  raise notice 'rolled back the functions; % preserved user decision(s) of kind pair_counterpart_removed and % ambiguity hold(s) were kept, with the columns and the checks that hold them', v_rows, v_holds;
end
$$;

commit;
