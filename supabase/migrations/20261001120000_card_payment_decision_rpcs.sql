-- Card-payment decision RPCs (Phase B slice 2b-1; CARD_PAYMENT_PAIRING_DESIGN.md §3.2–§3.7, §4.3, §8;
-- acceptance tests 20–22). Builds on 20260930120000_card_payment_matching_state.sql, which it does not
-- change.
--
-- DISCONNECTED. Nothing in the application calls these functions yet (no backend route, no frontend).
-- The sync batch and institution removal do not evaluate yet (slice 2b-2), so a user's states are fresh
-- only after a standalone evaluate_card_payments; until then every RPC here refuses with
-- card_payment_stale_version.
--
--   link_card_payment(user, transaction, counterpart, accepted_difference_cents, expected_version)
--       A user pair ("Match", "Match return", "Match with difference", "Choose the matching card
--       transaction"). Manual matching has no distance or $5 limit; a difference must be accepted
--       explicitly and exactly (|cash cents| − |credit cents|, 0 for an exact pair; §4.3).
--   mark_card_payment_destination(user, transaction, expected_version)
--       "It went to a card I haven't linked" — destination_unlinked, on a cash-side leg only. No caller
--       can create the system-only destination_removed_card kind through these RPCs.
--   dismiss_card_payment_candidate(user, transaction, candidate, expected_version)
--       "Not this one" — not_this_pair, one edge. It never claims either leg.
--   undo_card_payment_decision(user, decision, expected_version)
--       Removes one saved user decision (superseded_by := its own id). Undo does not forbid the same pair
--       from forming again through automatic evidence; rejecting a pairing is the dismissal.
--
-- Every RPC, in this order:
--   1. requires READ COMMITTED (every read after the locks then sees every commit before them);
--   2. takes the per-user advisory lock (L1) and the user's version row FOR UPDATE (L2) — the lock order of
--      §3.7. It takes no row lock on transactions. Its decision writes do take the foreign-key checks'
--      KEY SHARE locks on the referenced accounts and auth.users rows (and row locks on the decisions it
--      supersedes). So a LOCK-FREE writer deleting one of those rows (or editing those decisions) while an
--      RPC runs can close a cycle with L2. PostgreSQL detects it and rolls one side back completely —
--      the lock-free-writer class of design §3.7 (concurrency/c22). Writers that take L1 first (the sync
--      batch, LIM removal) are serialized instead;
--   3. refuses unless the caller's expected version is the user's current input_version AND the states
--      were evaluated at exactly that version (fresh). A missing, NULL, stale or otherwise different
--      version never authorizes a write, and the latest server version is never substituted for it. Only
--      an input change advances input_version, so only a real change refuses the action;
--   4. reads its targets under the locks and refuses unknown and foreign-owned targets with the same
--      message (card_payment_not_found) before any target-specific validation;
--   5. validates and writes, or refuses with nothing written;
--   6. evaluates the WHOLE user (try_evaluate_card_payments, in a subtransaction) and returns
--      jsonb: { status, reason, decisionId, supersededDecisionIds, matching, inputVersion,
--      evaluatedVersion, legs | lastErrorCode }.
--        status   'saved' | 'undone' | 'unchanged' (with reason already_confirmed / already_dismissed /
--                 already_undone: nothing was written and nothing evaluated).
--        matching 'fresh'   — the evaluation published the new version; `legs` holds the current states
--                             of the named transactions and of the legs of the decisions it superseded.
--                 'pending' — the decision is SAVED, but the evaluation failed and rolled back alone (or
--                             cannot be read as fresh): no leg states and no figures are returned, and the
--                             user stays stale (lastErrorCode) until a later evaluation succeeds.
--      Response scope: a decision can change legs it does not name (a dissolved tier 1 pair, a freed
--      candidate elsewhere). `legs` is therefore NOT the complete set of changes. A caller holding other
--      states must refresh them through get_card_payment_states and compare its evaluatedVersion.
--      A returned result describes a committed decision only once the surrounding transaction commits
--      (PostgREST runs each RPC call in its own transaction); an outer rollback undoes everything.
--   Refusals raise (prefix: function: detail) so the whole call rolls back and nothing is written:
--      card_payment_requires_read_committed, card_payment_stale_version, card_payment_not_found,
--      card_payment_ineligible (lineage_ambiguous | superseded | not_card_payment | zero_amount),
--      card_payment_invalid (same_transaction | sides_not_opposite | direction_mismatch |
--      difference_not_accepted | not_cash_side | system_decision), card_payment_counterpart_reserved,
--      card_payment_pair_confirmed, card_payment_decision_replaced.
--
-- Targets are named by the transaction ids the client got from get_card_payment_states, then resolved
-- under the locks to their lineage. Decisions store the lineage key (account, Plaid id, cents) as in
-- 2a; overlap with existing decisions is found by resolving each live decision's references with the
-- evaluator's own lineage rule (card_payment_lineage_row), so a reference by a pending id and one by
-- its posted replacement's id are the same leg. A conflicting replacement (several posted rows naming
-- one pending id) is never chosen between: it is refused as lineage_ambiguous.
--
-- Replacement (scoped, never half a pair):
--   * A new pair or destination confirmation supersedes every live affirmative user decision (pair,
--     destination_unlinked — active or inactive) on the transaction the user is resolving, whole: the
--     old pair's other leg is re-evaluated too.
--   * A counterpart held by a DIFFERENT affirmative decision is refused (card_payment_counterpart_reserved)
--     until that decision is undone; no bulk reassignment.
--   * A pair supersedes the dismissals of exactly its own edge, and no other dismissal.
--   * A dismissal supersedes nothing, coexists with any number of dismissals on the same leg, and is
--     refused on the exact edge of a saved pair (undo the pair first).
--   * Only currently non-superseded decisions are superseded; an existing superseded_by pointer is never
--     overwritten.
--   * A system-written destination_removed_card decision is never superseded by a user decision: it ranks
--     below one in the evaluator's precedence and stays as dormant history (design §4.7). Undo refuses it.
-- These rules hold for writes through these RPCs. There is no database constraint preventing an
-- arbitrary service_role statement from writing conflicting decisions; the evaluator keeps treating such
-- externally introduced conflicts conservatively (conflicting_decisions, unresolved).
--
-- superseded_by (documented on the column below): NULL — live; the decision's own id — explicitly
-- undone; another decision's id — replaced by that decision.
--
-- Security: every function SECURITY INVOKER with search_path pinned empty, executable by service_role
-- only. No new table. Postconditions at the end abort the file if any of that does not hold.
--
-- Rollback (nothing depends on these objects yet):
--   drop function public.undo_card_payment_decision(uuid, uuid, bigint);
--   drop function public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint);
--   drop function public.mark_card_payment_destination(uuid, uuid, bigint);
--   drop function public.link_card_payment(uuid, uuid, uuid, bigint, bigint);
--   drop function public.card_payment_decision_result(uuid, text, text, uuid, uuid[], uuid[], boolean);
--   drop function public.card_payment_decision_rows(uuid, uuid[]);
--   drop function public.card_payment_live_decisions(uuid);
--   drop function public.card_payment_lineage_row(uuid, text);
--   drop function public.card_payment_decision_check_leg(boolean, boolean, text, bigint, text);
--   drop function public.card_payment_decision_target(uuid, uuid, text);
--   drop function public.card_payment_decision_begin(uuid, bigint, text);
--   comment on column public.card_payment_decisions.superseded_by is null;

comment on column public.card_payment_decisions.superseded_by is
  'NULL: live. The decision''s own id: explicitly undone (undo_card_payment_decision). Another decision''s id: '
  'replaced by that decision. Never overwritten once set. No foreign key: deleting a replacement never '
  'reactivates this decision.';

-- ---- Shared steps ----------------------------------------------------------------------------------

-- Steps 1–3: READ COMMITTED, L1, L2, and the version check. Raises (nothing written) unless the caller's
-- expected version is the current, freshly evaluated input version.
create function public.card_payment_decision_begin(p_user_id uuid, p_expected_version bigint, p_caller text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_input bigint;
  v_evaluated bigint;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'card_payment_requires_read_committed: %: got %', p_caller, current_setting('transaction_isolation')
      using errcode = '25001';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select v.input_version, v.evaluated_version into v_input, v_evaluated
  from public.card_payment_eval_versions v where v.user_id = p_user_id
  for update;
  if not found or p_expected_version is null or v_evaluated is null
     or v_evaluated <> v_input or p_expected_version <> v_input then
    raise exception 'card_payment_stale_version: %: the matching state changed or is not current; reload it and retry', p_caller;
  end if;
end;
$$;

-- Step 4: one owned transaction, read under the locks, with the evaluator's leg facts. Unknown and
-- foreign-owned ids get the same refusal.
create function public.card_payment_decision_target(p_user_id uuid, p_transaction_id uuid, p_caller text)
returns table (id uuid, account_id uuid, plaid text, pending_of text, cents bigint, credit boolean,
               effective_role text, superseded boolean, conflict boolean)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select t.id, t.account_id, t.plaid_transaction_id, t.pending_transaction_id, (t.amount * 100)::bigint,
         coalesce(a.type = 'credit', false), t.effective_role,
         -- the evaluator's §3.6 rules, on the same account: a pending row named by a posted row is
         -- superseded; posted rows sharing one pending id are conflicting replacements
         exists (select 1 from public.transactions r
                 where r.account_id = t.account_id and r.pending_transaction_id = t.plaid_transaction_id),
         t.pending_transaction_id is not null
           and (select count(*) from public.transactions r
                where r.account_id = t.account_id and r.pending_transaction_id = t.pending_transaction_id) > 1
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items i on i.id = a.item_id
  where t.id = p_transaction_id and i.user_id = p_user_id;
  if not found then
    raise exception 'card_payment_not_found: %: transaction not found', p_caller;
  end if;
end;
$$;

-- A target must be a current, unambiguous card-payment leg (the evaluator's is_leg, not a conflicting
-- replacement).
create function public.card_payment_decision_check_leg(p_superseded boolean, p_conflict boolean, p_role text,
                                                       p_cents bigint, p_caller text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_conflict then
    raise exception 'card_payment_ineligible: %: lineage_ambiguous (more than one posted transaction replaces the same pending one)', p_caller;
  end if;
  if p_superseded then
    raise exception 'card_payment_ineligible: %: superseded (a posted transaction replaces this pending one)', p_caller;
  end if;
  if p_role is distinct from 'credit_card_payment' then
    raise exception 'card_payment_ineligible: %: not_card_payment', p_caller;
  end if;
  if p_cents = 0 then
    raise exception 'card_payment_ineligible: %: zero_amount', p_caller;
  end if;
end;
$$;

-- The current row a decision leg reference names, by the evaluator's §3.6 rule: the unique posted row
-- naming it as its pending id, else the row with that Plaid id — NULL when no row exists (waiting or
-- gone) or when the lineage is ambiguous (several replacements, or one of them named by its own id).
create function public.card_payment_lineage_row(p_account_id uuid, p_plaid text)
returns uuid
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_n integer;
  v_row uuid;
  v_pending_of text;
begin
  select count(*) into v_n from public.transactions t
  where t.account_id = p_account_id and t.pending_transaction_id = p_plaid;
  if v_n > 1 then
    return null;
  elsif v_n = 1 then
    select t.id into v_row from public.transactions t
    where t.account_id = p_account_id and t.pending_transaction_id = p_plaid;
    return v_row;
  end if;
  select t.id, t.pending_transaction_id into v_row, v_pending_of from public.transactions t
  where t.account_id = p_account_id and t.plaid_transaction_id = p_plaid;
  if not found then
    return null;
  end if;
  if v_pending_of is not null
     and (select count(*) from public.transactions r
          where r.account_id = p_account_id and r.pending_transaction_id = v_pending_of) > 1 then
    return null;
  end if;
  return v_row;
end;
$$;

-- The user's live decisions (not superseded; every account still the user's — the evaluator rejects the
-- others), each leg resolved to its current row.
create function public.card_payment_live_decisions(p_user_id uuid)
returns table (decision_id uuid, kind text, row_a uuid, row_b uuid, a_cents bigint, b_cents bigint,
               accepted_difference_cents bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.kind,
         public.card_payment_lineage_row(d.a_account_id, d.a_plaid_transaction_id),
         public.card_payment_lineage_row(d.b_account_id, d.b_plaid_transaction_id),
         d.a_cents, d.b_cents, d.accepted_difference_cents
  from public.card_payment_decisions d
  where d.user_id = p_user_id
    and d.superseded_by is null
    and exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id
                where a.id = d.a_account_id and i.user_id = p_user_id)
    and (d.b_account_id is null
         or exists (select 1 from public.accounts a join public.plaid_items i on i.id = a.item_id
                    where a.id = d.b_account_id and i.user_id = p_user_id))
$$;

-- The user's own current rows that the given decisions' legs resolve to (for the response's `legs`).
create function public.card_payment_decision_rows(p_user_id uuid, p_decision_ids uuid[])
returns uuid[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(distinct q.r), '{}')
  from (select public.card_payment_lineage_row(d.a_account_id, d.a_plaid_transaction_id) as r
        from public.card_payment_decisions d where d.id = any (p_decision_ids) and d.user_id = p_user_id
        union all
        select public.card_payment_lineage_row(d.b_account_id, d.b_plaid_transaction_id)
        from public.card_payment_decisions d where d.id = any (p_decision_ids) and d.user_id = p_user_id) q
  join public.transactions t on t.id = q.r
  join public.accounts a on a.id = t.account_id
  join public.plaid_items i on i.id = a.item_id and i.user_id = p_user_id
$$;

-- Step 6: evaluate the whole user (when something was written) and build the response. Leg states are
-- returned only when the evaluation succeeded and the states read back fresh.
create function public.card_payment_decision_result(p_user_id uuid, p_status text, p_reason text, p_decision_id uuid,
                                                    p_superseded uuid[], p_rows uuid[], p_evaluate boolean)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_evaluated boolean := true;
  v_states jsonb;
begin
  if p_evaluate then
    v_evaluated := public.try_evaluate_card_payments(p_user_id);
  end if;
  v_states := public.get_card_payment_states(p_user_id);
  if v_evaluated and coalesce((v_states->>'fresh')::boolean, false) then
    return jsonb_build_object(
      'status', p_status, 'reason', p_reason, 'decisionId', p_decision_id,
      'supersededDecisionIds', to_jsonb(coalesce(p_superseded, '{}'::uuid[])),
      'matching', 'fresh',
      'inputVersion', v_states->'inputVersion', 'evaluatedVersion', v_states->'evaluatedVersion',
      'legs', (select coalesce(jsonb_agg(l order by l->>'transactionId'), '[]'::jsonb)
               from jsonb_array_elements(v_states->'legs') l
               where (l->>'transactionId')::uuid = any (p_rows)));
  end if;
  return jsonb_build_object(
    'status', p_status, 'reason', p_reason, 'decisionId', p_decision_id,
    'supersededDecisionIds', to_jsonb(coalesce(p_superseded, '{}'::uuid[])),
    'matching', 'pending',
    'inputVersion', v_states->'inputVersion', 'evaluatedVersion', v_states->'evaluatedVersion',
    'lastErrorCode', v_states->'lastErrorCode');
end;
$$;

-- ---- The RPCs ---------------------------------------------------------------------------------------

create function public.link_card_payment(
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

create function public.mark_card_payment_destination(
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

create function public.dismiss_card_payment_candidate(
  p_user_id uuid,
  p_transaction_id uuid,            -- the leg the user is resolving
  p_candidate_transaction_id uuid,  -- the candidate they reject
  p_expected_version bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_s record;
  v_c record;
  v_pair_on_edge boolean;
  v_existing uuid[];
  v_new uuid;
begin
  perform public.card_payment_decision_begin(p_user_id, p_expected_version, 'dismiss_card_payment_candidate');
  select * into v_s from public.card_payment_decision_target(p_user_id, p_transaction_id, 'dismiss_card_payment_candidate');
  select * into v_c from public.card_payment_decision_target(p_user_id, p_candidate_transaction_id, 'dismiss_card_payment_candidate');

  if v_s.id = v_c.id then
    raise exception 'card_payment_invalid: dismiss_card_payment_candidate: same_transaction';
  end if;
  perform public.card_payment_decision_check_leg(v_s.superseded, v_s.conflict, v_s.effective_role, v_s.cents, 'dismiss_card_payment_candidate');
  perform public.card_payment_decision_check_leg(v_c.superseded, v_c.conflict, v_c.effective_role, v_c.cents, 'dismiss_card_payment_candidate');
  -- Only an opposite-side, opposite-direction leg can ever be a candidate.
  if v_s.credit = v_c.credit then
    raise exception 'card_payment_invalid: dismiss_card_payment_candidate: sides_not_opposite';
  end if;
  if sign(v_s.cents::numeric) <> -sign(v_c.cents::numeric) then
    raise exception 'card_payment_invalid: dismiss_card_payment_candidate: direction_mismatch';
  end if;

  -- One pass over the user's live decisions on exactly this edge.
  select coalesce(bool_or(x.kind = 'pair'), false),
         coalesce(array_agg(x.decision_id order by x.decision_id) filter (where x.kind = 'not_this_pair'), '{}')
  into v_pair_on_edge, v_existing
  from public.card_payment_live_decisions(p_user_id) x
  where (x.row_a = v_s.id and x.row_b = v_c.id) or (x.row_a = v_c.id and x.row_b = v_s.id);
  -- A dismissal never supersedes a confirmation: the saved pair on this exact edge must be undone first.
  if v_pair_on_edge then
    raise exception 'card_payment_pair_confirmed: dismiss_card_payment_candidate: these transactions are a saved match; undo the match first';
  end if;
  if cardinality(v_existing) > 0 then
    return public.card_payment_decision_result(p_user_id, 'unchanged', 'already_dismissed', v_existing[1],
                                               '{}', array[v_s.id, v_c.id], false);
  end if;

  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents,
                                             b_account_id, b_plaid_transaction_id, b_cents)
  values (p_user_id, 'not_this_pair', v_s.account_id, v_s.plaid, v_s.cents, v_c.account_id, v_c.plaid, v_c.cents)
  returning id into v_new;

  return public.card_payment_decision_result(p_user_id, 'saved', null, v_new, '{}', array[v_s.id, v_c.id], true);
end;
$$;

create function public.undo_card_payment_decision(
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

-- ---- Privileges ------------------------------------------------------------------------------------
-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated: revoke.
revoke all on function public.card_payment_decision_begin(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.card_payment_decision_target(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.card_payment_decision_check_leg(boolean, boolean, text, bigint, text) from public, anon, authenticated;
revoke all on function public.card_payment_lineage_row(uuid, text) from public, anon, authenticated;
revoke all on function public.card_payment_live_decisions(uuid) from public, anon, authenticated;
revoke all on function public.card_payment_decision_rows(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.card_payment_decision_result(uuid, text, text, uuid, uuid[], uuid[], boolean) from public, anon, authenticated;
revoke all on function public.link_card_payment(uuid, uuid, uuid, bigint, bigint) from public, anon, authenticated;
revoke all on function public.mark_card_payment_destination(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.undo_card_payment_decision(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.card_payment_decision_begin(uuid, bigint, text) to service_role;
grant execute on function public.card_payment_decision_target(uuid, uuid, text) to service_role;
grant execute on function public.card_payment_decision_check_leg(boolean, boolean, text, bigint, text) to service_role;
grant execute on function public.card_payment_lineage_row(uuid, text) to service_role;
grant execute on function public.card_payment_live_decisions(uuid) to service_role;
grant execute on function public.card_payment_decision_rows(uuid, uuid[]) to service_role;
grant execute on function public.card_payment_decision_result(uuid, text, text, uuid, uuid[], uuid[], boolean) to service_role;
grant execute on function public.link_card_payment(uuid, uuid, uuid, bigint, bigint) to service_role;
grant execute on function public.mark_card_payment_destination(uuid, uuid, bigint) to service_role;
grant execute on function public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint) to service_role;
grant execute on function public.undo_card_payment_decision(uuid, uuid, bigint) to service_role;

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_fn text;
  v_bad text := '';
begin
  foreach v_fn in array array[
    'public.card_payment_decision_begin(uuid, bigint, text)',
    'public.card_payment_decision_target(uuid, uuid, text)',
    'public.card_payment_decision_check_leg(boolean, boolean, text, bigint, text)',
    'public.card_payment_lineage_row(uuid, text)',
    'public.card_payment_live_decisions(uuid)',
    'public.card_payment_decision_rows(uuid, uuid[])',
    'public.card_payment_decision_result(uuid, text, text, uuid, uuid[], uuid[], boolean)',
    'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)',
    'public.mark_card_payment_destination(uuid, uuid, bigint)',
    'public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint)',
    'public.undo_card_payment_decision(uuid, uuid, bigint)'
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
    raise exception 'card-payment decision functions lack a security property:%', v_bad;
  end if;
  -- No new privilege on the decision table: still exactly what 20260930120000 granted.
  if (select array_agg(p.priv order by p.priv)
      from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
      where has_table_privilege('service_role', 'public.card_payment_decisions', p.priv))
     is distinct from array['delete', 'insert', 'select', 'update']
     or exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
                where has_table_privilege(r.role, 'public.card_payment_decisions', 'select')
                   or has_table_privilege(r.role, 'public.card_payment_decisions', 'insert')
                   or has_table_privilege(r.role, 'public.card_payment_decisions', 'update')
                   or has_table_privilege(r.role, 'public.card_payment_decisions', 'delete')) then
    raise exception 'card_payment_decisions privileges changed';
  end if;
end;
$$;
