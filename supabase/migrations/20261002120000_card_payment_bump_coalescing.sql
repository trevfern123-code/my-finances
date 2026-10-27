-- Card-payment invalidation: coalesce redundant version-row bumps within one transaction, and harden the
-- evaluator for it (P2-C1; P2_C1_IMPLEMENTATION_HANDOFF.md). Builds on
-- 20260930120000_card_payment_matching_state.sql. Changes no table, column, trigger, grant or row.
--
-- WHY. Every input-row change runs card_payment_bump, which UPDATEd the user's single version row once per
-- changed row. Inside one transaction those same-row updates cannot be pruned, so each costs more than
-- the last: a 20k-row sync batch spent about 4.5 s in them.
--
-- WHAT CHANGES
--   * card_payment_bump(uuid): the body only. A bump is skipped when ALL of these hold:
--       (a) the user's marker, the transaction-local setting card_payment.bumped_<user uuid without
--           dashes>, equals the current top-level transaction id (pg_current_xact_id(), the same inside
--           savepoints);
--       (b) the user's version row exists;
--       (c) that row is stale (evaluated_version IS DISTINCT FROM input_version; never evaluated counts).
--     Otherwise it runs the previous UPDATE / INSERT exactly as before. The marker is set only after that
--     UPDATE or INSERT succeeded, never for a NULL user or a user being deleted.
--   * evaluate_card_payments(uuid, timestamptz): ONE added step (3a), right after it captures the version
--     under L2. It clears this user's marker, so any input write this transaction makes after the capture
--     bumps unconditionally and leaves the publication stale. Nothing else in the evaluator changes: same
--     checks, locks (L1 advisory, then L2 version row FOR UPDATE), inputs, rules, and it still publishes
--     exactly the version it captured.
--
-- WHY THE SKIP IS SAFE. (a) holds only while a bump by this transaction still stands:
--   * ROLLBACK TO SAVEPOINT, or a caught exception, reverts the setting together with that bump's
--     UPDATE / INSERT;
--   * commit and rollback discard is_local settings;
--   * a value from any other transaction cannot equal this transaction's id.
-- That bump excludes every other session until this transaction ends, so none can capture, publish or
-- bump this user meanwhile, and (c) cannot change except by this transaction:
--   * an UPDATE holds the row lock (L2);
--   * an INSERT, when the row did not exist, holds the uncommitted key. The evaluator's and other bumps'
--     INSERT … ON CONFLICT wait on it, and a decision RPC finds no row and refuses as stale.
-- Re-arming:
--   * a publication with no later input write leaves the row fresh, so (c) fails and the next write bumps;
--   * a write after the capture bumps anyway, because step 3a cleared the marker.
-- A skip takes no new lock and never waits, and every transaction's first bump is the previous one.
-- Invalidation still happens in the writer's own transaction.
--
-- TRUST. The marker is an optimization, not an authorization. Forging it needs arbitrary SQL as a role
-- that can write the input tables (service_role, postgres), which can already UPDATE
-- card_payment_eval_versions directly. Client roles cannot execute either function, cannot run SQL, and
-- reach the database only through PostgREST, which sets only its own request.* settings and does not
-- expose pg_catalog. No function lets a caller choose a setting name.
--
-- OBSERVABLE CHANGE. input_version now advances at least once per transaction that changes a user's
-- inputs (and again after each publication inside that transaction), instead of once per changed row.
-- Its exact value was never a contract: equality with evaluated_version and the decision RPCs' expected
-- version are, and both are unchanged.
--
-- SESSION STATE. Each distinct user bumped through a database connection leaves one setting NAME in that
-- connection for its lifetime. Its value is cleared at every commit and rollback; neither RESET ALL nor
-- DISCARD ALL removes the name. The size is measured in P2_C1_IMPLEMENTATION_HANDOFF.md
-- (supabase/tests/card_payment_benchmark/coalescing/growth.sql).
--
-- COMPATIBILITY. No backend, API or schema change; nothing to backfill and no version reset.
-- A transaction that straddles the replacement is safe either way:
--   * the previous body always bumps;
--   * the new body skips only on a marker it set itself, in this same transaction.
-- A straddler may briefly pair the new bump with the previous evaluator, which does not clear the marker.
-- That pairing is safe because the evaluator writes no input table between capture and publication.
--
-- ROLLBACK. Run supabase/rollback/20261002120000_card_payment_bump_coalescing_rollback.sql. It re-creates
-- both previous bodies verbatim (checksum-verified) and changes no data. Markers are transaction-local and
-- version numbers stay monotonic, so no data cleanup is needed. Setting names already created in open
-- connections stay until those connections end; they are harmless.
--
-- Guard: applies only on top of the exact 20260930120000 bodies (checksums of the LF-normalised source).

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.card_payment_bump(uuid)'::regprocedure) <> '9b67a29937db09a4661f0f906cf80563'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'c43128295a457d62b83448083eb6f7d2' then
    raise exception 'card_payment_bump / evaluate_card_payments are not the 20260930120000 definitions; refusing to replace them';
  end if;
end
$$;

create or replace function public.card_payment_bump(p_user_id uuid) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_marker text;
  v_xact text;
  v_input bigint;
  v_evaluated bigint;
begin
  if p_user_id is null then
    return;
  end if;
  -- Coalescing: this transaction already made the user stale with a bump that still stands (so it still
  -- holds the row lock), and nothing has published since. The row cannot change before this transaction
  -- ends, so another increment would add nothing.
  v_marker := 'card_payment.bumped_' || replace(p_user_id::text, '-', '');
  v_xact := pg_current_xact_id()::text;
  if current_setting(v_marker, true) = v_xact then
    select v.input_version, v.evaluated_version into v_input, v_evaluated
    from public.card_payment_eval_versions v where v.user_id = p_user_id;
    if found and v_evaluated is distinct from v_input then
      return;
    end if;
  end if;
  update public.card_payment_eval_versions set input_version = input_version + 1 where user_id = p_user_id;
  if found then
    perform set_config(v_marker, v_xact, true);
    return;
  end if;
  begin
    insert into public.card_payment_eval_versions (user_id, input_version) values (p_user_id, 1)
    on conflict (user_id) do update set input_version = public.card_payment_eval_versions.input_version + 1;
  exception when foreign_key_violation then
    return; -- the user row is being deleted in this transaction: no version row, so no marker
  end;
  perform set_config(v_marker, v_xact, true);
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

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = 'public.card_payment_bump(uuid)'::regprocedure) <> '3fa11a0ed807dfb54aad20ba576e567c'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'f620515feaee49b382965cc8b73f02e2' then
    raise exception 'card_payment_bump / evaluate_card_payments are not the definitions this migration installs';
  end if;
  foreach v_fn in array array['public.card_payment_bump(uuid)', 'public.evaluate_card_payments(uuid, timestamp with time zone)'] loop
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
  if pg_get_function_result('public.card_payment_bump(uuid)'::regprocedure) <> 'void'
     or pg_get_function_result('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'bigint'
     or pg_get_function_arguments('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure)
        <> 'p_user_id uuid, p_as_of timestamp with time zone DEFAULT now()' then
    raise exception 'a card-payment function signature changed';
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
end
$$;
