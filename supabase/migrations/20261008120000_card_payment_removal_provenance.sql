-- Institution removal records the provenance of what it preserves (Phase B, I3A-R packet 1;
-- PHASE_B_I3A_R_P1_REMOVAL_PROVENANCE.md). Builds on 20261006110000 (the decision kinds a removal writes, the
-- evaluator) and 20261006120000 (the removal that preserves known card-payment destinations). Additive: two
-- new tables with their triggers and grants, and ONE replaced function body, remove_plaid_item_local(uuid, uuid).
-- It changes no existing table, column, trigger, grant, signature or row, neither evaluator, and no decision RPC.
--
-- THIS FILE SETTLES NOTHING. No hold is ended, no record is retired, no user action is added, and nothing reads
-- the new tables. It only makes sure that what a later, separately approved packet needs still exists by then.
--
-- WHY. Before it deletes an institution, remove_plaid_item_local writes three kinds of decisions about the
-- legs that survive (20261006120000, step 3): (a) the user's confirmed pair, kept on the surviving leg;
-- (b) a system record of a known removed destination; (c) a system ambiguity hold on a pair of two surviving
-- legs. Each exists because of ONE removed transaction — its source — and the removal then deletes that
-- transaction, its account and its item. What 20261006120000 kept of the source was a date (on a hold), a
-- Plaid id and an amount (on a user pair), or nothing (on a record). And it merged:
--   * statement (c) wrote ONE hold for a pair and a date. Two removed candidates with the same date — two
--     payments on one removed card on one day, or one on each of two removed cards — became one row; and a
--     later removal wrote no hold where an earlier removal's hold with the same pair and date was still live;
--   * statement (b) wrote no record where a live record with the same key existed, whichever removal wrote it.
-- For what is PUBLISHED that is complete: the evaluator needs only the pair and the date, and one row
-- withholds as well as two. But a row could then not say which removed transactions it depends on, and a
-- row could depend on several. Ending such a row because ONE of its sources is known to be back would also
-- end the protection another, still absent, source justifies. That cannot be repaired afterwards: the
-- removed rows are gone. So it is recorded now, before any settlement exists.
--
-- THE CONTRACT.
--   1. ONE SYSTEM ROW PER SOURCE. (b) writes one record for each (surviving cash leg, removed partner); (c)
--      writes one hold for each (owner, removed candidate, kept candidate). No merge by date, and no merge with
--      a row another removal wrote: a removal never reuses, extends or suppresses a row because a similar one
--      exists. (a) is unchanged: one decision per user pair.
--   2. EVERY ROW A REMOVAL WRITES HAS EXACTLY ONE PROVENANCE ROW (card_payment_removal_sources), written in
--      the same transaction, before the delete, from the live rows: this removal (its GENERATION), the removed
--      account, the removed transaction, and what that transaction was to the surviving leg. The function
--      checks the counts and removes nothing if they differ. No other decision ever has one: provenance is
--      written by the removal while it runs, in its own transaction, and is never backfilled (the tables'
--      triggers refuse a row outside the transaction that wrote its generation).
--   3. A SOURCE EVENT is (removal_id, source_plaid_account_id, source_plaid_transaction_id). Two removals differ
--      in the first part; two transactions on one removed account differ in the last, whatever their amounts
--      and dates. One source can justify several rows (a record and holds; holds with several kept candidates;
--      holds of several owners): each row carries it, and the rows describe it identically.
--   4. USER DECISIONS STAY APART. A provenance row says what its source WAS (source_relation):
--        confirmed_counterpart  the other leg of a pair the USER confirmed — on a pair_counterpart_removed
--                               decision, and only there. That decision is the user's: only the user ends it;
--                               it is never an input of any settlement;
--        automatic_partner      the leg the evaluator had matched the surviving leg to automatically — on a
--                               record, and on a hold whose removed candidate was that match (for a surviving
--                               CARD leg no record exists, so this is the only place it is kept);
--        removed_candidate      a competing tier 1 candidate that was not the match — on a hold.
--      The table's trigger ties the relation to the decision kind in both directions.
--   5. WHAT WAS OBSERVED IS RECORDED, AND NOTHING ELSE. A system row's source always had one current row
--      (source_resolution = 'row'); a source that cannot be read is refused, never recorded as missing. Only a
--      confirmed pair's reference can have resolved to something else, and then that is what is recorded:
--        waiting_to_post  no row; an unconsumed carry-over of the removed pending row (20260927120000), which
--                         the removal also deletes: its date and amount are recorded;
--        ambiguous        several rows named the reference; none of them is THE source, and none is recorded
--                         (an invalid user confirmation: it never settles; stated here as a limit);
--        gone             no row and no carry-over.
--      No transaction id, date or amount is invented for them; the reference and the cents the user confirmed
--      stay on the decision, as before.
--   6. NOTHING PUBLISHED CHANGES — no state, reason, detail, partner, effect, range or candidate list. The
--      evaluator is not touched and reads none of this. Identical live holds withhold as one (its hold list
--      has no key; the withholding is "any hold that applies"). Several live records on one leg read as one.
--      Three things do differ from 20261006120000, none of them a figure:
--        * how many system rows exist after same-date removed candidates or after a second removal, and so the
--          length of the reader's decisions list. Rows are added per removal and never multiplied: a removal
--          writes what it would have written had no earlier row existed. Nothing in this packet retires them;
--        * which record a leg NAMES when it has several: the evaluator keeps the least decision id. A leg's
--          decision id is not an attribution and never its complete set of dependencies; a later packet must
--          enumerate a leg's live records and holds and join this table, never go through the leg state;
--        * after a full rollback to the evaluator before 20261006110000 (its rollback script, case iii), two
--          holds on one pair read conflicting_decisions where one read not_cash_side, and an undo there must
--          be repeated per hold. Same-date candidates and second removals now fall under that existing case.
--
-- WHAT IS STORED, AND WHAT IS NOT.
--   card_payment_removal_generations — one row per removal the provenance knows of. For a removal run by this
--     body (sources_recorded): the removal (plaid_item_removals already keeps the item's own id, its Plaid item
--     id and the institution name), the user, the item's institution_id as it was (NULL when it had none), and
--     its ordinal in the user's order. For a removal that finished WITHOUT provenance: a marker (below).
--   card_payment_removal_sources — one row per decision: the generation; the relation and the resolution; of
--     the removed ACCOUNT its Plaid account id and — descriptive only — type, subtype and mask; of the removed
--     TRANSACTION its Plaid transaction id, the pending id it replaced (if any), whether it was pending, its
--     date, signed cents and currency.
--   NOT stored: access tokens or any credential, account numbers, balances, account names and official names
--     (free text), transaction names or merchants, accounts that are not a source, and any other transaction
--     of the removed item.
--   The Plaid ids are HISTORICAL references. Plaid issues new item, account and transaction ids when an
--     institution is linked again. This table can show that two rows share a source; it can never show that a
--     source has returned, and nothing may infer from it which later account or transaction corresponds. Type,
--     subtype and mask describe; they are not identity (Plaid: a mask may be absent and may repeat).
--   Rows written by successive removals for one pair and date, or one leg, are separate dependencies: settling
--     one never implies another. Every system row WITHOUT a provenance row — written before this file, or
--     while it was rolled back — is unattributed, and stays protected.
--
-- REMOVALS THAT RAN WITHOUT PROVENANCE (before this file; while it was rolled back). Such a removal merged by
-- pair and date, also into a live row that carries ANOTHER removal's provenance: that row then also stands for
-- a source it does not name. Timestamps cannot say when that happened (cleaned_at and recorded_at are
-- transaction start times; calls queue on the user's advisory lock). So the order is recorded instead:
--   * every generation gets an ORDINAL, per user, assigned by the table's trigger under that lock;
--   * the first statement of the preservation block gives every earlier cleaned removal of this user that has
--     no generation row a MARKER (sources_recorded = false), before this removal's own generation.
-- THE RULE a later packet must apply before it relies on a row's provenance: a system row written by
-- generation G is known to depend on its recorded source ALONE only if the user has no marker with a greater
-- ordinal than G and no cleaned removal without a generation row. Removals made before this file get markers
-- that precede every recorded generation and so cast doubt on nothing.
--
-- RETENTION AND REDACTION.
--   * RETENTION. A provenance row lives exactly as long as the decision ROW it explains: it references that
--     decision ON DELETE CASCADE and nothing else keeps it. A decision row is deleted only with a surviving
--     account it names or with its user — an undone or replaced decision is superseded, not deleted, and its
--     provenance stays with it. So retention is: while the surviving account stays linked. That is not a
--     bounded time, and it is stated here as such. There is no orphaned evidence and no purge job.
--   * A generation row lives as long as its ledger row. Everything goes with the user (ON DELETE CASCADE).
--   * REDACTION. Three classes of columns. IDENTITY (decision_id, user_id, removal_id, source_relation,
--     source_resolution, source_plaid_account_id, source_plaid_transaction_id; a generation's ordinal and
--     sources_recorded): never changed, by anyone — the triggers refuse it. EVIDENCE (pending id, pending
--     flag, date, cents, currency): what the evaluator read; kept while the decision is live. DESCRIPTIVE
--     (source_account_type, source_account_subtype, source_account_mask; a generation's institution_id):
--     nullable, in no constraint, read by nothing — they can be set to NULL at any time without changing
--     anything else.
--   * No application role can change or delete a row here (the service role may SELECT and INSERT, nothing
--     else), and this packet adds no path that ends a system row. Until one exists, redaction is an operator
--     action as the tables' owner. THE PACKET THAT ENDS ROWS MUST REDACT WHEN IT ENDS THEM: when a decision
--     that has a provenance row is settled, undone or replaced, its descriptive columns are set to NULL in the
--     same transaction. That is a release condition of that packet, recorded here so it is not rediscovered.
--   * What a removal keeps of the removed institution is therefore MORE than the two earlier headers say, and
--     those files are not rewritten. This header supersedes three of their sentences: 20261006110000's "the
--     date of the removed candidate. Nothing else of it is kept, and nothing references it." and "that account
--     is gone and nothing references it" (more is kept, beside the decision; no foreign key references it), and
--     20261006120000's "a leg that already has a live system record with exactly the same key gets no second
--     one." (it gets one per removal; and a hold is no longer merged by pair and date, which that file's body
--     did without its header saying so).
--   * CARD_PAYMENT_PAIRING_DESIGN.md §3.5 intends a purge of decisions whose lineage has been gone for 30 days.
--     None is built. If it is, a provenance row goes with its decision, and retention is bounded by it.
--
-- OWNERSHIP AND ACCESS. No client role has any privilege on either table (row security on, no policy).
-- Triggers enforce what a foreign key cannot: a generation's user is its ledger row's user; a recorded
-- generation is inserted only while its removal is running (ledger status plaid_removed) and a marker only for
-- a removal that is finished; a provenance row's user is its decision's user and its generation's user (a
-- composite foreign key); its decision is of a kind a removal writes; its relation fits that kind; its
-- generation is recorded, running, and was written in the SAME transaction; its account is an account of the
-- item being removed; it agrees with its decision (a hold's date; a confirmed pair's reference); and where it
-- says there was a row, a transaction with that Plaid id, date and amount is on that account. Their messages
-- are fixed and carry no value.
--   * What the triggers cannot know is which of the removed account's transactions was the surviving leg's
--     partner or candidate, or that a decision was written by the removal it is attached to rather than
--     earlier: inside one transaction that has written a recorded generation, a row for an older decision of
--     the same user would pass. remove_plaid_item_local writes its plan and nothing else; the tests pin that.
-- The function runs as its caller (the service role), as before, and needs no new privilege beyond INSERT on
-- the two tables. A decision can still be deleted or re-kinded by the service role directly, as before; no
-- application path does, and a provenance row is exactly as deletable as its decision.
--
-- THE FUNCTION. The body is 20261006120000's with these edits and no other (this file was generated from
-- that body by exact replacements; the unchanged statements are byte-for-byte the reviewed ones):
--   * the item row's institution_id is read with its status;
--   * the preservation block first writes the MARKERS and the GENERATION, then creates and empties a scratch
--     table of this transaction (pg_temp.rpp_plan), like the evaluator's;
--   * statements (a), (b) and (c) keep their selects — the same joins, the same predicates — and write to the
--     plan instead of the decisions table, each row with the id its decision will get and its source:
--     (a) the removed leg of the pair, and its current row by the existing lineage rule when there is exactly
--     one; (b) the removed partner; (c) the removed candidate rc, and whether it was the owner's match;
--   * (b) no longer skips a leg that has a live record; (c) no longer says DISTINCT and no longer skips a pair
--     that has a live hold with the same date (the contract, 1);
--   * the plan is then written: the decisions, with the columns and in the order each statement used (holds
--     that differ only in their source: by its Plaid id); and one provenance row for each, read in ONE
--     statement from the removed account and transaction rows, which still exist. The function then checks
--     that every planned decision was written and has its provenance row, and refuses otherwise.
--   Everything else — the locks and their order, the strict evaluation before, the loan restoration, the
--   counts, the delete, the ledger row, the best-effort evaluation after, the result — is unchanged.
--
-- FAILURES. Every new statement — the markers, the generation, the scratch table, the plan, the decisions,
-- the provenance, the count check — is inside the existing preservation block. If any of them fails, the
-- block's handler raises the existing refusal ("known card-payment destinations could not be preserved
-- (SQLSTATE …); nothing was removed") and the whole call rolls back: no decision, no provenance, no marker, no
-- restored balance, no deleted row; the removal stays plaid_removed and can be retried. There is no path on
-- which the delete proceeds without the provenance, and no fallback that records less.
--   * A cleaned removal is replayed before any of this, as before: it returns the stored result and writes
--     nothing. A second execution that somehow got past that would stop at the generation's primary key.
--   * Every NOT NULL and CHECK of the new tables was read against the nullability of its live source, because
--     each could otherwise block a Plaid-confirmed removal for good: transactions.pending may be NULL and is
--     recorded as the evaluator reads it (false); subtype, mask and currency may be NULL and are nullable here;
--     an account's Plaid id and a transaction's Plaid id are NOT NULL at their source, and a transaction with
--     no amount or date would already have failed the strict evaluation before. No constraint here judges the
--     CONTENT of a value the provider supplied.
--
-- LOCKS. No new lock class and no new order. The inserts take the foreign-key KEY SHARE locks an insert into
-- card_payment_decisions already took here (the user's row; the surviving accounts) plus KEY SHARE on rows this
-- transaction itself wrote or already holds FOR UPDATE (the decisions, the generation, this removal's ledger
-- row) and on the ledger rows of the user's earlier cleaned removals that get a marker (nothing updates their
-- key). They are taken where the decisions' inserts were: after L1, the item's account rows and L2.
--   * One difference in extent: the generation is written on EVERY removal, so every removal now takes KEY
--     SHARE on the user's auth.users row, where 20261006120000 took it only when it wrote a decision or a
--     state. A concurrent deletion of that user is the existing detected-deadlock case, now for every removal.
--   * The two tables are not inputs of the evaluator: they have no version-bump trigger and must not get one.
--   * Applying this file while a removal is in flight can deadlock on the tables' locks (the foreign keys to
--     card_payment_decisions and plaid_item_removals). PostgreSQL detects it; either side can simply be retried.
--
-- COMPATIBILITY. Same name, signature, security properties, grants and result; the ledger row is written as
-- before. A backend that predates this file calls the same function, and no API response changes.
--
-- ROLLBACK. supabase/rollback/20261008120000_card_payment_removal_provenance_rollback.sql re-creates the
-- 20261006120000 body verbatim (checksum-verified) and keeps both tables and every row. The order is now three
-- steps: that script, then the rollback of 20261006120000, then the rollback of 20261006110000. The two older
-- scripts refuse while this body is installed, with messages that do not name this file ("… is not the
-- 20261006120000 definition; refusing to roll back"; "roll back 20261006120000 first"): run this file's
-- rollback first. This file can be applied again afterwards: its DDL is repeatable, its postcondition verifies
-- the exact shape of both tables, and the removals made in between are marked as described above.
--
-- Guard: applies only on top of the exact 20261006120000 body, the 20261006110000 evaluator and reference
-- rule, the 20260930120000 best-effort wrapper and the 20261001120000 lineage rule.

do $$
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> '7997a757408fa888aa44bdbc9d85f89d' then
    raise exception 'remove_plaid_item_local is not the 20261006120000 definition; refusing to replace it';
  end if;
  -- The evaluator this body calls twice and whose scratch tables statement (c) reads. This file does not
  -- change it; it requires the one the body was written for.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' then
    raise exception 'evaluate_card_payments is not the 20261006110000 definition this function was written for';
  end if;
  -- The other functions the body calls, as 20261006120000 required them — and the lineage rule, which this
  -- body calls to find the removed row a confirmed pair names. A later migration that replaces one of them
  -- must look at this function too.
  if to_regprocedure('public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)') is null
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_reference_status(uuid, text, bigint, timestamp with time zone)'::regprocedure) <> '6f8add9a971061e1eaefc872d85ba74a' then
    raise exception 'card_payment_reference_status is not the 20261006110000 definition this function was written for';
  end if;
  if to_regprocedure('public.try_evaluate_card_payments(uuid, timestamp with time zone)') is null
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.try_evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> 'fac15fabe5470dd62a79a3a6c8630a89' then
    raise exception 'try_evaluate_card_payments is not the 20260930120000 definition this function was written for';
  end if;
  if to_regprocedure('public.card_payment_lineage_row(uuid, text)') is null
     or (select md5(replace(prosrc, E'\r', '')) from pg_proc
         where oid = 'public.card_payment_lineage_row(uuid, text)'::regprocedure) <> '8f72e239b95584d0162bbf8bb5cb164f' then
    raise exception 'card_payment_lineage_row is not the 20261001120000 definition this function was written for';
  end if;
  if to_regclass('public.plaid_item_removals') is null
     or to_regclass('public.card_payment_decisions') is null
     or to_regclass('public.transaction_carryovers') is null then
    raise exception 'objects this migration relies on are missing (20260926120000, 20260927120000, 20260930120000)';
  end if;
end
$$;

-- ---- The generation: one row per removal the provenance knows of -------------------------------------
create table if not exists public.card_payment_removal_generations (
  removal_id        uuid primary key references public.plaid_item_removals(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  ordinal           bigint not null,
  sources_recorded  boolean not null,
  institution_id    text null,
  recorded_at       timestamp with time zone not null default now(),
  constraint card_payment_removal_generations_removal_user_key unique (removal_id, user_id),
  constraint card_payment_removal_generations_user_ordinal_key unique (user_id, ordinal),
  constraint card_payment_removal_generations_ordinal_check check (ordinal >= 1),
  constraint card_payment_removal_generations_unrecorded_check check (sources_recorded or institution_id is null)
);
comment on table public.card_payment_removal_generations is
  'One row per institution removal that the card-payment provenance knows of (20261008120000). '
  'sources_recorded = true: remove_plaid_item_local ran it with provenance, and every decision it wrote has its '
  'source in card_payment_removal_sources. sources_recorded = false: a MARKER for a removal that finished '
  'without provenance (before 20261008120000, or while it was rolled back), written by the next removal of '
  'that user. A cleaned removal with no row here ran without provenance and has not been marked yet. '
  'Written only by remove_plaid_item_local; immutable.';
comment on column public.card_payment_removal_generations.ordinal is
  'The order, per user, in which removals became known to the provenance: 1, 2, 3, … Assigned by the insert '
  'trigger, under the user''s advisory lock; whatever an insert supplies is ignored. recorded_at and '
  'plaid_item_removals.cleaned_at are transaction start times and do NOT order removals; this does. A removal '
  'that ran without provenance may have merged what it knew into any system row that was live then. So a row '
  'written by generation G is known to depend on its recorded source alone only if the user has no marker '
  '(sources_recorded = false) with a greater ordinal than G, and no cleaned removal without a row here.';
comment on column public.card_payment_removal_generations.institution_id is
  'plaid_items.institution_id of the removed item at the removal, NULL when the item had none (and on a '
  'marker). The Plaid item id and the institution name are in plaid_item_removals. Identifies the '
  'institution, never an account. Descriptive: redactable.';
create index if not exists card_payment_removal_generations_user_idx on public.card_payment_removal_generations (user_id);

-- ---- The source: one row per decision a removal wrote ------------------------------------------------
create table if not exists public.card_payment_removal_sources (
  decision_id                    uuid primary key references public.card_payment_decisions(id) on delete cascade,
  user_id                        uuid not null references auth.users(id) on delete cascade,
  removal_id                     uuid not null,
  source_relation                text not null,
  source_resolution              text not null,
  source_plaid_account_id        text not null,
  source_plaid_transaction_id    text null,
  source_pending_transaction_id  text null,
  source_pending                 boolean null,
  source_date                    date null,
  source_cents                   bigint null,
  source_iso_currency_code       text null,
  source_account_type            text null,
  source_account_subtype         text null,
  source_account_mask            text null,
  constraint card_payment_removal_sources_generation_fkey
    foreign key (removal_id, user_id)
    references public.card_payment_removal_generations (removal_id, user_id) on delete cascade,
  constraint card_payment_removal_sources_relation_check
    check (source_relation in ('confirmed_counterpart', 'automatic_partner', 'removed_candidate')),
  constraint card_payment_removal_sources_resolution_check
    check (source_resolution in ('row', 'waiting_to_post', 'ambiguous', 'gone')
           and (source_relation = 'confirmed_counterpart' or source_resolution = 'row')),
  -- What was observed is recorded, and nothing else: a transaction's own id, pending flag, pending
  -- predecessor and currency only when there was ONE row; a date and an amount when there was that row or
  -- an unconsumed carry-over of it.
  constraint card_payment_removal_sources_observed_check
    check ((source_resolution = 'row') = (source_plaid_transaction_id is not null)
           and (source_resolution = 'row') = (source_pending is not null)
           and (source_resolution = 'row' or (source_pending_transaction_id is null and source_iso_currency_code is null))
           and (source_resolution in ('row', 'waiting_to_post')) = (source_date is not null)
           and (source_resolution in ('row', 'waiting_to_post')) = (source_cents is not null))
);
create index if not exists card_payment_removal_sources_user_idx on public.card_payment_removal_sources (user_id);
create index if not exists card_payment_removal_sources_source_idx
  on public.card_payment_removal_sources (removal_id, source_plaid_account_id, source_plaid_transaction_id);
comment on table public.card_payment_removal_sources is
  'Provenance of a decision that an institution removal wrote (20261008120000): the removed transaction the '
  'decision depends on, and the removed account it was on, as they were when the removal ran. Exactly one row '
  'per such decision; deleted with it. HISTORICAL: it references no live account, item or transaction, and its '
  'Plaid ids are not stable across a relink: it can show that two rows share a source, never that a source has '
  'returned. A source event is (removal_id, source_plaid_account_id, source_plaid_transaction_id); one source '
  'can appear on several rows. Written only by remove_plaid_item_local; never backfilled; immutable. Nothing '
  'reads it yet: no settlement exists.';
comment on column public.card_payment_removal_sources.source_relation is
  'What the removed transaction was to the surviving leg. confirmed_counterpart: the other leg of a pair the '
  'USER confirmed (the row is on a pair_counterpart_removed decision, which is the user''s: only the user ends '
  'it, and it is never an input of any settlement). automatic_partner: the leg the evaluator had matched it to '
  'automatically. removed_candidate: a competing tier 1 candidate that was not its match. The last two are on '
  'SYSTEM rows (a record; a hold).';
comment on column public.card_payment_removal_sources.source_resolution is
  'What the reference resolved to at the removal. row: one current row, described here. For a confirmed pair '
  'only: waiting_to_post (no row; an unconsumed carry-over of the removed pending row, whose date and amount '
  'are recorded), ambiguous (several rows named it; none is recorded), gone (no row and no carry-over). The '
  'reference itself, and the cents the user confirmed, are on the decision.';
comment on column public.card_payment_removal_sources.source_plaid_account_id is
  'Plaid account id of the removed account. Historical: Plaid issues a new one when the account is linked again.';
comment on column public.card_payment_removal_sources.source_plaid_transaction_id is
  'Plaid transaction id of the removed row; NULL when there was no single row (source_resolution). Historical: '
  'not stable across a relink. Distinguishes two removed transactions that have the same amount and date.';
comment on column public.card_payment_removal_sources.source_pending is
  'Whether the removed row was pending, as the evaluator reads it (a NULL flag is false).';
comment on column public.card_payment_removal_sources.source_cents is
  'Signed cents as the evaluator reads them (payment and return keep their signs): the removed row''s amount, '
  'or the carry-over''s. NULL when neither existed; what the user confirmed is on the decision.';
comment on column public.card_payment_removal_sources.source_account_type is
  'accounts.type of the removed account. Descriptive: redactable. Never evidence of identity.';
comment on column public.card_payment_removal_sources.source_account_subtype is
  'accounts.subtype of the removed account. Descriptive: redactable. Never evidence of identity.';
comment on column public.card_payment_removal_sources.source_account_mask is
  'accounts.mask of the removed account (Plaid: may be absent, and may repeat within an institution). '
  'Descriptive: redactable. Never evidence of identity.';

-- ---- What a foreign key cannot say ------------------------------------------------------------------------
-- A generation belongs to its ledger row's user; it is written while that removal is running (recorded), or
-- for a removal that already finished without provenance (a marker), never the other way round; and its place
-- in the user's order and its time are assigned here, whatever an insert supplies.
create or replace function public.card_payment_removal_generations_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
begin
  select r.status into v_status from public.plaid_item_removals r
  where r.id = new.removal_id and r.user_id = new.user_id;
  if not found then
    raise exception 'card_payment_removal_provenance_foreign_removal' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if v_status is distinct from (case when new.sources_recorded then 'plaid_removed' else 'cleaned' end) then
      raise exception 'card_payment_removal_provenance_wrong_moment' using errcode = '42501';
    end if;
    new.ordinal := coalesce((select max(g.ordinal) from public.card_payment_removal_generations g
                             where g.user_id = new.user_id), 0) + 1;
    new.recorded_at := transaction_timestamp();
  elsif new.ordinal is distinct from old.ordinal or new.sources_recorded is distinct from old.sources_recorded
        or new.removal_id is distinct from old.removal_id then
    raise exception 'card_payment_removal_provenance_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists card_payment_removal_generations_guard on public.card_payment_removal_generations;
create trigger card_payment_removal_generations_guard
  before insert or update on public.card_payment_removal_generations
  for each row execute function public.card_payment_removal_generations_guard();

-- A provenance row belongs to its decision's user; only a decision of a kind that a removal writes has one;
-- the relation fits the kind (a user decision is never a system dependency, and the reverse); and it is
-- written by the removal it names — in the transaction that wrote that removal's generation, while the removal
-- is running — about an account of the item being removed. Where it says there was a row, that row is there:
-- a transaction on that account with that Plaid id, date and amount.
-- For a system row there is no "no row": a source that cannot be read is refused, not recorded as missing.
create or replace function public.card_payment_removal_sources_guard() returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_kind text;
  v_reference text;
  v_date date;
begin
  select d.kind, d.b_plaid_transaction_id, d.counterpart_date into v_kind, v_reference, v_date
  from public.card_payment_decisions d
  where d.id = new.decision_id and d.user_id = new.user_id
    and d.kind in ('pair_counterpart_removed', 'destination_removed_card',
                   'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account');
  if not found then
    raise exception 'card_payment_removal_provenance_foreign_decision' using errcode = '42501';
  end if;
  if (v_kind = 'pair_counterpart_removed') <> (new.source_relation = 'confirmed_counterpart')
     or (v_kind = 'destination_removed_card' and new.source_relation <> 'automatic_partner') then
    raise exception 'card_payment_removal_provenance_wrong_relation' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.decision_id is distinct from old.decision_id or new.removal_id is distinct from old.removal_id
       or new.source_relation is distinct from old.source_relation
       or new.source_resolution is distinct from old.source_resolution
       or new.source_plaid_account_id is distinct from old.source_plaid_account_id
       or new.source_plaid_transaction_id is distinct from old.source_plaid_transaction_id then
      raise exception 'card_payment_removal_provenance_immutable' using errcode = '42501';
    end if;
    return new;
  end if;
  if not exists (select 1 from public.card_payment_removal_generations g
                 join public.plaid_item_removals r on r.id = g.removal_id
                 join public.accounts a on a.item_id = r.item_id
                 where g.removal_id = new.removal_id and g.user_id = new.user_id and g.sources_recorded
                   and g.recorded_at = transaction_timestamp()
                   and r.status = 'plaid_removed' and a.plaid_account_id = new.source_plaid_account_id) then
    raise exception 'card_payment_removal_provenance_wrong_moment' using errcode = '42501';
  end if;
  -- The row agrees with its decision: a hold's date is its source's date; a confirmed pair's reference is its
  -- source's own id or the pending id that row replaced.
  if (v_kind like 'ambiguity_hold_%' and new.source_date is distinct from v_date)
     or (v_kind = 'pair_counterpart_removed' and new.source_resolution = 'row'
         and v_reference is distinct from new.source_plaid_transaction_id
         and v_reference is distinct from new.source_pending_transaction_id) then
    raise exception 'card_payment_removal_provenance_disagrees' using errcode = '42501';
  end if;
  -- And with the row it describes, which the removal has not deleted yet.
  if new.source_resolution = 'row'
     and not exists (select 1 from public.transactions t
                     join public.accounts a on a.id = t.account_id
                     join public.plaid_item_removals r on r.item_id = a.item_id
                     where r.id = new.removal_id and a.plaid_account_id = new.source_plaid_account_id
                       and t.plaid_transaction_id = new.source_plaid_transaction_id
                       and t.date = new.source_date and (t.amount * 100)::bigint = new.source_cents) then
    raise exception 'card_payment_removal_provenance_disagrees' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists card_payment_removal_sources_guard on public.card_payment_removal_sources;
create trigger card_payment_removal_sources_guard
  before insert or update on public.card_payment_removal_sources
  for each row execute function public.card_payment_removal_sources_guard();

-- ---- Access: no client role; the service role may read and insert, nothing else --------------------------
alter table public.card_payment_removal_generations enable row level security;
alter table public.card_payment_removal_sources enable row level security;
revoke all on table public.card_payment_removal_generations, public.card_payment_removal_sources
  from public, anon, authenticated, service_role;
grant select, insert on table public.card_payment_removal_generations, public.card_payment_removal_sources to service_role;
revoke all on function public.card_payment_removal_generations_guard(), public.card_payment_removal_sources_guard()
  from public, anon, authenticated, service_role;

-- ---- The removal: 20261006120000's body, with the edits this file's header lists ------------------------
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

-- ---- Postcondition --------------------------------------------------------------------------------
do $$
declare
  v_oid oid := 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure;
  v_tbl text;
begin
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = v_oid) <> 'cc12b7a12c6510924781b93c658ee854' then
    raise exception 'remove_plaid_item_local is not the definition this migration installs';
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
  -- This file changes neither evaluator nor any decision RPC.
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
      where oid = 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) <> '6cb5e299b0383fab0b6517cc2e7522c8' then
    raise exception 'evaluate_card_payments changed';
  end if;
  -- The two provenance tables: row security on, no policy, no client privilege, and for the service role
  -- exactly SELECT and INSERT (rows are immutable; they go only with their decision, removal or user).
  foreach v_tbl in array array['card_payment_removal_generations', 'card_payment_removal_sources'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_tbl)::regclass)
       or exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = v_tbl) then
      raise exception '%: row level security must be on, with no policy', v_tbl;
    end if;
    if exists (select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
               cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
               where has_table_privilege(r.role, ('public.' || v_tbl)::regclass, p.priv)) then
      raise exception '%: a client role has a privilege', v_tbl;
    end if;
    if not has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'select')
       or not has_table_privilege('service_role', ('public.' || v_tbl)::regclass, 'insert')
       or exists (select 1 from (values ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
                  where has_table_privilege('service_role', ('public.' || v_tbl)::regclass, p.priv))
       or exists (select 1 from information_schema.column_privileges cp
                  where cp.table_schema = 'public' and cp.table_name = v_tbl
                    and cp.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
                    and cp.privilege_type not in ('SELECT', 'INSERT')) then
      raise exception '%: service_role must have exactly SELECT and INSERT', v_tbl;
    end if;
  end loop;
  -- No reference from provenance to a row the removal deletes: only to the decision, the removal ledger,
  -- the generation and the user.
  if exists (select 1 from pg_constraint c
             where c.contype = 'f'
               and c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
               and c.confrelid in ('public.accounts'::regclass, 'public.transactions'::regclass, 'public.plaid_items'::regclass)) then
    raise exception 'provenance must not reference accounts, transactions or plaid_items';
  end if;
  if (select count(*) from pg_trigger t
      where ((t.tgrelid = 'public.card_payment_removal_generations'::regclass and t.tgname = 'card_payment_removal_generations_guard')
          or (t.tgrelid = 'public.card_payment_removal_sources'::regclass and t.tgname = 'card_payment_removal_sources_guard'))
        and t.tgenabled = 'O' and not t.tgisinternal
        and t.tgtype = 23) <> 2 then  -- 23: a row trigger, before insert or update
    raise exception 'a provenance guard trigger is missing, disabled or not BEFORE INSERT OR UPDATE FOR EACH ROW';
  end if;
  if exists (select 1 from pg_trigger t
             where t.tgrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
               and not t.tgisinternal
               and t.tgname not in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')) then
    raise exception 'a provenance table has a trigger this migration does not define';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')
               and (p.prosecdef or p.proconfig is distinct from array['search_path=""']
                    or has_function_privilege('public', p.oid, 'execute')
                    or has_function_privilege('anon', p.oid, 'execute')
                    or has_function_privilege('authenticated', p.oid, 'execute')
                    or has_function_privilege('service_role', p.oid, 'execute'))) then
    raise exception 'a provenance trigger function has a wrong security property or grant';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('card_payment_removal_generations_guard', 'card_payment_removal_sources_guard')) <> 2 then
    raise exception 'a provenance trigger function is missing';
  end if;
  -- The tables have exactly the shape this file defines. Its DDL is repeatable (create … if not exists), so
  -- a table left behind in another shape would otherwise be kept silently.
  if (select string_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end,
                        ', ' order by a.attnum)
      from pg_attribute a
      where a.attrelid = 'public.card_payment_removal_generations'::regclass and a.attnum > 0 and not a.attisdropped)
     is distinct from 'removal_id uuid not null, user_id uuid not null, ordinal bigint not null, sources_recorded boolean not null, '
                      || 'institution_id text, recorded_at timestamp with time zone not null' then
    raise exception 'card_payment_removal_generations does not have the columns this migration defines';
  end if;
  if (select string_agg(a.attname::text || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end,
                        ', ' order by a.attnum)
      from pg_attribute a
      where a.attrelid = 'public.card_payment_removal_sources'::regclass and a.attnum > 0 and not a.attisdropped)
     is distinct from 'decision_id uuid not null, user_id uuid not null, removal_id uuid not null, source_relation text not null, '
                      || 'source_resolution text not null, source_plaid_account_id text not null, source_plaid_transaction_id text, '
                      || 'source_pending_transaction_id text, source_pending boolean, source_date date, source_cents bigint, '
                      || 'source_iso_currency_code text, source_account_type text, source_account_subtype text, source_account_mask text' then
    raise exception 'card_payment_removal_sources does not have the columns this migration defines';
  end if;
  if (select string_agg(c.conname::text || ':' || c.contype::text || case when c.contype = 'f'
                                                           then ':' || (select n.nspname::text || '.' || k.relname::text from pg_class k
                                                                        join pg_namespace n on n.oid = k.relnamespace
                                                                        where k.oid = c.confrelid) || ':' || c.confdeltype::text
                                                           else '' end,
                        ', ' order by c.conname)
      from pg_constraint c
      where c.conrelid in ('public.card_payment_removal_generations'::regclass, 'public.card_payment_removal_sources'::regclass)
        and c.contype in ('p', 'u', 'f', 'c') and c.convalidated)
     is distinct from 'card_payment_removal_generations_ordinal_check:c, card_payment_removal_generations_pkey:p, '
                      || 'card_payment_removal_generations_removal_id_fkey:f:public.plaid_item_removals:c, '
                      || 'card_payment_removal_generations_removal_user_key:u, card_payment_removal_generations_unrecorded_check:c, '
                      || 'card_payment_removal_generations_user_id_fkey:f:auth.users:c, card_payment_removal_generations_user_ordinal_key:u, '
                      || 'card_payment_removal_sources_decision_id_fkey:f:public.card_payment_decisions:c, '
                      || 'card_payment_removal_sources_generation_fkey:f:public.card_payment_removal_generations:c, '
                      || 'card_payment_removal_sources_observed_check:c, '
                      || 'card_payment_removal_sources_pkey:p, card_payment_removal_sources_relation_check:c, '
                      || 'card_payment_removal_sources_resolution_check:c, card_payment_removal_sources_user_id_fkey:f:auth.users:c' then
    raise exception 'the provenance tables do not have the constraints this migration defines';
  end if;
  if (select count(*) from pg_indexes i
      where i.schemaname = 'public'
        and i.indexname in ('card_payment_removal_generations_user_idx', 'card_payment_removal_sources_user_idx',
                            'card_payment_removal_sources_source_idx')) <> 3 then
    raise exception 'a provenance index is missing';
  end if;
  -- What the body relies on, unchanged by this file.
  if (select count(*) from pg_constraint c
      where c.conrelid = 'public.card_payment_decisions'::regclass and c.contype = 'f'
        and c.confrelid = 'public.accounts'::regclass and c.confdeltype = 'c') <> 2 then
    raise exception 'card_payment_decisions must reference accounts twice, ON DELETE CASCADE';
  end if;
end
$$;
