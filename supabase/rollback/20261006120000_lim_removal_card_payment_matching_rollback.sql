-- ROLLBACK for 20261006120000_lim_removal_card_payment_matching.sql. NOT a migration; run by an operator only
-- after approval, as the same role that applies migrations. The file is ONE explicit transaction
-- (begin … commit), so run it without psql's -1:
--   psql -X -v ON_ERROR_STOP=1 -f supabase/rollback/20261006120000_lim_removal_card_payment_matching_rollback.sql
-- Any failure, including a guard or postcondition, aborts it; nothing is half-applied.
--
-- WHAT IT DOES. It re-creates remove_plaid_item_local(uuid, uuid) exactly as
-- 20260926120000_linked_institution_management.sql defined it: verbatim, and checksum-verified below. The
-- signature, SECURITY INVOKER, the pinned search_path and the grants are preserved by CREATE OR REPLACE. No
-- backend change is needed in either direction: the name, arguments and result are the same.
--
-- WHAT IT DOES NOT DO — it changes no data, and it cannot give back what the forward function protected:
--   * It restores nothing a removal deleted, and it does not re-create a pair decision that went with a
--     removed card's account. (Neither does the forward migration: a removal is destructive either way.)
--   * It leaves every decision that a removal wrote while the forward function was installed: the system
--     records (destination_removed_card), the preserved user confirmations (pair_counterpart_removed) and
--     the ambiguity holds. They stay valid and fully understood: this file does not touch the evaluator
--     (20261006110000), which keeps honouring them, so legs already preserved keep reading as they did,
--     stay held, and a tie an earlier removal must not resolve stays unresolved. Deleting those rows would
--     destroy exactly the knowledge they hold, and is not part of this rollback.
--     (Rolling back 20261006110000 as well is a separate step with its own, larger, consequences: see that
--     rollback file.)
--   * AFTER it, institution removal behaves as it did before 20261006120000:
--       - a removal no longer preserves anything. The known destination of a surviving payment to a
--         removed card is LOST with the card's rows, and a user-confirmed pair is deleted with the removed
--         account, releasing the leg that survives to automatic matching. That leg then evaluates from
--         whatever is left (unresolved, another card's tier 1 pair, or no_included_card);
--       - a removal writes no ambiguity hold. A payment that was unresolved because a removed card and a
--         kept card both fitted it is matched automatically to the kept card once the other is deleted;
--       - so what revision 5 added is gone too (Option B, and the excluded accounts). A payment that was
--         matched AUTOMATICALLY to a card of the removed institution gets neither its record nor a hold: if a
--         card leg on a kept card was already there and merely fitted less well, the payment is again
--         SWITCHED to it by automatic matching, solely because its destination was deleted. And an ambiguity
--         that involves a leg on an account excluded from cash flow is again resolved by the deletion;
--       - a removal no longer locks the item's account rows early (it does not need to: it takes the
--         version row only inside its cascade, after them);
--       - a removal no longer evaluates. Its deletes still bump the version through the triggers, so the
--         user is STALE after it — readable as "updating", never as stale figures — until some later
--         evaluation;
--       - a removal no longer depends on the evaluator, on READ COMMITTED or on the TEMP privilege.
--     A removal that was running when this file is applied finishes with the body it started with.
--   * The migration's ledger row in supabase_migrations.schema_migrations is deliberately left alone.
--     Re-applying the forward definition means running the migration file's SQL again (its guard accepts
--     exactly this restored body), not `supabase db push`, which would see the version as applied.
--
-- Guard: refuses unless the current body is exactly the one 20261006120000 installs.

begin;

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> '7997a757408fa888aa44bdbc9d85f89d' then
    raise exception 'remove_plaid_item_local is not the 20261006120000 definition; refusing to roll back';
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

do $$
declare
  v_oid oid := 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_oid) <> 'a8f567d397b9dae5b777497317985ab7' then
    raise exception 'rollback did not restore the 20260926120000 definition exactly';
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
end
$$;

commit;
