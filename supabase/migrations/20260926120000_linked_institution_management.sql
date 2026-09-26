-- Linked Institution Management V1: connection lifecycle statuses and destructive institution removal.
--
-- Additive only: two nullable columns and a status CHECK on plaid_items, a trigger, one new table and
-- seven new functions. No existing row is modified. Apply BEFORE deploying the backend that calls these
-- functions; the current backend only ever writes 'active' / 'login_required' / 'credential_error',
-- all of which the new CHECK allows, and never writes 'removing', so the trigger is inert for it.
--
-- ---- Connection lifecycle (plaid_items.status) ---------------------------------------------------
--   active              syncing normally
--   login_required      the bank needs the user to sign in again (Update Mode)
--   pending_expiration  PENDING_EXPIRATION / PENDING_DISCONNECT: still syncing, reconnect soon
--                       (consent_expires_at, when Plaid gives one)
--   credential_error    this app could not read its stored token (not a bank problem)
--   permission_revoked  USER_PERMISSION_REVOKED: syncing stops, data is kept; Update Mode may restore it
--   removing            a removal operation (plaid_item_removals) owns this item. Terminal: the row
--                       only ever leaves it by being deleted by remove_plaid_item_local.
-- The backend enforces the ordinary transitions with conditional updates (dataService.setItemStatus).
-- plaid_items_keep_removing is the database backstop: an UPDATE can never take a row out of
-- 'removing' (a sync that was already running when removal began ends by writing 'active'; that
-- write keeps 'removing' instead of silently re-enabling the item).
--
-- ---- Removal operation (plaid_item_removals.status) ----------------------------------------------
--   requested      begin_plaid_item_removal: the user confirmed a preview whose digest still matches;
--                  the item is 'removing' (same transaction). Retry: call Plaid /item/remove again.
--   plaid_removed  Plaid confirmed the removal, or answered ITEM_NOT_FOUND (the Item no longer
--                  exists there). Retry: local cleanup only; Plaid is never called again.
--   cleaned        remove_plaid_item_local restored every manual-loan balance by its recorded
--                  applied amount and deleted the item (and, by cascade, its accounts, transactions,
--                  splits, recurring streams and liability records) in ONE transaction. Terminal.
--                  reconciled_at stays null until the backend's post-commit follow-ups (relational
--                  repair, forward reconciliation, today's net-worth snapshot) finish.
-- Local data is deleted only from plaid_removed: never before Plaid has confirmed the Item is gone.
-- A failed Plaid attempt is not a state: it stays `requested` with its outcome recorded
-- (last_outcome retryable | needs_attention), because the only permitted next step is the same.
-- There is no cancellation: once requested, an operation is resumed, never reset.
-- One operation per item, ever (unique item_id). The row outlives the item, so item_id has no FK.
-- No Plaid token of any kind is stored here.
--
-- ---- Restoration invariant ------------------------------------------------------------------------
-- Every manual-loan balance change a linked transaction made is recorded exactly in
-- transactions.loan_balance_applied (20260924130000). Cleanup restores, per loan, the sum of that
-- column over every linked transaction of the item at cleanup time: whatever those rows took, they
-- give back — including both a pending and a posted row if both were linked. A linked row without a
-- recorded amount, or one linked to a loan that is not this user's, makes begin refuse before
-- anything exists or reaches Plaid (plaid_item_removal_blocker), and cleanup refuse again as defense
-- in depth (fail closed): nothing is removed at Plaid and nothing is deleted locally.
--
-- Every function: SECURITY INVOKER, search_path pinned empty, the per-user advisory lock every other
-- balance- or sync-affecting writer takes, executable by service_role only. The table: service_role
-- only, SELECT + INSERT + column-level UPDATE of the lifecycle columns, no DELETE (a permanent record).
--
-- Rollback (only after reverting the backend to a build that does not call these functions):
--   drop function public.mark_plaid_item_removal_reconciled(uuid, uuid);
--   drop function public.remove_plaid_item_local(uuid, uuid);
--   drop function public.record_plaid_item_removal_attempt(uuid, uuid, text, text);
--   drop function public.begin_plaid_item_removal(uuid, uuid, text);
--   drop function public.preview_plaid_item_removal(uuid, uuid);
--   drop function public.plaid_item_removal_digest(uuid, uuid);
--   drop function public.plaid_item_removal_blocker(uuid, uuid);
--   drop table public.plaid_item_removals;
--   drop trigger plaid_items_keep_removing on public.plaid_items;
--   drop function public.plaid_items_keep_removing();
--   update public.plaid_items set status = 'active' where status not in ('active', 'login_required', 'credential_error');
--     (only if no item is 'removing'; a removing item must be finished first)
--   alter table public.plaid_items drop constraint plaid_items_status_check,
--     drop column consent_expires_at, drop column last_synced_at;

-- ---- plaid_items ---------------------------------------------------------------------------------

alter table public.plaid_items
  add column consent_expires_at timestamp with time zone null,
  add column last_synced_at timestamp with time zone null,
  add constraint plaid_items_status_check
    check (status in ('active', 'login_required', 'pending_expiration', 'credential_error', 'permission_revoked', 'removing'));

comment on column public.plaid_items.consent_expires_at is
  'When Plaid said this Item''s access consent expires (PENDING_EXPIRATION). Cleared by a successful reconnect.';
comment on column public.plaid_items.last_synced_at is
  'When this Item''s transactions last synced successfully.';

create function public.plaid_items_keep_removing() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Silently keep 'removing' rather than raising: the writers this stops are ordinary status updates
  -- racing a removal (a sync finishing with 'active', a failed sync writing 'login_required'); failing
  -- them would fail an unrelated sync request, while keeping the status is exactly the intent.
  if old.status = 'removing' and new.status is distinct from 'removing' then
    new.status := 'removing';
  end if;
  return new;
end;
$$;

create trigger plaid_items_keep_removing
  before update of status on public.plaid_items
  for each row execute function public.plaid_items_keep_removing();

-- ---- plaid_item_removals -------------------------------------------------------------------------

create table public.plaid_item_removals (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users(id) on delete cascade,
  -- No FK: the operation outlives the item it deleted.
  item_id           uuid        not null unique,
  -- Plaid's own Item identifier (not a credential), kept for support/diagnosis after the item is gone.
  plaid_item_id     text        not null,
  institution_name  text        null,
  status_before     text        not null,
  status            text        not null default 'requested'
                                check (status in ('requested', 'plaid_removed', 'cleaned')),
  preview_digest    text        not null,
  attempts          integer     not null default 0 check (attempts >= 0),
  last_attempt_at   timestamp with time zone null,
  last_outcome      text        null check (last_outcome in ('retryable', 'needs_attention')),
  last_error_code   text        null,
  plaid_outcome     text        null check (plaid_outcome in ('removed', 'already_removed')),
  loan_adjustments  jsonb       null,
  deleted_counts    jsonb       null,
  requested_at      timestamp with time zone not null default now(),
  plaid_removed_at  timestamp with time zone null,
  cleaned_at        timestamp with time zone null,
  reconciled_at     timestamp with time zone null,
  -- Every status fixes exactly which lifecycle fields are set, so no inconsistent row can exist:
  --   requested      nothing past the request; last_outcome may record a failed Plaid attempt
  --   plaid_removed  Plaid's answer recorded; nothing local yet
  --   cleaned        everything recorded; reconciled_at once the follow-ups finished
  constraint plaid_item_removals_state_check check (
    (status = 'requested'
      and plaid_removed_at is null and plaid_outcome is null and cleaned_at is null
      and loan_adjustments is null and deleted_counts is null and reconciled_at is null)
    or (status = 'plaid_removed'
      and plaid_removed_at is not null and plaid_outcome is not null and cleaned_at is null
      and loan_adjustments is null and deleted_counts is null and reconciled_at is null
      and last_outcome is null)
    or (status = 'cleaned'
      and plaid_removed_at is not null and plaid_outcome is not null and cleaned_at is not null
      and loan_adjustments is not null and deleted_counts is not null and last_outcome is null)
  ),
  constraint plaid_item_removals_result_shape_check check (
    (loan_adjustments is null or jsonb_typeof(loan_adjustments) = 'array')
    and (deleted_counts is null or jsonb_typeof(deleted_counts) = 'object')
  ),
  constraint plaid_item_removals_order_check check (
    (plaid_removed_at is null or plaid_removed_at >= requested_at)
    and (cleaned_at is null or cleaned_at >= plaid_removed_at)
    and (reconciled_at is null or reconciled_at >= cleaned_at)
  )
);

create index plaid_item_removals_user_id_idx on public.plaid_item_removals (user_id);

comment on table public.plaid_item_removals is
  'One destructive institution-removal operation per Plaid item (Linked Institution Management V1). Outlives the item. Never stores a token.';

alter table public.plaid_item_removals enable row level security;
revoke all on table public.plaid_item_removals from public, anon, authenticated, service_role;
grant select, insert on table public.plaid_item_removals to service_role;
grant update (status, attempts, last_attempt_at, last_outcome, last_error_code, plaid_outcome, loan_adjustments,
              deleted_counts, plaid_removed_at, cleaned_at, reconciled_at)
  on table public.plaid_item_removals to service_role;

-- ---- Functions -----------------------------------------------------------------------------------

-- What a removal would delete and restore, reduced to one comparable value: the item's account ids
-- and every linked transaction's (id, loan, recorded applied amount). An ordinary new, unlinked
-- transaction does not change it (it is simply deleted with the rest); a new or changed loan
-- restoration, or a new account, does. begin_plaid_item_removal refuses a digest that no longer matches,
-- so the user always confirms the restorations that will actually be made.
create function public.plaid_item_removal_digest(p_user_id uuid, p_item_id uuid) returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(sha256(convert_to(
    coalesce((select string_agg(a.id::text, ',' order by a.id)
              from public.accounts a
              join public.plaid_items pi on pi.id = a.item_id
              where a.item_id = p_item_id and pi.user_id = p_user_id), '')
    || '|' ||
    coalesce((select string_agg(t.id::text || ':' || t.manual_loan_id::text || ':' || coalesce(t.loan_balance_applied::text, 'null'),
                                ',' order by t.id)
              from public.transactions t
              join public.accounts a on a.id = t.account_id
              join public.plaid_items pi on pi.id = a.item_id
              where a.item_id = p_item_id and pi.user_id = p_user_id and t.manual_loan_id is not null), ''),
    'UTF8')), 'hex');
$$;

-- Why local cleanup of this item could not run, or null when it could. Evaluated over EVERY linked
-- transaction of the item's accounts — deliberately with no join that filters by the loan's owner, so
-- no malformed row can be hidden:
--   manual_loan_ownership_mismatch       a transaction of this user's item is linked to a manual loan
--                                         that is not this user's (or no longer exists) — cleanup
--                                         refuses to touch another user's loan
--   manual_loan_reconciliation_required  a linked transaction has no recorded applied amount, so its
--                                         restoration cannot be exact
-- preview reports it; begin refuses on it under the per-user lock, before the operation exists, the
-- item is marked removing, or anything is sent to Plaid; the backend re-checks it before every Plaid
-- attempt. So no operation reaches plaid_removed while its cleanup is already known to be impossible.
-- Neither condition can be created through this schema's own write paths (the link functions check
-- ownership and record the amount), so both mean data was written some other way; the codes never
-- name another user's rows.
create function public.plaid_item_removal_blocker(p_user_id uuid, p_item_id uuid) returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when exists (select 1 from public.transactions t
                 join public.accounts a on a.id = t.account_id
                 left join public.manual_loans ml on ml.id = t.manual_loan_id
                 where a.item_id = p_item_id and t.manual_loan_id is not null
                   and (ml.id is null or ml.user_id is distinct from p_user_id))
      then 'manual_loan_ownership_mismatch'
    when exists (select 1 from public.transactions t
                 join public.accounts a on a.id = t.account_id
                 where a.item_id = p_item_id and t.manual_loan_id is not null and t.loan_balance_applied is null)
      then 'manual_loan_reconciliation_required'
  end;
$$;

-- Read-only: what removing this item would do. Null when the item does not exist for this user.
create function public.preview_plaid_item_removal(p_user_id uuid, p_item_id uuid) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_item record;
begin
  select pi.id, pi.status, pi.institution_name into v_item
  from public.plaid_items pi
  where pi.id = p_item_id and pi.user_id = p_user_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'item_id', v_item.id,
    'institution_name', v_item.institution_name,
    'status', v_item.status,
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'mask', a.mask, 'type', a.type, 'subtype', a.subtype)
                       order by a.name, a.id)
      from public.accounts a where a.item_id = p_item_id), '[]'::jsonb),
    'counts', jsonb_build_object(
      'accounts', (select count(*) from public.accounts a where a.item_id = p_item_id),
      'transactions', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                       where a.item_id = p_item_id),
      'linked_transactions', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                              where a.item_id = p_item_id and t.manual_loan_id is not null),
      'splits', (select count(*) from public.transaction_splits s join public.transactions t on t.id = s.transaction_id
                 join public.accounts a on a.id = t.account_id where a.item_id = p_item_id),
      'recurring_streams', (select count(*) from public.recurring_streams r where r.item_id = p_item_id),
      'liabilities', (select count(*) from public.loans l where l.item_id = p_item_id)),
    'loan_restorations', coalesce((
      select jsonb_agg(jsonb_build_object(
               'loan_id', x.loan_id, 'loan_name', ml.name, 'linked_transactions', x.linked,
               'restore_amount', x.restore, 'current_balance', ml.current_balance,
               'balance_after', ml.current_balance + x.restore) order by x.loan_id)
      from (select t.manual_loan_id as loan_id, count(*) as linked, sum(t.loan_balance_applied) as restore
            from public.transactions t join public.accounts a on a.id = t.account_id
            where a.item_id = p_item_id and t.manual_loan_id is not null
            group by t.manual_loan_id) x
      join public.manual_loans ml on ml.id = x.loan_id and ml.user_id = p_user_id), '[]'::jsonb),
    -- Linked rows without a recorded applied amount: removal would be refused (fail closed).
    'unrestorable_links', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                           where a.item_id = p_item_id and t.manual_loan_id is not null and t.loan_balance_applied is null),
    -- Linked rows whose loan is not this user's: removal would be refused (fail closed). Counted
    -- without revealing anything about that loan (loan_restorations above lists only this user's).
    'ownership_mismatch_links', (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
                                 left join public.manual_loans ml on ml.id = t.manual_loan_id
                                 where a.item_id = p_item_id and t.manual_loan_id is not null
                                   and (ml.id is null or ml.user_id is distinct from p_user_id)),
    'blocker', public.plaid_item_removal_blocker(p_user_id, p_item_id),
    'digest', public.plaid_item_removal_digest(p_user_id, p_item_id));
end;
$$;

-- Starts the removal (or returns the existing operation: one per item, resumed, never restarted).
-- Returns {outcome: started | existing | not_found | connection_needs_attention | preview_stale |
-- manual_loan_reconciliation_required | manual_loan_ownership_mismatch, removal?}.
create function public.begin_plaid_item_removal(p_user_id uuid, p_item_id uuid, p_preview_digest text) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
  v_item record;
  v_blocker text;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select * into v_removal from public.plaid_item_removals where item_id = p_item_id for update;
  if found then
    if v_removal.user_id is distinct from p_user_id then
      return jsonb_build_object('outcome', 'not_found');
    end if;
    return jsonb_build_object('outcome', 'existing', 'removal', to_jsonb(v_removal));
  end if;

  select pi.id, pi.status, pi.plaid_item_id, pi.institution_name into v_item
  from public.plaid_items pi
  where pi.id = p_item_id and pi.user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_item.status = 'removing' then
    raise exception 'begin_plaid_item_removal: item % is removing but has no removal operation', p_item_id;
  end if;
  if v_item.status = 'credential_error' then
    return jsonb_build_object('outcome', 'connection_needs_attention');
  end if;

  -- Fail closed before anything happens at Plaid, while holding the lock every link/unlink/re-price
  -- writer takes: if cleanup could not run (another user's loan, or an unrecorded applied amount),
  -- nothing is created, the item stays as it is, and Plaid is never asked to remove it.
  v_blocker := public.plaid_item_removal_blocker(p_user_id, p_item_id);
  if v_blocker is not null then
    return jsonb_build_object('outcome', v_blocker);
  end if;

  if p_preview_digest is null or p_preview_digest is distinct from public.plaid_item_removal_digest(p_user_id, p_item_id) then
    return jsonb_build_object('outcome', 'preview_stale');
  end if;

  insert into public.plaid_item_removals (user_id, item_id, plaid_item_id, institution_name, status_before, preview_digest)
  values (p_user_id, p_item_id, v_item.plaid_item_id, v_item.institution_name, v_item.status, p_preview_digest)
  returning * into v_removal;

  update public.plaid_items set status = 'removing', updated_at = now() where id = p_item_id;

  return jsonb_build_object('outcome', 'started', 'removal', to_jsonb(v_removal));
end;
$$;

-- Records one Plaid /item/remove attempt. removed / already_removed (ITEM_NOT_FOUND) move the operation
-- to plaid_removed; retryable / needs_attention keep it requested. Idempotent: an operation already past
-- requested is returned unchanged (a concurrent retry got there first).
create function public.record_plaid_item_removal_attempt(p_user_id uuid, p_item_id uuid, p_outcome text, p_error_code text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
begin
  if p_outcome is null or p_outcome not in ('removed', 'already_removed', 'retryable', 'needs_attention') then
    raise exception 'record_plaid_item_removal_attempt: unknown outcome %', p_outcome;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select * into v_removal from public.plaid_item_removals where item_id = p_item_id and user_id = p_user_id for update;
  if not found then
    raise exception 'record_plaid_item_removal_attempt: no removal operation for this user/item';
  end if;
  if v_removal.status <> 'requested' then
    return to_jsonb(v_removal);
  end if;

  if p_outcome in ('removed', 'already_removed') then
    update public.plaid_item_removals
    set status = 'plaid_removed', plaid_outcome = p_outcome, plaid_removed_at = now(),
        attempts = attempts + 1, last_attempt_at = now(), last_outcome = null, last_error_code = p_error_code
    where id = v_removal.id
    returning * into v_removal;
  else
    update public.plaid_item_removals
    set attempts = attempts + 1, last_attempt_at = now(), last_outcome = p_outcome, last_error_code = p_error_code
    where id = v_removal.id
    returning * into v_removal;
  end if;
  return to_jsonb(v_removal);
end;
$$;

-- The atomic local cleanup. Allowed ONLY once Plaid removal is confirmed (plaid_removed). Restores
-- every manual loan by exactly the sum of loan_balance_applied over the item's linked transactions,
-- then deletes the item (cascading to its accounts, transactions, splits, recurring streams and
-- liability records) and records what it did — one transaction, so no partial state is reachable.
-- A replay of a cleaned operation returns the stored result and writes nothing.
create function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
  v_item_status text;
  v_adjustments jsonb;
  v_counts jsonb;
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
  -- access token goes with this row.
  delete from public.plaid_items where id = p_item_id and user_id = p_user_id;

  update public.plaid_item_removals
  set status = 'cleaned', cleaned_at = now(), loan_adjustments = v_adjustments, deleted_counts = v_counts
  where id = v_removal.id;

  return jsonb_build_object('replayed', false, 'loan_adjustments', v_adjustments, 'deleted_counts', v_counts);
end;
$$;

-- The backend's post-commit follow-ups (relational repair, forward reconciliation, today's snapshot)
-- finished for a cleaned operation. Until then, a retried removal reruns them.
create function public.mark_plaid_item_removal_reconciled(p_user_id uuid, p_item_id uuid) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  update public.plaid_item_removals
  set reconciled_at = coalesce(reconciled_at, now())
  where item_id = p_item_id and user_id = p_user_id and status = 'cleaned';
  if not found then
    raise exception 'mark_plaid_item_removal_reconciled: no cleaned removal operation for this user/item';
  end if;
end;
$$;

-- Supabase's default privileges grant EXECUTE on every new function directly to anon/authenticated
-- (see 20260912120000's note): revoke from each role explicitly, not just from PUBLIC.
revoke all on function public.plaid_items_keep_removing() from public, anon, authenticated, service_role;
revoke all on function public.plaid_item_removal_digest(uuid, uuid) from public, anon, authenticated;
revoke all on function public.plaid_item_removal_blocker(uuid, uuid) from public, anon, authenticated;
revoke all on function public.preview_plaid_item_removal(uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_plaid_item_removal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_plaid_item_removal_attempt(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.remove_plaid_item_local(uuid, uuid) from public, anon, authenticated;
revoke all on function public.mark_plaid_item_removal_reconciled(uuid, uuid) from public, anon, authenticated;
grant execute on function public.plaid_item_removal_digest(uuid, uuid) to service_role;
grant execute on function public.plaid_item_removal_blocker(uuid, uuid) to service_role;
grant execute on function public.preview_plaid_item_removal(uuid, uuid) to service_role;
grant execute on function public.begin_plaid_item_removal(uuid, uuid, text) to service_role;
grant execute on function public.record_plaid_item_removal_attempt(uuid, uuid, text, text) to service_role;
grant execute on function public.remove_plaid_item_local(uuid, uuid) to service_role;
grant execute on function public.mark_plaid_item_removal_reconciled(uuid, uuid) to service_role;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
  v_bad text := '';
begin
  foreach v_fn in array array[
    'public.plaid_item_removal_digest(uuid, uuid)',
    'public.plaid_item_removal_blocker(uuid, uuid)',
    'public.preview_plaid_item_removal(uuid, uuid)',
    'public.begin_plaid_item_removal(uuid, uuid, text)',
    'public.record_plaid_item_removal_attempt(uuid, uuid, text, text)',
    'public.remove_plaid_item_local(uuid, uuid)',
    'public.mark_plaid_item_removal_reconciled(uuid, uuid)'
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
    raise exception 'linked institution management functions lack a security property:%', v_bad;
  end if;

  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
             where has_table_privilege(r.role, 'public.plaid_item_removals', p.priv)) then
    raise exception 'plaid_item_removals is accessible to a client role';
  end if;
  if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
             cross join pg_attribute a
             cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
             where a.attrelid = 'public.plaid_item_removals'::regclass and a.attnum > 0 and not a.attisdropped
               and has_column_privilege(r.role, 'public.plaid_item_removals', a.attname, p.priv)) then
    raise exception 'plaid_item_removals has a column privilege for a client role';
  end if;
  if (select array_agg(p.priv order by p.priv)
      from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
      where has_table_privilege('service_role', 'public.plaid_item_removals', p.priv)) is distinct from array['insert', 'select'] then
    raise exception 'plaid_item_removals: service_role must have exactly SELECT and INSERT at table level (no DELETE, TRUNCATE, MAINTAIN, ...)';
  end if;
  if (select array_agg(a.attname::text order by a.attname) from pg_attribute a
      where a.attrelid = 'public.plaid_item_removals'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('service_role', 'public.plaid_item_removals', a.attname, 'update'))
     is distinct from array['attempts', 'cleaned_at', 'deleted_counts', 'last_attempt_at', 'last_error_code', 'last_outcome',
                            'loan_adjustments', 'plaid_outcome', 'plaid_removed_at', 'reconciled_at', 'status'] then
    raise exception 'plaid_item_removals: service_role may UPDATE only the lifecycle columns';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.plaid_item_removals'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_item_removals') then
    raise exception 'plaid_item_removals must have row level security enabled and no policies';
  end if;
  if exists (select 1 from pg_proc p where p.oid = 'public.plaid_items_keep_removing()'::regprocedure
             and (p.prosecdef or p.proconfig is distinct from array['search_path=""']
                  or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) then
    raise exception 'plaid_items_keep_removing lacks a security property';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.plaid_item_removals'::regclass and convalidated
      and conname in ('plaid_item_removals_state_check', 'plaid_item_removals_result_shape_check', 'plaid_item_removals_order_check')) <> 3 then
    raise exception 'plaid_item_removals state constraints are missing or not validated';
  end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'public.plaid_item_removals'::regclass
             and a.attnum > 0 and not a.attisdropped and a.attname like '%token%') then
    raise exception 'plaid_item_removals must never carry a token column';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.plaid_items'::regclass
                 and conname = 'plaid_items_status_check' and convalidated) then
    raise exception 'plaid_items_status_check is missing or not validated';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.plaid_items'::regclass
                 and tgname = 'plaid_items_keep_removing' and tgenabled = 'O') then
    raise exception 'plaid_items_keep_removing trigger is missing or disabled';
  end if;
end
$$;
