-- Guarded manual recovery after an institution removal (Phase B, I3A-R packet 2-A;
-- PHASE_B_I3A_R_PACKET_2A_REVIEW.md). Builds on 20261006110000 (the evaluator), 20261006120000 and
-- 20261008120000 (the removal that preserves known destinations and records their provenance).
--
-- WHAT THIS FILE DOES NOT DO. It retires nothing. No ambiguity hold is ended, no removed-destination record
-- is retired, no review obligation is discharged, no source is "settled", and no function here can do any of
-- that. It offers no generic "reviewed" switch and no provider-identity check. Those are later, separately
-- approved work (P-Y and P-D stay separate permissions).
--
-- WHY. After an institution is removed, 20261006120000 keeps what was known about the payments that survive:
-- an ambiguity hold (H) on a pair the removed candidate stood in the way of, and a record (D) of a removed
-- destination. Both are about the legs that existed THEN. A transaction that appears later — an unrelated
-- payment, or the removed card linked again — is none of them, and the ordinary matcher pairs it by date and
-- amount alone. A payment whose history says "its card was removed" could then silently read "tracked, 0"
-- against a leg nobody ever reviewed (packet 2 errata E7; E2 is the same with a genuine return).
--
-- THE CONTRACT (approved 2026-10-09; the packet note has the full text and the tests).
--   1. A REVIEW OBLIGATION names an AFFECTED PAYMENT: a surviving leg that had an eligible candidate on the
--      removed institution — every staying leg of a tier 1 edge that the removal cuts, read from the
--      evaluator's complete pool before the delete, WHETHER OR NOT the removal writes a hold or a record for
--      it — and the surviving leg of a preserved user confirmation. It is keyed by that leg's lineage reference
--      (account, Plaid id, cents) WITHOUT a foreign key: it stays when the account, the decision or the
--      provenance row it came from is deleted. It goes only with its user. One obligation per (affected
--      payment, removal). Each keeps its own SOURCES, one by one: a row per decision the removal wrote, with
--      the removed transaction that decision depends on, and a row (graph_source) per removed candidate it
--      wrote no decision for. A and B are never merged, and no decision is invented.
--   2. Each obligation lists the SURVIVING EDGES it positively knows: the pairs that joined the affected
--      payment to another surviving leg in the eligible automatic-matching graph immediately before that
--      removal. A removal that runs with this file captures all of them, from the evaluator's complete pool
--      (accounts excluded from cash flow included), before anything is deleted. History that exists already is
--      seeded from what is actually retained: a hold names one such edge; a record names none. Nothing is
--      reconstructed from today's rows, dates, masks, amounts or names.
--   3. A GAP is its own obligation, never folded into another: a decision with no provenance row, or a removal
--      that finished without recording its sources (20261008120000's marker, or a cleaned removal with no
--      generation row). A gap knows no edge.
--   4. THE GUARD. The evaluator computes tier 1 exactly as before and applies the holds exactly as before.
--      Then, for each automatic pair that is left: if either leg is an affected payment, the pair stays only if
--      EVERY obligation on either leg positively lists that pair (the same two lineages).
--      Otherwise the pair is withheld, in both directions. No other pair is formed in its place. Both legs stay
--      in the pool, as candidates of each other and of anyone else.
--   5. WHAT A WITHHELD LEG READS (no controlling user decision; a user decision, active or not, still wins and
--      keeps the leg out of automatic matching, as before). The record D is NOT applied to it and is not named
--      on it: the guard result is published first.
--          included cash leg, an included card exists   unresolved / relink_review_required, the range {0, -cents}
--          included cash leg, no included card          untracked / no_included_card, effect -cents
--          included card leg                            unresolved / relink_review_required, effect 0
--          leg on an excluded account                   not_counted / excluded_account, effect 0
--      Every affected payment and every withheld leg also gets a REVIEW STATE row (below) at that version.
--   6. A range is published only by a FRESH evaluation of THIS evaluator. Its publications stamp the user
--      (card_payment_evaluator_contracts); the reader returns states only for a stamped user, and this file and
--      its rollback clear every stamp. Results evaluated before this file are therefore not readable until the
--      user is evaluated again, and this file queues that for every user who has a version row.
--   7. ACTIONS are the existing user decisions, reached through ONE wrapper in ONE transaction:
--      pair_current (link_card_payment), confirm_unlinked (mark_card_payment_destination), dismiss_candidate
--      (dismiss_card_payment_candidate), undo_decision (undo_card_payment_decision) — unchanged, called inside
--      the wrapper — and two that change no figure: reject_suggestion (this suggestion, at this revision of the
--      evidence) and defer. The wrapper writes an immutable receipt and registers refresh work in the same
--      transaction. Nothing an action does retires H, D or an obligation, and none grants anything to a
--      transaction that arrives later.
--   8. REFRESH is durable and does not depend on a bank sync: a per-owner queue row, written by the trigger on
--      the version row whenever an affected owner's inputs change, claimed by a worker under a lease.
--
-- THE REMOVAL (remove_plaid_item_local). 20261008120000's body with ONE added statement, inside the existing
-- preservation block, after its count check and before anything is deleted: the capture
-- (card_payment_review_capture), which reads the eligible graph and checks its own completeness against that
-- graph. A failure there is the existing refusal: nothing is removed. Everything else —
-- locks and their order, the strict evaluation before, the plan, the decisions and their provenance, the loan
-- restoration, the delete, the best-effort evaluation after, the result — is byte-for-byte the reviewed text.
--
-- THE EVALUATOR (evaluate_card_payments). 20261006110000's body with these hunks and no other (generated by
-- exact replacement; every other line is the reviewed text): three scratch tables; the guard, after the holds;
-- the withheld-leg branch between tier 1 and the record; the review states; the contract stamp; and the queue
-- row of work this publication satisfies is deleted. The scratch tables remove_plaid_item_local reads keep
-- their names and columns. cpe_pool, cpe_txn and cpe_dismissed are as before; cpe_tier1 is as before LESS the
-- pairs the guard withholds, so a withheld leg reads as a leg with no automatic match — which is what it
-- publishes. The capture reads the edges from cpe_pool, never from cpe_tier1: the guard erases no evidence.
--
-- LOCKS. No new class above L2. Actions: L1 (the user's advisory lock), the accounts of the named
-- transactions FOR KEY SHARE in id order (the lock the decision's insert takes anyway), then L2 (the version
-- row), then the receipt and the queue row. Evaluation: L1, L2, then the queue row. A writer that bumps the
-- version takes the queue row after L2 (the trigger). The claim locks queue rows only, with SKIP LOCKED, in
-- its own short transaction. So the queue row is always taken after L2, or alone. Lock-free writers exist as
-- before; deadlocks they can form are detected, roll back cleanly, and leave the queue row.
--
-- ACCESS. Row security on, no policy, no client privilege on any new table. The service role gets what the
-- functions need and nothing more (obligations, sources, memberships, annotations and receipts: SELECT and
-- INSERT only — no application path changes or deletes one). Every function is SECURITY INVOKER with an empty
-- search_path, executable by service_role only; trigger functions by nobody.
--
-- RETENTION. Obligations, receipts and annotations go with their user (ON DELETE CASCADE) and with nothing
-- else. "Immutable" means immutable while retained. Retention duration, redaction and disclosure are open
-- release gates, recorded in the packet note; this file builds no purge.
--
-- ROLLBACK. supabase/rollback/20261009120000_card_payment_recovery_review_rollback.sql. It REFUSES while any
-- review obligation exists: the previous evaluator would publish the unguarded pair as fresh. With an explicit
-- operator setting it proceeds and leaves a fence that keeps every affected owner unreadable. It keeps every
-- table and row. This file can be applied again: its DDL is repeatable and its seeding is idempotent.
--
-- Guard: applies only on top of the exact bodies it was written for.

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' then
    raise exception 'evaluate_card_payments is not the 20261006110000 definition; refusing to replace it';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'cc12b7a12c6510924781b93c658ee854' then
    raise exception 'remove_plaid_item_local is not the 20261008120000 definition; refusing to replace it';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '446e7a46e2774d52ef995cd55a79d5ed' then
    raise exception 'get_card_payment_states is not the 20260930120000 definition; refusing to replace it';
  end if;
  -- The functions the wrapper calls and the removal relies on, as they were reviewed.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '1ddf83f559f5179975ef52a08b7f2063'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.mark_card_payment_destination(uuid, uuid, bigint)'::regprocedure) <> 'c2c5368d749e490ed8f7e062ded261cd'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> 'dfcba4535ba1087928185d14cc978c10'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.dismiss_card_payment_candidate(uuid, uuid, uuid, bigint)'::regprocedure) <> '8a8d458f21f14cd136b596b05709cc68' then
    raise exception 'a card-payment decision RPC is not the definition the recovery wrapper was written for';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.try_evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'fac15fabe5470dd62a79a3a6c8630a89'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_lineage_row(uuid, text)'::regprocedure) <> '8f72e239b95584d0162bbf8bb5cb164f' then
    raise exception 'try_evaluate_card_payments / card_payment_lineage_row are not the definitions this file was written for';
  end if;
  if to_regclass('public.card_payment_removal_generations') is null
     or to_regclass('public.card_payment_removal_sources') is null then
    raise exception 'the provenance tables of 20261008120000 are missing';
  end if;
end
$$;

-- A previous rollback with the operator's override leaves this fence. This file replaces what it stood in for.
drop trigger if exists card_payment_recovery_downgrade_fence on public.card_payment_eval_versions;
drop function if exists public.card_payment_recovery_downgrade_fence();

-- ---- Review obligations ---------------------------------------------------------------------------------
create table if not exists public.card_payment_review_obligations (
  id                           uuid primary key default gen_random_uuid(),
  user_id                      uuid not null references auth.users(id) on delete cascade,
  anchor_account_id            uuid not null,
  anchor_plaid_transaction_id  text not null,
  anchor_cents                 bigint not null,
  anchor_side                  text not null,
  origin                       text not null,
  removal_id                   uuid null,
  gap_reason                   text null,
  completeness                 text not null,
  created_at                   timestamp with time zone not null default now(),
  constraint card_payment_review_obligations_side_check check (anchor_side in ('cash', 'credit')),
  constraint card_payment_review_obligations_origin_check check (origin in ('captured', 'seeded', 'gap')),
  constraint card_payment_review_obligations_gap_check
    check ((origin = 'gap') = (gap_reason is not null)
           and (gap_reason is null or gap_reason in ('unattributed_decision', 'unrecorded_removal'))
           and (gap_reason is distinct from 'unrecorded_removal' or removal_id is not null)
           and (origin <> 'captured' or removal_id is not null)),
  constraint card_payment_review_obligations_completeness_check
    check (completeness = case origin when 'captured' then 'complete' when 'seeded' then 'observed_only' else 'unknown' end),
  constraint card_payment_review_obligations_key
    unique nulls not distinct (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, gap_reason, removal_id)
);
comment on table public.card_payment_review_obligations is
  'One row per (affected payment, removal) that an institution removal left something about, and one row per '
  'coverage gap on such a payment (20261009120000). The affected payment is named by its lineage reference '
  '(account, Plaid id, cents) WITHOUT a foreign key: the row stays when the account, the decision or the '
  'provenance it came from is deleted. captured: written by the removal itself, with every surviving edge. '
  'seeded: from decisions that were already retained, with only the edges a hold names. gap: a decision with no '
  'provenance, or a removal that recorded no sources; it knows no edge. Never updated or deleted by an '
  'application path; goes with its user.';
comment on column public.card_payment_review_obligations.removal_id is
  'plaid_item_removals.id of the removal (the generation). NULL for evidence with no provenance row. No foreign '
  'key. For a gap of reason unrecorded_removal: the removal that recorded nothing.';
create index if not exists card_payment_review_obligations_user_idx on public.card_payment_review_obligations (user_id);
create index if not exists card_payment_review_obligations_anchor_idx
  on public.card_payment_review_obligations (anchor_account_id, anchor_plaid_transaction_id);

create table if not exists public.card_payment_review_obligation_sources (
  id                           uuid primary key default gen_random_uuid(),
  obligation_id                uuid not null references public.card_payment_review_obligations(id) on delete cascade,
  user_id                      uuid not null references auth.users(id) on delete cascade,
  evidence_kind                text not null,
  decision_id                  uuid null,
  decision_kind                text null,
  source_removal_id            uuid null,
  source_plaid_account_id      text null,
  source_plaid_transaction_id  text null,
  source_relation              text null,
  source_date                  date null,
  source_cents                 bigint null,
  created_at                   timestamp with time zone not null default now(),
  constraint card_payment_review_obligation_sources_kind_check
    check (evidence_kind in ('ambiguity_hold', 'removed_destination', 'preserved_confirmation', 'graph_source')),
  -- A graph-observed source names NO decision; every other kind names exactly the decision it came from.
  constraint card_payment_review_obligation_sources_decision_check
    check ((evidence_kind = 'graph_source') = (decision_id is null) and (decision_id is null) = (decision_kind is null)),
  -- A graph-observed source is always fully identified: the removal (its generation), the removed account and
  -- the removed transaction, as the capture read them from rows that still existed.
  constraint card_payment_review_obligation_sources_graph_check
    check (evidence_kind <> 'graph_source'
           or (source_removal_id is not null and source_plaid_account_id is not null
               and source_plaid_transaction_id is not null and source_date is not null and source_cents is not null
               and source_relation in ('automatic_partner', 'removed_candidate'))),
  constraint card_payment_review_obligation_sources_decision_key unique (decision_id)
);
comment on table public.card_payment_review_obligation_sources is
  'What established a review obligation, one removed transaction at a time. For a decision a removal wrote (a '
  'hold, a removed-destination record, a preserved user confirmation): one row per decision, with the removed '
  'transaction it depends on, copied from its provenance row when it has one. decision_id has NO foreign key: '
  'the row stays when the decision is deleted with its account. For a removed candidate the removal wrote NO '
  'decision for (graph_source): one row per (obligation, removed transaction), read from the eligible graph '
  'before the delete; decision_id is NULL — no decision is invented. Two sources are two rows; nothing here '
  'merges them. Never updated.';
-- One graph-observed row per (obligation, removed account, removed transaction).
create unique index if not exists card_payment_review_obligation_sources_graph_key
  on public.card_payment_review_obligation_sources (obligation_id, source_plaid_account_id, source_plaid_transaction_id)
  where decision_id is null;
create index if not exists card_payment_review_obligation_sources_obligation_idx
  on public.card_payment_review_obligation_sources (obligation_id);
create index if not exists card_payment_review_obligation_sources_user_idx
  on public.card_payment_review_obligation_sources (user_id);

create table if not exists public.card_payment_review_memberships (
  obligation_id                uuid not null references public.card_payment_review_obligations(id) on delete cascade,
  user_id                      uuid not null references auth.users(id) on delete cascade,
  member_account_id            uuid not null,
  member_plaid_transaction_id  text not null,
  member_cents                 bigint not null,
  observed_from                text not null,
  created_at                   timestamp with time zone not null default now(),
  constraint card_payment_review_memberships_pkey primary key (obligation_id, member_account_id, member_plaid_transaction_id),
  constraint card_payment_review_memberships_observed_check check (observed_from in ('captured_graph', 'ambiguity_hold'))
);
comment on table public.card_payment_review_memberships is
  'A surviving edge an obligation positively knows: the other leg (its lineage reference, no foreign key) of a '
  'pair that joined the affected payment to a leg that survived that removal, in the eligible automatic-matching '
  'graph immediately before it. Positive facts only: a missing row says nothing. Membership is not eligibility: '
  'the evaluator still decides whether the pair is the automatic match today.';
create index if not exists card_payment_review_memberships_user_idx on public.card_payment_review_memberships (user_id);

-- ---- Derived review state (written only by the evaluator) -----------------------------------------------
create table if not exists public.card_payment_review_states (
  user_id                          uuid not null references auth.users(id) on delete cascade,
  transaction_id                   uuid not null,
  guard_withheld                   boolean not null,
  withheld_partner_transaction_id  uuid null,
  obligation_ids                   uuid[] not null,
  coverage_gap                     boolean not null,
  computed_at_version              bigint not null,
  constraint card_payment_review_states_pkey primary key (user_id, transaction_id),
  constraint card_payment_review_states_withheld_check check (guard_withheld = (withheld_partner_transaction_id is not null))
);
comment on table public.card_payment_review_states is
  'Per evaluation: every card-payment leg that is an affected payment (an obligation names it) or whose '
  'automatic pair the relink-review guard withheld, with the obligations concerned. Derived, like '
  'card_payment_leg_states, and readable only at the evaluated version.';

create table if not exists public.card_payment_evaluator_contracts (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  evaluated_version  bigint not null,
  contract           integer not null
);
comment on table public.card_payment_evaluator_contracts is
  'Which evaluator contract publishes a user''s states. Contract 2 is the evaluator with the relink-review guard '
  '(20261009120000), which writes this row at every publication (evaluated_version: the last one). '
  'get_card_payment_states returns states only for a user stamped with contract 2. The migration and its '
  'rollback delete every row, so a result an older evaluator published is never read as current.';
-- Repeatable, and the point of the stamp: whatever was published before this file is not this contract's.
delete from public.card_payment_evaluator_contracts;

-- ---- Review workflow (no financial meaning) -------------------------------------------------------------
create table if not exists public.card_payment_review_revisions (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  revision  bigint not null default 0
);
comment on table public.card_payment_review_revisions is
  'A per-user counter that advances whenever the user''s review obligations, their sources, their known edges '
  'or the review annotations change. An action names the revision the user saw. It is NOT the matching input '
  'version and never changes a figure.';

create table if not exists public.card_payment_review_annotations (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references auth.users(id) on delete cascade,
  operation_id              uuid not null,
  kind                      text not null,
  transaction_id            uuid not null,
  transaction_cents         bigint not null,
  transaction_date          date not null,
  candidate_transaction_id  uuid null,
  candidate_cents           bigint null,
  candidate_date            date null,
  created_at                timestamp with time zone not null default now(),
  constraint card_payment_review_annotations_kind_check check (kind in ('reject_suggestion', 'defer')),
  constraint card_payment_review_annotations_candidate_check
    check ((kind = 'reject_suggestion') = (candidate_transaction_id is not null)
           and (candidate_transaction_id is null) = (candidate_cents is null)
           and (candidate_transaction_id is null) = (candidate_date is null))
);
comment on table public.card_payment_review_annotations is
  'Review workflow notes: the user rejected ONE suggestion (that candidate, at those amounts and dates) or '
  'deferred a review. Not a decision: it dismisses no candidate, changes no figure and grants nothing. It '
  'applies only while the two rows still have the recorded amounts and dates.';
create index if not exists card_payment_review_annotations_user_idx
  on public.card_payment_review_annotations (user_id, transaction_id);

-- ---- Action receipts ------------------------------------------------------------------------------------
create table if not exists public.card_payment_recovery_actions (
  user_id                    uuid not null references auth.users(id) on delete cascade,
  operation_id               uuid not null,
  action                     text not null,
  payload                    jsonb not null,
  payload_hash               text not null,
  expected_input_version     bigint null,
  expected_review_revision   bigint null,
  outcome                    text not null,
  reason                     text null,
  decision_id                uuid null,
  superseded_decision_ids    uuid[] not null default '{}',
  subject_transaction_ids    uuid[] not null default '{}',
  retained_obligation_ids    uuid[] not null default '{}',
  committed_input_version    bigint null,
  committed_review_revision  bigint not null,
  created_at                 timestamp with time zone not null default now(),
  constraint card_payment_recovery_actions_pkey primary key (user_id, operation_id),
  constraint card_payment_recovery_actions_action_check
    check (action in ('pair_current', 'confirm_unlinked', 'dismiss_candidate', 'undo_decision', 'reject_suggestion',
                      'defer', 'refresh_retry')),
  constraint card_payment_recovery_actions_outcome_check check (outcome in ('saved', 'unchanged', 'undone', 'queued')),
  constraint card_payment_recovery_actions_hash_check check (payload_hash ~ '^[0-9a-f]{64}$')
);
comment on table public.card_payment_recovery_actions is
  'The receipt of one recovery operation: who, which operation id, the intent and its hash, the revisions the '
  'user saw, what was written, and the versions committed. Written in the transaction of the action itself; '
  'never updated. It records facts of the action, not figures: a figure is always read fresh. '
  'retained_obligation_ids are the obligations on the legs concerned, all of which REMAIN: no action retires one.';

-- ---- Durable refresh queue ------------------------------------------------------------------------------
create table if not exists public.card_payment_recovery_refresh_queue (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  target_version      bigint not null,
  enqueued_at         timestamp with time zone not null default now(),
  available_at        timestamp with time zone not null default now(),
  attempts            integer not null default 0,
  total_failures      bigint not null default 0,
  needs_attention     boolean not null default false,
  last_error_code     text null,
  last_attempt_at     timestamp with time zone null,
  retry_requested_at  timestamp with time zone null,
  lease_token         uuid null,
  lease_owner         uuid null,
  lease_expires_at    timestamp with time zone null,
  constraint card_payment_recovery_refresh_queue_attempts_check check (attempts >= 0 and total_failures >= 0),
  constraint card_payment_recovery_refresh_queue_lease_check check ((lease_token is null) = (lease_expires_at is null))
);
comment on table public.card_payment_recovery_refresh_queue is
  'One row per owner whose card-payment states must be evaluated again: target_version is the input version '
  'the work was registered for (the greatest, when coalesced). Written by the trigger on '
  'card_payment_eval_versions for owners with review obligations, by an action that committed without a fresh '
  'evaluation, and by an explicit refresh request. A worker claims it under a lease; the row is removed only '
  'when an evaluation at or after target_version is published.';
create index if not exists card_payment_recovery_refresh_queue_available_idx
  on public.card_payment_recovery_refresh_queue (available_at);

-- ---- Review revision and semantic invalidation ----------------------------------------------------------
create or replace function public.card_payment_review_touch(p_user_id uuid) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_user_id is null then
    return;
  end if;
  begin
    insert into public.card_payment_review_revisions (user_id, revision) values (p_user_id, 1)
    on conflict (user_id) do update set revision = public.card_payment_review_revisions.revision + 1;
  exception when foreign_key_violation then
    null; -- the user row is being deleted in this transaction
  end;
end;
$$;

-- Obligations and known edges are MATCHING INPUTS: a new one changes what the evaluator publishes, so it makes
-- the owner stale in the writer's transaction, like every other input. Sources and annotations are not.
create or replace function public.card_payment_review_inputs_changed() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in select distinct n.user_id from new_rows n loop
    perform public.card_payment_bump(v_user);
    perform public.card_payment_review_touch(v_user);
  end loop;
  return null;
end;
$$;

create or replace function public.card_payment_review_notes_changed() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in select distinct n.user_id from new_rows n loop
    perform public.card_payment_review_touch(v_user);
  end loop;
  return null;
end;
$$;

drop trigger if exists card_payment_review_obligations_changed on public.card_payment_review_obligations;
create trigger card_payment_review_obligations_changed
  after insert on public.card_payment_review_obligations
  referencing new table as new_rows
  for each statement execute function public.card_payment_review_inputs_changed();
drop trigger if exists card_payment_review_memberships_changed on public.card_payment_review_memberships;
create trigger card_payment_review_memberships_changed
  after insert on public.card_payment_review_memberships
  referencing new table as new_rows
  for each statement execute function public.card_payment_review_inputs_changed();
drop trigger if exists card_payment_review_obligation_sources_changed on public.card_payment_review_obligation_sources;
create trigger card_payment_review_obligation_sources_changed
  after insert on public.card_payment_review_obligation_sources
  referencing new table as new_rows
  for each statement execute function public.card_payment_review_notes_changed();
drop trigger if exists card_payment_review_annotations_changed on public.card_payment_review_annotations;
create trigger card_payment_review_annotations_changed
  after insert on public.card_payment_review_annotations
  referencing new table as new_rows
  for each statement execute function public.card_payment_review_notes_changed();

-- Durable refresh: whenever the inputs of an owner who has review obligations change, the work is registered
-- in the WRITER's transaction — whatever the writer was (a sync, an account setting, a decision, a removal).
-- The queue row is taken after the version row (L2), which the writer already holds.
create or replace function public.card_payment_recovery_enqueue() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.input_version is not distinct from old.input_version then
    return null;
  end if;
  if not exists (select 1 from public.card_payment_review_obligations o where o.user_id = new.user_id) then
    return null;
  end if;
  insert into public.card_payment_recovery_refresh_queue (user_id, target_version)
  values (new.user_id, new.input_version)
  on conflict (user_id) do update
    set target_version = greatest(public.card_payment_recovery_refresh_queue.target_version, excluded.target_version);
  return null;
end;
$$;

drop trigger if exists card_payment_recovery_enqueue on public.card_payment_eval_versions;
create trigger card_payment_recovery_enqueue
  after insert or update of input_version on public.card_payment_eval_versions
  for each row execute function public.card_payment_recovery_enqueue();

-- ---- Capture: what a removal knows about the payments that survive it ------------------------------------
-- Called by remove_plaid_item_local ONLY, inside its preservation block, after the plan (pg_temp.rpp_plan) was
-- written with its provenance and before anything is deleted. It reads the evaluator's scratch tables of the
-- strict evaluation the removal has just run in this transaction (pg_temp.cpe_pool, cpe_txn, cpe_tier1,
-- cpe_dismissed): the COMPLETE pool, accounts excluded from cash flow included, as it was before the guard
-- withheld anything. Called anywhere else it fails (the scratch tables do not exist) and writes nothing.
--
-- WHO IS AFFECTED is read from that GRAPH, not from the decisions the removal happens to write:
--   THE CUT   every tier 1 edge (the evaluator's edge rule: both legs in the pool, opposite sides, exactly
--             opposite cents, at most 5 days apart, not dismissed by the user) between a leg on an account that
--             STAYS and a leg on an account of the item being REMOVED. The staying leg is an AFFECTED PAYMENT; the
--             removed leg is a SOURCE of its obligation. Whether the removal writes a hold or a record for that
--             payment makes no difference: a payment whose only candidates are all removed gets neither, and is
--             affected all the same.
--   and the surviving leg of every user-confirmed pair the removal preserves (the plan's step a). A user
--   decision holds that leg, so it is not in the pool and has no edge.
-- A source the removal ALSO wrote a decision for (the removed partner of a record, the removed candidate of a
-- hold, the removed leg of a preserved confirmation) is represented by that decision's source row, with its
-- provenance, as before. A source it wrote no decision for gets ONE row of kind graph_source: no decision is
-- invented for it and nothing is added to 20261008120000's provenance tables. Two removed transactions are two
-- sources, whatever they have in common.
-- COMPLETENESS is checked against the graph, counted a second time straight from the pool — not against the
-- plan, which is empty exactly when it matters.
create or replace function public.card_payment_review_capture(p_user_id uuid, p_removal_id uuid) returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item uuid;
  v_planned bigint;
  v_sourced bigint;
  v_cut bigint;
  v_cut_again bigint;
  v_graph_sourced bigint;
  v_uncovered bigint;
begin
  select pr.item_id into v_item from public.plaid_item_removals pr where pr.id = p_removal_id and pr.user_id = p_user_id;
  if not found then
    raise exception 'card_payment_review_capture: no such removal for this user';
  end if;

  -- THE CUT, once, as a scratch table of this transaction: (surviving leg, removed leg) for every tier 1 edge
  -- that crosses the removal. Ownership is read from the items: both must be this user's.
  create temporary table if not exists pg_temp.crc_cut (
    anchor_id uuid not null, anchor_account uuid not null, anchor_plaid text not null, anchor_cents bigint not null,
    anchor_credit boolean not null,
    source_id uuid not null, source_account uuid not null, source_relation text not null,
    primary key (anchor_id, source_id)
  ) on commit drop;
  truncate pg_temp.crc_cut;
  insert into pg_temp.crc_cut
    (anchor_id, anchor_account, anchor_plaid, anchor_cents, anchor_credit, source_id, source_account, source_relation)
  select o.id, o.account_id, ot.plaid, o.cents, o.credit, rc.id, rc.account_id,
         case when t1.partner = rc.id then 'automatic_partner' else 'removed_candidate' end
  from pg_temp.cpe_pool o
  join pg_temp.cpe_txn ot on ot.id = o.id
  join public.accounts oa on oa.id = o.account_id
  join public.plaid_items oi on oi.id = oa.item_id
  join pg_temp.cpe_pool rc on rc.id <> o.id and rc.credit <> o.credit and rc.cents = -o.cents and abs(o.day - rc.day) <= 5
  join public.accounts ra on ra.id = rc.account_id
  join public.plaid_items ri on ri.id = ra.item_id
  left join pg_temp.cpe_tier1 t1 on t1.id = o.id
  where oi.user_id = p_user_id and oi.id <> v_item
    and ri.user_id = p_user_id and ri.id = v_item
    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));
  get diagnostics v_cut = row_count;

  -- One obligation per (affected payment, this removal): the staying leg of every edge of the cut, and the leg
  -- the removed transaction mattered to in every decision of the plan — the owner of a hold (the cash leg when a
  -- card leg was removed, the card leg when a cash leg was), the cash leg of a record, the surviving leg of a
  -- preserved confirmation.
  insert into public.card_payment_review_obligations
    (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, anchor_side, origin, removal_id, completeness)
  select distinct p_user_id, x.anchor_account, x.anchor_plaid, x.anchor_cents, x.anchor_side, 'captured', p_removal_id, 'complete'
  from (
    select c.anchor_account, c.anchor_plaid, c.anchor_cents, case when c.anchor_credit then 'credit' else 'cash' end as anchor_side
    from pg_temp.crc_cut c
    union
    select case when p.kind = 'ambiguity_hold_removed_card' then p.b_account else p.a_account end,
           case when p.kind = 'ambiguity_hold_removed_card' then p.b_plaid else p.a_plaid end,
           case when p.kind = 'ambiguity_hold_removed_card' then p.b_cents else p.a_cents end,
           case p.kind
             when 'ambiguity_hold_removed_card' then 'cash'
             when 'ambiguity_hold_removed_cash_account' then 'credit'
             when 'destination_removed_card' then 'cash'
             else case when coalesce(a.type = 'credit', false) then 'credit' else 'cash' end
           end
    from pg_temp.rpp_plan p
    join public.accounts a on a.id = p.a_account
  ) x;

  -- Its decision-backed sources: one row per decision the removal wrote, with the removed transaction that
  -- decision depends on (from its provenance row, written just before). A and B stay two rows.
  insert into public.card_payment_review_obligation_sources
    (obligation_id, user_id, evidence_kind, decision_id, decision_kind, source_removal_id, source_plaid_account_id,
     source_plaid_transaction_id, source_relation, source_date, source_cents)
  select o.id, p_user_id,
         case p.kind when 'destination_removed_card' then 'removed_destination'
                     when 'pair_counterpart_removed' then 'preserved_confirmation' else 'ambiguity_hold' end,
         p.decision_id, p.kind, s.removal_id, s.source_plaid_account_id, s.source_plaid_transaction_id, s.source_relation,
         s.source_date, s.source_cents
  from pg_temp.rpp_plan p
  join public.card_payment_removal_sources s on s.decision_id = p.decision_id
  join public.card_payment_review_obligations o
    on o.user_id = p_user_id and o.removal_id = p_removal_id and o.gap_reason is null
   and o.anchor_account_id = case when p.kind = 'ambiguity_hold_removed_card' then p.b_account else p.a_account end
   and o.anchor_plaid_transaction_id = case when p.kind = 'ambiguity_hold_removed_card' then p.b_plaid else p.a_plaid end
   and o.anchor_cents = case when p.kind = 'ambiguity_hold_removed_card' then p.b_cents else p.a_cents end;
  get diagnostics v_sourced = row_count;
  select count(*) into v_planned from pg_temp.rpp_plan;
  if v_sourced <> v_planned then
    raise exception 'card_payment_review_capture: % decisions were planned, % given a review obligation', v_planned, v_sourced;
  end if;

  -- Its graph-observed sources: every removed leg of the cut that NO decision of this removal on this payment
  -- names (the plan row carries the removed row's id, so this is an identity, not a likeness). Read from the
  -- rows that are still there, in the shape 20261008120000 records a source.
  insert into public.card_payment_review_obligation_sources
    (obligation_id, user_id, evidence_kind, decision_id, decision_kind, source_removal_id, source_plaid_account_id,
     source_plaid_transaction_id, source_relation, source_date, source_cents)
  select o.id, p_user_id, 'graph_source', null, null, p_removal_id, sa.plaid_account_id, st.plaid_transaction_id,
         c.source_relation, st.date, (st.amount * 100)::bigint
  from pg_temp.crc_cut c
  join public.card_payment_review_obligations o
    on o.user_id = p_user_id and o.removal_id = p_removal_id and o.gap_reason is null
   and o.anchor_account_id = c.anchor_account and o.anchor_plaid_transaction_id = c.anchor_plaid and o.anchor_cents = c.anchor_cents
  join public.transactions st on st.id = c.source_id
  join public.accounts sa on sa.id = c.source_account
  where not exists (
    select 1 from pg_temp.rpp_plan p
    where p.source_txn = c.source_id
      and c.anchor_account = case when p.kind = 'ambiguity_hold_removed_card' then p.b_account else p.a_account end
      and c.anchor_plaid = case when p.kind = 'ambiguity_hold_removed_card' then p.b_plaid else p.a_plaid end
      and c.anchor_cents = case when p.kind = 'ambiguity_hold_removed_card' then p.b_cents else p.a_cents end);
  get diagnostics v_graph_sourced = row_count;

  -- COMPLETENESS, against the graph. The cut is counted again, straight from the pool, in another formulation
  -- (from the removed side); and every edge of it must now be represented: an obligation on its staying leg,
  -- and its removed leg as a source of that obligation — a decision's, or its own row.
  select count(*) into v_cut_again
  from pg_temp.cpe_pool rc
  join public.accounts ra on ra.id = rc.account_id and ra.item_id = v_item
  join pg_temp.cpe_pool o on o.id <> rc.id and o.credit <> rc.credit and o.cents = -rc.cents and abs(rc.day - o.day) <= 5
  join public.accounts oa on oa.id = o.account_id and oa.item_id <> v_item
  where not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));
  select count(*) into v_uncovered
  from pg_temp.crc_cut c
  join public.transactions st on st.id = c.source_id
  join public.accounts sa on sa.id = c.source_account
  where not exists (
    select 1
    from public.card_payment_review_obligations o
    join public.card_payment_review_obligation_sources s on s.obligation_id = o.id
    where o.user_id = p_user_id and o.removal_id = p_removal_id and o.gap_reason is null and o.origin = 'captured'
      and o.anchor_account_id = c.anchor_account and o.anchor_plaid_transaction_id = c.anchor_plaid and o.anchor_cents = c.anchor_cents
      and s.source_removal_id = p_removal_id
      and s.source_plaid_account_id = sa.plaid_account_id
      and s.source_plaid_transaction_id = st.plaid_transaction_id);
  if v_cut_again <> v_cut or v_uncovered <> 0 then
    raise exception 'card_payment_review_capture: the removal cuts % eligible edges (% counted again); % of them were given no obligation and source',
      v_cut, v_cut_again, v_uncovered;
  end if;

  -- Its surviving edges: EVERY tier 1 edge of the affected payment to a leg that stays, from the complete pool
  -- (the same edge rule). Not only the pairs a hold was written for, and not from the published states. A leg
  -- that a user decision holds is not in the pool and has no edge.
  insert into public.card_payment_review_memberships
    (obligation_id, user_id, member_account_id, member_plaid_transaction_id, member_cents, observed_from)
  select distinct o.id, p_user_id, y.account_id, yt.plaid, y.cents, 'captured_graph'
  from public.card_payment_review_obligations o
  join pg_temp.cpe_txn at on at.account_id = o.anchor_account_id and at.plaid = o.anchor_plaid_transaction_id
  join pg_temp.cpe_pool ap on ap.id = at.id
  join pg_temp.cpe_pool y on y.id <> ap.id and y.credit <> ap.credit and y.cents = -ap.cents and abs(ap.day - y.day) <= 5
  join pg_temp.cpe_txn yt on yt.id = y.id
  join public.accounts ya on ya.id = y.account_id
  where o.user_id = p_user_id and o.removal_id = p_removal_id and o.origin = 'captured'
    and ya.item_id <> v_item
    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(ap.id, y.id) and dd.hi = greatest(ap.id, y.id));

  -- Gaps: a removal of this user that recorded no sources (its marker was written a moment ago, or earlier)
  -- may have merged what it knew into any row that was live then. Every affected payment whose evidence is
  -- older than such a marker gets that gap, as its own obligation.
  perform public.card_payment_review_record_gaps(p_user_id);
  return v_sourced + v_graph_sourced;
end;
$$;

-- The gaps of one user (or of every user), from what is retained now. Idempotent.
create or replace function public.card_payment_review_record_gaps(p_user_id uuid default null) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- A removal that finished without recording its sources and has its marker: it casts doubt on every
  -- obligation written before it (a lower ordinal, or no generation at all).
  insert into public.card_payment_review_obligations
    (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, anchor_side, origin, removal_id, gap_reason, completeness)
  select distinct o.user_id, o.anchor_account_id, o.anchor_plaid_transaction_id, o.anchor_cents, o.anchor_side,
         'gap', g.removal_id, 'unrecorded_removal', 'unknown'
  from public.card_payment_review_obligations o
  join public.card_payment_removal_generations g on g.user_id = o.user_id and not g.sources_recorded
  left join public.card_payment_removal_generations og on og.removal_id = o.removal_id
  where (p_user_id is null or o.user_id = p_user_id)
    and o.origin <> 'gap'
    and (og.ordinal is null or og.ordinal < g.ordinal)
  on conflict do nothing;

  -- A cleaned removal with no generation row at all: when it ran is not known, so it casts doubt on every
  -- obligation of its user.
  insert into public.card_payment_review_obligations
    (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, anchor_side, origin, removal_id, gap_reason, completeness)
  select distinct o.user_id, o.anchor_account_id, o.anchor_plaid_transaction_id, o.anchor_cents, o.anchor_side,
         'gap', pr.id, 'unrecorded_removal', 'unknown'
  from public.card_payment_review_obligations o
  join public.plaid_item_removals pr on pr.user_id = o.user_id and pr.status = 'cleaned'
  where (p_user_id is null or o.user_id = p_user_id)
    and o.origin <> 'gap'
    and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = pr.id)
  on conflict do nothing;
end;
$$;

-- Seeding: review obligations for what earlier removals left, from the decisions and provenance rows that are
-- ACTUALLY RETAINED. One obligation per (affected payment, removal); a decision with no provenance row belongs
-- to an obligation with no removal and adds a gap. A hold names ONE surviving edge, and that is all that is
-- recorded: no other edge is inferred. Idempotent: a decision that already has a source row is skipped.
create or replace function public.card_payment_review_seed_retained() returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_seeded bigint;
begin
  create temporary table if not exists pg_temp.crs_evidence (
    decision_id uuid primary key, user_id uuid not null, kind text not null,
    anchor_account uuid not null, anchor_plaid text not null, anchor_cents bigint not null, anchor_side text not null,
    member_account uuid, member_plaid text, member_cents bigint,
    removal_id uuid, source_plaid_account_id text, source_plaid_transaction_id text, source_relation text,
    source_date date, source_cents bigint
  ) on commit drop;
  truncate pg_temp.crs_evidence;

  insert into pg_temp.crs_evidence
  select d.id, d.user_id, d.kind,
         case when d.kind = 'ambiguity_hold_removed_card' then d.b_account_id else d.a_account_id end,
         case when d.kind = 'ambiguity_hold_removed_card' then d.b_plaid_transaction_id else d.a_plaid_transaction_id end,
         case when d.kind = 'ambiguity_hold_removed_card' then d.b_cents else d.a_cents end,
         case d.kind
           when 'ambiguity_hold_removed_card' then 'cash'
           when 'ambiguity_hold_removed_cash_account' then 'credit'
           when 'destination_removed_card' then 'cash'
           else case when coalesce(a.type = 'credit', false) then 'credit' else 'cash' end
         end,
         case d.kind when 'ambiguity_hold_removed_card' then d.a_account_id when 'ambiguity_hold_removed_cash_account' then d.b_account_id end,
         case d.kind when 'ambiguity_hold_removed_card' then d.a_plaid_transaction_id when 'ambiguity_hold_removed_cash_account' then d.b_plaid_transaction_id end,
         case d.kind when 'ambiguity_hold_removed_card' then d.a_cents when 'ambiguity_hold_removed_cash_account' then d.b_cents end,
         s.removal_id, s.source_plaid_account_id, s.source_plaid_transaction_id, s.source_relation, s.source_date, s.source_cents
  from public.card_payment_decisions d
  join public.accounts a on a.id = d.a_account_id
  left join public.card_payment_removal_sources s on s.decision_id = d.id
  where d.kind in ('pair_counterpart_removed', 'destination_removed_card',
                   'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
    and not exists (select 1 from public.card_payment_review_obligation_sources x where x.decision_id = d.id);
  get diagnostics v_seeded = row_count;

  insert into public.card_payment_review_obligations
    (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, anchor_side, origin, removal_id, completeness)
  select distinct e.user_id, e.anchor_account, e.anchor_plaid, e.anchor_cents, e.anchor_side, 'seeded', e.removal_id, 'observed_only'
  from pg_temp.crs_evidence e
  on conflict do nothing;

  insert into public.card_payment_review_obligation_sources
    (obligation_id, user_id, evidence_kind, decision_id, decision_kind, source_removal_id, source_plaid_account_id,
     source_plaid_transaction_id, source_relation, source_date, source_cents)
  select o.id, e.user_id,
         case e.kind when 'destination_removed_card' then 'removed_destination'
                     when 'pair_counterpart_removed' then 'preserved_confirmation' else 'ambiguity_hold' end,
         e.decision_id, e.kind, e.removal_id, e.source_plaid_account_id, e.source_plaid_transaction_id, e.source_relation,
         e.source_date, e.source_cents
  from pg_temp.crs_evidence e
  join public.card_payment_review_obligations o
    on o.user_id = e.user_id and o.gap_reason is null and o.removal_id is not distinct from e.removal_id
   and o.anchor_account_id = e.anchor_account and o.anchor_plaid_transaction_id = e.anchor_plaid and o.anchor_cents = e.anchor_cents;

  insert into public.card_payment_review_memberships
    (obligation_id, user_id, member_account_id, member_plaid_transaction_id, member_cents, observed_from)
  select distinct o.id, e.user_id, e.member_account, e.member_plaid, e.member_cents, 'ambiguity_hold'
  from pg_temp.crs_evidence e
  join public.card_payment_review_obligations o
    on o.user_id = e.user_id and o.gap_reason is null and o.removal_id is not distinct from e.removal_id
   and o.anchor_account_id = e.anchor_account and o.anchor_plaid_transaction_id = e.anchor_plaid and o.anchor_cents = e.anchor_cents
  where e.member_account is not null
  on conflict do nothing;

  -- A decision with no provenance row: its source is not known. Its own gap, on its payment.
  insert into public.card_payment_review_obligations
    (user_id, anchor_account_id, anchor_plaid_transaction_id, anchor_cents, anchor_side, origin, removal_id, gap_reason, completeness)
  select distinct e.user_id, e.anchor_account, e.anchor_plaid, e.anchor_cents, e.anchor_side, 'gap', null::uuid, 'unattributed_decision', 'unknown'
  from pg_temp.crs_evidence e
  where e.removal_id is null
  on conflict do nothing;

  perform public.card_payment_review_record_gaps(null);
  return v_seeded;
end;
$$;

-- ---- The removal: 20261008120000's body, with the capture --------------------------------------------------
create or replace function public.remove_plaid_item_local(p_user_id uuid, p_item_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_removal public.plaid_item_removals;
  v_item_status text;
  v_institution_id text;
  v_planned bigint;
  v_written bigint;
  v_recorded bigint;
  v_adjustments jsonb;
  v_counts jsonb;
  v_evaluated bigint;
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

  select pi.status, pi.institution_id into v_item_status, v_institution_id from public.plaid_items pi
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

  -- The item's ACCOUNT rows, locked now, in id order, with the lock their delete will take — BEFORE the
  -- evaluation below takes the user's version row. The body this one replaces reached these rows (its
  -- cascade's delete) before its first version bump; taking them first keeps that order. A direct statement
  -- that holds one of them and then bumps the version (the account-settings update; an insert that
  -- references the account) therefore makes this function wait, as it always did, instead of closing a cycle.
  perform 1 from public.accounts a where a.item_id = p_item_id order by a.id for update;

  -- Card-payment matching, part 1 (design §4.7, T9): BEFORE anything is deleted.
  -- The matching states of the rows as they are now, computed here: never the stored ones, which may be
  -- stale or may not exist. STRICT: if matching cannot be evaluated, what is known about the destinations
  -- of the surviving payments cannot be preserved, so nothing is removed. From here to the end of this
  -- transaction the evaluator's lock on the user's version row keeps every other writer's input change
  -- from committing.
  begin
    v_evaluated := public.evaluate_card_payments(p_user_id);
  exception when others then
    raise exception 'remove_plaid_item_local: card-payment matching could not be evaluated before the removal (SQLSTATE %); nothing was removed', sqlstate
      using errcode = sqlstate;
  end;

  -- Preserve what is known before anything is deleted (20261006120000's header, step 3; this file's header,
  -- THE FUNCTION): three statements plan it, and the plan is written with its provenance.
  begin
    -- Provenance (20261008120000). First, every EARLIER removal of this user that finished without recording
    -- any — before this body existed, or while it was rolled back — gets its MARKER now, under the user's
    -- advisory lock. Such a removal merged by pair and date: it may have left what it knew on a row an older
    -- removal wrote. The marker's place in the user's order (its ordinal, assigned by the table's trigger)
    -- says which rows those can be: every one that was written before it.
    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)
    select pr.id, pr.user_id, false
    from public.plaid_item_removals pr
    where pr.user_id = p_user_id and pr.status = 'cleaned'
      and not exists (select 1 from public.card_payment_removal_generations g where g.removal_id = pr.id)
    order by pr.cleaned_at, pr.id;

    -- Then the GENERATION of this removal, once. Its primary key is the removal's id, so a second execution
    -- for one removal cannot write a second set of rows: it would fail here, and the handler below turns that
    -- into the refusal that removes nothing.
    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)
    values (v_removal.id, p_user_id, true, v_institution_id);

    -- The PLAN: one row per decision this removal is about to write, with the id that decision will have and
    -- the removed transaction it depends on (its source). (a), (b) and (c) below fill it; then it is written
    -- twice: the decisions, and one provenance row for each. A scratch table of this transaction, like the
    -- evaluator's.
    create temporary table if not exists pg_temp.rpp_plan (
      decision_id uuid primary key,
      step text not null,
      kind text not null,
      a_account uuid not null, a_plaid text not null, a_cents bigint not null,
      b_account uuid, b_plaid text, b_cents bigint,
      accepted_difference_cents bigint, counterpart_status text, counterpart_date date,
      decided_seq bigint, created_at timestamp with time zone,
      source_relation text not null,
      source_account uuid not null, source_txn uuid, source_plaid text not null,
      ord uuid not null
    ) on commit drop;
    truncate pg_temp.rpp_plan;

    -- (a) USER-CONFIRMED pairs with one leg on an account of THIS item and the other on an account of
    -- another item of this user. The cascade below deletes the pair; the user's confirmation is kept first,
    -- as a USER decision on the leg that survives — whichever side that is, and whether the pair is active
    -- or not. counterpart_status freezes what was true of the removed side: 'valid' when the evaluation
    -- above found the pair active; otherwise the removed leg's own status, and, if that leg is valid,
    -- whether the two legs still relate as recorded (sides, direction, accepted difference).
    -- NOT a pair one of whose legs the USER re-classified away from card payment: that newer explicit
    -- action supersedes the confirmation, which is not carried forward.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, b_plaid, b_cents,
       accepted_difference_cents, counterpart_status, decided_seq, created_at,
       source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'a', 'pair_counterpart_removed', o.sv_account, o.sv_plaid, o.sv_cents, o.rm_plaid, o.rm_cents,
           d.accepted_difference_cents,
           case
             when ds.status = 'active' then 'valid'
             when ds.detail = 'conflicting_decisions' then 'conflicting_decisions'
             else coalesce(
               nullif(public.card_payment_reference_status(o.rm_account, o.rm_plaid, o.rm_cents, now()), 'valid'),
               case
                 when coalesce(sa.type = 'credit', false) = coalesce(ra.type = 'credit', false) then 'sides_not_opposite'
                 when sign(o.sv_cents::numeric) <> -sign(o.rm_cents::numeric) then 'direction_mismatch'
                 when (case when coalesce(sa.type = 'credit', false) then abs(o.rm_cents) - abs(o.sv_cents)
                            else abs(o.sv_cents) - abs(o.rm_cents) end) <> d.accepted_difference_cents then 'difference_not_accepted'
                 else 'valid'
               end)
           end,
           d.decided_seq, d.created_at,
           'confirmed_counterpart', o.rm_account, public.card_payment_lineage_row(o.rm_account, o.rm_plaid), o.rm_plaid, d.id
    from public.card_payment_decisions d
    cross join lateral (values
      (d.a_account_id, d.a_plaid_transaction_id, d.a_cents, d.b_account_id, d.b_plaid_transaction_id, d.b_cents),
      (d.b_account_id, d.b_plaid_transaction_id, d.b_cents, d.a_account_id, d.a_plaid_transaction_id, d.a_cents)
    ) as o(sv_account, sv_plaid, sv_cents, rm_account, rm_plaid, rm_cents)
    join public.accounts sa on sa.id = o.sv_account
    join public.plaid_items si on si.id = sa.item_id
    join public.accounts ra on ra.id = o.rm_account
    join public.plaid_items ri on ri.id = ra.item_id
    left join public.card_payment_decision_states ds
      on ds.user_id = p_user_id and ds.decision_id = d.id and ds.computed_at_version = v_evaluated
    where d.user_id = p_user_id and d.kind = 'pair' and d.superseded_by is null
      and si.user_id = p_user_id and si.id <> p_item_id
      and ri.user_id = p_user_id and ri.id = p_item_id
      and not exists (select 1 from public.transactions t
                      where ((t.account_id = d.a_account_id and d.a_plaid_transaction_id in (t.plaid_transaction_id, t.pending_transaction_id))
                          or (t.account_id = d.b_account_id and d.b_plaid_transaction_id in (t.plaid_transaction_id, t.pending_transaction_id)))
                        and t.user_role_override is not null and t.user_role_override <> 'credit_card_payment')
    order by d.id;

    -- (b) AUTOMATIC pairs. A cash-side leg of ANOTHER item of this user that the evaluation above paired by
    -- tier 1 (a partner, and no decision) with a leg on an account of THIS item: the pair was the evidence
    -- of where that money went, and it is about to be deleted. Record the known destination on the surviving
    -- leg, by its lineage key (its account, its own Plaid id, its cents), as the system decision the
    -- evaluator ranks below every user decision and every tier 1 pair. A leg with no partner gets no
    -- destination: removal is not evidence ((c) keeps the removal from resolving it the other way either).
    -- A leg held by a user decision is (a)'s, or stays as it is.
    -- ONE RECORD PER REMOVED PARTNER (20261008120000). The record depends on THAT transaction, and its
    -- provenance row says so. A live record that an earlier removal wrote for this leg is not reused and does
    -- not suppress this one: it depends on another source. Several live records on one leg read as one.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'b', 'destination_removed_card', t.account_id, t.plaid_transaction_id, s.amount_cents,
           'automatic_partner', pt.account_id, pt.id, pt.plaid_transaction_id, t.id
    from public.card_payment_leg_states s
    join public.transactions t on t.id = s.transaction_id
    join public.accounts ca on ca.id = t.account_id
    join public.plaid_items ci on ci.id = ca.item_id
    join public.transactions pt on pt.id = s.partner_transaction_id
    join public.accounts pa on pa.id = pt.account_id
    join public.plaid_items pi on pi.id = pa.item_id
    where s.user_id = p_user_id
      and s.computed_at_version = v_evaluated
      and s.side = 'cash'
      and s.partner_transaction_id is not null
      and s.decision_id is null
      and ci.user_id = p_user_id and ci.id <> p_item_id
      and pi.user_id = p_user_id and pi.id = p_item_id
    order by t.id;

    -- (c) AMBIGUITY HOLDS. Removal is not evidence, and deleting a candidate is not evidence either. Read from
    -- the evaluator's COMPLETE POOL, as the evaluation above left it in its scratch tables in this transaction
    -- (pg_temp.cpe_pool, cpe_txn, cpe_tier1, cpe_dismissed) — NOT from the published states. The published
    -- states are a presentation: a leg on an account that is excluded from cash flow takes part in tier 1
    -- like any other but is published not_counted with no candidates, and a payment that an earlier removal's
    -- record or the "no included card" rule decides is published untracked. Any of them can have candidates
    -- on both sides of this removal.
    --   o   the OWNER: a pool leg on an account of ANOTHER item of this user whose automatic match is NOT with
    --       a leg that stays — it has no tier 1 partner at all, or its tier 1 partner is on an account of THIS
    --       item (it was matched automatically to what is being removed);
    --   rc  a tier 1 candidate of o on an account of THIS item — every one of them, also when o has a partner
    --       (which is then the closest of them). At the dates of the removal the partner's hold alone would
    --       do; but the evaluator judges a hold on the dates as they THEN are, and if o itself is later
    --       re-dated (a pending payment that posts on another day) a second removed candidate can be the one
    --       that would still have been closer;
    --   y   a tier 1 candidate of o on an account of another item of this user: a competitor that is already
    --       there, and stays.
    -- For each (o, rc, y): record that the pair (o, y) is not to be formed automatically while the removed
    -- candidate — on the hold only its date is kept — would still have been at least as close to o (the evaluator decides
    -- that, from the dates as they then are). Card-side leg first; the kind says which side the removed
    -- candidate was on. A SYSTEM record: it claims nothing, publishes no effect and names no destination.
    --   * o had no partner: its ambiguity is kept. It stays without an automatic match, as it was.
    --   * o's partner was on THIS item: (b) recorded the known destination of a cash-side o, and this keeps a
    --     card that was already there from taking the payment merely because that destination disappeared.
    --     With tier 1 withheld, the leg reads its record: untracked / removed_card.
    -- A leg whose candidates are all on one side of the removal, or whose automatic match stays, gets nothing.
    -- The candidate test is the evaluator's tier 1 edge and must stay that rule: both legs in the pool,
    -- opposite sides, exactly opposite cents, at most 5 days apart, not dismissed by the user.
    -- (The alias is rc, not r: r is this function's loop record, and PL/pgSQL would read r.id as its field.)
    -- ONE HOLD PER (o, rc, y) (20261008120000). Each removed candidate is a dependency of its own: two removed
    -- candidates with the same date are two holds, and a hold that an earlier removal wrote on the same pair
    -- with the same date is neither reused nor a reason to write none. Identical live holds withhold as one.
    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, b_account, b_plaid, b_cents, counterpart_date,
       source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'c', h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date,
           h.source_relation, h.source_account, h.source_txn, h.source_plaid, h.source_txn
    from (
      select case when not o.credit then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,
             case when o.credit then o.account_id else y.account_id end as a_account,
             case when o.credit then ot.plaid else yt.plaid end as a_plaid,
             case when o.credit then o.cents else y.cents end as a_cents,
             case when o.credit then y.account_id else o.account_id end as b_account,
             case when o.credit then yt.plaid else ot.plaid end as b_plaid,
             case when o.credit then y.cents else o.cents end as b_cents,
             case when t1.partner = rc.id then 'automatic_partner' else 'removed_candidate' end as source_relation,
             rc.account_id as source_account, rc.id as source_txn, rt.plaid as source_plaid,
             rt.date as removed_date
      from pg_temp.cpe_pool o
      join pg_temp.cpe_txn ot on ot.id = o.id
      join public.accounts oa on oa.id = o.account_id
      join public.plaid_items oi on oi.id = oa.item_id
      left join pg_temp.cpe_tier1 t1 on t1.id = o.id
      left join pg_temp.cpe_pool tp on tp.id = t1.partner
      left join public.accounts pa on pa.id = tp.account_id
      join pg_temp.cpe_pool rc on rc.id <> o.id and rc.credit <> o.credit and rc.cents = -o.cents and abs(o.day - rc.day) <= 5
      join pg_temp.cpe_txn rt on rt.id = rc.id
      join public.accounts ra on ra.id = rc.account_id
      join public.plaid_items ri on ri.id = ra.item_id
      join pg_temp.cpe_pool y on y.id <> o.id and y.credit <> o.credit and y.cents = -o.cents and abs(o.day - y.day) <= 5
      join pg_temp.cpe_txn yt on yt.id = y.id
      join public.accounts ya on ya.id = y.account_id
      join public.plaid_items yi on yi.id = ya.item_id
      where oi.user_id = p_user_id and oi.id <> p_item_id
        and ri.user_id = p_user_id and ri.id = p_item_id
        and yi.user_id = p_user_id and yi.id <> p_item_id
        and (t1.partner is null or pa.item_id = p_item_id)
        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id))
        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, y.id) and dd.hi = greatest(o.id, y.id))
    ) h;

    -- Write the plan. First the decisions, with the columns and in the order each statement used before; each
    -- gets the id the plan gave it. (Holds that differ only in their source are ordered by its Plaid id.)
    insert into public.card_payment_decisions
      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,
       accepted_difference_cents, counterpart_status, decided_seq, created_at)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents, p.b_plaid, p.b_cents,
           p.accepted_difference_cents, p.counterpart_status, p.decided_seq, p.created_at
    from pg_temp.rpp_plan p
    where p.step = 'a'
    order by p.ord;
    get diagnostics v_written = row_count;
    insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents
    from pg_temp.rpp_plan p
    where p.step = 'b'
    order by p.ord;
    get diagnostics v_recorded = row_count;
    v_written := v_written + v_recorded;
    insert into public.card_payment_decisions
      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,
       counterpart_date)
    select p.decision_id, p_user_id, p.kind, p.a_account, p.a_plaid, p.a_cents, p.b_account, p.b_plaid, p.b_cents,
           p.counterpart_date
    from pg_temp.rpp_plan p
    where p.step = 'c'
    order by p.kind, p.a_account, p.a_plaid, p.b_account, p.b_plaid, p.counterpart_date, p.source_plaid collate "C";
    get diagnostics v_recorded = row_count;
    v_written := v_written + v_recorded;

    -- Then, for every one of them, its provenance: this removal, the removed account and the removed
    -- transaction. ALL of it is read HERE, in this one statement, from the rows that are still there — so rows
    -- that share a source describe it identically. The delete below takes those rows; this is what remains of
    -- them. For a confirmed pair whose reference resolved to no single row, what was there instead is
    -- recorded: several rows (ambiguous), an unconsumed carry-over of the removed pending row (its date and
    -- amount), or nothing. For a system row there is no such case: the table's trigger refuses it.
    insert into public.card_payment_removal_sources
      (decision_id, user_id, removal_id, source_relation, source_resolution, source_plaid_account_id,
       source_plaid_transaction_id, source_pending_transaction_id, source_pending, source_date, source_cents,
       source_iso_currency_code, source_account_type, source_account_subtype, source_account_mask)
    select p.decision_id, p_user_id, v_removal.id, p.source_relation,
           case when st.id is not null then 'row'
                when named.n > 0 then 'ambiguous'
                when co.id is not null then 'waiting_to_post'
                else 'gone' end,
           sa.plaid_account_id,
           st.plaid_transaction_id, st.pending_transaction_id,
           case when st.id is not null then coalesce(st.pending, false) end,
           case when st.id is not null then st.date when named.n = 0 then co.pending_date end,
           case when st.id is not null then (st.amount * 100)::bigint when named.n = 0 then (co.pending_amount * 100)::bigint end,
           st.iso_currency_code, sa.type, sa.subtype, sa.mask
    from pg_temp.rpp_plan p
    join public.accounts sa on sa.id = p.source_account
    left join public.transactions st on st.id = p.source_txn
    cross join lateral (select count(*) as n from public.transactions x
                        where st.id is null and x.account_id = p.source_account
                          and p.source_plaid in (x.plaid_transaction_id, x.pending_transaction_id)) named
    left join public.transaction_carryovers co
      on st.id is null and co.account_id = p.source_account and co.pending_plaid_transaction_id = p.source_plaid
     and co.consumed_at is null and co.expires_at > now();
    get diagnostics v_recorded = row_count;
    -- No decision without its provenance, and no planned decision unwritten: anything else removes nothing.
    select count(*) into v_planned from pg_temp.rpp_plan;
    if v_written <> v_planned or v_recorded <> v_planned then
      raise exception 'remove_plaid_item_local: % decisions were planned, % written, % given a provenance row',
        v_planned, v_written, v_recorded;
    end if;

    -- Review obligations (20261009120000): what this removal knows about the payments that survive it — one
    -- obligation per affected payment (every surviving leg of an eligible edge this removal cuts, whether or not
    -- a decision was written for it above), its removed sources one by one, and EVERY surviving tier 1 edge of
    -- that payment, read from the evaluator's complete pool while the rows are still there. Inside this block:
    -- if it fails, nothing is removed.
    perform public.card_payment_review_capture(p_user_id, v_removal.id);
  exception when others then
    raise exception 'remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE %); nothing was removed', sqlstate
      using errcode = sqlstate;
  end;

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
  -- access token goes with this row. Card-payment decisions that reference one of its accounts go too
  -- (their account cascade): the pairs converted above, and anything else decided about its legs.
  delete from public.plaid_items where id = p_item_id and user_id = p_user_id;

  update public.plaid_item_removals
  set status = 'cleaned', cleaned_at = now(), loan_adjustments = v_adjustments, deleted_counts = v_counts
  where id = v_removal.id;

  -- Card-payment matching, part 2: the states of what is left, published with the version that includes
  -- every write above — so a removal normally commits fresh states. BEST-EFFORT, in a subtransaction, and
  -- the LAST statement, so nothing after it can make the publication stale. The evidence is preserved and
  -- the removal is done: if this evaluation fails, only it is rolled back. The removal commits, the
  -- version stays ahead of the evaluated one, the SQLSTATE alone is recorded, and the reader returns no
  -- states until a later evaluation succeeds (Trevor's decision, 2026-10-06).
  perform public.try_evaluate_card_payments(p_user_id);

  return jsonb_build_object('replayed', false, 'loan_adjustments', v_adjustments, 'deleted_counts', v_counts);
end;
$$;

-- ---- The evaluator: 20261006110000's body, with the hunks this file's header lists -----------------------
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
  -- The scratch tables below are this function's own, with ONE outside reader: remove_plaid_item_local
  -- (20261006120000) reads cpe_pool, cpe_txn, cpe_tier1 and cpe_dismissed — these names and columns — in its
  -- own transaction, right after its strict call of this function, to derive the ambiguity holds from the
  -- complete pool. A migration that replaces this function must replace, or guard on, that one in the same file.
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
  create temporary table if not exists cpe_hold (owner_id uuid not null, other_id uuid not null, day integer not null) on commit drop;
  -- The relink-review guard (20261009120000): the review obligations whose affected payment resolves to a
  -- current row, the surviving edges each of them positively lists, and the automatic pairs the guard withholds
  -- (both directions, like cpe_tier1).
  create temporary table if not exists cpe_review_anchor (obligation_id uuid not null, row_id uuid not null, gap boolean not null) on commit drop;
  create temporary table if not exists cpe_review_member (obligation_id uuid not null, row_id uuid not null) on commit drop;
  create temporary table if not exists cpe_guard (id uuid primary key, partner uuid not null) on commit drop;
  create temporary table if not exists cpe_tracked (
    cash_account uuid not null, credit_account uuid not null, abs_cents bigint not null, cash_day integer not null,
    credit_day integer not null) on commit drop;
  create temporary table if not exists cpe_state (
    id uuid primary key, state text not null, reason text, detail text, partner uuid, decision_id uuid, effect bigint,
    cash_excess bigint not null, card_excess bigint not null, contradictions boolean not null) on commit drop;
  truncate pg_temp.cpe_accounts, pg_temp.cpe_txn, pg_temp.cpe_pool, pg_temp.cpe_named, pg_temp.cpe_dismissed, pg_temp.cpe_removed,
           pg_temp.cpe_udec, pg_temp.cpe_dec_result, pg_temp.cpe_claim, pg_temp.cpe_tier1, pg_temp.cpe_tracked,
           pg_temp.cpe_state, pg_temp.cpe_hold, pg_temp.cpe_review_anchor, pg_temp.cpe_review_member, pg_temp.cpe_guard;

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
        if d.kind not in ('not_this_pair', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
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
          if d.kind not in ('not_this_pair', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
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

    if d.kind in ('ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account') then
      -- A system ambiguity hold (§4.7), written by institution removal on ONE possible pair of two legs that
      -- both survive. Not a user decision: it claims nothing. It applies while both references resolve to
      -- current card legs on opposite sides with the recorded cents; anything else is new evidence, and the
      -- ordinary rules decide alone.
      if v_inactive is null then
        select * into v_ra from pg_temp.cpe_txn t where t.id = v_rows[1];
        select * into v_rb from pg_temp.cpe_txn t where t.id = v_rows[2];
        if v_ra.cents <> d.a_cents or v_rb.cents <> d.b_cents then
          v_inactive := 'amount_changed';
        elsif not v_ra.is_leg or not v_rb.is_leg then
          v_inactive := 'role_changed';
        elsif v_ra.credit = v_rb.credit then
          v_inactive := 'sides_not_opposite';
        end if;
      end if;
      insert into pg_temp.cpe_dec_result values (d.id, d.kind, case when v_inactive is null then 'active' else 'inactive' end, v_inactive);
      if v_inactive is null then
        -- owner: the leg the removed candidate competed for — the cash-side leg when a card leg was removed,
        -- the card-side leg when a cash leg was.
        insert into pg_temp.cpe_hold (owner_id, other_id, day)
        select case when v_ra.credit = (d.kind = 'ambiguity_hold_removed_card') then v_rows[2] else v_rows[1] end,
               case when v_ra.credit = (d.kind = 'ambiguity_hold_removed_card') then v_rows[1] else v_rows[2] end,
               d.counterpart_date - date '1970-01-01';
      end if;
      continue;
    end if;

    if v_inactive is null then
      -- shapeDetail: a preserved pair's frozen disqualifier first (it is about the side that is gone); then, as
      -- for every decision, amount first, then role, then sides / direction / accepted difference.
      select * into v_ra from pg_temp.cpe_txn t where t.id = v_rows[1];
      if d.kind = 'pair' then
        select * into v_rb from pg_temp.cpe_txn t where t.id = v_rows[2];
      else
        v_rb := v_ra; -- keeps the record assigned; only read when kind = pair
      end if;
      if d.kind = 'pair_counterpart_removed' and d.counterpart_status not in ('valid', 'waiting_to_post', 'amount_changed') then
        -- A preserved pair (§4.7) whose REMOVED side was invalid for a reason other than its amount. That is
        -- frozen in the decision, and it is the decision's reason whatever the amount or role of the leg that
        -- survived is now: a later correction of the surviving leg resolves nothing about the side that is
        -- gone. Checked BEFORE the amount, so that it can never be reported as 'amount_changed' — the one
        -- inactive reason the known-effect exception below accepts.
        v_inactive := d.counterpart_status;
      elsif v_ra.cents <> d.a_cents or (d.kind = 'pair' and v_rb.cents <> d.b_cents) then
        v_inactive := 'amount_changed';
      elsif not v_ra.is_leg or (d.kind = 'pair' and not v_rb.is_leg) then
        v_inactive := 'role_changed';
      elsif d.kind = 'pair_counterpart_removed' then
        -- A preserved pair holds the leg that survived, on either side, and that leg is valid. Of the frozen
        -- statuses only the removed side's own amount change is left to keep it inactive.
        v_inactive := case when d.counterpart_status = 'amount_changed' then 'amount_changed' end;
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

  -- Ambiguity holds (§4.7): institution removal is not evidence. The automatic pair of a hold's own two legs
  -- is withheld while the candidate that was removed would still be at least as close to the leg it competed
  -- for (the owner) as that leg's partner is, on the dates as they are now. Only that pair: both legs stay in
  -- the pool as candidates, no other pair is formed in its place, and a pair with any other leg is untouched.
  delete from pg_temp.cpe_tier1 t1
  using pg_temp.cpe_hold h
    join pg_temp.cpe_txn o on o.id = h.owner_id
    join pg_temp.cpe_txn x on x.id = h.other_id
  where ((t1.id = h.owner_id and t1.partner = h.other_id) or (t1.id = h.other_id and t1.partner = h.owner_id))
    and abs(h.day - o.day) <= abs(o.day - x.day);
  -- Institution removal (20261006120000) reads cpe_pool, cpe_txn, cpe_dismissed and cpe_tier1 AS THEY ARE FROM
  -- HERE ON, in its own transaction, right after its strict call of this function: the complete pool and its
  -- automatic pairs, before any presentation rule (a leg on an excluded account is published not_counted, with
  -- no candidates, but it is in the pool). Nothing below this line writes cpe_pool, cpe_txn or cpe_dismissed; the
  -- guard that follows removes from cpe_tier1 the pairs it withholds, and nothing after it writes cpe_tier1.

  -- The relink-review guard (20261009120000; PHASE_B_I3A_R_PACKET_2A_REVIEW.md). An AFFECTED PAYMENT is a leg
  -- that a review obligation names: its reference resolves, by the lineage rule above, to one current row. A
  -- row of a conflicting replacement group resolves to nothing, as for a decision. The LINEAGE decides, not the
  -- amount: a payment whose amount the bank corrected is still the affected payment.
  insert into pg_temp.cpe_review_anchor (obligation_id, row_id, gap)
  select o.id, t.id, o.origin = 'gap'
  from public.card_payment_review_obligations o
  cross join lateral (
    select count(*) as n, (array_agg(x.id))[1] as id from pg_temp.cpe_txn x
    where x.account_id = o.anchor_account_id and x.pending_of = o.anchor_plaid_transaction_id) rep
  left join pg_temp.cpe_txn own
    on rep.n = 0 and own.account_id = o.anchor_account_id and own.plaid = o.anchor_plaid_transaction_id and not own.conflict
  join pg_temp.cpe_txn t on t.id = case when rep.n = 1 then rep.id else own.id end
  where o.user_id = p_user_id;
  -- The surviving edges those obligations positively list: the other leg, resolved the same way. An edge is a
  -- pair of LINEAGES: if the bank later corrects an amount it is still the same two legs, and whether they are
  -- the automatic match is for the ordinary rules to say — as it was before this guard existed.
  insert into pg_temp.cpe_review_member (obligation_id, row_id)
  select m.obligation_id, t.id
  from public.card_payment_review_memberships m
  cross join lateral (
    select count(*) as n, (array_agg(x.id))[1] as id from pg_temp.cpe_txn x
    where x.account_id = m.member_account_id and x.pending_of = m.member_plaid_transaction_id) rep
  left join pg_temp.cpe_txn own
    on rep.n = 0 and own.account_id = m.member_account_id and own.plaid = m.member_plaid_transaction_id and not own.conflict
  join pg_temp.cpe_txn t on t.id = case when rep.n = 1 then rep.id else own.id end
  where m.user_id = p_user_id
    and m.obligation_id in (select a.obligation_id from pg_temp.cpe_review_anchor a);
  -- Of the automatic pairs that are left after the holds: one whose leg is an affected payment stays only if
  -- EVERY obligation on either leg positively lists that pair. A gap lists nothing. Withheld in both directions;
  -- nothing is selected in its place; both legs stay in the pool, as candidates of each other and of anyone else.
  insert into pg_temp.cpe_guard (id, partner)
  select t1.id, t1.partner from pg_temp.cpe_tier1 t1
  where exists (
    select 1 from pg_temp.cpe_review_anchor a
    where a.row_id in (t1.id, t1.partner)
      and not exists (
        select 1 from pg_temp.cpe_review_member m
        where m.obligation_id = a.obligation_id
          and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end));
  delete from pg_temp.cpe_tier1 t1 using pg_temp.cpe_guard g where g.id = t1.id;

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
        elsif v_claim.kind = 'pair_counterpart_removed' then
          -- A user-confirmed pair whose other account was removed: the confirmed counterpart is outside the
          -- tracked set. A cash leg counts in full; a card leg is funded from outside (effect 0, as always).
          if l.credit then
            v_state := 'funded_from_excluded'; v_reason := 'removed_cash_account'; v_effect := 0;
          else
            v_state := 'untracked'; v_reason := 'removed_card'; v_effect := -l.cents;
          end if;
        else
          v_pair_partner := case when v_claim.row_a is not null and v_claim.row_a <> l.id then v_claim.row_a else v_claim.row_b end;
          v_pair_reason := 'user_pair';
        end if;
      else
        -- Held by an inactive user decision: reserved, the decision attached (needs review).
        v_detail := v_claim.inactive;
        if v_claim.inactive = 'amount_changed' and v_claim.kind in ('destination_unlinked', 'pair_counterpart_removed') and not l.credit
           and not v_included_credit and sign(l.cents::numeric) = sign(v_claim.a_cents::numeric) then
          -- The one approved exception (2026-09-30): the corrected effect is known independently. Extended
          -- (2026-10-06) to a preserved pair: the absence of any included card establishes it, not the old
          -- confirmation, which stays inactive.
          v_state := 'untracked'; v_reason := 'no_included_card'; v_effect := -l.cents;
        else
          v_reason := case when v_claim.inactive = 'waiting_to_post' then 'matched_leg_not_posted' else 'decision_invalidated' end;
        end if;
      end if;
    elsif v_t1_partner is not null then
      -- 2. Tier 1.
      v_pair_partner := v_t1_partner;
      v_pair_reason := 'auto_pair';
    elsif exists (select 1 from pg_temp.cpe_guard g where g.id = l.id) then
      -- 2a. The guard withheld this leg's automatic pair: it needs review. Published BEFORE the record of a
      -- removed destination (3), which stays stored and is not named on this leg. A cash leg is a range, unless
      -- no included card exists: that is established independently, and counts in full. A card leg stays
      -- unresolved (effect 0, set below); a leg on an excluded account stays not counted (set below).
      if not l.credit and not v_included_credit then
        v_state := 'untracked'; v_reason := 'no_included_card'; v_effect := -l.cents;
      else
        v_reason := 'relink_review_required';
      end if;
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
  delete from public.card_payment_review_states where user_id = p_user_id;

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
  -- Review states: every leg that is an affected payment, and every leg whose automatic pair the guard
  -- withheld — with the obligations concerned (its own, and those of the leg it was withheld from).
  insert into public.card_payment_review_states (user_id, transaction_id, guard_withheld, withheld_partner_transaction_id,
                                                 obligation_ids, coverage_gap, computed_at_version)
  select p_user_id, x.row_id, g.id is not null, g.partner, x.obligation_ids, x.gap, v_version
  from (
    select r.row_id, array_agg(distinct r.obligation_id order by r.obligation_id) as obligation_ids, bool_or(r.gap) as gap
    from (
      select a.row_id, a.obligation_id, a.gap from pg_temp.cpe_review_anchor a
      union all
      select w.id, a.obligation_id, a.gap from pg_temp.cpe_guard w join pg_temp.cpe_review_anchor a on a.row_id = w.partner
    ) r
    join pg_temp.cpe_txn t on t.id = r.row_id and t.is_leg
    group by r.row_id
  ) x
  left join pg_temp.cpe_guard g on g.id = x.row_id;

  -- Steps 6–7: publish exactly the version read under L2 (committed together with the states).
  update public.card_payment_eval_versions
  set evaluated_version = v_version,
      evaluated_as_of = p_as_of,
      superseded_transaction_ids = coalesce((select array_agg(t.id order by t.id) from pg_temp.cpe_txn t where t.superseded), '{}'),
      last_error_code = null,
      last_attempt_at = clock_timestamp()
  where user_id = p_user_id;
  -- The contract stamp (20261009120000): this user's states are published by the evaluator with the
  -- relink-review guard. The reader returns states only for a stamped user; every stamp is cleared whenever this
  -- evaluator is installed or removed.
  insert into public.card_payment_evaluator_contracts (user_id, evaluated_version, contract)
  values (p_user_id, v_version, 2)
  on conflict (user_id) do update set evaluated_version = excluded.evaluated_version, contract = excluded.contract;
  -- Refresh work this publication satisfies. Work registered for a later version stays. (The queue row is taken
  -- after L2, as everywhere.)
  delete from public.card_payment_recovery_refresh_queue q where q.user_id = p_user_id and q.target_version <= v_version;
  return v_version;
end;
$$;

-- ---- The state reader: 20260930120000's, plus the contract and the review states --------------------------
create or replace function public.get_card_payment_states(p_user_id uuid, p_from date default null, p_to date default null)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when v.user_id is null or v.evaluated_version is distinct from v.input_version or c.contract is distinct from 2 then
      jsonb_build_object('fresh', false, 'inputVersion', v.input_version, 'evaluatedVersion', v.evaluated_version,
                         'lastErrorCode', v.last_error_code, 'evaluatorContract', c.contract)
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
      'supersededTransactionIds', to_jsonb(v.superseded_transaction_ids),
      'evaluatorContract', c.contract,
      'reviews', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'transactionId', r.transaction_id, 'guardWithheld', r.guard_withheld,
                 'withheldPartnerTransactionId', r.withheld_partner_transaction_id,
                 'obligationIds', to_jsonb(r.obligation_ids), 'coverageGap', r.coverage_gap) order by r.transaction_id), '[]'::jsonb)
        from public.card_payment_review_states r
        join public.card_payment_leg_states s on s.user_id = r.user_id and s.transaction_id = r.transaction_id
        where r.user_id = p_user_id and r.computed_at_version = v.evaluated_version
          and s.computed_at_version = v.evaluated_version
          and (p_from is null or s.date >= p_from) and (p_to is null or s.date < p_to)))
  end
  from (select 1) one
  left join public.card_payment_eval_versions v on v.user_id = p_user_id
  left join public.card_payment_evaluator_contracts c on c.user_id = p_user_id
$$;

-- ---- Freshness and receipts, as every recovery response reports them --------------------------------------
-- What the database says NOW: never a figure, never taken from a receipt.
create or replace function public.card_payment_recovery_freshness(p_user_id uuid) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'fresh', v.user_id is not null and v.evaluated_version is not null
             and v.evaluated_version is not distinct from v.input_version and c.contract is not distinct from 2,
    'inputVersion', v.input_version,
    'evaluatedVersion', v.evaluated_version,
    'lastErrorCode', v.last_error_code,
    'reviewRevision', coalesce(rr.revision, 0),
    'refresh', case when q.user_id is null then jsonb_build_object('queued', false, 'needsAttention', false, 'attempts', 0)
                    else jsonb_build_object('queued', true, 'needsAttention', q.needs_attention, 'attempts', q.attempts,
                                            'lastErrorCode', q.last_error_code) end)
  from (select 1) one
  left join public.card_payment_eval_versions v on v.user_id = p_user_id
  left join public.card_payment_evaluator_contracts c on c.user_id = p_user_id
  left join public.card_payment_review_revisions rr on rr.user_id = p_user_id
  left join public.card_payment_recovery_refresh_queue q on q.user_id = p_user_id
$$;

create or replace function public.card_payment_recovery_receipt(p_user_id uuid, p_operation_id uuid) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'operationId', a.operation_id, 'action', a.action, 'intent', a.payload, 'outcome', a.outcome, 'reason', a.reason,
    'decisionId', a.decision_id, 'supersededDecisionIds', to_jsonb(a.superseded_decision_ids),
    'subjectTransactionIds', to_jsonb(a.subject_transaction_ids),
    'retainedObligationIds', to_jsonb(a.retained_obligation_ids),
    'permanentRetirement', false,
    'expectedInputVersion', a.expected_input_version, 'expectedReviewRevision', a.expected_review_revision,
    'committedInputVersion', a.committed_input_version, 'committedReviewRevision', a.committed_review_revision,
    'committedAt', a.created_at)
  from public.card_payment_recovery_actions a
  where a.user_id = p_user_id and a.operation_id = p_operation_id
$$;

-- found = false says that NO RECEIPT IS VISIBLE to this statement. An action writes its receipt in the same
-- transaction as its decision: while that transaction is open, another session sees nothing. So found = false is
-- NOT "the action was not saved". A client keeps the operation id and its intent, and asks or sends again.
create or replace function public.get_card_payment_recovery_action(p_user_id uuid, p_operation_id uuid) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'found', public.card_payment_recovery_receipt(p_user_id, p_operation_id) is not null,
    'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
    'freshness', public.card_payment_recovery_freshness(p_user_id))
$$;

-- ---- The action wrapper: one request, one transaction -----------------------------------------------------
-- Order: READ COMMITTED; L1; the operation's receipt (an identical replay returns it, another intent under the
-- same id is refused); the review revision; the accounts of the named rows FOR KEY SHARE in id order; L2 and
-- the versions; the subject must be under review at exactly that version; then the EXISTING decision RPC, here,
-- in this transaction; then the receipt; then the refresh work. Anything raised anywhere rolls all of it back.
-- The decision RPC's own evaluation is best-effort, as always: when it fails in the ordinary way the action
-- still commits, the receipt says so, and the queue row carries the work. A cancellation or a timeout is not
-- an ordinary failure: it aborts the transaction, and nothing is written.
create or replace function public.apply_card_payment_recovery_action(
  p_user_id uuid,
  p_operation_id uuid,
  p_expected_input_version bigint,
  p_expected_review_revision bigint,
  p_action jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_txn uuid;
  v_other uuid;
  v_decision uuid;
  v_diff bigint;
  v_intent jsonb;
  v_hash text;
  v_existing_hash text;
  v_existing_action text;
  v_review bigint;
  v_accounts uuid[];
  v_targets uuid[];
  v_input bigint;
  v_evaluated bigint;
  v_contract integer;
  v_d public.card_payment_decisions;
  v_inner jsonb;
  v_fresh boolean;
  v_retained uuid[];
  v_subject record;
  v_candidate record;
  v_outcome text;
  v_superseded uuid[];
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'card_payment_requires_read_committed: apply_card_payment_recovery_action: got %', current_setting('transaction_isolation')
      using errcode = '25001';
  end if;
  if p_user_id is null or p_operation_id is null or p_action is null or jsonb_typeof(p_action) <> 'object' then
    raise exception 'card_payment_recovery_invalid: apply_card_payment_recovery_action: malformed_request';
  end if;

  -- The intent, normalised: exactly the fields the action has. Its hash is what a replay is compared with.
  v_kind := p_action->>'action';
  begin
    if v_kind in ('pair_current', 'confirm_unlinked', 'dismiss_candidate', 'reject_suggestion', 'defer') then
      v_txn := (p_action->>'transactionId')::uuid;
    end if;
    if v_kind = 'pair_current' then
      v_other := (p_action->>'counterpartTransactionId')::uuid;
      v_diff := (p_action->>'acceptedDifferenceCents')::bigint;
    elsif v_kind in ('dismiss_candidate', 'reject_suggestion') then
      v_other := (p_action->>'candidateTransactionId')::uuid;
    elsif v_kind = 'undo_decision' then
      v_decision := (p_action->>'decisionId')::uuid;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'card_payment_recovery_invalid: apply_card_payment_recovery_action: malformed_request';
  end;
  v_intent := case v_kind
    when 'pair_current' then jsonb_build_object('action', v_kind, 'transactionId', v_txn, 'counterpartTransactionId', v_other,
                                                'acceptedDifferenceCents', v_diff)
    when 'confirm_unlinked' then jsonb_build_object('action', v_kind, 'transactionId', v_txn)
    when 'dismiss_candidate' then jsonb_build_object('action', v_kind, 'transactionId', v_txn, 'candidateTransactionId', v_other)
    when 'undo_decision' then jsonb_build_object('action', v_kind, 'decisionId', v_decision)
    when 'reject_suggestion' then jsonb_build_object('action', v_kind, 'transactionId', v_txn, 'candidateTransactionId', v_other)
    when 'defer' then jsonb_build_object('action', v_kind, 'transactionId', v_txn)
  end;
  if v_intent is null
     or (v_kind <> 'undo_decision' and v_txn is null)
     or (v_kind in ('pair_current', 'dismiss_candidate', 'reject_suggestion') and v_other is null)
     or (v_kind = 'pair_current' and v_diff is null)
     or (v_kind = 'undo_decision' and v_decision is null) then
    raise exception 'card_payment_recovery_invalid: apply_card_payment_recovery_action: malformed_request';
  end if;
  v_hash := encode(sha256(convert_to(v_intent::text, 'UTF8')), 'hex');

  -- L1.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- The operation, first: one logical action per (user, operation id), whatever is asked again.
  select a.payload_hash, a.action into v_existing_hash, v_existing_action
  from public.card_payment_recovery_actions a
  where a.user_id = p_user_id and a.operation_id = p_operation_id;
  if found then
    if v_existing_hash <> v_hash then
      raise exception 'card_payment_recovery_operation_conflict: apply_card_payment_recovery_action: this operation id was already used for another request';
    end if;
    return jsonb_build_object('status', 'replayed',
                              'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
                              'freshness', public.card_payment_recovery_freshness(p_user_id));
  end if;

  -- The review revision the user saw.
  select coalesce((select r.revision from public.card_payment_review_revisions r where r.user_id = p_user_id), 0) into v_review;
  if p_expected_review_revision is distinct from v_review then
    raise exception 'card_payment_recovery_stale_review: apply_card_payment_recovery_action: the review changed; reload it and retry';
  end if;

  -- The accounts concerned, locked in id order BEFORE the version row: the lock a decision's insert takes on
  -- them anyway (its foreign keys). Only this user's rows are looked at; anything else is refused below.
  v_targets := array_remove(array[v_txn, v_other], null);
  if v_kind = 'undo_decision' then
    select d.* into v_d from public.card_payment_decisions d where d.id = v_decision and d.user_id = p_user_id;
    if not found then
      raise exception 'card_payment_not_found: apply_card_payment_recovery_action: decision not found';
    end if;
    v_accounts := array_remove(array[v_d.a_account_id, v_d.b_account_id], null);
  else
    select coalesce(array_agg(distinct t.account_id), '{}') into v_accounts
    from public.transactions t
    join public.accounts a on a.id = t.account_id
    join public.plaid_items i on i.id = a.item_id
    where t.id = any (v_targets) and i.user_id = p_user_id;
  end if;
  perform 1 from public.accounts a where a.id = any (v_accounts) order by a.id for key share;

  -- L2, and the versions. The states the user saw must be the current, freshly evaluated ones, published by
  -- this evaluator contract.
  select v.input_version, v.evaluated_version into v_input, v_evaluated
  from public.card_payment_eval_versions v where v.user_id = p_user_id
  for update;
  select c.contract into v_contract from public.card_payment_evaluator_contracts c where c.user_id = p_user_id;
  if v_input is null or v_evaluated is null or p_expected_input_version is null
     or v_evaluated <> v_input or p_expected_input_version <> v_input or v_contract is distinct from 2 then
    raise exception 'card_payment_stale_version: apply_card_payment_recovery_action: the matching state changed or is not current; reload it and retry';
  end if;
  -- A row moved to another account after the locks above were taken: retry rather than lock out of order.
  if exists (select 1 from public.transactions t
             join public.accounts a on a.id = t.account_id
             join public.plaid_items i on i.id = a.item_id
             where t.id = any (v_targets) and i.user_id = p_user_id and t.account_id <> all (v_accounts)) then
    raise exception 'card_payment_recovery_retry: apply_card_payment_recovery_action: a named transaction moved; retry'
      using errcode = '40001';
  end if;

  -- The subject must be under review at this version: an affected payment, or a leg whose automatic pair the
  -- guard withheld. A foreign or unknown id is refused exactly like one that is simply not under review.
  if v_kind = 'undo_decision' then
    if not exists (select 1 from public.card_payment_recovery_actions a
                   where a.user_id = p_user_id and a.decision_id = v_decision)
       and not exists (select 1 from public.card_payment_review_states rs
                       where rs.user_id = p_user_id and rs.computed_at_version = v_evaluated
                         and rs.transaction_id in (public.card_payment_lineage_row(v_d.a_account_id, v_d.a_plaid_transaction_id),
                                                   public.card_payment_lineage_row(v_d.b_account_id, v_d.b_plaid_transaction_id))) then
      raise exception 'card_payment_recovery_not_reviewable: apply_card_payment_recovery_action: this is not under review';
    end if;
    select coalesce(array_agg(distinct x), '{}') into v_targets
    from unnest(array[public.card_payment_lineage_row(v_d.a_account_id, v_d.a_plaid_transaction_id),
                      public.card_payment_lineage_row(v_d.b_account_id, v_d.b_plaid_transaction_id)]) x
    where x is not null;
  elsif not exists (select 1 from public.card_payment_review_states rs
                    where rs.user_id = p_user_id and rs.transaction_id = v_txn and rs.computed_at_version = v_evaluated) then
    raise exception 'card_payment_recovery_not_reviewable: apply_card_payment_recovery_action: this is not under review';
  end if;

  -- The obligations on the legs concerned, as they are now. They all remain: the receipt names them.
  select coalesce(array_agg(distinct o order by o), '{}') into v_retained
  from public.card_payment_review_states rs cross join lateral unnest(rs.obligation_ids) o
  where rs.user_id = p_user_id and rs.computed_at_version = v_evaluated and rs.transaction_id = any (v_targets);

  -- The action. The four decisions are the EXISTING RPCs, unchanged, in this transaction: their own version
  -- check, ownership checks, supersession rules and best-effort evaluation.
  v_superseded := '{}';
  if v_kind = 'pair_current' then
    v_inner := public.link_card_payment(p_user_id, v_txn, v_other, v_diff, p_expected_input_version);
  elsif v_kind = 'confirm_unlinked' then
    v_inner := public.mark_card_payment_destination(p_user_id, v_txn, p_expected_input_version);
  elsif v_kind = 'dismiss_candidate' then
    v_inner := public.dismiss_card_payment_candidate(p_user_id, v_txn, v_other, p_expected_input_version);
  elsif v_kind = 'undo_decision' then
    v_inner := public.undo_card_payment_decision(p_user_id, v_decision, p_expected_input_version);
  else
    -- Workflow only: no decision, no dismissal, no figure, no version.
    select s.transaction_id, s.amount_cents, s.date, s.candidates into v_subject
    from public.card_payment_leg_states s
    where s.user_id = p_user_id and s.transaction_id = v_txn and s.computed_at_version = v_evaluated;
    if not found then
      raise exception 'card_payment_recovery_not_reviewable: apply_card_payment_recovery_action: this is not under review';
    end if;
    if v_kind = 'reject_suggestion' then
      select s.transaction_id, s.amount_cents, s.date into v_candidate
      from public.card_payment_leg_states s
      where s.user_id = p_user_id and s.transaction_id = v_other and s.computed_at_version = v_evaluated
        and (exists (select 1 from jsonb_array_elements(v_subject.candidates) e where (e->>'transactionId')::uuid = v_other)
             or exists (select 1 from public.card_payment_review_states rs
                        where rs.user_id = p_user_id and rs.transaction_id = v_txn and rs.computed_at_version = v_evaluated
                          and rs.withheld_partner_transaction_id = v_other));
      if not found then
        raise exception 'card_payment_recovery_invalid: apply_card_payment_recovery_action: not_a_suggestion';
      end if;
      insert into public.card_payment_review_annotations
        (user_id, operation_id, kind, transaction_id, transaction_cents, transaction_date,
         candidate_transaction_id, candidate_cents, candidate_date)
      values (p_user_id, p_operation_id, v_kind, v_txn, v_subject.amount_cents, v_subject.date,
              v_other, v_candidate.amount_cents, v_candidate.date);
    else
      insert into public.card_payment_review_annotations
        (user_id, operation_id, kind, transaction_id, transaction_cents, transaction_date)
      values (p_user_id, p_operation_id, v_kind, v_txn, v_subject.amount_cents, v_subject.date);
    end if;
    v_inner := jsonb_build_object('status', 'saved', 'reason', null, 'decisionId', null, 'supersededDecisionIds', '[]'::jsonb);
  end if;
  v_outcome := v_inner->>'status';
  select coalesce(array_agg(x::uuid), '{}') into v_superseded
  from jsonb_array_elements_text(coalesce(v_inner->'supersededDecisionIds', '[]'::jsonb)) x;

  -- What the database holds after the inner evaluation — read here, not taken from its answer.
  select v.input_version, v.evaluated_version into v_input, v_evaluated
  from public.card_payment_eval_versions v where v.user_id = p_user_id;
  select c.contract into v_contract from public.card_payment_evaluator_contracts c where c.user_id = p_user_id;
  v_fresh := v_evaluated is not null and v_evaluated = v_input and v_contract is not distinct from 2;

  insert into public.card_payment_recovery_actions
    (user_id, operation_id, action, payload, payload_hash, expected_input_version, expected_review_revision, outcome, reason,
     decision_id, superseded_decision_ids, subject_transaction_ids, retained_obligation_ids, committed_input_version,
     committed_review_revision)
  values (p_user_id, p_operation_id, v_kind, v_intent, v_hash, p_expected_input_version, p_expected_review_revision,
          v_outcome, v_inner->>'reason', (v_inner->>'decisionId')::uuid, v_superseded, v_targets, v_retained, v_input,
          coalesce((select r.revision from public.card_payment_review_revisions r where r.user_id = p_user_id), 0));

  -- Durable refresh for what this action left unevaluated (the trigger registered it when the decision bumped
  -- the version, for an owner with obligations; this makes it certain).
  if not v_fresh then
    insert into public.card_payment_recovery_refresh_queue (user_id, target_version)
    values (p_user_id, v_input)
    on conflict (user_id) do update
      set target_version = greatest(public.card_payment_recovery_refresh_queue.target_version, excluded.target_version);
  end if;

  return jsonb_build_object('status', case when v_fresh then 'committed_fresh' else 'committed_pending' end,
                            'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
                            'freshness', public.card_payment_recovery_freshness(p_user_id));
end;
$$;

-- ---- The refresh-only retry -------------------------------------------------------------------------------
-- Not a payment action: it replays no decision, releases no guard, retires nothing and changes no version. It
-- registers refresh work for the SERVER's current input version of this owner and makes a row that had stopped
-- being retried eligible again. Accepted whatever the freshness is. Failure history is kept.
create or replace function public.request_card_payment_recovery_refresh(p_user_id uuid, p_operation_id uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_intent constant jsonb := jsonb_build_object('action', 'refresh_retry');
  v_hash text;
  v_existing_hash text;
  v_input bigint;
begin
  if p_user_id is null or p_operation_id is null then
    raise exception 'card_payment_recovery_invalid: request_card_payment_recovery_refresh: malformed_request';
  end if;
  v_hash := encode(sha256(convert_to(v_intent::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select a.payload_hash into v_existing_hash from public.card_payment_recovery_actions a
  where a.user_id = p_user_id and a.operation_id = p_operation_id;
  if found then
    if v_existing_hash <> v_hash then
      raise exception 'card_payment_recovery_operation_conflict: request_card_payment_recovery_refresh: this operation id was already used for another request';
    end if;
    return jsonb_build_object('status', 'replayed',
                              'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
                              'freshness', public.card_payment_recovery_freshness(p_user_id));
  end if;

  select coalesce((select v.input_version from public.card_payment_eval_versions v where v.user_id = p_user_id), 0) into v_input;
  insert into public.card_payment_recovery_refresh_queue (user_id, target_version, retry_requested_at)
  values (p_user_id, v_input, clock_timestamp())
  on conflict (user_id) do update
    set target_version = greatest(public.card_payment_recovery_refresh_queue.target_version, excluded.target_version),
        attempts = 0,
        needs_attention = false,
        available_at = now(),
        retry_requested_at = clock_timestamp();

  insert into public.card_payment_recovery_actions
    (user_id, operation_id, action, payload, payload_hash, outcome, committed_input_version, committed_review_revision)
  values (p_user_id, p_operation_id, 'refresh_retry', v_intent, v_hash, 'queued', v_input,
          coalesce((select r.revision from public.card_payment_review_revisions r where r.user_id = p_user_id), 0));

  return jsonb_build_object('status', 'queued',
                            'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
                            'freshness', public.card_payment_recovery_freshness(p_user_id));
end;
$$;

-- ---- The worker's two calls -------------------------------------------------------------------------------
-- Claim: a short transaction that locks queue rows only (SKIP LOCKED, so it never waits) and hands out leases.
-- At most ten per call. A row that failed eight times in a row is not handed out until a refresh is requested.
create or replace function public.claim_card_payment_recovery_refresh(p_worker_token uuid, p_limit integer default 10) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claims jsonb;
begin
  if p_worker_token is null then
    raise exception 'card_payment_recovery_invalid: claim_card_payment_recovery_refresh: malformed_request';
  end if;
  with due as (
    select q.user_id from public.card_payment_recovery_refresh_queue q
    where q.available_at <= now() and not q.needs_attention
      and (q.lease_expires_at is null or q.lease_expires_at <= now())
    order by q.available_at, q.user_id
    limit greatest(1, least(coalesce(p_limit, 10), 10))
    for update skip locked
  ), leased as (
    update public.card_payment_recovery_refresh_queue q
    set lease_token = gen_random_uuid(), lease_owner = p_worker_token, lease_expires_at = now() + interval '120 seconds'
    from due where q.user_id = due.user_id
    returning q.user_id, q.lease_token, q.target_version, q.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('userId', l.user_id, 'leaseToken', l.lease_token,
                                               'targetVersion', l.target_version, 'attempts', l.attempts)
                            order by l.user_id), '[]'::jsonb)
  into v_claims from leased l;
  return jsonb_build_object('claims', v_claims, 'leaseSeconds', 120);
end;
$$;

-- Refresh one owner under a lease. The lease is READ, not locked, before the evaluation (the queue row is
-- only ever locked after L2). The evaluation is the existing best-effort wrapper. The acknowledgement is
-- fenced by the lease token and by the version: a lost lease acknowledges nothing, and work registered for a
-- later version is never removed.
create or replace function public.refresh_card_payment_recovery_owner(p_user_id uuid, p_lease_token uuid) returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '10s'
as $$
declare
  v_fresh boolean;
  v_evaluated bigint;
  v_code text;
  v_attempts integer;
  v_attention boolean;
begin
  if p_user_id is null or p_lease_token is null then
    raise exception 'card_payment_recovery_invalid: refresh_card_payment_recovery_owner: malformed_request';
  end if;
  if not exists (select 1 from public.card_payment_recovery_refresh_queue q
                 where q.user_id = p_user_id and q.lease_token = p_lease_token and q.lease_expires_at > now()) then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  v_fresh := coalesce((public.card_payment_recovery_freshness(p_user_id)->>'fresh')::boolean, false);
  if not v_fresh then
    perform public.try_evaluate_card_payments(p_user_id);
    v_fresh := coalesce((public.card_payment_recovery_freshness(p_user_id)->>'fresh')::boolean, false);
  end if;
  select v.evaluated_version, v.last_error_code into v_evaluated, v_code
  from public.card_payment_eval_versions v where v.user_id = p_user_id;

  if v_fresh then
    -- Published at v_evaluated. The evaluator itself removes the work its publication satisfies, so the row is
    -- normally gone already; remove it if it is still here (the states were fresh on arrival). A row that
    -- remains under this lease is work registered for a LATER version: never removed — released, to be claimed again.
    delete from public.card_payment_recovery_refresh_queue q
    where q.user_id = p_user_id and q.lease_token = p_lease_token and q.target_version <= v_evaluated;
    if not found then
      update public.card_payment_recovery_refresh_queue q
      set lease_token = null, lease_owner = null, lease_expires_at = null, available_at = now()
      where q.user_id = p_user_id and q.lease_token = p_lease_token;
      if found then
        return jsonb_build_object('status', 'superseded', 'evaluatedVersion', v_evaluated);
      end if;
    end if;
    return jsonb_build_object('status', 'fresh', 'evaluatedVersion', v_evaluated);
  end if;

  -- An ordinary evaluation failure: keep the work, back off (5 s doubling, capped at five minutes), and after
  -- eight failures in a row stop retrying until someone asks.
  update public.card_payment_recovery_refresh_queue q
  set attempts = q.attempts + 1,
      total_failures = q.total_failures + 1,
      needs_attention = q.attempts + 1 >= 8,
      last_error_code = v_code,
      last_attempt_at = clock_timestamp(),
      available_at = now() + make_interval(secs => least(300, 5 * power(2, least(q.attempts, 10)))::integer),
      lease_token = null, lease_owner = null, lease_expires_at = null
  where q.user_id = p_user_id and q.lease_token = p_lease_token
  returning q.attempts, q.needs_attention into v_attempts, v_attention;
  if not found then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  return jsonb_build_object('status', 'pending', 'attempts', v_attempts, 'needsAttention', v_attention);
end;
$$;

-- ---- The review reader ------------------------------------------------------------------------------------
-- One statement, one snapshot. Reviews are returned only from a fresh evaluation of this contract; otherwise
-- the answer says how many payments are under review and that the figures are not current — never a figure.
-- Ordered by date (newest first), then id; the cursor is the last row's "date|id".
create or replace function public.get_card_payment_recovery_reviews(p_user_id uuid, p_cursor text default null,
                                                                    p_limit integer default 20)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_fresh jsonb := public.card_payment_recovery_freshness(p_user_id);
  v_version bigint := (v_fresh->>'evaluatedVersion')::bigint;
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 50));
  v_cursor_date date;
  v_cursor_id uuid;
  v_rows jsonb;
  v_next text;
  v_total bigint;
begin
  if p_cursor is not null then
    if p_cursor !~ '^\d{4}-\d{2}-\d{2}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'card_payment_recovery_invalid: get_card_payment_recovery_reviews: invalid_cursor';
    end if;
    begin
      v_cursor_date := split_part(p_cursor, '|', 1)::date;
      v_cursor_id := split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'card_payment_recovery_invalid: get_card_payment_recovery_reviews: invalid_cursor';
    end;
  end if;

  if not coalesce((v_fresh->>'fresh')::boolean, false) then
    return jsonb_build_object(
      'fresh', false, 'freshness', v_fresh, 'reviews', '[]'::jsonb, 'nextCursor', null,
      'affectedPaymentCount', (select count(*) from (select distinct o.anchor_account_id, o.anchor_plaid_transaction_id
                                                     from public.card_payment_review_obligations o
                                                     where o.user_id = p_user_id) a));
  end if;

  select count(*) into v_total from public.card_payment_review_states rs
  where rs.user_id = p_user_id and rs.computed_at_version = v_version;

  with page as (
    select s.*, rs.guard_withheld, rs.withheld_partner_transaction_id, rs.obligation_ids, rs.coverage_gap
    from public.card_payment_review_states rs
    join public.card_payment_leg_states s on s.user_id = rs.user_id and s.transaction_id = rs.transaction_id
    where rs.user_id = p_user_id and rs.computed_at_version = v_version and s.computed_at_version = v_version
      and (v_cursor_date is null or (s.date, s.transaction_id) < (v_cursor_date, v_cursor_id))
    order by s.date desc, s.transaction_id desc
    limit v_limit + 1
  ), shown as (
    select * from page order by date desc, transaction_id desc limit v_limit
  ), dismissed as materialized (
    -- the pairs the user dismissed, by their current rows
    select x.row_a, x.row_b from public.card_payment_live_decisions(p_user_id) x where x.kind = 'not_this_pair'
  ), offered as (
    -- A leg's own candidate list, where the evaluator published one (an unresolved leg; a leg under an active
    -- user decision, whose list is what contradicts it).
    select s.transaction_id as leg_id, (c.e->>'transactionId')::uuid as candidate_id, c.e->>'kind' as kind,
           (c.e->>'distanceDays')::integer as dist, (c.e->>'differenceCents')::bigint as diff
    from shown s cross join lateral jsonb_array_elements(s.candidates) c(e)
    union all
    -- A leg that reads a definite state has no such list. The review still offers what could be its other side
    -- TODAY, by the evaluator's suggestion shapes: the exact opposite amount within 60 days, or an amount within
    -- 5.00 within 5 days — on the other side, not held by a user decision, not a conflicting replacement, not a
    -- pair the user dismissed. Suggestions only.
    select s.transaction_id, o.transaction_id,
           case when o.amount_cents = -s.amount_cents and abs(o.date - s.date) <= 5 then 'tier1_competitor'
                when o.amount_cents = -s.amount_cents then 'exact_amount' else 'near_amount' end,
           abs(o.date - s.date),
           case when o.amount_cents = -s.amount_cents then 0 else abs(s.amount_cents) - abs(o.amount_cents) end
    from shown s
    join public.card_payment_leg_states o
      on o.user_id = p_user_id and o.computed_at_version = v_version and o.side <> s.side and o.transaction_id <> s.transaction_id
    where jsonb_array_length(s.candidates) = 0
      and ((o.amount_cents = -s.amount_cents and abs(o.date - s.date) <= 60)
           or (sign(o.amount_cents::numeric) = -sign(s.amount_cents::numeric)
               and abs(abs(s.amount_cents) - abs(o.amount_cents)) between 1 and 500 and abs(o.date - s.date) <= 5))
      and o.reason <> 'ambiguous_replacement'
      and not exists (select 1 from public.card_payment_decision_states ds
                      where ds.user_id = p_user_id and ds.decision_id = o.decision_id and ds.computed_at_version = v_version
                        and ds.kind in ('pair', 'destination_unlinked', 'pair_counterpart_removed'))
      and not exists (select 1 from dismissed d
                      where (d.row_a = s.transaction_id and d.row_b = o.transaction_id)
                         or (d.row_a = o.transaction_id and d.row_b = s.transaction_id))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'transactionId', p.transaction_id, 'accountId', p.account_id, 'date', to_char(p.date, 'YYYY-MM-DD'),
           'amountCents', p.amount_cents, 'pending', p.pending, 'side', p.side, 'direction', p.direction,
           'accountIncluded', p.account_included, 'state', p.state, 'reason', p.reason, 'detail', p.detail,
           'effectCents', p.effect_cents, 'lowCents', p.low_cents, 'highCents', p.high_cents,
           'partnerTransactionId', p.partner_transaction_id,
           'guardWithheld', p.guard_withheld, 'withheldPartnerTransactionId', p.withheld_partner_transaction_id,
           'coverageGap', p.coverage_gap,
           'controllingDecision', (
             select jsonb_build_object('decisionId', ds.decision_id, 'kind', ds.kind, 'status', ds.status, 'detail', ds.detail,
                                       'userDecision', ds.kind in ('pair', 'destination_unlinked', 'pair_counterpart_removed'))
             from public.card_payment_decision_states ds
             where ds.user_id = p_user_id and ds.decision_id = p.decision_id and ds.computed_at_version = v_version),
           'deferred', exists (
             select 1 from public.card_payment_review_annotations n
             where n.user_id = p_user_id and n.kind = 'defer' and n.transaction_id = p.transaction_id
               and n.transaction_cents = p.amount_cents and n.transaction_date = p.date),
           'obligations', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'obligationId', o.id, 'origin', o.origin, 'completeness', o.completeness, 'gapReason', o.gap_reason,
                      'removalId', o.removal_id,
                      'institutionName', (select pr.institution_name from public.plaid_item_removals pr
                                          where pr.id = o.removal_id and pr.user_id = p_user_id),
                      'removedOn', (select to_char(pr.cleaned_at, 'YYYY-MM-DD') from public.plaid_item_removals pr
                                    where pr.id = o.removal_id and pr.user_id = p_user_id),
                      'sources', (
                        select coalesce(jsonb_agg(jsonb_build_object(
                                 'evidenceKind', x.evidence_kind, 'decisionId', x.decision_id, 'decisionKind', x.decision_kind,
                                 'decisionStatus', (select ds.status from public.card_payment_decision_states ds
                                                    where ds.user_id = p_user_id and ds.decision_id = x.decision_id
                                                      and ds.computed_at_version = v_version),
                                 'sourceRelation', x.source_relation,
                                 'sourceDate', to_char(x.source_date, 'YYYY-MM-DD'), 'sourceCents', x.source_cents,
                                 'sourceKnown', x.source_plaid_transaction_id is not null)
                                 order by x.evidence_kind, x.decision_id nulls last, x.source_plaid_account_id, x.source_plaid_transaction_id),
                                 '[]'::jsonb)
                        from public.card_payment_review_obligation_sources x where x.obligation_id = o.id),
                      'knownSurvivingEdgeCount', (select count(*) from public.card_payment_review_memberships m
                                                  where m.obligation_id = o.id)) order by o.id), '[]'::jsonb)
             from public.card_payment_review_obligations o
             where o.user_id = p_user_id and o.id = any (p.obligation_ids)),
           -- Suggestions only: what the matcher sees today. None is verified, and none is applied without the
           -- user's explicit action.
           'candidates', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'transactionId', cs.transaction_id, 'accountId', cs.account_id, 'date', to_char(cs.date, 'YYYY-MM-DD'),
                      'amountCents', cs.amount_cents, 'pending', cs.pending, 'accountIncluded', cs.account_included,
                      'kind', c.kind, 'distanceDays', c.dist, 'differenceCents', c.diff,
                      'withheldByGuard', cs.transaction_id is not distinct from p.withheld_partner_transaction_id,
                      'suggestionOnly', true,
                      'rejected', exists (
                        select 1 from public.card_payment_review_annotations n
                        where n.user_id = p_user_id and n.kind = 'reject_suggestion' and n.transaction_id = p.transaction_id
                          and n.transaction_cents = p.amount_cents and n.transaction_date = p.date
                          and n.candidate_transaction_id = cs.transaction_id and n.candidate_cents = cs.amount_cents
                          and n.candidate_date = cs.date))
                      order by c.dist, cs.transaction_id), '[]'::jsonb)
             from offered c
             join public.card_payment_leg_states cs
               on cs.user_id = p_user_id and cs.transaction_id = c.candidate_id and cs.computed_at_version = v_version
             where c.leg_id = p.transaction_id))
           order by p.date desc, p.transaction_id desc), '[]'::jsonb),
         (select to_char(l.date, 'YYYY-MM-DD') || '|' || l.transaction_id::text
          from (select * from shown order by date, transaction_id limit 1) l
          where (select count(*) from page) > v_limit)
  into v_rows, v_next
  from shown p;

  return jsonb_build_object('fresh', true, 'freshness', v_fresh, 'reviews', v_rows, 'nextCursor', v_next,
                            'affectedPaymentCount', v_total);
end;
$$;

-- ---- Access -----------------------------------------------------------------------------------------------
alter table public.card_payment_review_obligations enable row level security;
alter table public.card_payment_review_obligation_sources enable row level security;
alter table public.card_payment_review_memberships enable row level security;
alter table public.card_payment_review_states enable row level security;
alter table public.card_payment_evaluator_contracts enable row level security;
alter table public.card_payment_review_revisions enable row level security;
alter table public.card_payment_review_annotations enable row level security;
alter table public.card_payment_recovery_actions enable row level security;
alter table public.card_payment_recovery_refresh_queue enable row level security;

revoke all on table public.card_payment_review_obligations, public.card_payment_review_obligation_sources,
  public.card_payment_review_memberships, public.card_payment_review_states, public.card_payment_evaluator_contracts,
  public.card_payment_review_revisions, public.card_payment_review_annotations, public.card_payment_recovery_actions,
  public.card_payment_recovery_refresh_queue
  from public, anon, authenticated, service_role;
grant select, insert on table public.card_payment_review_obligations, public.card_payment_review_obligation_sources,
  public.card_payment_review_memberships, public.card_payment_review_annotations, public.card_payment_recovery_actions
  to service_role;
grant select, insert, delete on table public.card_payment_review_states to service_role;
grant select, insert, update on table public.card_payment_evaluator_contracts, public.card_payment_review_revisions to service_role;
grant select, insert, update, delete on table public.card_payment_recovery_refresh_queue to service_role;

revoke all on function public.card_payment_review_touch(uuid), public.card_payment_review_capture(uuid, uuid),
  public.card_payment_review_record_gaps(uuid), public.card_payment_review_seed_retained(),
  public.card_payment_recovery_freshness(uuid), public.card_payment_recovery_receipt(uuid, uuid),
  public.get_card_payment_recovery_action(uuid, uuid),
  public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb),
  public.request_card_payment_recovery_refresh(uuid, uuid),
  public.claim_card_payment_recovery_refresh(uuid, integer),
  public.refresh_card_payment_recovery_owner(uuid, uuid),
  public.get_card_payment_recovery_reviews(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.card_payment_review_touch(uuid), public.card_payment_review_capture(uuid, uuid),
  public.card_payment_review_record_gaps(uuid),
  public.card_payment_recovery_freshness(uuid), public.card_payment_recovery_receipt(uuid, uuid),
  public.get_card_payment_recovery_action(uuid, uuid),
  public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb),
  public.request_card_payment_recovery_refresh(uuid, uuid),
  public.claim_card_payment_recovery_refresh(uuid, integer),
  public.refresh_card_payment_recovery_owner(uuid, uuid),
  public.get_card_payment_recovery_reviews(uuid, text, integer)
  to service_role;
-- Seeding is the migration's (and an operator's) alone.
revoke all on function public.card_payment_review_seed_retained() from service_role;
revoke all on function public.card_payment_review_inputs_changed(), public.card_payment_review_notes_changed(),
  public.card_payment_recovery_enqueue()
  from public, anon, authenticated, service_role;

-- ---- Seeding, and the invalidation of everything evaluated before this file --------------------------------
-- Obligations for what is already retained (their insert makes each affected owner stale), then refresh work
-- for EVERY user who has a version row: none of them carries this contract's stamp, so none is readable until
-- it is evaluated again.
select public.card_payment_review_seed_retained();

insert into public.card_payment_recovery_refresh_queue (user_id, target_version)
select v.user_id, v.input_version from public.card_payment_eval_versions v
on conflict (user_id) do update
  set target_version = greatest(public.card_payment_recovery_refresh_queue.target_version, excluded.target_version);

-- ---- Postcondition ----------------------------------------------------------------------------------------
do $$
declare
  v_fn text;
  v_tbl text;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6a8f92136f769ccd91fbd7fa57f3a519'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> '5b3cb3fdc0ab9570a345cf1ace387481'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> '8ec18bc2b27acc658fdb5a42c7251e8e'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb)'::regprocedure) <> 'a82255aefe708a50bde46b7fbc74e184'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_review_capture(uuid, uuid)'::regprocedure) <> '0bc7488878f01c59bb0a9d5bb8563423'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.refresh_card_payment_recovery_owner(uuid, uuid)'::regprocedure) <> '76681609d6f10c3a7f8502d548942f81' then
    raise exception 'a function is not the definition this migration installs';
  end if;
  -- The decision RPCs are untouched.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.link_card_payment(uuid, uuid, uuid, bigint, bigint)'::regprocedure) <> '1ddf83f559f5179975ef52a08b7f2063'
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.undo_card_payment_decision(uuid, uuid, bigint)'::regprocedure) <> 'dfcba4535ba1087928185d14cc978c10' then
    raise exception 'a decision RPC changed';
  end if;
  foreach v_fn in array array[
    'public.evaluate_card_payments(uuid, timestamp with time zone)',
    'public.remove_plaid_item_local(uuid, uuid)',
    'public.get_card_payment_states(uuid, date, date)',
    'public.card_payment_review_touch(uuid)',
    'public.card_payment_review_capture(uuid, uuid)',
    'public.card_payment_review_record_gaps(uuid)',
    'public.card_payment_recovery_freshness(uuid)',
    'public.card_payment_recovery_receipt(uuid, uuid)',
    'public.get_card_payment_recovery_action(uuid, uuid)',
    'public.apply_card_payment_recovery_action(uuid, uuid, bigint, bigint, jsonb)',
    'public.request_card_payment_recovery_refresh(uuid, uuid)',
    'public.claim_card_payment_recovery_refresh(uuid, integer)',
    'public.get_card_payment_recovery_reviews(uuid, text, integer)'] loop
    perform 1 from pg_proc p
    where p.oid = v_fn::regprocedure
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and has_function_privilege('service_role', p.oid, 'execute');
    if not found then
      raise exception '% lost a security or definition property', v_fn;
    end if;
  end loop;
  perform 1 from pg_proc p
  where p.oid = 'public.refresh_card_payment_recovery_owner(uuid, uuid)'::regprocedure
    and not p.prosecdef
    and p.proconfig = array['search_path=""', 'lock_timeout=10s']
    and not has_function_privilege('public', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('authenticated', p.oid, 'execute')
    and has_function_privilege('service_role', p.oid, 'execute');
  if not found then
    raise exception 'refresh_card_payment_recovery_owner lost a security or definition property';
  end if;
  -- Seeding and the trigger functions: no application role.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('card_payment_review_seed_retained', 'card_payment_review_inputs_changed',
                                 'card_payment_review_notes_changed', 'card_payment_recovery_enqueue')
               and (p.prosecdef or p.proconfig is distinct from array['search_path=""']
                    or has_function_privilege('public', p.oid, 'execute')
                    or has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute')
                    or has_function_privilege('service_role', p.oid, 'execute')))
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('card_payment_review_seed_retained', 'card_payment_review_inputs_changed',
                             'card_payment_review_notes_changed', 'card_payment_recovery_enqueue')) <> 4 then
    raise exception 'a seeding or trigger function is missing or has a wrong security property or grant';
  end if;
  if pg_get_function_result('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'bigint'
     or pg_get_function_arguments('public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure)
        <> 'p_user_id uuid, p_as_of timestamp with time zone DEFAULT now()'
     or pg_get_function_result('public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'jsonb'
     or pg_get_function_arguments('public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> 'p_user_id uuid, p_item_id uuid'
     or (select provolatile from pg_proc where oid = 'public.get_card_payment_states(uuid, date, date)'::regprocedure) <> 's'
     or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('evaluate_card_payments', 'remove_plaid_item_local', 'get_card_payment_states',
                             'apply_card_payment_recovery_action', 'request_card_payment_recovery_refresh',
                             'claim_card_payment_recovery_refresh', 'refresh_card_payment_recovery_owner',
                             'get_card_payment_recovery_reviews', 'get_card_payment_recovery_action')) <> 9 then
    raise exception 'a function signature changed, or an overload exists';
  end if;
  -- The new tables: row security on, no policy, no client privilege; the service role exactly as granted above.
  foreach v_tbl in array array['card_payment_review_obligations', 'card_payment_review_obligation_sources',
                               'card_payment_review_memberships', 'card_payment_review_states',
                               'card_payment_evaluator_contracts', 'card_payment_review_revisions',
                               'card_payment_review_annotations', 'card_payment_recovery_actions',
                               'card_payment_recovery_refresh_queue'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_tbl)::regclass)
       or exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = v_tbl) then
      raise exception '%: row level security must be on, with no policy', v_tbl;
    end if;
    if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
               cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
               where has_table_privilege(r.role, ('public.' || v_tbl)::regclass, p.priv)) then
      raise exception '%: a client role has a privilege', v_tbl;
    end if;
    if exists (select 1 from (values ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
               where has_table_privilege('service_role', ('public.' || v_tbl)::regclass, p.priv)) then
      raise exception '%: service_role has a privilege it must not have', v_tbl;
    end if;
  end loop;
  foreach v_tbl in array array['card_payment_review_obligations', 'card_payment_review_obligation_sources',
                               'card_payment_review_memberships', 'card_payment_review_annotations',
                               'card_payment_recovery_actions'] loop
    if not has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'select')
       or not has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'insert')
       or has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'update')
       or has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'delete')
       or exists (select 1 from information_schema.column_privileges cp
                  where cp.table_schema = 'public' and cp.table_name = v_tbl and cp.grantee = 'service_role'
                    and cp.privilege_type not in ('SELECT', 'INSERT')) then
      raise exception '%: service_role must have exactly SELECT and INSERT', v_tbl;
    end if;
  end loop;
  -- Nothing here references a row that a removal or an account cascade deletes: only the user.
  if exists (select 1 from pg_constraint c
             where c.contype = 'f'
               and c.conrelid in ('public.card_payment_review_obligations'::regclass,
                                  'public.card_payment_review_obligation_sources'::regclass,
                                  'public.card_payment_review_memberships'::regclass,
                                  'public.card_payment_review_annotations'::regclass,
                                  'public.card_payment_recovery_actions'::regclass,
                                  'public.card_payment_recovery_refresh_queue'::regclass)
               and c.confrelid not in ('auth.users'::regclass, 'public.card_payment_review_obligations'::regclass)) then
    raise exception 'a review table references something other than its user or its obligation';
  end if;
  if (select count(*) from pg_trigger t
      where not t.tgisinternal and t.tgenabled = 'O'
        and ((t.tgrelid = 'public.card_payment_review_obligations'::regclass and t.tgname = 'card_payment_review_obligations_changed')
          or (t.tgrelid = 'public.card_payment_review_memberships'::regclass and t.tgname = 'card_payment_review_memberships_changed')
          or (t.tgrelid = 'public.card_payment_review_obligation_sources'::regclass and t.tgname = 'card_payment_review_obligation_sources_changed')
          or (t.tgrelid = 'public.card_payment_review_annotations'::regclass and t.tgname = 'card_payment_review_annotations_changed')
          or (t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_enqueue'))) <> 5 then
    raise exception 'an invalidation or enqueue trigger is missing or disabled';
  end if;
  if exists (select 1 from pg_trigger t
             where t.tgrelid = 'public.card_payment_eval_versions'::regclass and t.tgname = 'card_payment_recovery_downgrade_fence') then
    raise exception 'the downgrade fence is still installed';
  end if;
  -- Every retained removal-written decision has its obligation source.
  if exists (select 1 from public.card_payment_decisions d
             where d.kind in ('pair_counterpart_removed', 'destination_removed_card',
                              'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
               and not exists (select 1 from public.card_payment_review_obligation_sources x where x.decision_id = d.id)) then
    raise exception 'a retained removal-written decision has no review obligation';
  end if;
  -- No user is readable on a result this evaluator did not publish, and each has refresh work registered.
  if exists (select 1 from public.card_payment_evaluator_contracts)
     or exists (select 1 from public.card_payment_eval_versions v
                where coalesce((public.get_card_payment_states(v.user_id)->>'fresh')::boolean, false)
                   or not exists (select 1 from public.card_payment_recovery_refresh_queue q where q.user_id = v.user_id)) then
    raise exception 'a result of an earlier evaluator is readable as fresh, or a user has no refresh work';
  end if;
end
$$;
