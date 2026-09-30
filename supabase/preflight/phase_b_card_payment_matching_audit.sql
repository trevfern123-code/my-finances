-- DRAFT — NOT YET RUN AGAINST PRODUCTION. Read-only audit of card-payment matching for design §13 R3
-- (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md) and CARD_PAYMENT_PAIRING_DESIGN.md §9.
--
-- Two statements, each a single SELECT: no write, no DDL, no function call with side effects. Safe to
-- run one at a time in the Supabase SQL editor once Trevor approves the run. This file lives outside
-- supabase/migrations on purpose: no migration runner will ever execute it.
--
-- What it measures (last 12 months, card-payment legs on the user's own accounts):
--   * which legs today's automatic rule pairs (exact opposite cents, other side, ±5 days, reciprocal,
--     closest wins, tie = ambiguous) — CONFIRMED;
--   * which unpaired legs have evidence of a counterpart the rule cannot use — POSSIBLE (exact amount
--     6–60 days away, a near amount within 5 days, a tie, or a match on an excluded card);
--   * which have no counterpart at all — UNKNOWN (recent, or older) — and card-shaped rows the
--     classifier does not treat as card payments.
--
-- Classification is respected exactly as the app applies it:
--   * a user override (user_role_override) always wins; a row overridden to another role is out of
--     scope, a row overridden TO credit_card_payment is in;
--   * otherwise the stored auto_role;
--   * otherwise (auto_role NULL — most rows until the Phase A backfill runs, see §8) the row-level
--     rules of transactionClassifier.ts, which are the ONLY source of credit_card_payment (relational
--     reconciliation never produces it): manual-loan link → debt_payment; detailed category
--     LOAN_PAYMENTS_CREDIT_CARD_PAYMENT with VERY_HIGH/HIGH confidence → credit_card_payment;
--     anything else is not a card payment. `role_basis` reports which of the three applied.
--   * tracked set: a leg on an account with exclude_from_cash_flow is never a candidate for today's
--     rule (it is reported separately), exactly as semanticAggregation.ts.
--
-- Minimum necessary output: counts, distinct-user counts and cent-exact amount totals per bucket. No
-- user id, account id, transaction id, name, merchant, institution name or date leaves the query, and
-- no access-token column (plaintext or encrypted) is read at all.
--
-- Sandbox / test data. The Plaid environment is a property of the deployment (PLAID_ENV), not of a
-- row: if production ran with PLAID_ENV=sandbox for the whole period, EVERY row is Sandbox data and the
-- env_class split below is informational only. Where environments were mixed over time, items are
-- classified by Plaid's documented Sandbox institution ids and by the Sandbox institutions' names
-- (First Platypus Bank, First Gingham Credit Union, Tattersall Federal Credit Union, Tartan Bank,
-- Houndstooth Bank, …); everything else is 'not_identified' (NOT "proven real"). Before running,
-- Trevor may list known test users' ids in params.test_user_ids; they are reported as 'test_user'.
-- Verify the institution-id list against Plaid's current Sandbox documentation before relying on it.

-- AUDIT 1 — card-payment legs by environment, side, direction, role basis and matching bucket.
--
-- Columns: env_class, side (cash_side / credit_side), direction (payment / return — on the card side a
-- payment is the −leg, a reversal the +leg), role_basis (override / stored / predicted), bucket, legs,
-- users, pending_legs, amount (sum of |amount|), current_rule_cash_flow_effect (what today's pure module
-- adds to cash flow for these legs: −amount for an unpaired cash-side payment, +amount for an unpaired
-- cash-side return, 0 otherwise; NULL for out-of-scope rows, which it does not treat as card payments).
--
-- Buckets, in precedence order (each leg lands in exactly one):
--   out_of_scope_user_override_other_role   card-shaped, but the user overrode it to another role
--   out_of_scope_classified_other_role      card-shaped, but classified as another role (e.g. the
--                                           LOAN_PAYMENTS fallback → debt_payment, or no detailed
--                                           category stored) — today counted as that role, not here
--   out_of_scope_excluded_account           a card payment on an account excluded from cash flow
--   confirmed_paired_within_5d              today's rule pairs it
--   possible_tie_or_not_reciprocal_5d       an exact candidate within 5 days, but a tie or the
--                                           candidate prefers another leg
--   possible_exact_amount_6_to_60d          an unpaired exact-opposite leg on the other side 6–60 days away
--   possible_amount_differs_within_5d       an unpaired leg on the other side within 5 days whose
--                                           amount differs by 1 cent to $5.00 (fee / rounding shape)
--   possible_partner_on_excluded_card       (cash side) an exact match within 5 days on a credit
--                                           account excluded from cash flow
--   unknown_no_included_card                (cash side) the user has no included credit account
--   unknown_recent_no_candidate             no counterpart, leg younger than 10 days
--   unknown_no_candidate                    no counterpart, older
with params as (
  select (current_date - interval '12 months')::date as audit_start,
         current_date                               as audit_end,        -- inclusive
         5                                          as pair_window_days, -- CARD_PAYMENT_PAIR_WINDOW_DAYS
         60                                         as horizon_days,
         500                                        as near_amount_cents,
         10                                         as settle_days,
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
         (a.type = 'credit')                     as credit_side,
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
  where t.date >= p.audit_start - p.horizon_days
    and t.date <= p.audit_end + p.horizon_days
    and t.amount <> 0
),
card_legs as (select * from legs where role = 'credit_card_payment'),
pool as (select * from card_legs where included),
-- Today's rule, over the pool: exact opposite cents, other side, within the window.
cand as (
  select x.id as a_id, y.id as b_id, abs(x.date - y.date) as dist
  from pool x
  join pool y on y.user_id = x.user_id and y.credit_side <> x.credit_side and y.cents = -x.cents
  where abs(x.date - y.date) <= (select pair_window_days from params)
),
ranked as (
  select a_id, b_id, dist,
         min(dist) over (partition by a_id)     as dmin,
         count(*)  over (partition by a_id, dist) as n_at_dist
  from cand
),
best as (select a_id, b_id from ranked where dist = dmin and n_at_dist = 1),
paired as (
  select x.a_id as id
  from best x join best y on y.a_id = x.b_id and y.b_id = x.a_id
),
unpaired as (select p.* from pool p where not exists (select 1 from paired q where q.id = p.id)),
classified as (
  select l.env_class, l.user_id, l.credit_side, l.cents, l.pending, l.role_basis, l.date,
         case
           when l.role <> 'credit_card_payment' and l.role_basis = 'override'
             then 'out_of_scope_user_override_other_role'
           when l.role <> 'credit_card_payment'
             then 'out_of_scope_classified_other_role'
           when not l.included
             then 'out_of_scope_excluded_account'
           when exists (select 1 from paired q where q.id = l.id)
             then 'confirmed_paired_within_5d'
           when exists (select 1 from cand c where c.a_id = l.id)
             then 'possible_tie_or_not_reciprocal_5d'
           when exists (select 1 from unpaired u
                        where u.user_id = l.user_id and u.credit_side <> l.credit_side and u.cents = -l.cents
                          and abs(u.date - l.date) between (select pair_window_days from params) + 1
                                                       and (select horizon_days from params))
             then 'possible_exact_amount_6_to_60d'
           when exists (select 1 from unpaired u
                        where u.user_id = l.user_id and u.credit_side <> l.credit_side
                          and sign(u.cents) = -sign(l.cents)
                          and abs(u.cents + l.cents) between 1 and (select near_amount_cents from params)
                          and abs(u.date - l.date) <= (select pair_window_days from params))
             then 'possible_amount_differs_within_5d'
           when not l.credit_side
            and exists (select 1 from card_legs e
                        where e.user_id = l.user_id and e.credit_side and not e.included and e.cents = -l.cents
                          and abs(e.date - l.date) <= (select pair_window_days from params))
             then 'possible_partner_on_excluded_card'
           when not l.credit_side
            and not exists (select 1 from public.accounts a2 join items i2 on i2.item_id = a2.item_id
                            where i2.user_id = l.user_id and a2.type = 'credit' and not a2.exclude_from_cash_flow)
             then 'unknown_no_included_card'
           when l.date > (select audit_end from params) - (select settle_days from params)
             then 'unknown_recent_no_candidate'
           else 'unknown_no_candidate'
         end as bucket
  from legs l
  where (l.role = 'credit_card_payment' or l.card_shaped)
)
select env_class,
       case when credit_side then 'credit_side' else 'cash_side' end                     as side,
       case when (credit_side and cents < 0) or (not credit_side and cents > 0)
            then 'payment' else 'return' end                                            as direction,
       role_basis,
       bucket,
       count(*)                                                                          as legs,
       count(distinct user_id)                                                           as users,
       count(*) filter (where pending)                                                   as pending_legs,
       (sum(abs(cents)) / 100.0)::numeric(14, 2)                                         as amount,
       case when bucket like 'out_of_scope%' then null
            else (sum(case when not credit_side and bucket <> 'confirmed_paired_within_5d'
                          then -cents else 0 end) / 100.0)::numeric(14, 2) end           as current_rule_cash_flow_effect
from classified
where date between (select audit_start from params) and (select audit_end from params)
group by 1, 2, 3, 4, 5
order by 1, 2, 3, 5, 4;

-- AUDIT 2 — context for AUDIT 1: how the tracked set is shaped, per environment class. Counts only.
-- A cash-side payment can only be tracked if its user has an included credit account; stale items
-- matter because a card leg cannot arrive from an item that is not syncing (design §5.3).
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
       count(a.id) filter (where a.type <> 'credit' or a.type is null)                   as other_accounts,
       count(a.id) filter (where (a.type <> 'credit' or a.type is null) and a.exclude_from_cash_flow) as other_accounts_excluded
from items i
left join public.accounts a on a.item_id = i.item_id
group by 1
order by 1;
