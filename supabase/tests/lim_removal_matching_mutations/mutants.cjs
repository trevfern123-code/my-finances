// Mutants (negative controls) for the two I3A migrations:
//   20261006120000_lim_removal_card_payment_matching.sql      remove_plaid_item_local
//   20261006110000_card_payment_pair_counterpart_removed.sql  evaluate_card_payments (the new decision kinds)
//
//   node mutants.cjs <out-dir>     writes <name>.sql per mutant, plus manifest.tsv
//
// Each mutant re-creates ONE function from the real migration text with exact substitutions. Every
// substitution must match exactly the stated number of times, or generation fails. run.sh applies each mutant
// as the LAST migration of a disposable database and records which tests detect it. `expect` names the test
// and the beginning of the failure that must appear, or SURVIVES when the safeguard is deliberately redundant
// with another one. `expect` may be a LIST: then every one of those failures must appear (a control for a rule
// that several contract tests pin is only "detected" when each of them says so).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n/g, '\n');
const definition = (src, head) => {
  const start = src.indexOf(head);
  if (start < 0 || src.indexOf(head, start + 1) >= 0) throw new Error(`definition not unique: ${head}`);
  return src.slice(start, src.indexOf('\n$$;', start) + 4);
};
const REMOVAL = definition(read('20261006120000_lim_removal_card_payment_matching.sql'), 'create or replace function public.remove_plaid_item_local(');
const EVALUATOR = definition(read('20261006110000_card_payment_pair_counterpart_removed.sql'), 'create or replace function public.evaluate_card_payments(');

/** The text of `src` from `from` up to and including `to` (`from` must be unique). */
function block(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0 || src.indexOf(from, a + 1) >= 0) throw new Error(`block not unique: ${from.slice(0, 50)}`);
  return src.slice(a, b + to.length);
}
// ---- remove_plaid_item_local -------------------------------------------------------------------------
const ACCOUNT_LOCKS = `  perform 1 from public.accounts a where a.item_id = p_item_id order by a.id for update;\n`;
const FIRST_EVAL = block(REMOVAL, '  begin\n    v_evaluated := public.evaluate_card_payments(p_user_id);',
  "before the removal (SQLSTATE %); nothing was removed', sqlstate\n      using errcode = sqlstate;\n  end;\n");
// The two preservation statements, in their one fail-closed block.
const PRESERVE = block(REMOVAL, '  begin\n    -- (a) USER-CONFIRMED pairs',
  "could not be preserved (SQLSTATE %); nothing was removed', sqlstate\n      using errcode = sqlstate;\n  end;\n");
const USER_PAIRS = block(REMOVAL, '    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,', '    order by d.id;\n');
const USER_PAIRS_ORDER = `    order by d.id;\n`;
const AUTO_PAIRS_NOT_HELD = `      and s.partner_transaction_id is not null\n      and s.decision_id is null\n`;
const NOT_RECLASSIFIED = block(REMOVAL, '      and not exists (select 1 from public.transactions t\n', "and t.user_role_override is not null and t.user_role_override <> 'credit_card_payment')\n");
// The final evaluation is best-effort (Trevor's decision, 2026-10-06): one statement, in a subtransaction.
const FINAL_EVAL = `  perform public.try_evaluate_card_payments(p_user_id);\n`;
// What it was in the first candidate: strict, so its failure rolled the whole removal back.
const FINAL_EVAL_STRICT = `  begin
    perform public.evaluate_card_payments(p_user_id);
  exception when others then
    raise exception 'remove_plaid_item_local: card-payment matching could not be evaluated after the removal (SQLSTATE %); nothing was removed', sqlstate
      using errcode = sqlstate;
  end;
`;
const DELETE = `  delete from public.plaid_items where id = p_item_id and user_id = p_user_id;\n`;
const STORED_VERSION = `  select v.evaluated_version into v_evaluated from public.card_payment_eval_versions v where v.user_id = p_user_id;\n`;
const L1 = `  perform pg_advisory_xact_lock(hashtext(p_user_id::text));\n`;
const DEDUPE = block(REMOVAL, '      and not exists (select 1 from public.card_payment_decisions d', '                        and d.a_cents = s.amount_cents)\n');
// (c) The ambiguity holds (Trevor's decision of 2026-10-06 on §4.7).
const HOLDS_STMT = block(REMOVAL, '    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,\n       counterpart_date)',
  '    order by 2, 3, 4, 6, 7, 9;\n');
const HOLD_KIND = `      select case when not o.credit then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,\n`;
// Whose candidates are held: a leg with no automatic match, or one whose automatic match is on the removed item.
const HOLD_OWNER = `        and (t1.partner is null or pa.item_id = p_item_id)\n`;
const HOLD_OWNER_ITEM = `      where oi.user_id = p_user_id and oi.id <> p_item_id\n`;
const HOLD_KEPT_ITEM = `        and yi.user_id = p_user_id and yi.id <> p_item_id\n`;
const HOLD_KEPT_EDGE = `      join pg_temp.cpe_pool y on y.id <> o.id and y.credit <> o.credit and y.cents = -o.cents and abs(o.day - y.day) <= 5\n`;
// The same tier 1 edge, restated for the REMOVED candidate, and the "not dismissed" half of it on either side.
const HOLD_RC_EDGE = `      join pg_temp.cpe_pool rc on rc.id <> o.id and rc.credit <> o.credit and rc.cents = -o.cents and abs(o.day - rc.day) <= 5\n`;
const HOLD_RC_NOT_DISMISSED = `        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id))\n`;
const HOLD_Y_NOT_DISMISSED = `        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, y.id) and dd.hi = greatest(o.id, y.id))\n`;
// Statement (c) as it was in revision 4: read from the PUBLISHED states (unresolved, no decision, displayed candidates).
const R4_HOLDS_STMT = "    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,\n       counterpart_date)\n    select distinct p_user_id, h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date\n    from (\n      select case when s.side = 'cash' then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,\n             case when s.side = 'cash' then yt.account_id else xt.account_id end as a_account,\n             case when s.side = 'cash' then yt.plaid_transaction_id else xt.plaid_transaction_id end as a_plaid,\n             case when s.side = 'cash' then (yt.amount * 100)::bigint else s.amount_cents end as a_cents,\n             case when s.side = 'cash' then xt.account_id else yt.account_id end as b_account,\n             case when s.side = 'cash' then xt.plaid_transaction_id else yt.plaid_transaction_id end as b_plaid,\n             case when s.side = 'cash' then s.amount_cents else (yt.amount * 100)::bigint end as b_cents,\n             rt.date as removed_date\n      from public.card_payment_leg_states s\n      join public.transactions xt on xt.id = s.transaction_id\n      join public.accounts xa on xa.id = xt.account_id\n      join public.plaid_items xi on xi.id = xa.item_id\n      cross join lateral jsonb_array_elements(s.candidates) rc\n      join public.transactions rt on rt.id = (rc->>'transactionId')::uuid\n      join public.accounts ra on ra.id = rt.account_id\n      join public.plaid_items ri on ri.id = ra.item_id\n      cross join lateral jsonb_array_elements(s.candidates) sc\n      join public.transactions yt on yt.id = (sc->>'transactionId')::uuid\n      join public.accounts ya on ya.id = yt.account_id\n      join public.plaid_items yi on yi.id = ya.item_id\n      where s.user_id = p_user_id\n        and s.computed_at_version = v_evaluated\n        and s.state = 'unresolved'\n        and s.decision_id is null\n        and rc->>'kind' = 'tier1_competitor'\n        and sc->>'kind' = 'tier1_competitor'\n        and xi.user_id = p_user_id and xi.id <> p_item_id\n        and ri.user_id = p_user_id and ri.id = p_item_id\n        and yi.user_id = p_user_id and yi.id <> p_item_id\n    ) h\n    where not exists (select 1 from public.card_payment_decisions d\n                      where d.user_id = p_user_id and d.kind = h.kind and d.superseded_by is null\n                        and d.a_account_id = h.a_account and d.a_plaid_transaction_id = h.a_plaid and d.a_cents = h.a_cents\n                        and d.b_account_id = h.b_account and d.b_plaid_transaction_id = h.b_plaid and d.b_cents = h.b_cents\n                        and d.counterpart_date = h.removed_date)\n    order by 2, 3, 4, 6, 7, 9;\n";
const HOLD_REMOVED_ITEM = `        and ri.user_id = p_user_id and ri.id = p_item_id\n`;
const HOLD_DATE = `             rt.date as removed_date\n`;
const HOLD_DEDUPE = block(REMOVAL, '    where not exists (select 1 from public.card_payment_decisions d\n                      where d.user_id = p_user_id and d.kind = h.kind',
  '                        and d.counterpart_date = h.removed_date)\n');
// ---- evaluate_card_payments ----------------------------------------------------------------------------
// The frozen status of a preserved pair is read in two places since revision 5: a disqualifier other than an
// amount BEFORE the surviving leg's amount and role, and a frozen amount change after them.
const FROZEN_FIRST_IF = `      if d.kind = 'pair_counterpart_removed' and d.counterpart_status not in ('valid', 'waiting_to_post', 'amount_changed') then\n`;
const FROZEN_FIRST = `        v_inactive := d.counterpart_status;\n`;
const FROZEN_LAST = `        v_inactive := case when d.counterpart_status = 'amount_changed' then 'amount_changed' end;\n`;
const FROZEN_LAST_R4 = `        v_inactive := case when d.counterpart_status not in ('valid', 'waiting_to_post') then d.counterpart_status end;\n`;
const EXCEPTION = `        if v_claim.inactive = 'amount_changed' and v_claim.kind in ('destination_unlinked', 'pair_counterpart_removed') and not l.credit\n`;
const SYSTEM_KIND = `    if d.kind = 'destination_removed_card' then\n`;
const POOL = `  where t.is_leg and not t.conflict and not exists (select 1 from pg_temp.cpe_claim c where c.leg_id = t.id);\n`;
// The ambiguity hold in the evaluator: when it applies, what it withholds, and what it leaves alone.
const VETO = block(EVALUATOR, '  delete from pg_temp.cpe_tier1 t1\n', '    and abs(h.day - o.day) <= abs(o.day - x.day);\n');
const VETO_EDGE = `  where ((t1.id = h.owner_id and t1.partner = h.other_id) or (t1.id = h.other_id and t1.partner = h.owner_id))\n`;
const VETO_DATE = `    and abs(h.day - o.day) <= abs(o.day - x.day);\n`;
const HOLD_AMOUNTS = `        if v_ra.cents <> d.a_cents or v_rb.cents <> d.b_cents then\n          v_inactive := 'amount_changed';\n        elsif not v_ra.is_leg or not v_rb.is_leg then\n`;
const REMOVED_STEP = `    elsif not l.credit and exists (select 1 from pg_temp.cpe_removed r where r.row_id = l.id) then\n`;
const USER_RESULTS = `  insert into pg_temp.cpe_dec_result\n  select u.decision_id, u.kind, case when u.inactive is null then 'active' else 'inactive' end, u.inactive from pg_temp.cpe_udec u;\n`;

const AUTO_RECORDS = 'exactly the eight surviving cash legs that were paired AUTOMATICALLY with a removed card leg have a system record';
const USER_RECORDS = 'exactly the two USER-confirmed pairs became user decisions on their surviving legs';
const CONTRACT = 'institution removal keeps explicit user confirmations and their reservations (Decision 2); violated in: ';
const HOLD_CONTRACT = 'institution removal is not evidence: an unresolved tie stays unresolved until new evidence or the user decides; violated in: ';
// The three contract tests of revision 5: a23 (the audit's P1), a24 (P2), a25 (Trevor's decision "Option B").
const P1_CONTRACT = 'institution removal is not evidence where an excluded account is involved either: an ambiguity in the complete matching pool is held; violated in: ';
const P2_CONTRACT = 'a frozen counterpart invalidity is never masked by a surviving amount correction; violated in: ';
const B_CONTRACT = 'a removal does not switch an automatically matched payment to a card that was already there; violated in: ';
// Every case of a25 in which a payment (or, in L, a card leg) was matched AUTOMATICALLY to the removed
// institution while a leg that stays also fitted it. (O3 is a tie behind an earlier record: it is held by the
// other half of the rule, so it is named separately where a control breaks that half or the withholding.)
const ALL_SWITCHED = 'A, D, E, E2, F-amt, F-date, F-own, G, G-card, G-date, G-two, H, J, K-ce, K-e, K-xe, L, N, O, O2';
// Every frozen disqualifier of a24 on user aa: the three produced through the real removal and the seven written
// directly (bb's competitor case C-amount is added per control).
const ALL_DISQUALIFIED = 'G-amount, L-amount, M-conflicting_decisions, M-difference_not_accepted, M-direction_mismatch, M-lineage_ambiguous, M-partner_gone, M-role_changed, M-sides_not_opposite, R-amount';
const STALE = 'states are not fresh when reading leg k-a';
// Every case of a22 whose payment is held against an ambiguity (N, R and S have no hold: their ties are between
// two kept cards). T has a hold too, but its requirement is about WHICH holds are written, not about what the
// payment reads: it is named separately where a control changes that.
const ALL_HELD = 'A, B, C-amount, C-date, C-new, C-posted, D, E, F, G, M, P';

const mutants = [
  // ---- the removal: evaluation, preservation of automatic pairs, freshness (as in the first review) ----
  { name: 'no_preservation', subs: [[PRESERVE, '  null;\n']],
    what: 'DELETION WITHOUT PRESERVATION: both preservation statements are removed; the removal only evaluates and deletes',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'preservation_after_delete', subs: [[PRESERVE, ''], [DELETE, DELETE + '\n' + PRESERVE]],
    what: 'PRESERVATION AFTER THE DELETE: the same statements, moved after the item is deleted (the rows and the pair decisions are gone)',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'no_first_evaluation', subs: [[FIRST_EVAL, STORED_VERSION], [HOLDS_STMT, '']],
    what: 'no in-transaction evaluation before the preservation: the user pairs and the automatic pairs are read from the STORED states at their stored version (the hold statement, which needs the evaluation\'s own pool, is taken out so that this is what the control shows)',
    expect: 'a19: records: k-a, and k-late (a pair no stored state knew)' },
  { name: 'no_first_evaluation_fails_closed', subs: [[FIRST_EVAL, STORED_VERSION]],
    what: 'no in-transaction evaluation, the hold statement left in: it finds no pool of this transaction (the evaluator\'s scratch tables do not exist), and the removal fails closed instead of preserving from stale states',
    expect: 'a18: remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE 42P01); nothing was removed' },
  { name: 'first_evaluation_best_effort', subs: [[FIRST_EVAL, `  perform public.try_evaluate_card_payments(p_user_id);\n${STORED_VERSION}`]],
    what: 'PRE-EVALUATION BEST-EFFORT: the first evaluation in a subtransaction whose failure is swallowed (try_evaluate). The removal no longer says that matching could not be evaluated; with the hold statement in, it then fails closed on the missing pool rather than run on stale states',
    expect: 'a19: expected an error like remove_plaid_item_local: card-payment matching could not be evaluated before the removal (SQLSTATE 25001); nothing was removed but got: remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE 42P01); nothing was removed' },
  { name: 'no_final_evaluation', subs: [[FINAL_EVAL, '']],
    what: 'no evaluation after the delete: the removal commits with the version ahead of the published states (the readers of the three revision 5 contract tests refuse to read them)',
    expect: ['a18: the removal published fresh states at exactly the final input version', `a23: ${STALE}`, `a25: ${STALE}`] },
  { name: 'final_evaluation_strict', subs: [[FINAL_EVAL, FINAL_EVAL_STRICT]],
    what: 'FINAL EVALUATION STRICT AGAIN: a failure of the final evaluation raises, and undoes a removal whose evidence was already preserved',
    expect: 'a19: B3: a failed final evaluation must not fail the removal' },
  { name: 'failed_final_evaluation_marked_fresh', subs: [[FINAL_EVAL,
      `  if not public.try_evaluate_card_payments(p_user_id) then\n` +
      `    update public.card_payment_eval_versions set evaluated_version = input_version where user_id = p_user_id;\n` +
      `  end if;\n`]],
    what: 'STALE STATE EXPOSED AS FRESH AFTER A FAILED FINAL EVALUATION: the normal path is untouched; when the final evaluation fails, the version is declared evaluated anyway',
    expect: 'a19: B3: the versions say stale' },
  { name: 'stale_marked_fresh', subs: [[FINAL_EVAL, '  update public.card_payment_eval_versions set evaluated_version = input_version where user_id = p_user_id;\n']],
    what: 'STALE FINAL STATE PUBLISHED AS FRESH: instead of evaluating again, the version is simply declared evaluated (the stored states keep the version of before the removal, so the reader reports fresh and returns no leg and no decision at all)',
    expect: 'a18: no state row of an earlier version, and none for a deleted transaction' },
  { name: 'version_not_advanced', subs: [[FINAL_EVAL, FINAL_EVAL +
      `  update public.card_payment_leg_states set computed_at_version = v_evaluated where user_id = p_user_id;\n` +
      `  update public.card_payment_auto_pairs set computed_at_version = v_evaluated where user_id = p_user_id;\n` +
      `  update public.card_payment_decision_states set computed_at_version = v_evaluated where user_id = p_user_id;\n` +
      `  update public.card_payment_eval_versions set input_version = v_evaluated, evaluated_version = v_evaluated where user_id = p_user_id;\n`]],
    what: 'MISSING VERSION BUMP: correct states, but the input version ends where it was before the removal (needs UPDATE on the derived tables: applied as postgres-owned SECURITY DEFINER in the mutant only). The decisions the removal wrote — records, preserved pairs, holds — would then not count as an input change',
    expect: 'a18: the matching input version advanced',
    definer: true },
  { name: 'converts_unresolved', subs: [['    join public.transactions pt on pt.id = s.partner_transaction_id\n', '    join public.transactions pt on pt.amount = -t.amount\n'],
                                        ['      and s.partner_transaction_id is not null\n', '']],
    what: 'REMOVAL TREATED AS EVIDENCE: any surviving cash leg with an opposite-amount leg on the removed item gets a system record, paired or not',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'converts_kept_pairs', subs: [['      and pi.user_id = p_user_id and pi.id = p_item_id\n', '      and pi.user_id = p_user_id\n']],
    what: 'no restriction to the removed item: automatic pairs with a card that stays get a system record too',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'wrong_lineage_key', subs: [["    select p_user_id, 'destination_removed_card', t.account_id, t.plaid_transaction_id, s.amount_cents\n",
                                       "    select p_user_id, 'destination_removed_card', t.account_id, pt.plaid_transaction_id, s.amount_cents\n"]],
    what: "the system record is keyed by the removed card leg's Plaid id instead of the surviving cash leg's own",
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'no_dedupe', subs: [[DEDUPE, '']],
    what: 'no check for an existing live system record with the same key',
    expect: 'a18: second removal: a leg whose key is unchanged keeps its one record' },
  { name: 'raw_errors', subs: [[PRESERVE, PRESERVE.replace('  begin\n', '').replace(/  exception when others then[\s\S]*$/, '')]],
    what: 'the preservation error is not replaced by the fixed message: whatever the failing statement says reaches the caller',
    expect: 'a19: expected an error like remove_plaid_item_local: known card-payment destinations could not be preserved' },
  { name: 'version_row_before_advisory_lock', subs: [[L1, `  perform 1 from public.card_payment_eval_versions v where v.user_id = p_user_id for update;\n${L1}`]],
    what: 'LOCK ORDER: the version row (L2) is locked before the per-user advisory lock (L1)',
    expect: 'c33: while waiting on L1, the removal held no lock on the version row' },
  { name: 'no_user_filter', subs: [['      and ci.user_id = p_user_id and ci.id <> p_item_id\n', '      and ci.id <> p_item_id\n'],
                                   ['      and pi.user_id = p_user_id and pi.id = p_item_id\n', '      and pi.id = p_item_id\n']],
    what: 'the automatic-pair statement does not re-check the owner of either account (the evaluator already wrote only this user\'s states, and the insert trigger re-checks the account)',
    expect: 'SURVIVES (defense in depth: redundant with the per-user states and card_payment_decisions_same_user)' },
  { name: 'no_survivor_filter', subs: [['      and ci.user_id = p_user_id and ci.id <> p_item_id\n', '      and ci.user_id = p_user_id\n']],
    what: 'cash legs on the removed item itself get a system record too (deleted with their account by the cascade)',
    expect: 'SURVIVES (redundant with the account cascade: a record on a removed account goes with it)' },

  // ---- the removal: user-confirmed pairs (Trevor's decision 2 and the mirror case) ----
  { name: 'user_pairs_not_preserved', subs: [[USER_PAIRS, '']],
    what: 'USER-STRENGTH PRESERVATION DROPPED: no pair_counterpart_removed decision is written; a user-confirmed pair is simply deleted with the account',
    expect: `a18: ${USER_RECORDS}` },
  { name: 'user_pairs_downgraded_to_system_record', subs: [[USER_PAIRS, ''], [AUTO_PAIRS_NOT_HELD, `      and s.partner_transaction_id is not null\n`]],
    what: 'DOWNGRADE TO THE SYSTEM RECORD: an active user-confirmed pair gets the ordinary non-reserving destination_removed_card instead (the behaviour of the candidate before this decision)',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'waiting_confirmation_released', subs: [[USER_PAIRS_ORDER, `      and ds.detail is distinct from 'waiting_to_post'\n${USER_PAIRS_ORDER}`]],
    what: 'WAITING CONFIRMATION RELEASED: a user pair that is waiting to post when the account is removed is not preserved',
    expect: `a20: ${CONTRACT}W-card, W-cash` },
  { name: 'amount_changed_reservation_released', subs: [[USER_PAIRS_ORDER, `      and ds.detail is distinct from 'amount_changed'\n${USER_PAIRS_ORDER}`]],
    what: 'AMOUNT-CHANGED RESERVATION RELEASED: a user pair invalidated by an amount change is not preserved',
    expect: `a20: ${CONTRACT}A-card, A-cash, M-amount` },
  { name: 'ambiguous_confirmation_released', subs: [[USER_PAIRS_ORDER, `      and ds.detail is distinct from 'lineage_ambiguous'\n${USER_PAIRS_ORDER}`]],
    what: 'AMBIGUOUS-LINEAGE RESERVATION RELEASED: a user pair with conflicting replacements is not preserved',
    expect: `a20: ${CONTRACT}L-card, L-cash` },
  { name: 'mirror_case_not_preserved', subs: [[USER_PAIRS_ORDER, `      and not coalesce(sa.type = 'credit', false)\n${USER_PAIRS_ORDER}`]],
    what: 'MIRROR CASE DROPPED: only a surviving CASH leg is preserved; a card leg whose confirmed cash account was removed is released',
    expect: `a20: ${CONTRACT}M-active, M-amount` },
  { name: 'active_pair_frozen_as_invalid', subs: [["             when ds.status = 'active' then 'valid'\n", "             when ds.status = 'active' then 'amount_changed'\n"]],
    what: 'WRONG FROZEN STATUS: an active confirmation is preserved, but recorded as invalid — it would hold its leg and never count',
    expect: `a18: ${USER_RECORDS}` },
  { name: 'superseded_pairs_preserved', subs: [["    where d.user_id = p_user_id and d.kind = 'pair' and d.superseded_by is null\n", "    where d.user_id = p_user_id and d.kind = 'pair'\n"]],
    what: 'AN UNDONE OR REPLACED CONFIRMATION RESURRECTED: superseded pairs are preserved too',
    expect: 'a21: aa: preserved' },
  { name: 'reclassified_pairs_preserved', subs: [[NOT_RECLASSIFIED, '']],
    what: 'A NEWER EXPLICIT USER ACTION IGNORED: a pair one of whose legs the user re-classified away from card payment is preserved, and keeps holding the other leg',
    expect: 'a21: aa: preserved' },

  // ---- the removal: the account-row locks (the lock-order mitigation) ----
  { name: 'no_account_locks', subs: [[ACCOUNT_LOCKS, '']],
    what: 'ACCOUNT LOCKS OMITTED: the version row is taken (first evaluation) before any account row of the item — the new deadlock of the earlier candidate',
    expect: 'c34: deadlock detected' },
  { name: 'account_locks_after_first_evaluation', subs: [[ACCOUNT_LOCKS, ''], [FIRST_EVAL, FIRST_EVAL + '\n' + ACCOUNT_LOCKS]],
    what: 'ACCOUNT LOCKS TOO LATE: the same locks, taken after the first evaluation has taken the version row',
    expect: 'c34: deadlock detected' },
  { name: 'account_locks_for_share', subs: [[ACCOUNT_LOCKS, ACCOUNT_LOCKS.replace('for update', 'for share')]],
    what: 'ACCOUNT LOCKS TOO WEAK: FOR SHARE instead of the delete\'s own FOR UPDATE — it stops an account update but lets an insert that references the account through',
    expect: 'c35: deadlock detected' },

  // ---- the evaluator: the new decision kind ----
  { name: 'eval_preserved_pair_not_reserving', target: 'evaluator', subs: [[SYSTEM_KIND, `    if d.kind in ('destination_removed_card', 'pair_counterpart_removed') then\n`]],
    what: 'EVALUATOR: the preserved user pair is read like the system record — below tier 1 and holding nothing (user strength lost at evaluation)',
    expect: `a20: ${CONTRACT}` },
  { name: 'eval_preserved_leg_left_in_tier1_pool', target: 'evaluator', subs: [[POOL,
      `  where t.is_leg and not t.conflict\n` +
      `    and not exists (select 1 from pg_temp.cpe_claim c join pg_temp.cpe_udec u on u.decision_id = c.decision_id\n` +
      `                    where c.leg_id = t.id and u.kind <> 'pair_counterpart_removed');\n`]],
    what: 'EVALUATOR: COMPETITOR AUTO-MATCH ALLOWED — a leg held by a preserved pair stays in the automatic-matching pool, so another card can pair with it',
    expect: `a20: ${CONTRACT}` },
  { name: 'eval_frozen_status_ignored', target: 'evaluator', subs: [[FROZEN_FIRST_IF, `      if false then\n`], [FROZEN_LAST, `        v_inactive := null;\n`]],
    what: 'EVALUATOR: the frozen status of the removed side is ignored, in both places it is read — a confirmation that was invalid on that side becomes valid through the removal',
    expect: [`a20: ${CONTRACT}A-card, L-card, M-amount`, `a24: ${P2_CONTRACT}A-amount, C-amount, ${ALL_DISQUALIFIED.replace('M-conflicting_decisions', 'M-amount_changed, M-conflicting_decisions')} (`] },
  // ---- the evaluator: a frozen disqualifier and a surviving amount correction (the audit's P2) ----
  { name: 'eval_frozen_status_after_amount', target: 'evaluator', subs: [[FROZEN_FIRST_IF, `      if false then\n`], [FROZEN_LAST, FROZEN_LAST_R4]],
    what: 'EVALUATOR: AMOUNT_CHANGED MASKS A FROZEN DISQUALIFIER — the revision 4 order: the surviving leg\'s amount is checked first, so a corrected amount hides what was wrong with the removed side (and, with no included card, publishes a known effect)',
    expect: `a24: ${P2_CONTRACT}C-amount, ${ALL_DISQUALIFIED} (` },
  { name: 'eval_frozen_status_only_while_card_leg', target: 'evaluator', subs: [[FROZEN_FIRST_IF,
      `      if d.kind = 'pair_counterpart_removed' and v_ra.is_leg and d.counterpart_status not in ('valid', 'waiting_to_post', 'amount_changed') then\n`]],
    what: 'EVALUATOR: THE FROZEN DISQUALIFIER IS READ ONLY WHILE THE SURVIVING ROW IS A CARD LEG — once the surviving payment is re-classified, the decision reports the surviving row\'s own role instead of what was wrong with the removed side (M-role_changed cannot show it: both readings are role_changed)',
    expect: `a24: ${P2_CONTRACT}M-conflicting_decisions, M-difference_not_accepted, M-direction_mismatch, M-lineage_ambiguous, M-partner_gone, M-sides_not_opposite (` },
  { name: 'eval_exception_for_any_inactive_preserved_pair', target: 'evaluator', subs: [[EXCEPTION,
      `        if (v_claim.inactive = 'amount_changed' or v_claim.kind = 'pair_counterpart_removed') and v_claim.kind in ('destination_unlinked', 'pair_counterpart_removed') and not l.credit\n`]],
    what: 'EVALUATOR: THE FROZEN INVALIDITY IS BYPASSED — the known-effect exception accepts a preserved pair whatever its inactive reason is: with no included card, an ambiguous, withdrawn or re-classified counterpart no longer keeps the payment unresolved',
    expect: `a24: ${P2_CONTRACT}${ALL_DISQUALIFIED} (` },

  // ---- the removal: the system ambiguity hold (Trevor's decision of 2026-10-06: removal is not evidence) ----
  { name: 'ambiguity_hold_omitted', subs: [[HOLDS_STMT, '']],
    what: 'AMBIGUITY HOLD OMITTED: the removal writes no hold; a tie between a removed card and a kept one resolves to the kept card when the other is deleted (the behaviour before this decision)',
    expect: `a22: ${HOLD_CONTRACT}${ALL_HELD}, T (` },
  { name: 'hold_without_a_removed_candidate', subs: [[HOLD_REMOVED_ITEM, `        and ri.user_id = p_user_id\n`]],
    what: 'EVERY UNRESOLVED PAYMENT FROZEN: a hold is written whether or not one of the candidates is on the removed institution',
    expect: `a22: ${HOLD_CONTRACT}A, B, C-amount, C-date, C-new, C-posted, D, E, F, G, M, N, P, R, S, T (` },
  { name: 'hold_records_the_wrong_date', subs: [[HOLD_DATE, `             yt.date as removed_date\n`]],
    what: "WRONG DATE KEPT: the hold records the KEPT candidate's date instead of the removed one's — a kept card that was strictly closer all along is then withheld like a tie",
    expect: `a22: ${HOLD_CONTRACT}P (` },
  { name: 'hold_kind_swapped', subs: [[HOLD_KIND, `      select case when not o.credit then 'ambiguity_hold_removed_cash_account' else 'ambiguity_hold_removed_card' end as kind,\n`]],
    what: 'WRONG LEG: the hold says the removed candidate competed for the other leg of the pair',
    expect: `a22: ${HOLD_CONTRACT}${ALL_HELD}, T (` },
  { name: 'hold_not_deduplicated', subs: [[HOLD_DEDUPE, '']],
    what: 'no check for an existing live hold with the same legs and date: a second removal with the same ambiguity writes it again',
    expect: [`a22: ${HOLD_CONTRACT}G (`, `a25: ${B_CONTRACT}H (`] },

  // ---- the removal: holds derived from the complete pool (the audit's P1) and for automatic matches (Option B) ----
  { name: 'holds_from_published_states', subs: [[HOLDS_STMT, R4_HOLDS_STMT]],
    what: 'THE REVISION 4 STATEMENT PUT BACK: holds only for a leg that is PUBLISHED unresolved with no decision, from its displayed candidates. A leg on an excluded account, one the no-included-card rule decides, and every leg that was matched automatically to the removed institution get nothing',
    expect: [`a23: ${P1_CONTRACT}B, C, F, G, H, I, INV, N, N2 (`, `a25: ${B_CONTRACT}${ALL_SWITCHED}, O3 (`] },
  { name: 'excluded_owner_omitted', subs: [[HOLD_OWNER_ITEM, `      where oi.user_id = p_user_id and oi.id <> p_item_id and not oa.exclude_from_cash_flow\n`]],
    what: 'EXCLUDED ACCOUNT OMITTED FROM THE AMBIGUITY CAPTURE: a leg on an account that is excluded from cash flow is never the owner of a hold (the audit\'s counterexample: the excluded card leg that two payments fitted)',
    expect: [`a23: ${P1_CONTRACT}B, C, F, G, H, I, INV, N (`, `a25: ${B_CONTRACT}K-ce (`] },
  { name: 'excluded_candidate_ignored', subs: [[HOLD_KEPT_ITEM, `        and yi.user_id = p_user_id and yi.id <> p_item_id and not ya.exclude_from_cash_flow\n`]],
    what: 'EXCLUDED-ACCOUNT CANDIDATE IGNORED: a surviving candidate on an excluded account does not count as one; the payment is then matched to it when the other candidate is deleted',
    expect: [`a23: ${P1_CONTRACT}A, D, E, F, INV, N2 (`, `a25: ${B_CONTRACT}K-e (`] },
  { name: 'excluded_removed_candidate_ignored', subs: [[HOLD_REMOVED_ITEM, `        and ri.user_id = p_user_id and ri.id = p_item_id and not ra.exclude_from_cash_flow\n`]],
    what: 'EXCLUDED-ACCOUNT CANDIDATE IGNORED, on the removed side: a candidate on an excluded account of the removed institution does not count as one',
    expect: [`a23: ${P1_CONTRACT}D, F, INV, N2 (`, `a25: ${B_CONTRACT}K-xe (`] },
  { name: 'automatic_destination_protection_omitted', subs: [[HOLD_OWNER, `        and t1.partner is null\n`]],
    what: 'AUTOMATIC DESTINATION PROTECTION OMITTED: holds only for a leg that had no automatic match. A payment that was matched automatically to the removed card gets its record and nothing else, and a card that was already there takes it',
    expect: [`a25: ${B_CONTRACT}${ALL_SWITCHED} (`, 'a21: E-undo: the undone confirmation is not resurrected (no user decision is left on the payment); it was an automatic match to the removed card'] },
  { name: 'hold_only_for_the_removed_partner', subs: [[HOLD_OWNER, `        and (t1.partner is null or t1.partner = rc.id)\n`]],
    what: 'ONE HOLD ONLY, dated by the removed partner: an automatically matched payment gets no hold for the removed institution\'s other candidates. When the payment is later re-dated, the partner\'s date no longer withholds, although another removed leg would still have been closer than the competitor',
    expect: `a25: ${B_CONTRACT}G-two (` },
  { name: 'holds_for_legs_whose_automatic_match_stays', subs: [[HOLD_OWNER, `        and true\n`]],
    what: 'HOLDS WHERE THERE IS NOTHING TO HOLD: a leg whose automatic match is with a leg that STAYS gets holds too, merely because a leg of the removed institution also fitted it',
    expect: [`a25: ${B_CONTRACT}P (`, `a23: ${P1_CONTRACT}F (`] },
  { name: 'hold_candidate_window_widened', subs: [[HOLD_KEPT_EDGE, HOLD_KEPT_EDGE.replace('<= 5', '<= 60')]],
    what: 'NOT THE TIER 1 EDGE: a kept leg up to sixty days away counts as a competitor that was already there, although it was never a candidate for an automatic match',
    expect: `a25: ${B_CONTRACT}Q (` },
  { name: 'hold_removed_candidate_window_widened', subs: [[HOLD_RC_EDGE, HOLD_RC_EDGE.replace('<= 5', '<= 60')]],
    what: 'NOT THE TIER 1 EDGE, on the removed side: a leg of the removed institution up to sixty days away counts as a removed candidate, although it was never a candidate for an automatic match; a tie between two kept cards is then held with its date',
    expect: `a22: ${HOLD_CONTRACT}S (` },
  { name: 'hold_for_a_dismissed_removed_candidate', subs: [[HOLD_RC_NOT_DISMISSED, '']],
    what: 'A DISMISSED REMOVED CANDIDATE COUNTS: a leg of the removed institution that the user had dismissed for this payment still counts as a removed candidate, so a tie between two kept cards gets holds dated by the dismissed leg',
    expect: `a22: ${HOLD_CONTRACT}R (` },
  { name: 'hold_for_a_dismissed_kept_candidate', subs: [[HOLD_Y_NOT_DISMISSED, '']],
    what: 'A DISMISSED KEPT CANDIDATE COUNTS: a kept leg that the user had dismissed for this payment still gets a hold as "a competitor that was already there" (this pins the behaviour AS IMPLEMENTED: whether such a leg should be protected against is open question 2 of the slice document)',
    expect: `a22: ${HOLD_CONTRACT}T (` },
  { name: 'no_included_card_owner_omitted', subs: [[HOLD_OWNER_ITEM, `      where oi.user_id = p_user_id and oi.id <> p_item_id and (o.credit or exists (select 1 from pg_temp.cpe_accounts ca where ca.credit and ca.included))\n`]],
    what: 'A PAYMENT THE NO-INCLUDED-CARD RULE DECIDES IS LEFT OUT: a cash-side owner of a user with no included card gets no hold, although a removed and a kept leg both fitted it (it is published untracked, but it had no automatic match in the pool)',
    expect: `a23: ${P1_CONTRACT}N2 (` },
  { name: 'hold_no_user_filter', subs: [[HOLD_OWNER_ITEM, `      where oi.id <> p_item_id\n`], [HOLD_REMOVED_ITEM, `        and ri.id = p_item_id\n`], [HOLD_KEPT_ITEM, `        and yi.id <> p_item_id\n`]],
    what: 'the hold statement does not re-check the owner of its three accounts (the pool it reads is this user\'s only: the evaluator filled it for this user in this transaction, and the insert trigger re-checks both accounts)',
    expect: 'SURVIVES (defense in depth: redundant with the per-user pool and card_payment_decisions_same_user)' },

  // ---- the evaluator: the system ambiguity hold ----
  { name: 'eval_hold_does_not_withhold', target: 'evaluator', subs: [[VETO, '']],
    what: 'EVALUATOR: THE HOLD FAILS TO BLOCK THE SURVIVING COMPETITOR — it is recorded and read, but the automatic pair of its two legs is formed anyway',
    expect: [`a22: ${HOLD_CONTRACT}A, B, C-amount, C-date, C-new, C-posted, D, E, F, G, M (`, `a23: ${P1_CONTRACT}A, B, C, D, E, G, I, INV, N, N2 (`, `a25: ${B_CONTRACT}A, C, ${ALL_SWITCHED.slice(3)}, O3 (`] },
  { name: 'eval_hold_moot_beside_a_record', target: 'evaluator', subs: [[VETO_DATE,
      `    and abs(h.day - o.day) <= abs(o.day - x.day)\n    and not exists (select 1 from pg_temp.cpe_removed r where r.row_id = h.owner_id);\n`]],
    what: 'EVALUATOR: THE EXISTING COMPETITOR IS ALLOWED TO TAKE THE PAYMENT — a hold does not withhold where the payment has a known removed destination: the record is there, tier 1 outranks it, and the card that was already there gets the payment',
    expect: [`a25: ${B_CONTRACT}${ALL_SWITCHED.replace('L, ', '')}, O3 (`, 'a21: E-undo: the undone confirmation is not resurrected (no user decision is left on the payment); it was an automatic match to the removed card'] },
  { name: 'eval_hold_released_by_posting', target: 'evaluator', subs: [[HOLD_AMOUNTS,
      `        if v_ra.plaid <> d.a_plaid_transaction_id or v_rb.plaid <> d.b_plaid_transaction_id then\n          v_inactive := 'partner_gone';\n        elsif v_ra.cents <> d.a_cents or v_rb.cents <> d.b_cents then\n          v_inactive := 'amount_changed';\n        elsif not v_ra.is_leg or not v_rb.is_leg then\n`]],
    what: 'EVALUATOR: THE PROTECTION DISAPPEARS ON UNCHANGED POSTING — a hold applies only to the very rows it was recorded on, so a leg of its pair posting with the same amount (the payment, or the kept card\'s leg) releases it',
    expect: [`a22: ${HOLD_CONTRACT}C-posted (`, `a23: ${P1_CONTRACT}I (`, `a25: ${B_CONTRACT}G, G-card, G-two (`] },
  { name: 'eval_hold_publishes_an_effect', target: 'evaluator', subs: [[REMOVED_STEP,
      `    elsif not l.credit and (exists (select 1 from pg_temp.cpe_removed r where r.row_id = l.id)\n` +
      `                             or exists (select 1 from pg_temp.cpe_hold h where l.id in (h.owner_id, h.other_id))) then\n`]],
    what: 'EVALUATOR: THE HOLD PUBLISHES A FINANCIAL EFFECT — a held payment is read like a known removed-card destination (untracked, −amount), also where it was only ever a tie',
    expect: [`a22: ${HOLD_CONTRACT}${ALL_HELD} (`, `a23: ${P1_CONTRACT}A, B, C, D, E, G, I, INV, N, N2 (`, `a25: ${B_CONTRACT}C, L (`] },
  { name: 'eval_hold_user_strength', target: 'evaluator', subs: [[POOL,
      `  where t.is_leg and not t.conflict and not exists (select 1 from pg_temp.cpe_claim c where c.leg_id = t.id)\n` +
      `    and not exists (select 1 from pg_temp.cpe_hold h where t.id in (h.owner_id, h.other_id));\n`]],
    what: 'EVALUATOR: THE HOLD HAS USER-STRENGTH PRECEDENCE — its legs are taken out of automatic matching altogether, like legs a user decision holds: the system protection of an automatic match would reserve the payment against new evidence and a relinked card',
    expect: [`a22: ${HOLD_CONTRACT}${ALL_HELD} (`, `a23: ${P1_CONTRACT}A, B, C, D, E, G, I, N, N2 (`, `a25: ${B_CONTRACT}A, C, E, F-date, G-date, H, K-ce, L, O, O2 (`] },
  { name: 'eval_hold_ignores_date_changes', target: 'evaluator', subs: [[VETO_DATE, `    and true;\n`]],
    what: "EVALUATOR: THE HOLD NEVER EXPIRES ON A DATE CHANGE — the pair is withheld whatever the dates are now, even when the partner is strictly closer than the removed candidate was",
    expect: [`a22: ${HOLD_CONTRACT}C-date, M, P (`, `a25: ${B_CONTRACT}F-date, G-date (`] },
  { name: 'eval_hold_ignores_amount_changes', target: 'evaluator', subs: [[HOLD_AMOUNTS, `        if not v_ra.is_leg or not v_rb.is_leg then\n`]],
    what: 'EVALUATOR: THE HOLD NEVER EXPIRES ON AN AMOUNT CHANGE — it still applies after the bank corrected the legs it was recorded for',
    expect: [`a22: ${HOLD_CONTRACT}C-amount (`, `a25: ${B_CONTRACT}F-amt (`] },
  { name: 'eval_hold_blocks_any_pair_of_its_legs', target: 'evaluator', subs: [[VETO_EDGE, `  where t1.id in (h.owner_id, h.other_id)\n`]],
    what: 'EVALUATOR: THE HOLD BLOCKS BEYOND ITS SCOPE — it withholds any automatic pair of a held leg, also one with a new transaction or a relinked leg: the protection of an automatic match would never give way to genuinely new evidence',
    expect: [`a22: ${HOLD_CONTRACT}C-new (`, `a25: ${B_CONTRACT}E, H, O, O2 (`] },
  { name: 'eval_hold_overrides_user_decision', target: 'evaluator', subs: [[USER_RESULTS,
      `  update pg_temp.cpe_udec u set inactive = 'conflicting_decisions'\n` +
      `  where exists (select 1 from pg_temp.cpe_hold h where u.row_a in (h.owner_id, h.other_id) or u.row_b in (h.owner_id, h.other_id));\n` + USER_RESULTS]],
    what: "EVALUATOR: THE HOLD BLOCKS A LATER EXPLICIT USER DECISION — a user's confirmation or \"unlinked\" on a held leg is read as conflicting with the hold",
    expect: [`a22: ${HOLD_CONTRACT}D (`, `a23: ${P1_CONTRACT}G (`, `a25: ${B_CONTRACT}J (`] },
];

function apply(m) {
  let s = m.target === 'evaluator' ? EVALUATOR : REMOVAL;
  for (const [from, to, n = 1] of m.subs) {
    const found = s.split(from).length - 1;
    if (found !== n) throw new Error(`${m.name}: expected ${n} match(es) of ${JSON.stringify(from.slice(0, 70))}, found ${found}`);
    s = s.split(from).join(to);
  }
  if (m.definer) {
    // The mutation itself needs privileges the real function never has; it is not a change under test.
    if (!s.includes('security invoker')) throw new Error(`${m.name}: security clause not found`);
    s = s.replace('security invoker', 'security definer');
  }
  return s;
}
const out = process.argv[2];
if (!out) throw new Error('usage: node mutants.cjs <out-dir>');
fs.mkdirSync(out, { recursive: true });
const manifest = [];
for (const m of mutants) {
  fs.writeFileSync(path.join(out, `${m.name}.sql`), `-- MUTANT ${m.name} (deliberately wrong; disposable test databases only): ${m.what}\n${apply(m)}\n`);
  manifest.push([m.name, [].concat(m.expect).join(' && '), m.what].join('\t'));
}
fs.writeFileSync(path.join(out, 'manifest.tsv'), manifest.join('\n') + '\n');
console.log(`wrote ${mutants.length} mutants to ${out}`);
