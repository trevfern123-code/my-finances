-- Card-payment matching state (Phase B slice 2a; CARD_PAYMENT_PAIRING_DESIGN.md rev 3 §3.5–§3.8).
--
-- DISCONNECTED. Nothing in the application calls these objects yet: no decision-writing RPC, no sync or
-- institution-removal integration, no aggregation reads them (slices 2b–2d). The input triggers only
-- advance a per-user version number; they never block or alter a write.
--
--   * card_payment_decisions — what the user decided, keyed by transaction LINEAGE (account + Plaid
--     id + cents at decision time), with NO foreign key to transactions (§3.5): posting replaces the
--     pending row on the same account, and a cascade would erase the confirmation the posted row needs.
--   * card_payment_eval_versions — one row per user: input_version (advanced by every input change,
--     in the writer's own transaction) and evaluated_version (the input_version the stored states were
--     computed from). States are readable only when the two are equal (§3.7).
--   * card_payment_leg_states, card_payment_auto_pairs, card_payment_decision_states — derived,
--     recomputable, written only by the evaluator, with NO foreign key to transactions or accounts
--     (only user_id), so the evaluator never takes a lock on a data row (§3.7 lock order).
--   * evaluate_card_payments(user, as_of) — the SQL evaluator: the same rules as the TypeScript
--     reference evaluator backend/src/services/cardPaymentMatching.ts (the oracle, §3.8), including the
--     approved 2026-09-30 rules (conflicting replacements held; changed confirmations reserved; the
--     narrow known-effect exception). Lock order: per-user advisory lock (L1), then the version row
--     FOR UPDATE (L2); it reads inputs only after L2, takes no data-row lock (L3), and publishes exactly
--     the version it read under L2.
--   * try_evaluate_card_payments — the same in a subtransaction: a failure rolls back only the
--     evaluation, records a sanitized SQLSTATE, and leaves the user stale.
--   * get_card_payment_states — one statement, one snapshot: returns states only when fresh.
--
-- Security: every table service-role only (RLS on, no policies, no client privilege); every function
-- SECURITY INVOKER with search_path pinned empty, executable by service_role only; trigger functions
-- executable by no role. Postconditions at the end abort the file if any of that does not hold.
--
-- Rollback (nothing depends on these objects yet):
--   drop trigger card_payment_bump_transactions_ins_del on public.transactions;
--   drop trigger card_payment_bump_transactions_upd on public.transactions;
--   drop trigger card_payment_bump_accounts_ins_del on public.accounts;
--   drop trigger card_payment_bump_accounts_upd on public.accounts;
--   drop trigger card_payment_bump_plaid_items_del on public.plaid_items;
--   drop trigger card_payment_bump_plaid_items_upd on public.plaid_items;
--   drop trigger card_payment_bump_carryovers_ins_del on public.transaction_carryovers;
--   drop trigger card_payment_bump_carryovers_upd on public.transaction_carryovers;
--   drop function public.get_card_payment_states(uuid, date, date);
--   drop function public.try_evaluate_card_payments(uuid, timestamptz);
--   drop function public.evaluate_card_payments(uuid, timestamptz);
--   drop table public.card_payment_leg_states, public.card_payment_auto_pairs,
--              public.card_payment_decision_states, public.card_payment_decisions,
--              public.card_payment_eval_versions;
--   drop function public.card_payment_bump_transactions(), public.card_payment_bump_accounts(),
--                 public.card_payment_bump_plaid_items(), public.card_payment_bump_decisions(),
--                 public.card_payment_bump_carryovers(), public.card_payment_decisions_same_user(),
--                 public.card_payment_bump(uuid);
--   drop sequence public.card_payment_decisions_seq;

-- ---- Version bookkeeping ---------------------------------------------------------------------------
create table public.card_payment_eval_versions (
  user_id                     uuid primary key references auth.users(id) on delete cascade,
  input_version               bigint not null default 0,
  -- NULL: never evaluated (states are not readable).
  evaluated_version           bigint null,
  evaluated_as_of             timestamp with time zone null,
  superseded_transaction_ids  uuid[] not null default '{}',
  last_error_code             text null,
  last_attempt_at             timestamp with time zone null
);

-- Advances a user's input_version. Called by the input triggers in the writer's transaction; the row
-- lock it takes is L2, held until that transaction ends. It can only ever make a user STALE — the safe
-- direction — so service_role may execute it. A user being deleted (cascade) is skipped: its version
-- row is going too.
create function public.card_payment_bump(p_user_id uuid) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_user_id is null then
    return;
  end if;
  update public.card_payment_eval_versions set input_version = input_version + 1 where user_id = p_user_id;
  if found then
    return;
  end if;
  begin
    insert into public.card_payment_eval_versions (user_id, input_version) values (p_user_id, 1)
    on conflict (user_id) do update set input_version = public.card_payment_eval_versions.input_version + 1;
  exception when foreign_key_violation then
    null; -- the user row is being deleted in this transaction
  end;
end;
$$;

-- ---- Decisions (lineage-keyed; §3.5) ---------------------------------------------------------------
create sequence public.card_payment_decisions_seq;

create table public.card_payment_decisions (
  id                         uuid primary key default gen_random_uuid(),
  user_id                    uuid not null references auth.users(id) on delete cascade,
  kind                       text not null,
  -- Leg references: the Plaid id and cents AT DECISION TIME. Account FK cascades: relinking creates new
  -- accounts and Plaid ids, so no replacement ever comes through a deleted account (§3.5).
  a_account_id               uuid not null references public.accounts(id) on delete cascade,
  a_plaid_transaction_id     text not null,
  a_cents                    bigint not null,
  b_account_id               uuid null references public.accounts(id) on delete cascade,
  b_plaid_transaction_id     text null,
  b_cents                    bigint null,
  -- pair only: |cash cents| − |credit cents| the user explicitly accepted (0 for an exact pair; §4.3).
  accepted_difference_cents  bigint null,
  decided_seq                bigint not null default nextval('public.card_payment_decisions_seq'),
  created_at                 timestamp with time zone not null default now(),
  -- Undo history: set when the user undid or replaced the decision. The evaluator ignores superseded
  -- decisions. An audit pointer, deliberately without a foreign key (a superseding row's deletion must
  -- never reactivate this one).
  superseded_by              uuid null,
  constraint card_payment_decisions_kind_check
    check (kind in ('pair', 'not_this_pair', 'destination_unlinked', 'destination_removed_card')),
  constraint card_payment_decisions_legs_check
    check ((kind in ('pair', 'not_this_pair'))
           = (b_account_id is not null and b_plaid_transaction_id is not null and b_cents is not null)
           and (b_account_id is null) = (b_plaid_transaction_id is null)
           and (b_account_id is null) = (b_cents is null)),
  constraint card_payment_decisions_difference_check
    check ((kind = 'pair') = (accepted_difference_cents is not null))
);

create index card_payment_decisions_user_idx on public.card_payment_decisions (user_id);
create index card_payment_decisions_a_account_idx on public.card_payment_decisions (a_account_id);
create index card_payment_decisions_b_account_idx on public.card_payment_decisions (b_account_id);

-- §3.5: every decision's accounts belong to its user, checked at write time. (An account that later
-- moves to another user is reported by the evaluator as foreign_account.)
create function public.card_payment_decisions_same_user() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id
                 where a.id = new.a_account_id and i.user_id = new.user_id)
     or (new.b_account_id is not null
         and not exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id
                         where a.id = new.b_account_id and i.user_id = new.user_id)) then
    raise exception 'card_payment_decision_foreign_account' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger card_payment_decisions_same_user
  before insert or update of user_id, a_account_id, b_account_id on public.card_payment_decisions
  for each row execute function public.card_payment_decisions_same_user();

-- ---- Derived state (written only by the evaluator; no FK to data rows) -----------------------------
create table public.card_payment_leg_states (
  user_id                 uuid not null references auth.users(id) on delete cascade,
  transaction_id          uuid not null,
  account_id              uuid not null,
  date                    date not null,
  amount_cents            bigint not null,
  pending                 boolean not null,
  side                    text not null,
  direction               text not null,
  account_included        boolean not null,
  state                   text not null,
  reason                  text not null,
  detail                  text null,
  partner_transaction_id  uuid null,
  decision_id             uuid null,
  candidates              jsonb not null,
  effect_cents            bigint null,
  low_cents               bigint not null,
  high_cents              bigint not null,
  cash_excess_cents       bigint not null,
  card_excess_cents       bigint not null,
  recent                  boolean not null,
  computed_at_version     bigint not null,
  primary key (user_id, transaction_id)
);
create index card_payment_leg_states_user_date_idx on public.card_payment_leg_states (user_id, date);

create table public.card_payment_auto_pairs (
  user_id                uuid not null references auth.users(id) on delete cascade,
  cash_transaction_id    uuid not null,
  credit_transaction_id  uuid not null,
  computed_at_version    bigint not null,
  primary key (user_id, cash_transaction_id)
);

create table public.card_payment_decision_states (
  user_id              uuid not null references auth.users(id) on delete cascade,
  decision_id          uuid not null,
  kind                 text not null,
  status               text not null,
  detail               text null,
  computed_at_version  bigint not null,
  primary key (user_id, decision_id)
);

-- ---- Input triggers (§3.7): every input change bumps the owner's version in the writer's transaction.
-- The owner is found through row → account → item. A cascaded delete whose parent is already gone is
-- covered by the parent's own trigger (an account's by its item's, a transaction's by its account's).

create function public.card_payment_bump_transactions() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select i.user_id into v_old from public.accounts a join public.plaid_items i on i.id = a.item_id where a.id = old.account_id;
    perform public.card_payment_bump(v_old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select i.user_id into v_new from public.accounts a join public.plaid_items i on i.id = a.item_id where a.id = new.account_id;
    if v_new is distinct from v_old then
      perform public.card_payment_bump(v_new);
    end if;
  end if;
  return null;
end;
$$;

create trigger card_payment_bump_transactions_ins_del
  after insert or delete on public.transactions
  for each row execute function public.card_payment_bump_transactions();
create trigger card_payment_bump_transactions_upd
  after update of amount, date, account_id, plaid_transaction_id, pending, pending_transaction_id,
                  auto_role, user_role_override on public.transactions
  for each row
  when (old.amount is distinct from new.amount
        or old.date is distinct from new.date
        or old.account_id is distinct from new.account_id
        or old.plaid_transaction_id is distinct from new.plaid_transaction_id
        or old.pending is distinct from new.pending
        or old.pending_transaction_id is distinct from new.pending_transaction_id
        or old.auto_role is distinct from new.auto_role
        or old.user_role_override is distinct from new.user_role_override)
  execute function public.card_payment_bump_transactions();

create function public.card_payment_bump_accounts() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select i.user_id into v_old from public.plaid_items i where i.id = old.item_id;
    perform public.card_payment_bump(v_old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select i.user_id into v_new from public.plaid_items i where i.id = new.item_id;
    if v_new is distinct from v_old then
      perform public.card_payment_bump(v_new);
    end if;
  end if;
  return null;
end;
$$;

create trigger card_payment_bump_accounts_ins_del
  after insert or delete on public.accounts
  for each row execute function public.card_payment_bump_accounts();
create trigger card_payment_bump_accounts_upd
  after update of type, exclude_from_cash_flow, item_id on public.accounts
  for each row
  when (old.type is distinct from new.type
        or old.exclude_from_cash_flow is distinct from new.exclude_from_cash_flow
        or old.item_id is distinct from new.item_id)
  execute function public.card_payment_bump_accounts();

create function public.card_payment_bump_plaid_items() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform public.card_payment_bump(old.user_id);
  if tg_op = 'UPDATE' then
    perform public.card_payment_bump(new.user_id);
  end if;
  return null;
end;
$$;

create trigger card_payment_bump_plaid_items_del
  after delete on public.plaid_items
  for each row execute function public.card_payment_bump_plaid_items();
create trigger card_payment_bump_plaid_items_upd
  after update of user_id on public.plaid_items
  for each row when (old.user_id is distinct from new.user_id)
  execute function public.card_payment_bump_plaid_items();

create function public.card_payment_bump_decisions() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.card_payment_bump(old.user_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.user_id is distinct from old.user_id) then
    perform public.card_payment_bump(new.user_id);
  end if;
  return null;
end;
$$;

create trigger card_payment_bump_decisions
  after insert or update or delete on public.card_payment_decisions
  for each row execute function public.card_payment_bump_decisions();

create function public.card_payment_bump_carryovers() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.card_payment_bump(old.user_id);
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.user_id is distinct from old.user_id) then
    perform public.card_payment_bump(new.user_id);
  end if;
  return null;
end;
$$;

create trigger card_payment_bump_carryovers_ins_del
  after insert or delete on public.transaction_carryovers
  for each row execute function public.card_payment_bump_carryovers();
create trigger card_payment_bump_carryovers_upd
  after update of consumed_at, expires_at, account_id, pending_plaid_transaction_id, user_id
    on public.transaction_carryovers
  for each row
  when (old.consumed_at is distinct from new.consumed_at
        or old.expires_at is distinct from new.expires_at
        or old.account_id is distinct from new.account_id
        or old.pending_plaid_transaction_id is distinct from new.pending_plaid_transaction_id
        or old.user_id is distinct from new.user_id)
  execute function public.card_payment_bump_carryovers();

-- ---- The evaluator (§3.7 steps 1–7) -----------------------------------------------------------------
-- Mirrors backend/src/services/cardPaymentMatching.ts exactly; supabase/tests/card_payment_evaluator
-- requires identical output on generated histories. Section comments name the TypeScript step.
create function public.evaluate_card_payments(p_user_id uuid, p_as_of timestamp with time zone default now())
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

-- The evaluator in a subtransaction: a failure rolls back only the evaluation, records a sanitized
-- SQLSTATE and leaves the user stale; the caller's own writes are unaffected (§3.7).
create function public.try_evaluate_card_payments(p_user_id uuid, p_as_of timestamp with time zone default now())
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code text;
begin
  begin
    perform public.evaluate_card_payments(p_user_id, p_as_of);
    return true;
  exception when others then
    v_code := sqlstate;
  end;
  insert into public.card_payment_eval_versions (user_id) values (p_user_id) on conflict (user_id) do nothing;
  update public.card_payment_eval_versions set last_error_code = v_code, last_attempt_at = clock_timestamp()
  where user_id = p_user_id;
  return false;
end;
$$;

-- ---- The state reader (§3.7): one statement, one snapshot; states only when fresh ------------------
create function public.get_card_payment_states(p_user_id uuid, p_from date default null, p_to date default null)
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

-- ---- Privileges ------------------------------------------------------------------------------------
alter table public.card_payment_eval_versions enable row level security;
alter table public.card_payment_decisions enable row level security;
alter table public.card_payment_leg_states enable row level security;
alter table public.card_payment_auto_pairs enable row level security;
alter table public.card_payment_decision_states enable row level security;

revoke all on table public.card_payment_eval_versions, public.card_payment_decisions, public.card_payment_leg_states,
                    public.card_payment_auto_pairs, public.card_payment_decision_states
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.card_payment_eval_versions to service_role;
grant select, insert, update, delete on table public.card_payment_decisions to service_role;
grant select, insert, delete on table public.card_payment_leg_states, public.card_payment_auto_pairs,
                                     public.card_payment_decision_states to service_role;

revoke all on sequence public.card_payment_decisions_seq from public, anon, authenticated;
grant usage, select on sequence public.card_payment_decisions_seq to service_role;

-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated: revoke.
revoke all on function public.card_payment_bump(uuid) from public, anon, authenticated;
revoke all on function public.evaluate_card_payments(uuid, timestamp with time zone) from public, anon, authenticated;
revoke all on function public.try_evaluate_card_payments(uuid, timestamp with time zone) from public, anon, authenticated;
revoke all on function public.get_card_payment_states(uuid, date, date) from public, anon, authenticated;
grant execute on function public.card_payment_bump(uuid) to service_role;
grant execute on function public.evaluate_card_payments(uuid, timestamp with time zone) to service_role;
grant execute on function public.try_evaluate_card_payments(uuid, timestamp with time zone) to service_role;
grant execute on function public.get_card_payment_states(uuid, date, date) to service_role;
revoke all on function public.card_payment_decisions_same_user() from public, anon, authenticated, service_role;
revoke all on function public.card_payment_bump_transactions() from public, anon, authenticated, service_role;
revoke all on function public.card_payment_bump_accounts() from public, anon, authenticated, service_role;
revoke all on function public.card_payment_bump_plaid_items() from public, anon, authenticated, service_role;
revoke all on function public.card_payment_bump_decisions() from public, anon, authenticated, service_role;
revoke all on function public.card_payment_bump_carryovers() from public, anon, authenticated, service_role;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
  v_tbl text;
  v_bad text := '';
begin
  foreach v_fn in array array[
    'public.card_payment_bump(uuid)',
    'public.evaluate_card_payments(uuid, timestamp with time zone)',
    'public.try_evaluate_card_payments(uuid, timestamp with time zone)',
    'public.get_card_payment_states(uuid, date, date)'
  ] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      v_bad := v_bad || E'\n  ' || v_fn;
    end if;
  end loop;
  foreach v_fn in array array[
    'public.card_payment_decisions_same_user()', 'public.card_payment_bump_transactions()',
    'public.card_payment_bump_accounts()', 'public.card_payment_bump_plaid_items()',
    'public.card_payment_bump_decisions()', 'public.card_payment_bump_carryovers()'
  ] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      v_bad := v_bad || E'\n  ' || v_fn;
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'card-payment functions lack a security property:%', v_bad;
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

  foreach v_tbl in array array['card_payment_eval_versions', 'card_payment_decisions', 'card_payment_leg_states',
                               'card_payment_auto_pairs', 'card_payment_decision_states'] loop
    if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
               cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'),
                                  ('trigger'), ('maintain')) p(priv)
               where has_table_privilege(r.role, ('public.' || v_tbl)::regclass, p.priv)) then
      raise exception '% is accessible to a client role', v_tbl;
    end if;
    if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
               cross join pg_attribute a
               cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
               where a.attrelid = ('public.' || v_tbl)::regclass and a.attnum > 0 and not a.attisdropped
                 and has_column_privilege(r.role, ('public.' || v_tbl)::regclass, a.attname, p.priv)) then
      raise exception '% has a column privilege for a client role', v_tbl;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || v_tbl)::regclass)
       or exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_tbl) then
      raise exception '% must have row level security enabled and no policies', v_tbl;
    end if;
  end loop;
  if (select array_agg(p.priv order by p.priv)
      from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
      where has_table_privilege('service_role', 'public.card_payment_eval_versions', p.priv))
     is distinct from array['insert', 'select', 'update'] then
    raise exception 'card_payment_eval_versions: service_role must have exactly SELECT, INSERT and UPDATE';
  end if;
  if (select array_agg(p.priv order by p.priv)
      from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
      where has_table_privilege('service_role', 'public.card_payment_decisions', p.priv))
     is distinct from array['delete', 'insert', 'select', 'update'] then
    raise exception 'card_payment_decisions: service_role must have exactly SELECT, INSERT, UPDATE and DELETE';
  end if;
  foreach v_tbl in array array['card_payment_leg_states', 'card_payment_auto_pairs', 'card_payment_decision_states'] loop
    if (select array_agg(p.priv order by p.priv)
        from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
        where has_table_privilege('service_role', ('public.' || v_tbl)::regclass, p.priv))
       is distinct from array['delete', 'insert', 'select'] then
      raise exception '%: service_role must have exactly SELECT, INSERT and DELETE', v_tbl;
    end if;
  end loop;

  -- §3.5 / §3.7: derived tables carry no foreign key to transactions or accounts.
  if exists (select 1 from pg_constraint c
             where c.contype = 'f'
               and c.conrelid in ('public.card_payment_leg_states'::regclass, 'public.card_payment_auto_pairs'::regclass,
                                  'public.card_payment_decision_states'::regclass, 'public.card_payment_eval_versions'::regclass)
               and c.confrelid in ('public.transactions'::regclass, 'public.accounts'::regclass)) then
    raise exception 'a derived card-payment table references a data row';
  end if;
  -- Decisions reference accounts only, never transactions.
  if exists (select 1 from pg_constraint c where c.contype = 'f' and c.conrelid = 'public.card_payment_decisions'::regclass
             and c.confrelid = 'public.transactions'::regclass) then
    raise exception 'card_payment_decisions must not reference transactions';
  end if;

  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             where has_sequence_privilege(r.role, 'public.card_payment_decisions_seq', 'usage')
                or has_sequence_privilege(r.role, 'public.card_payment_decisions_seq', 'update'))
     or not has_sequence_privilege('service_role', 'public.card_payment_decisions_seq', 'usage') then
    raise exception 'card_payment_decisions_seq privileges are wrong';
  end if;
end;
$$;
