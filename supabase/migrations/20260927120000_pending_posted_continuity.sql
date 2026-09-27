-- Pending -> posted transaction continuity (design: PENDING_POSTED_CONTINUITY_DESIGN.md, rev 5, approved).
--
-- Plaid reports most transactions twice: a pending row, then days later a posted row with a new id and
-- a `pending_transaction_id` pointing at the pending one, while the pending row is reported removed.
-- Until now the two were unrelated events, so every correction the user made to the pending row —
-- budget category (including a deliberate clear), approval, splits, manual-loan link, and soon
-- Phase B's role override — was lost when it posted. This migration:
--
--   * records the link (transactions.pending_transaction_id) and carries the user's state across
--     posting through a carry-over record, so it survives every arrival order (same page, posted
--     before the removal, removal before the posting — even in a later sync);
--   * replaces the two-call sync write (batch RPC, then a separate delete RPC) with ONE atomic RPC,
--     apply_synced_transaction_batch_v2, that handles removals, inserts and updates in one
--     transaction under the per-user advisory lock. The old RPCs are kept unchanged so an old
--     backend keeps working during deployment and rollback (design §9);
--   * brings the pending-row mutations that were lock-free direct UPDATEs — category, approval,
--     splits, the category-mapping backfill — under the same lock, as RPCs, so an edit either lands
--     before the posting and is carried, or finds the row gone and is reported (design §6, §8);
--   * protects a deliberately cleared category from being refilled: budget_category_source records
--     who set the category, every new-backend writer stamps budget_category_set_seq from a sequence
--     (guaranteed to differ on every write, unlike now()), and a trigger keeps a user-cleared row at
--     NULL when a writer that does not know the protocol — an old backend's backfill during a
--     rollback — tries to fill it (design §6.2);
--   * creates transactions.user_role_override_at now, so Phase B's migration adds no column and the
--     carry-over can copy it (design §3 P6).
--
-- Additive only: six nullable columns, one sequence, one index, one table, one trigger, five RPCs.
-- No existing function, constraint or row is changed. Every function: SECURITY INVOKER, search_path
-- pinned empty, the per-user advisory lock every balance/sync writer takes, executable by
-- service_role only (the trigger function by no role). Postconditions at the end abort the whole
-- file if any of that does not hold.
--
-- Manual-loan ledger: the carry-over restores the pending row's loan_balance_applied through the
-- existing delete_transactions_and_restore_loan_balances and re-links the posted row through the
-- existing link_transaction_to_manual_loan, so Σ restored = Σ applied holds at every commit and LIM
-- removal / loan deletion keep restoring exactly what was applied.
--
-- Rollback (only if abandoning the feature; never while an old backend may still see 'user' labels):
--   drop trigger transactions_keep_user_cleared_category on public.transactions;
--   drop function public.transactions_keep_user_cleared_category();
--   drop function public.apply_synced_transaction_batch_v2(uuid, jsonb, jsonb, text[]);
--   drop function public.set_transaction_budget_category(uuid, uuid, uuid);
--   drop function public.approve_transaction(uuid, uuid);
--   drop function public.replace_transaction_splits(uuid, uuid, jsonb);
--   drop function public.backfill_category_mapping(uuid, text, uuid);
--   drop table public.transaction_carryovers;
--   drop index public.transactions_pending_transaction_id_idx;
--   alter table public.transactions drop column pending_transaction_id, drop column posted_from_pending_amount,
--     drop column review_note, drop column budget_category_source, drop column budget_category_set_seq;
--   drop sequence public.transactions_budget_category_seq;
--   -- user_role_override_at is NEVER dropped: it is Phase B's user-history column (design §9 row 5).

-- ---- Columns ---------------------------------------------------------------------------------------
alter table public.transactions
  add column pending_transaction_id text null,
  add column posted_from_pending_amount numeric null,
  add column review_note text null,
  add column budget_category_source text null,
  add column budget_category_set_seq bigint null,
  add column user_role_override_at timestamp with time zone null;

alter table public.transactions
  add constraint transactions_budget_category_source_check
    check (budget_category_source is null or budget_category_source in ('mapping', 'user'));

comment on column public.transactions.pending_transaction_id is
  'Plaid id of the pending transaction this posted row replaced (continuity); null when Plaid gave none.';
comment on column public.transactions.posted_from_pending_amount is
  'The pending amount when it differed from the posted amount; null otherwise.';
comment on column public.transactions.review_note is
  'Why continuity (re)set needs_review — amount change, dropped splits, reduced principal, deleted loan; cleared on approve.';
comment on column public.transactions.budget_category_source is
  'Who set budget_category_id: mapping (sync/backfill) or user (category RPC, including a deliberate NULL). Null = unknown (pre-column).';
comment on column public.transactions.budget_category_set_seq is
  'Protocol marker: every new-backend category write takes nextval(transactions_budget_category_seq). A writer that changes budget_category_id without moving it does not know the protocol (see trigger).';
comment on column public.transactions.user_role_override_at is
  'When the user last set or cleared user_role_override (Phase B). Created here for migration ordering.';

create sequence public.transactions_budget_category_seq as bigint;
revoke all on sequence public.transactions_budget_category_seq from public, anon, authenticated;
grant usage, select on sequence public.transactions_budget_category_seq to service_role;

create index transactions_pending_transaction_id_idx
  on public.transactions (pending_transaction_id)
  where pending_transaction_id is not null;

-- ---- Trigger: keep a user-cleared category cleared against a protocol-unaware writer -------------
-- Pins exactly one transition: a 'user'-labelled NULL being filled by a statement that did not move
-- the protocol marker (an old backend's mapping backfill or category endpoint during a rollback).
-- Silent pin rather than RAISE, like plaid_items_keep_removing: a RAISE would fail the old
-- backfill's whole multi-row UPDATE after its mapping was already created. Known, accepted
-- limitation: through an old UI a user cannot re-categorise a row they cleared through the new
-- backend (design §6.2).
create function public.transactions_keep_user_cleared_category() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.budget_category_source = 'user'
     and old.budget_category_id is null
     and new.budget_category_id is not null
     and new.budget_category_set_seq is not distinct from old.budget_category_set_seq then
    new.budget_category_id := null;
  end if;
  return new;
end;
$$;

create trigger transactions_keep_user_cleared_category
  before update of budget_category_id on public.transactions
  for each row execute function public.transactions_keep_user_cleared_category();

-- ---- Carry-over records ----------------------------------------------------------------------------
-- The carry-able state of a removed pending row, kept until the posted row consumes it or it expires
-- (30 days; a declined authorisation never posts). Separate from transactions so no existing query
-- (feeds, aggregates, LIM counts, loan history, digests) can resurrect or double-count a dead row.
create table public.transaction_carryovers (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid not null references auth.users(id) on delete cascade,
  account_id                    uuid not null references public.accounts(id) on delete cascade,
  pending_plaid_transaction_id  text not null unique,
  -- The deleted pending row's uuid: a mutation that arrives after the posting finds the row gone and
  -- resolves what happened through this (design §8; always looked up together with user_id).
  pending_transaction_row_id    uuid not null unique,
  pending_amount                numeric(12,2) not null,
  pending_date                  date not null,
  pending_name                  text null,
  -- The pending row's Plaid category, so backfill_category_mapping can fill an unconsumed
  -- carry-over exactly as it fills a live row of that category (design §6.1).
  pending_plaid_category        text null,
  budget_category_id            uuid null references public.budget_categories(id) on delete set null,
  budget_category_source        text null,
  budget_category_set_seq       bigint null,
  needs_review                  boolean not null,
  user_role_override            text null,
  user_role_override_at         timestamp with time zone null,
  splits                        jsonb null,
  manual_loan_id                uuid null references public.manual_loans(id) on delete set null,
  -- Never nulled by the loan's deletion: lets the posted row's note name the loan (design §5 I5).
  manual_loan_id_snapshot       uuid null,
  manual_loan_name_snapshot     text null,
  principal_portion             numeric null,
  removed_at                    timestamp with time zone not null default now(),
  expires_at                    timestamp with time zone not null,
  consumed_at                   timestamp with time zone null,
  -- Cascade, not set null: a consumed record is an audit row for one posted row, and set null would
  -- violate the CHECK below the moment that row was deleted.
  consumed_by_transaction_id    uuid null references public.transactions(id) on delete cascade,
  constraint transaction_carryovers_consumed_check
    check ((consumed_at is null) = (consumed_by_transaction_id is null)),
  constraint transaction_carryovers_link_check
    check (manual_loan_id is null or principal_portion is not null),
  constraint transaction_carryovers_source_check
    check (budget_category_source is null or budget_category_source in ('mapping', 'user')),
  constraint transaction_carryovers_splits_check
    check (splits is null or jsonb_typeof(splits) = 'array')
);

create index transaction_carryovers_user_expiry_idx on public.transaction_carryovers (user_id, expires_at);
create index transaction_carryovers_account_idx on public.transaction_carryovers (account_id);

alter table public.transaction_carryovers enable row level security;
revoke all on table public.transaction_carryovers from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.transaction_carryovers to service_role;

-- ---- One atomic sync write per page ---------------------------------------------------------------
-- Design §5. Order: R (removals: carry-over for pending rows, then the existing delete/restore),
-- I (inserts, consuming carry-overs), U (updates). A posted row whose pending row is still live
-- (posted arrived before the removal) is handled by treating that pending row as removed in this
-- same page, so one code path — the carry-over record — serves every arrival order.
-- The existing apply_synced_transaction_batch does the validated insert/update work (ownership,
-- duplicates, CAS, counts); this function wraps it and adds only what continuity needs.
create function public.apply_synced_transaction_batch_v2(
  p_user_id uuid,
  p_inserts jsonb,
  p_updates jsonb,
  p_removed_plaid_ids text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inserts jsonb := coalesce(p_inserts, '[]'::jsonb);
  v_removed text[] := coalesce(p_removed_plaid_ids, '{}'::text[]);
  v_live_pending text[];
  v_augmented jsonb;
  v_inserted jsonb;
  v_carried jsonb := '[]'::jsonb;
  v_removed_count integer := 0;
  r record;
  c record;
  v_posted_id uuid;
  v_posted_amount numeric;
  v_sign_flip boolean;
  v_amount_changed boolean;
  v_needs_review boolean;
  v_notes text[];
  v_override text;
  v_override_at timestamp with time zone;
  v_bad_split_categories integer;
  v_principal numeric;
  v_applied numeric;
  v_link_result text;
  v_carry_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  if jsonb_typeof(v_inserts) <> 'array' then
    raise exception 'apply_synced_transaction_batch_v2: p_inserts must be a JSON array';
  end if;

  -- Posted-before-removal: a live pending row named by an insert's pending_transaction_id is brought
  -- through the removal path now, so its ledger effect is undone in this transaction and the later
  -- `removed` for it is a no-op (design §5 I2).
  select array_agg(t.plaid_transaction_id) into v_live_pending
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where pi.user_id = p_user_id
    and t.pending
    and t.plaid_transaction_id in (
      select x.pending_transaction_id
      from jsonb_to_recordset(v_inserts) as x(plaid_transaction_id text, pending_transaction_id text)
      where x.pending_transaction_id is not null
        and not exists (select 1 from public.transactions e where e.plaid_transaction_id = x.plaid_transaction_id)
    );
  if v_live_pending is not null then
    v_removed := v_removed || v_live_pending;
  end if;

  -- R. Removals: write a carry-over for every owned PENDING row, then delete/restore all removed rows
  -- through the existing function (posted rows: plain delete + restore, as today).
  if cardinality(v_removed) > 0 then
    for r in
      select t.id, t.account_id, t.plaid_transaction_id, t.amount, t.date, t.name, t.category,
             t.budget_category_id, t.budget_category_source, t.budget_category_set_seq, t.needs_review,
             t.user_role_override, t.user_role_override_at, t.manual_loan_id, t.principal_portion,
             ml.name as loan_name
      from public.transactions t
      join public.accounts a on a.id = t.account_id
      join public.plaid_items pi on pi.id = a.item_id
      left join public.manual_loans ml on ml.id = t.manual_loan_id
      where pi.user_id = p_user_id
        and t.pending
        and t.plaid_transaction_id = any(v_removed)
      for update of t
    loop
      insert into public.transaction_carryovers (
        user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id, pending_amount,
        pending_date, pending_name, pending_plaid_category, budget_category_id, budget_category_source,
        budget_category_set_seq, needs_review, user_role_override, user_role_override_at, splits,
        manual_loan_id, manual_loan_id_snapshot, manual_loan_name_snapshot, principal_portion, expires_at)
      values (
        p_user_id, r.account_id, r.plaid_transaction_id, r.id, r.amount, r.date, r.name, r.category,
        r.budget_category_id, r.budget_category_source, r.budget_category_set_seq, r.needs_review,
        r.user_role_override, r.user_role_override_at,
        (select jsonb_agg(jsonb_build_object('budget_category_id', s.budget_category_id, 'amount', s.amount, 'note', s.note)
                          order by s.created_at, s.id)
         from public.transaction_splits s where s.transaction_id = r.id),
        r.manual_loan_id, r.manual_loan_id, r.loan_name, r.principal_portion, now() + interval '30 days')
      on conflict (pending_plaid_transaction_id) do nothing;
    end loop;

    select count(*) into v_removed_count
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items pi on pi.id = a.item_id
    where pi.user_id = p_user_id and t.plaid_transaction_id = any(v_removed);

    perform public.delete_transactions_and_restore_loan_balances(p_user_id, v_removed);
  end if;

  -- I. Inserts: the carry-over decides the inserted budget category (copied EXACTLY, including NULL —
  -- design §5 I3, C6) and the initial review state; everything else is applied after the insert.
  select coalesce(jsonb_agg(
    case when cv.id is null then x.row
         else x.row || jsonb_build_object(
           'budget_category_id', cv.budget_category_id,
           'needs_review', (cv.needs_review or cv.pending_amount <> (x.row->>'amount')::numeric))
    end), '[]'::jsonb)
  into v_augmented
  from (select e as row from jsonb_array_elements(v_inserts) e) x
  -- alias cv, not c: plpgsql would otherwise read the (not yet assigned) record variable c here
  left join public.transaction_carryovers cv
    on cv.user_id = p_user_id
   and cv.consumed_at is null
   and cv.expires_at > now()
   and cv.pending_plaid_transaction_id = x.row->>'pending_transaction_id';

  v_inserted := public.apply_synced_transaction_batch(p_user_id, v_augmented, coalesce(p_updates, '[]'::jsonb));

  -- Post-insert: link, label, carry, consume.
  for r in
    select x.plaid_transaction_id, x.pending_transaction_id, t.id as posted_id, t.amount as posted_amount,
           t.budget_category_id as posted_category
    from jsonb_to_recordset(v_inserts) as x(plaid_transaction_id text, pending_transaction_id text)
    join public.transactions t on t.plaid_transaction_id = x.plaid_transaction_id
    where t.id in (select (e->>'id')::uuid from jsonb_array_elements(coalesce(v_inserted, '[]'::jsonb)) e)
  loop
    v_posted_id := r.posted_id;
    v_posted_amount := r.posted_amount;

    select * into c
    from public.transaction_carryovers k
    where k.user_id = p_user_id
      and k.consumed_at is null
      and k.expires_at > now()
      and k.pending_plaid_transaction_id = r.pending_transaction_id
    for update;

    if not found then
      -- New row (or Plaid did not link it, or the carry-over expired): record the id for the UI and
      -- label a mapping-derived category.
      update public.transactions
      set pending_transaction_id = r.pending_transaction_id,
          budget_category_source = case when r.posted_category is not null then 'mapping' end,
          budget_category_set_seq = case when r.posted_category is not null then nextval('public.transactions_budget_category_seq') end
      where id = v_posted_id;
      continue;
    end if;

    v_notes := '{}'::text[];
    v_amount_changed := c.pending_amount <> v_posted_amount;
    v_sign_flip := (c.pending_amount > 0) <> (v_posted_amount > 0);
    v_needs_review := c.needs_review or v_amount_changed;

    if v_amount_changed then
      v_notes := array_append(v_notes, format('Amount changed from %s to %s', to_char(c.pending_amount, 'FM9999999990.00'), to_char(v_posted_amount, 'FM9999999990.00')));
    end if;

    v_override := c.user_role_override;
    v_override_at := c.user_role_override_at;
    if v_sign_flip and v_override is not null then
      v_override := null;
      v_override_at := null;
      v_needs_review := true;
      v_notes := array_append(v_notes, 'Sign changed between pending and posted; the role correction was not carried over');
    end if;

    -- Splits: re-created only when the amount is unchanged AND every category still exists and is
    -- the user's; otherwise dropped whole (never scaled, never partial).
    if c.splits is not null and jsonb_array_length(c.splits) > 0 then
      select count(*) into v_bad_split_categories
      from jsonb_to_recordset(c.splits) as s(budget_category_id uuid)
      left join public.budget_categories bc on bc.id = s.budget_category_id and bc.user_id = p_user_id
      where bc.id is null;

      if v_amount_changed then
        v_needs_review := true;
        v_notes := array_append(v_notes, 'splits removed');
      elsif v_bad_split_categories > 0 then
        v_needs_review := true;
        v_notes := array_append(v_notes, 'A category used by this transaction''s splits was deleted; splits removed');
      else
        insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
        select v_posted_id, s.budget_category_id, s.amount, s.note
        from jsonb_to_recordset(c.splits) as s(budget_category_id uuid, amount numeric, note text);
      end if;
    end if;

    update public.transactions
    set pending_transaction_id = r.pending_transaction_id,
        posted_from_pending_amount = case when v_amount_changed then c.pending_amount end,
        budget_category_source = c.budget_category_source,
        budget_category_set_seq = c.budget_category_set_seq,
        user_role_override = v_override,
        user_role_override_at = v_override_at
    where id = v_posted_id;

    -- Loan link: only if the loan still exists, the posted row is a positive outflow and the sign did
    -- not flip. principal' = least(principal, amount) (C3); the link function clamps what it applies
    -- to the remaining balance and records that as loan_balance_applied (K12).
    if c.manual_loan_id is not null then
      if v_sign_flip or v_posted_amount <= 0 then
        v_needs_review := true;
        v_notes := array_append(v_notes, 'Sign changed between pending and posted; the loan payment link was not carried over');
      else
        v_principal := least(c.principal_portion, v_posted_amount);
        v_link_result := public.link_transaction_to_manual_loan(p_user_id, v_posted_id, c.manual_loan_id, v_principal, 1::smallint);
        if v_link_result <> 'linked' then
          raise exception 'apply_synced_transaction_batch_v2: re-linking posted row % to loan % returned %', v_posted_id, c.manual_loan_id, v_link_result;
        end if;
        if v_principal < c.principal_portion then
          v_needs_review := true;
          v_notes := array_append(v_notes, format('Principal reduced from %s to %s (posted amount %s)',
            to_char(c.principal_portion, 'FM9999999990.00'), to_char(v_principal, 'FM9999999990.00'), to_char(v_posted_amount, 'FM9999999990.00')));
        end if;
        select loan_balance_applied into v_applied from public.transactions where id = v_posted_id;
        if v_applied < v_principal then
          v_needs_review := true;
          v_notes := array_append(v_notes, format('Only %s of the %s principal could be applied; the loan balance reached 0',
            to_char(v_applied, 'FM9999999990.00'), to_char(v_principal, 'FM9999999990.00')));
        end if;
      end if;
    elsif c.manual_loan_id_snapshot is not null then
      v_needs_review := true;
      v_notes := array_append(v_notes, format('Its loan ''%s'' was deleted before this posted; the payment is no longer linked',
        coalesce(c.manual_loan_name_snapshot, c.manual_loan_id_snapshot::text)));
    end if;

    update public.transactions
    set needs_review = v_needs_review,
        review_note = case when cardinality(v_notes) > 0 then array_to_string(v_notes, '; ') end
    where id = v_posted_id;

    update public.transaction_carryovers
    set consumed_at = now(), consumed_by_transaction_id = v_posted_id
    where id = c.id;

    v_carry_count := v_carry_count + 1;
    v_carried := v_carried || jsonb_build_object('posted_id', v_posted_id, 'pending_plaid_id', c.pending_plaid_transaction_id,
      'notes', to_jsonb(v_notes));
  end loop;

  return jsonb_build_object('inserted', coalesce(v_inserted, '[]'::jsonb), 'carried', v_carried,
                            'carried_count', v_carry_count, 'removed', v_removed_count);
end;
$$;

-- ---- Pending-row mutations under the lock (design §6) ---------------------------------------------
create function public.set_transaction_budget_category(
  p_user_id uuid,
  p_transaction_id uuid,
  p_budget_category_id uuid
) returns public.transactions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.transactions;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.* into v_row
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id and pi.user_id = p_user_id
  for update of t, a, pi;
  if not found then
    raise exception 'transaction_not_found: set_transaction_budget_category: transaction % not found or not owned by user', p_transaction_id;
  end if;

  if p_budget_category_id is not null
     and not exists (select 1 from public.budget_categories bc where bc.id = p_budget_category_id and bc.user_id = p_user_id) then
    raise exception 'budget_category_not_found: set_transaction_budget_category: budget category % not found or not owned by user', p_budget_category_id;
  end if;

  update public.transactions
  set budget_category_id = p_budget_category_id,
      budget_category_source = 'user',
      budget_category_set_seq = nextval('public.transactions_budget_category_seq')
  where id = p_transaction_id
  returning * into v_row;
  return v_row;
end;
$$;

create function public.approve_transaction(
  p_user_id uuid,
  p_transaction_id uuid
) returns public.transactions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.transactions;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select t.* into v_row
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id and pi.user_id = p_user_id
  for update of t, a, pi;
  if not found then
    raise exception 'transaction_not_found: approve_transaction: transaction % not found or not owned by user', p_transaction_id;
  end if;

  update public.transactions
  set needs_review = false, review_note = null
  where id = p_transaction_id
  returning * into v_row;
  return v_row;
end;
$$;

-- Replaces the application's delete-then-insert (which could leave a row with no splits if the insert
-- failed after the delete). Σ amounts must equal the row's amount to the cent, with the row's sign;
-- an empty array clears. Phase B later replaces this body to add its role-eligibility check.
create function public.replace_transaction_splits(
  p_user_id uuid,
  p_transaction_id uuid,
  p_splits jsonb
) returns setof public.transaction_splits
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_amount numeric;
  v_total numeric;
  v_count integer;
  v_bad integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  if p_splits is null or jsonb_typeof(p_splits) <> 'array' then
    raise exception 'splits_invalid: replace_transaction_splits: p_splits must be a JSON array';
  end if;

  select t.amount into v_amount
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items pi on pi.id = a.item_id
  where t.id = p_transaction_id and pi.user_id = p_user_id
  for update of t, a, pi;
  if not found then
    raise exception 'transaction_not_found: replace_transaction_splits: transaction % not found or not owned by user', p_transaction_id;
  end if;

  v_count := jsonb_array_length(p_splits);
  if v_count > 0 then
    select count(*) into v_bad
    from jsonb_to_recordset(p_splits) as s(budget_category_id uuid, amount numeric)
    left join public.budget_categories bc on bc.id = s.budget_category_id and bc.user_id = p_user_id
    where bc.id is null
       or s.amount is null
       or not (s.amount > -'Infinity'::numeric and s.amount < 'Infinity'::numeric);
    if v_bad > 0 then
      raise exception 'splits_invalid: replace_transaction_splits: % split(s) reference a budget category not owned by this user or carry a non-finite amount', v_bad;
    end if;

    select round(sum(s.amount), 2) into v_total
    from jsonb_to_recordset(p_splits) as s(amount numeric);
    if v_total is distinct from round(v_amount, 2) then
      raise exception 'splits_unbalanced: replace_transaction_splits: splits must add up to the transaction''s amount (%)', to_char(v_amount, 'FM9999999990.00');
    end if;
  end if;

  delete from public.transaction_splits where transaction_id = p_transaction_id;

  if v_count > 0 then
    return query
      insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
      select p_transaction_id, s.budget_category_id, s.amount, s.note
      from jsonb_to_recordset(p_splits) as s(budget_category_id uuid, amount numeric, note text)
      returning *;
  end if;
  return;
end;
$$;

-- Replaces the lock-free select-then-UPDATE backfill (design §6.1): skips every user-cleared row,
-- labels what it fills, and also fills matching unconsumed carry-overs so a removed-not-yet-posted
-- row receives the mapping exactly as a live one would.
create function public.backfill_category_mapping(
  p_user_id uuid,
  p_plaid_category text,
  p_budget_category_id uuid
) returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  if p_plaid_category is null or p_budget_category_id is null then
    raise exception 'backfill_category_mapping: plaid category and budget category are required';
  end if;
  if not exists (select 1 from public.budget_categories bc where bc.id = p_budget_category_id and bc.user_id = p_user_id) then
    raise exception 'budget_category_not_found: backfill_category_mapping: budget category % not found or not owned by user', p_budget_category_id;
  end if;

  update public.transactions t
  set budget_category_id = p_budget_category_id,
      budget_category_source = 'mapping',
      budget_category_set_seq = nextval('public.transactions_budget_category_seq')
  from public.accounts a
  join public.plaid_items pi on pi.id = a.item_id
  where t.account_id = a.id
    and pi.user_id = p_user_id
    and t.category = p_plaid_category
    and t.budget_category_id is null
    and t.budget_category_source is distinct from 'user';
  get diagnostics v_count = row_count;

  update public.transaction_carryovers c
  set budget_category_id = p_budget_category_id,
      budget_category_source = 'mapping',
      budget_category_set_seq = nextval('public.transactions_budget_category_seq')
  where c.user_id = p_user_id
    and c.consumed_at is null
    and c.expires_at > now()
    and c.pending_plaid_category = p_plaid_category
    and c.budget_category_id is null
    and c.budget_category_source is distinct from 'user';

  return v_count;
end;
$$;

-- ---- Privileges -------------------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated: revoke
-- from each role explicitly, not just from PUBLIC.
revoke all on function public.transactions_keep_user_cleared_category() from public, anon, authenticated, service_role;
revoke all on function public.apply_synced_transaction_batch_v2(uuid, jsonb, jsonb, text[]) from public, anon, authenticated;
revoke all on function public.set_transaction_budget_category(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.approve_transaction(uuid, uuid) from public, anon, authenticated;
revoke all on function public.replace_transaction_splits(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.backfill_category_mapping(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.apply_synced_transaction_batch_v2(uuid, jsonb, jsonb, text[]) to service_role;
grant execute on function public.set_transaction_budget_category(uuid, uuid, uuid) to service_role;
grant execute on function public.approve_transaction(uuid, uuid) to service_role;
grant execute on function public.replace_transaction_splits(uuid, uuid, jsonb) to service_role;
grant execute on function public.backfill_category_mapping(uuid, text, uuid) to service_role;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
  v_bad text := '';
begin
  foreach v_fn in array array[
    'public.apply_synced_transaction_batch_v2(uuid, jsonb, jsonb, text[])',
    'public.set_transaction_budget_category(uuid, uuid, uuid)',
    'public.approve_transaction(uuid, uuid)',
    'public.replace_transaction_splits(uuid, uuid, jsonb)',
    'public.backfill_category_mapping(uuid, text, uuid)'
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
  if v_bad <> '' then
    raise exception 'pending-posted continuity functions lack a security property:%', v_bad;
  end if;

  if exists (select 1 from pg_proc p where p.oid = 'public.transactions_keep_user_cleared_category()'::regprocedure
             and (p.prosecdef or p.proconfig is distinct from array['search_path=""']
                  or has_function_privilege('public', p.oid, 'execute')
                  or has_function_privilege('anon', p.oid, 'execute')
                  or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))) then
    raise exception 'transactions_keep_user_cleared_category lacks a security property';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.transactions'::regclass
                 and tgname = 'transactions_keep_user_cleared_category' and tgenabled = 'O') then
    raise exception 'transactions_keep_user_cleared_category trigger is missing or disabled';
  end if;

  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
             where has_table_privilege(r.role, 'public.transaction_carryovers', p.priv)) then
    raise exception 'transaction_carryovers is accessible to a client role';
  end if;
  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join pg_attribute a
             cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
             where a.attrelid = 'public.transaction_carryovers'::regclass and a.attnum > 0 and not a.attisdropped
               and has_column_privilege(r.role, 'public.transaction_carryovers', a.attname, p.priv)) then
    raise exception 'transaction_carryovers has a column privilege for a client role';
  end if;
  if (select array_agg(p.priv order by p.priv)
      from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
      where has_table_privilege('service_role', 'public.transaction_carryovers', p.priv))
     is distinct from array['delete', 'insert', 'select', 'update'] then
    raise exception 'transaction_carryovers: service_role must have exactly SELECT, INSERT, UPDATE and DELETE';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.transaction_carryovers'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'transaction_carryovers') then
    raise exception 'transaction_carryovers must have row level security enabled and no policies';
  end if;

  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             where has_sequence_privilege(r.role, 'public.transactions_budget_category_seq', 'usage')
                or has_sequence_privilege(r.role, 'public.transactions_budget_category_seq', 'update'))
     or not has_sequence_privilege('service_role', 'public.transactions_budget_category_seq', 'usage') then
    raise exception 'transactions_budget_category_seq privileges are wrong';
  end if;

  if (select count(*) from information_schema.columns
      where table_schema = 'public' and table_name = 'transactions'
        and column_name in ('pending_transaction_id', 'posted_from_pending_amount', 'review_note',
                            'budget_category_source', 'budget_category_set_seq', 'user_role_override_at')) <> 6 then
    raise exception 'transactions is missing a continuity column';
  end if;

  -- The old sync RPCs must be untouched: an old backend keeps calling them during deployment/rollback.
  if to_regprocedure('public.apply_synced_transaction_batch(uuid, jsonb, jsonb)') is null
     or to_regprocedure('public.delete_transactions_and_restore_loan_balances(uuid, text[])') is null then
    raise exception 'the pre-existing sync RPCs must remain';
  end if;
end;
$$;
