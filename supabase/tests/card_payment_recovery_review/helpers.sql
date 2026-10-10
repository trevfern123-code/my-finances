-- Fixture and reading helpers of the packet 2-A harness (schema rrh). Loaded once, as supabase_admin, after the
-- shared assertion helpers (supabase/tests/phase_a/helpers.sql: th.assert, th.expect_error). Every function runs
-- as its caller. Nothing here decides an expectation: the tests state every expected value themselves.
create schema rrh;

create function rrh.aa() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function rrh.bb() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
-- A deterministic operation id: rrh.op(7) is always the same uuid.
create function rrh.op(p_n integer) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid $$;

-- ---- Fixture -----------------------------------------------------------------------------------------------
create function rrh.item(p_id uuid, p_user uuid, p_plaid text, p_name text) returns void language sql as $$
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name)
  values (p_id, p_user, p_plaid, 'placeholder-token-' || p_plaid, p_name) $$;
create function rrh.account(p_id uuid, p_item uuid, p_plaid text, p_type text, p_excluded boolean default false) returns void language sql as $$
  insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow)
  values (p_id, p_item, p_plaid, 'Account ' || p_plaid, p_type, p_excluded) $$;
-- One card-payment leg. Amounts are DOLLARS with the Plaid sign (+ out of a cash account, − into a card).
create function rrh.cardleg(p_plaid text, p_account uuid, p_amount numeric, p_date date, p_pending boolean default false,
                            p_pending_of text default null) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, pending_transaction_id, user_role_override)
  values (p_account, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, p_pending_of, 'credit_card_payment') $$;
create function rrh.remove(p_user uuid, p_item uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started',
                    'fixture: the removal begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
  v := public.remove_plaid_item_local(p_user, p_item);
  perform th.assert((v->>'replayed')::boolean = false, 'fixture: the removal runs');
  return v;
end $$;

-- ---- Reading -----------------------------------------------------------------------------------------------
create function rrh.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
create function rrh.pid(p_id uuid) returns text language sql as $$
  select plaid_transaction_id from public.transactions where id = p_id $$;
create function rrh.iv(p_user uuid default rrh.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function rrh.rev(p_user uuid default rrh.aa()) returns bigint language sql as $$
  select coalesce((select revision from public.card_payment_review_revisions where user_id = p_user), 0) $$;
create function rrh.states(p_user uuid default rrh.aa()) returns jsonb language sql as $$
  select public.get_card_payment_states(p_user) $$;
create function rrh.fresh(p_user uuid default rrh.aa()) returns boolean language sql as $$
  select coalesce((public.get_card_payment_states(p_user)->>'fresh')::boolean, false) $$;
-- A leg's published state. Raises when the states are not fresh, so no check can pass on a stale read.
create function rrh.leg(p_plaid text, p_user uuid default rrh.aa()) returns jsonb language plpgsql as $$
declare
  v jsonb := rrh.states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select l from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = rrh.tid(p_plaid));
end $$;
-- "state/reason/effect partner=<Plaid id> decision=<kind> range=<low>..<high>": everything a reader sees of a leg.
create function rrh.line(p_plaid text, p_user uuid default rrh.aa()) returns text language sql as $$
  select coalesce((l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null')
         || ' partner=' || coalesce(rrh.pid((l->>'partnerTransactionId')::uuid), '-')
         || ' decision=' || coalesce((select d.kind from public.card_payment_decisions d where d.id = (l->>'decisionId')::uuid), '-')
         || ' range=' || (l->>'lowCents') || '..' || (l->>'highCents'), '(no leg)')
  from (select rrh.leg(p_plaid, p_user) as l) x $$;
-- The leg's review state: "withheld=<Plaid id of the partner> obligations=<n> gap=<t/f>", or "none".
create function rrh.review(p_plaid text, p_user uuid default rrh.aa()) returns text language plpgsql as $$
declare
  v jsonb := rrh.states(p_user);
  r jsonb;
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading the review of %', p_plaid;
  end if;
  select x into r from jsonb_array_elements(v->'reviews') x where (x->>'transactionId')::uuid = rrh.tid(p_plaid);
  if r is null then return 'none'; end if;
  return 'withheld=' || coalesce(rrh.pid((r->>'withheldPartnerTransactionId')::uuid), '-')
         || ' obligations=' || jsonb_array_length(r->'obligationIds')
         || ' gap=' || case when (r->>'coverageGap')::boolean then 't' else 'f' end;
end $$;
-- The Plaid ids of a leg's candidates of one kind, sorted.
create function rrh.candidates(p_plaid text, p_kind text default 'tier1_competitor', p_user uuid default rrh.aa()) returns text language sql as $$
  select coalesce(string_agg(t.plaid_transaction_id, ',' order by t.plaid_transaction_id collate "C"), '')
  from jsonb_array_elements(rrh.leg(p_plaid, p_user)->'candidates') c
  join public.transactions t on t.id = (c->>'transactionId')::uuid where c->>'kind' = p_kind $$;
-- Whether the evaluator published an automatic pair for a cash leg.
create function rrh.auto_pair(p_cash_plaid text) returns text language sql as $$
  select coalesce((select rrh.pid(p.credit_transaction_id) from public.card_payment_auto_pairs p
                   where p.cash_transaction_id = rrh.tid(p_cash_plaid)), '-') $$;
-- The LIVE removal-written decisions that name a Plaid id as either leg: "H(card/cash@date)" and "D(cash)", sorted.
create function rrh.retained(p_plaid text) returns text language sql as $$
  select coalesce(string_agg(q.x, ' ' order by q.x collate "C"), 'none')
  from (select case when d.kind like 'ambiguity_hold_%' then 'H(' || d.a_plaid_transaction_id || '/' || d.b_plaid_transaction_id || '@' || d.counterpart_date || ')'
                    when d.kind = 'destination_removed_card' then 'D(' || d.a_plaid_transaction_id || ')'
                    else 'P(' || d.a_plaid_transaction_id || ')' end as x
        from public.card_payment_decisions d
        where d.superseded_by is null
          and d.kind in ('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
          and p_plaid in (d.a_plaid_transaction_id, d.b_plaid_transaction_id)) q $$;
-- The review obligations on a payment (by the Plaid id its obligations name), sorted:
--   origin[gap reason](removed item's Plaid item id) edges=<known surviving edges> sources=<evidence:removed transaction>
create function rrh.obligations(p_plaid text, p_user uuid default rrh.aa()) returns text language sql as $$
  select coalesce(string_agg(q.x, ' ; ' order by q.x collate "C"), 'none')
  from (select o.origin || coalesce('[' || o.gap_reason || ']', '')
               || '(' || coalesce((select pr.plaid_item_id from public.plaid_item_removals pr where pr.id = o.removal_id), '-') || ')'
               || ' edges=' || coalesce((select string_agg(m.member_plaid_transaction_id, ',' order by m.member_plaid_transaction_id collate "C")
                                         from public.card_payment_review_memberships m where m.obligation_id = o.id), '')
               || ' sources=' || coalesce((select string_agg(s.evidence_kind || ':' || coalesce(s.source_plaid_transaction_id, '?'), ','
                                                             order by s.evidence_kind, s.source_plaid_transaction_id collate "C")
                                           from public.card_payment_review_obligation_sources s where s.obligation_id = o.id), '') as x
        from public.card_payment_review_obligations o
        where o.user_id = p_user and o.anchor_plaid_transaction_id = p_plaid) q $$;
-- The sum of the bounds of every counted cash leg (included account) in a date range: what an aggregate reports.
create function rrh.bounds(p_from date, p_to date, p_user uuid default rrh.aa()) returns text language plpgsql as $$
declare
  v jsonb := rrh.states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when summing bounds';
  end if;
  return (select coalesce(sum((l->>'lowCents')::bigint), 0) || '..' || coalesce(sum((l->>'highCents')::bigint), 0)
          from jsonb_array_elements(v->'legs') l
          where l->>'side' = 'cash' and (l->>'accountIncluded')::boolean
            and (l->>'date')::date >= p_from and (l->>'date')::date < p_to);
end $$;

-- ---- Acting ------------------------------------------------------------------------------------------------
-- One recovery action as a request of its own (a subtransaction: a refusal undoes everything it did). Returns
-- the wrapper's answer, or {"refused": <message>}. The versions default to the current ones — what a client
-- that has just reloaded would send.
create function rrh.act(p_op uuid, p_action jsonb, p_user uuid default rrh.aa(), p_input bigint default null,
                        p_review bigint default null) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  begin
    v := public.apply_card_payment_recovery_action(p_user, p_op, coalesce(p_input, rrh.iv(p_user)), coalesce(p_review, rrh.rev(p_user)), p_action);
  exception when others then
    return jsonb_build_object('refused', sqlerrm, 'sqlstate', sqlstate);
  end;
  return v;
end $$;
-- A short reading of that answer: its status, or "refused: <the message's code>".
create function rrh.outcome(p_answer jsonb) returns text language sql as $$
  select coalesce(p_answer->>'status', 'refused: ' || split_part(p_answer->>'refused', ':', 1)) $$;

-- ---- The standard guarded payment (the concurrency tests' fixture) ------------------------------------------
-- User aa: k (+370, checking C, 2026-09-10); its automatic match x (−370, card X, the 11th) was removed with
-- item 1; y (−370, card Y, the 12th) stays on item 3; w (−370, card W, the 11th) arrived afterwards on item 8.
-- Evaluated: k is withheld from w and reads the range {−370, 0}. A second kept institution (item 4, card V with
-- one unrelated leg) is there for tests that need another removal.
create function rrh.guarded_fixture() returns void language plpgsql as $$
begin
  perform rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'fixture-item-kept', 'Kept Bank');
  perform rrh.item('00000000-0000-0000-0000-000000000004', rrh.aa(), 'fixture-item-second', 'Second Bank');
  perform rrh.account('00000000-0000-0000-0000-00000001f0a1', '00000000-0000-0000-0000-000000000001', 'fixture-x', 'credit');
  perform rrh.account('00000000-0000-0000-0000-00000001f0c1', '00000000-0000-0000-0000-000000000003', 'fixture-c', 'depository');
  perform rrh.account('00000000-0000-0000-0000-00000001f0c2', '00000000-0000-0000-0000-000000000003', 'fixture-y', 'credit');
  perform rrh.account('00000000-0000-0000-0000-00000001f0d1', '00000000-0000-0000-0000-000000000004', 'fixture-v', 'credit');
  perform rrh.cardleg('k', '00000000-0000-0000-0000-00000001f0c1', 370, '2026-09-10');
  perform rrh.cardleg('x', '00000000-0000-0000-0000-00000001f0a1', -370, '2026-09-11');
  perform rrh.cardleg('y', '00000000-0000-0000-0000-00000001f0c2', -370, '2026-09-12');
  perform rrh.cardleg('v', '00000000-0000-0000-0000-00000001f0d1', -55, '2026-09-20');
  perform rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
  perform rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'fixture-item-other', 'Other Bank');
  perform rrh.account('00000000-0000-0000-0000-00000001f0e1', '00000000-0000-0000-0000-000000000008', 'fixture-w', 'credit');
  perform rrh.cardleg('w', '00000000-0000-0000-0000-00000001f0e1', -370, '2026-09-11');
  perform public.evaluate_card_payments(rrh.aa());
  perform th.assert(rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0', 'fixture: k is guarded: ' || rrh.line('k'));
end $$;
-- The pair k/w as an action payload.
create function rrh.pair_kw() returns jsonb language sql as $$
  select jsonb_build_object('action', 'pair_current', 'transactionId', rrh.tid('k'), 'counterpartTransactionId', rrh.tid('w'), 'acceptedDifferenceCents', 0) $$;

grant usage on schema rrh to postgres, anon, authenticated, service_role;
grant execute on all functions in schema rrh to postgres, anon, authenticated, service_role;
