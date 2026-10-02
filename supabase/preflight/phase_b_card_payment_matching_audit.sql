-- DRAFT (rev 3) — NOT YET RUN AGAINST PRODUCTION. Read-only audit of card-payment matching for
-- FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §13 R3 and CARD_PAYMENT_PAIRING_DESIGN.md §9.
--
-- Two statements, each a single SELECT: no write, no DDL, no function with side effects. Safe to run
-- one at a time in the Supabase SQL editor once Trevor approves the run. This file lives outside
-- supabase/migrations on purpose: no migration runner will ever execute it. Validated only against
-- synthetic rows: supabase/tests/card_payment_audit/run.sh.
--
-- What it measures (last 12 months, card-payment legs on the user's own accounts):
--   * CONFIRMED — the destination is established by evidence: an automatic pair (exact opposite
--     cents, other side, ±5 days, reciprocal, closest wins, tie = ambiguous) with an included or an
--     excluded partner, or a cash-side leg of a user who has no included credit account at all;
--   * POSSIBLE — a counterpart may exist but the automatic rule cannot use it (a tie, an exact amount
--     6–60 days away, a near amount within 5 days);
--   * UNKNOWN — no counterpart found within these limits. Not proof of anything: the counterpart may
--     be misclassified, farther away or differ by more than $5 (design §3.4);
--   * OUT OF SCOPE — card-shaped rows the classification does not treat as card payments, and legs on
--     excluded accounts (still used as pairing evidence).
--
-- POSSIBLE and UNKNOWN are EXPOSURE, not confirmed error: `unresolved_exposure` is the most the
-- slice-1 figure could be wrong by for those legs, not the amount it is wrong by. CONFIRMED buckets
-- can still differ from slice 1 — the approved rules (design §10) see more evidence, e.g. an excluded
-- card closer than the included one (T5). That KNOWN difference is `confirmed_difference`, reported
-- separately and never added to exposure.
--
-- Classification is respected as the app applies it:
--   * a user override (user_role_override) always wins — a row overridden to another role is out of
--     scope, a row overridden TO credit_card_payment is in;
--   * otherwise the stored auto_role;
--   * otherwise (auto_role NULL — most rows until the Phase A backfill runs) the row-level rules of
--     transactionClassifier.ts, which are the only source of credit_card_payment (relational
--     reconciliation never produces it): manual-loan link → debt_payment; detailed category
--     LOAN_PAYMENTS_CREDIT_CARD_PAYMENT with VERY_HIGH/HIGH confidence → credit_card_payment;
--     anything else is not a card payment.
--   `role_basis` says which applied; `classification` is 'current' (override or stored role) or
--   'projected' (what the classifier WILL assign once the backfill runs — not current behaviour).
--
-- Sides follow semanticAggregation.ts exactly: an account whose type is 'credit' is the credit side;
-- every other account — including a NULL type — is the cash side.
--
-- Five columns are reported separately, never summed together:
--   live_effect          what the LIVE app adds to cash flow for these legs today: it is sign-based
--                        and role-blind, so every leg on an included account counts −amount (Plaid
--                        convention, + = outflow) and legs on excluded accounts count 0;
--   slice1_effect        what the disconnected Phase B slice-1 module WOULD add, with the
--                        classification above (projected for 'projected' rows): −amount for a
--                        cash-side leg it leaves unpaired (payment −, return +), 0 otherwise;
--                        NULL for out-of-scope rows;
--   proposed_effect      CONFIRMED buckets only: what the approved rules add (cash side: 0 when the
--                        partner is on an included card, −amount for a payment / +amount for a
--                        return when the partner is excluded or the user has no included card;
--                        credit side: 0). NULL where the destination is not established;
--   confirmed_difference proposed_effect − slice1_effect, CONFIRMED buckets only: how much slice 1 is
--                        KNOWN to differ from the approved rules. NULL otherwise;
--   unresolved_exposure  Σ|amount| of cash-side legs whose destination is not established (POSSIBLE,
--                        UNKNOWN); 0 for CONFIRMED and for every credit-side leg (never moves cash
--                        flow under D5); NULL out of scope.
--
-- Surrounding evidence. A leg's POSSIBLE candidates reach 60 days away, and whether a candidate is
-- itself automatically paired depends on legs up to two pairing windows beyond it (reciprocity is two
-- hops deep). Rows are therefore loaded from audit_start − (60 + 2×5) days to audit_end + (60 + 2×5).
--
-- Minimum necessary output: counts, distinct-user counts and amounts per bucket. No user id, account
-- id, transaction id, name, merchant, institution name or date leaves the query, and no access-token
-- column (plaintext or encrypted) is read.
--
-- Sandbox / test data. The Plaid environment is a property of the deployment (PLAID_ENV), not of a
-- row: if production ran with PLAID_ENV=sandbox throughout, EVERY row is Sandbox data and the split is
-- informational only. Items are classified by Plaid's Sandbox institution ids and the Sandbox
-- institutions' names (First Platypus Bank, First Gingham Credit Union, Tattersall Federal Credit
-- Union, Tartan Bank, Houndstooth Bank, …); everything else is 'not_identified' (NOT "proven real").
-- Trevor may list known test users' ids in params.test_user_ids (both statements). Verify the
-- institution-id list against Plaid's current Sandbox documentation before relying on it.

-- AUDIT 1 — card-payment legs by environment, side, direction, classification and bucket.
--
-- Buckets, in precedence order (each leg lands in exactly one):
--   out_of_scope_user_override_other_role     card-shaped, the user overrode it to another role
--   out_of_scope_classified_other_role        card-shaped, classified as another role (e.g. the
--                                             LOAN_PAYMENTS fallback → debt_payment, or no detailed
--                                             category stored)
--   out_of_scope_excluded_account             a card leg on an account excluded from cash flow
--   confirmed_tracked_pair_5d                 automatic pair, partner on an included account
--   confirmed_untracked_partner_excluded_5d   (cash side) automatic pair, partner on an excluded card:
--                                             slice 1 already counts it as an untracked outflow —
--                                             correct, no exposure
--   confirmed_funded_from_excluded_account_5d (credit side) automatic pair, partner on an excluded
--                                             cash account: 0 under D5
--   possible_tie_or_not_reciprocal_5d         an exact candidate within 5 days, but a tie, or the
--                                             candidate prefers another leg
--   possible_exact_amount_6_to_60d            an unpaired exact-opposite leg on the other side 6–60 days away
--   possible_amount_differs_within_5d         an unpaired other-side leg within 5 days whose amount
--                                             differs by 1 cent to $5.00
--   confirmed_untracked_no_included_card      (cash side) the user has no included credit account
--   unknown_no_candidate_recent               none of the above, leg younger than 10 days
--   unknown_no_candidate                      none of the above, older
with params as (
  select (current_date - interval '12 months')::date as audit_start,
         current_date                               as audit_end,        -- inclusive
         5                                          as pair_window_days, -- CARD_PAYMENT_PAIR_WINDOW_DAYS
         60                                         as horizon_days,
         500                                        as near_amount_cents,
         10                                         as recent_days,      -- labelling only
         array[]::uuid[]                            as test_user_ids     -- Trevor: known test users, if any
),
items as (
  select pi.id as item_id,
         pi.user_id,
         case
           when pi.user_id = any (p.test_user_ids) then 'test_user'
           when pi.institution_id = any (array['ins_109508', 'ins_109509', 'ins_109510', 'ins_109511',
                                               'ins_109512', 'ins_116834', 'ins_117650', 'ins_127287',
                                               'ins_132241']) then 'sandbox_institution_id'
           when pi.institution_name ~* '(platypus|gingham|tattersall|tartan|houndstooth|royal bank of plaid)'
             then 'sandbox_institution_name'
           else 'not_identified'
         end as env_class
  from public.plaid_items pi cross join params p
),
legs as (
  select t.id,
         i.user_id,
         i.env_class,
         coalesce(a.type = 'credit', false)      as credit_side,   -- NULL type → cash side, as the module
         (not a.exclude_from_cash_flow)          as included,
         t.date,
         (t.amount * 100)::bigint                as cents,
         coalesce(t.pending, false)              as pending,
         case when t.user_role_override is not null then 'override'
              when t.auto_role is not null          then 'stored'
              else 'predicted' end               as role_basis,
         coalesce(t.user_role_override, t.auto_role,
                  case when t.manual_loan_id is not null then 'debt_payment'
                       when t.personal_finance_category_detailed = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
                        and t.personal_finance_category_confidence in ('VERY_HIGH', 'HIGH')
                         then 'credit_card_payment'
                       else 'not_card_payment' end) as role,
         (coalesce(t.personal_finance_category_detailed, '') = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'
          or (t.personal_finance_category_detailed is null and t.category = 'LOAN_PAYMENTS')) as card_shaped
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join items i on i.item_id = a.item_id
  cross join params p
  where t.date >= p.audit_start - (p.horizon_days + 2 * p.pair_window_days)
    and t.date <= p.audit_end   + (p.horizon_days + 2 * p.pair_window_days)
    and t.amount <> 0
),
card_legs as (select * from legs where role = 'credit_card_payment'),
-- Pairing S1 — Phase B slice 1 as built: only legs on included accounts are candidates.
s1_cand as (
  select x.id as a_id, y.id as b_id, abs(x.date - y.date) as dist
  from card_legs x
  join card_legs y on y.user_id = x.user_id and y.credit_side <> x.credit_side and y.cents = -x.cents
  where x.included and y.included and abs(x.date - y.date) <= (select pair_window_days from params)
),
s1_ranked as (
  select a_id, b_id, dist, min(dist) over (partition by a_id) as dmin,
         count(*) over (partition by a_id, dist) as n_at_dist
  from s1_cand
),
s1_best as (select a_id, b_id from s1_ranked where dist = dmin and n_at_dist = 1),
s1_paired as (select x.a_id as id from s1_best x join s1_best y on y.a_id = x.b_id and y.b_id = x.a_id),
-- Pairing T1 — the proposal's tier 1 (design §3.3): every linked account is evidence.
t1_cand as (
  select x.id as a_id, y.id as b_id, abs(x.date - y.date) as dist
  from card_legs x
  join card_legs y on y.user_id = x.user_id and y.credit_side <> x.credit_side and y.cents = -x.cents
  where abs(x.date - y.date) <= (select pair_window_days from params)
),
t1_ranked as (
  select a_id, b_id, dist, min(dist) over (partition by a_id) as dmin,
         count(*) over (partition by a_id, dist) as n_at_dist
  from t1_cand
),
t1_best as (select a_id, b_id from t1_ranked where dist = dmin and n_at_dist = 1),
t1_paired as (
  select x.a_id as id, x.b_id as partner_id
  from t1_best x join t1_best y on y.a_id = x.b_id and y.b_id = x.a_id
),
t1_unpaired as (select c.* from card_legs c where not exists (select 1 from t1_paired q where q.id = c.id)),
classified as (
  select l.env_class, l.user_id, l.credit_side, l.included, l.cents, l.pending, l.role_basis, l.date,
         exists (select 1 from s1_paired q where q.id = l.id) as s1_paired,
         case
           when l.role <> 'credit_card_payment' and l.role_basis = 'override'
             then 'out_of_scope_user_override_other_role'
           when l.role <> 'credit_card_payment'
             then 'out_of_scope_classified_other_role'
           when not l.included
             then 'out_of_scope_excluded_account'
           when exists (select 1 from t1_paired q join card_legs pt on pt.id = q.partner_id
                        where q.id = l.id and pt.included)
             then 'confirmed_tracked_pair_5d'
           when exists (select 1 from t1_paired q where q.id = l.id) and not l.credit_side
             then 'confirmed_untracked_partner_excluded_5d'
           when exists (select 1 from t1_paired q where q.id = l.id)
             then 'confirmed_funded_from_excluded_account_5d'
           when exists (select 1 from t1_cand c where c.a_id = l.id)
             then 'possible_tie_or_not_reciprocal_5d'
           when exists (select 1 from t1_unpaired u
                        where u.user_id = l.user_id and u.credit_side <> l.credit_side and u.cents = -l.cents
                          and abs(u.date - l.date) between (select pair_window_days from params) + 1
                                                       and (select horizon_days from params))
             then 'possible_exact_amount_6_to_60d'
           when exists (select 1 from t1_unpaired u
                        where u.user_id = l.user_id and u.credit_side <> l.credit_side
                          and sign(u.cents) = -sign(l.cents)
                          and abs(u.cents + l.cents) between 1 and (select near_amount_cents from params)
                          and abs(u.date - l.date) <= (select pair_window_days from params))
             then 'possible_amount_differs_within_5d'
           when not l.credit_side
            and not exists (select 1 from public.accounts a2 join items i2 on i2.item_id = a2.item_id
                            where i2.user_id = l.user_id and a2.type = 'credit' and not a2.exclude_from_cash_flow)
             then 'confirmed_untracked_no_included_card'
           when l.date > (select audit_end from params) - (select recent_days from params)
             then 'unknown_no_candidate_recent'
           else 'unknown_no_candidate'
         end as bucket
  from legs l
  where (l.role = 'credit_card_payment' or l.card_shaped)
)
select env_class,
       case when credit_side then 'credit_side' else 'cash_side' end                   as side,
       case when (credit_side and cents < 0) or (not credit_side and cents > 0)
            then 'payment' else 'return' end                                          as direction,
       case when role_basis = 'predicted' then 'projected' else 'current' end         as classification,
       role_basis,
       bucket,
       count(*)                                                                        as legs,
       count(distinct user_id)                                                         as users,
       count(*) filter (where pending)                                                 as pending_legs,
       (sum(abs(cents)) / 100.0)::numeric(14, 2)                                       as amount,
       (sum(case when included then -cents else 0 end) / 100.0)::numeric(14, 2)        as live_effect,
       case when bucket like 'out_of_scope%' then null
            else (sum(case when not credit_side and not s1_paired then -cents else 0 end)
                  / 100.0)::numeric(14, 2) end                                        as slice1_effect,
       case when bucket like 'confirmed%'
            then (sum(case when not credit_side and bucket <> 'confirmed_tracked_pair_5d'
                           then -cents else 0 end) / 100.0)::numeric(14, 2) end            as proposed_effect,
       case when bucket like 'confirmed%'
            then (sum(case when not credit_side and bucket <> 'confirmed_tracked_pair_5d' then -cents else 0 end
                      - case when not credit_side and not s1_paired then -cents else 0 end)
                  / 100.0)::numeric(14, 2) end                                        as confirmed_difference,
       case when bucket like 'out_of_scope%' then null
            else (sum(case when not credit_side and (bucket like 'possible%' or bucket like 'unknown%')
                           then abs(cents) else 0 end) / 100.0)::numeric(14, 2) end   as unresolved_exposure
from classified
where date between (select audit_start from params) and (select audit_end from params)
group by 1, 2, 3, 4, 5, 6
order by 1, 2, 3, 6, 4, 5;

-- AUDIT 2 — context for AUDIT 1: how the tracked set is shaped, per environment class. Counts only.
-- A cash-side payment can only be tracked if its user has an included credit account; stale items
-- matter because a card leg cannot arrive from an item that is not syncing (shown to the user as a
-- reason, never used as evidence of absence — design §3.4).
with params as (
  select array[]::uuid[] as test_user_ids  -- keep identical to AUDIT 1
),
items as (
  select pi.id as item_id, pi.user_id, pi.status, pi.last_synced_at,
         case
           when pi.user_id = any (p.test_user_ids) then 'test_user'
           when pi.institution_id = any (array['ins_109508', 'ins_109509', 'ins_109510', 'ins_109511',
                                               'ins_109512', 'ins_116834', 'ins_117650', 'ins_127287',
                                               'ins_132241']) then 'sandbox_institution_id'
           when pi.institution_name ~* '(platypus|gingham|tattersall|tartan|houndstooth|royal bank of plaid)'
             then 'sandbox_institution_name'
           else 'not_identified'
         end as env_class
  from public.plaid_items pi cross join params p
)
select i.env_class,
       count(distinct i.item_id)                                                         as items,
       count(distinct i.item_id) filter (where i.status <> 'active')                     as items_not_active,
       count(distinct i.item_id) filter (where i.last_synced_at is null
                                          or i.last_synced_at < now() - interval '2 days') as items_not_synced_2d,
       count(distinct i.user_id)                                                         as users,
       count(a.id) filter (where a.type = 'credit')                                      as credit_accounts,
       count(a.id) filter (where a.type = 'credit' and a.exclude_from_cash_flow)         as credit_accounts_excluded,
       count(a.id) filter (where a.type is distinct from 'credit')                       as cash_side_accounts,
       count(a.id) filter (where a.type is distinct from 'credit' and a.exclude_from_cash_flow) as cash_side_accounts_excluded,
       count(a.id) filter (where a.type is null)                                         as accounts_type_null
from items i
left join public.accounts a on a.item_id = i.item_id
group by 1
order by 1;
