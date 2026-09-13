-- Financial Semantics Foundation, Phase A: persists the extra Plaid category detail needed to
-- distinguish a credit-card payment / internal transfer from ordinary spend (see the approved
-- Financial Semantics Foundation Design + corrections), plus one canonical semantic-role
-- classification per transaction. Entirely additive — no existing column is touched, no existing
-- financial calculation reads any of this yet (Phase B+ work).
--
-- personal_finance_category_detailed / _confidence: Plaid's own granular category and its
-- confidence in that category (VERY_HIGH/HIGH/MEDIUM/LOW/UNKNOWN, stored verbatim from Plaid, not
-- validated here) — already sent by Plaid on every transaction today but previously discarded
-- (only .primary was kept, in the existing `category` column). No new Plaid API call.
--
-- auto_role / role_source / role_confidence: the backend classifier's own output — see
-- transactionClassifier.ts for the precedence that produces these. classifier_version records
-- which version of that logic produced them, so a future algorithm change can selectively
-- re-classify only stale rows via an explicit backfill rather than silently reclassifying
-- everything. All three of auto_role/role_source/role_confidence are set atomically by the same
-- write (never independently), enforced by the all-or-none check below.
--
-- user_role_override: the user's own correction, if any — never written by sync, backfill, or
-- reconciliation, the same "later automation never resets an explicit user choice" guarantee this
-- schema already relies on for budget_category_id/needs_review.
--
-- effective_role: generated (not independently writable) so it can never drift from its own
-- inputs — every consumer that only needs a single-role-per-row answer reads this directly;
-- consumers that must account for manual-loan principal/interest decomposition use the
-- getSemanticEffects() backend helper instead (see that module's own doc comment for why
-- effective_role alone is insufficient for those rows).
alter table public.transactions
  add column personal_finance_category_detailed text null,
  add column personal_finance_category_confidence text null,
  add column auto_role text null,
  add column role_source text null,
  add column role_confidence text null,
  add column classifier_version smallint not null default 1,
  add column user_role_override text null;

alter table public.transactions
  add column effective_role text generated always as (
    coalesce(user_role_override, auto_role)
  ) stored;

alter table public.transactions
  add constraint transactions_auto_role_check
    check (auto_role is null or auto_role in
      ('expense', 'income', 'internal_transfer', 'credit_card_payment', 'debt_payment', 'refund'));

alter table public.transactions
  add constraint transactions_user_role_override_check
    check (user_role_override is null or user_role_override in
      ('expense', 'income', 'internal_transfer', 'credit_card_payment', 'debt_payment', 'refund'));

-- Round 2 remediation: 'refund_candidate_unconfirmed' was removed — an ordinary negative
-- transaction with no refund evidence classifies directly and finally as income/sign_default
-- (see transactionClassifier.ts's own doc comment); reconciliation independently reconsiders any
-- sign_default negative row against real refund evidence, with no separate speculative tag needed.
alter table public.transactions
  add constraint transactions_role_source_check
    check (role_source is null or role_source in (
      'manual_loan_link',
      'category_detailed',
      'category_primary_fallback',
      'category_detailed_account_transfer',
      'account_pair_match',
      'refund_match',
      'transfer_like_unconfirmed',
      'sign_default'
    ));

alter table public.transactions
  add constraint transactions_role_confidence_check
    check (role_confidence is null or role_confidence in ('high', 'medium', 'low'));

alter table public.transactions
  add constraint transactions_classifier_version_check
    check (classifier_version > 0);

-- auto_role/role_source/role_confidence are set together by the classifier or not at all — this
-- catches any future write path that accidentally sets one without the other two.
alter table public.transactions
  add constraint transactions_role_fields_all_or_none_check
    check (
      (auto_role is null and role_source is null and role_confidence is null)
      or
      (auto_role is not null and role_source is not null and role_confidence is not null)
    );
