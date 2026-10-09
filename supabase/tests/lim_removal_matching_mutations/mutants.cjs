// Mutants (negative controls) for institution removal and the decision kinds it writes:
//   20261008120000_card_payment_removal_provenance.sql        remove_plaid_item_local (the body that is INSTALLED:
//                                                             the removal that records the provenance of what it preserves)
//   20261006110000_card_payment_pair_counterpart_removed.sql  evaluate_card_payments (the decision kinds)
//
//   node mutants.cjs <out-dir>     writes <name>.sql per mutant, plus manifest.tsv (per mutant: its name, what
//                                  is expected, what it is, and the checksum of the function it replaces and
//                                  of the body it installs)
//
// Each mutant re-creates ONE function from the real migration text with exact substitutions. Every
// substitution must match exactly the stated number of times, or generation fails. run.sh applies each mutant
// as the LAST migration of a disposable database and records which tests detect it.
//
// WHICH BODY IS MUTATED, AND HOW THAT IS KEPT TRUE. A mutant is a bare CREATE OR REPLACE, applied last: built
// from any text but the installed one it would silently put ANOTHER body in place of the function under test,
// and every control would then be "detected" for the wrong reason. So the text is bound twice:
//   * here, at generation: the md5 of each text that is mutated (the body as pg_proc.prosrc holds it) must be
//     the checksum that 20261008120000's postcondition requires of the installed function — for the removal
//     ("is not the definition this migration installs") and for the evaluator ("evaluate_card_payments
//     changed"). Both literals are READ from that file; none is written here. Generation refuses otherwise;
//   * in the database, at application: every mutant file first compares the installed function's md5 with
//     that same value and raises otherwise. run.sh reports such a mutant as ERROR (it did not apply), never as
//     a detection.
// A migration that later replaces either function therefore stops this harness until it is bound to that file.
// A mutant replaces one function and nothing else: no table, trigger, grant or row (the provenance tables and
// their guards are the real ones in every run). The guards are trigger functions and are NOT mutated here: what
// each of their predicates refuses is a27's part, shown there by direct inserts. Here a guard appears only as
// what a mutant of the removal runs into (a source on an account that is not being removed, a generation that
// another transaction wrote, a row that is not on the account it names, an amount that is not the row's).
// A test may itself pin the installed function by that checksum (a27 does). Under a mutant such a pin fails for
// that reason alone and ends the test there: it would "detect" every mutant and show nothing of what the test
// finds. The manifest therefore carries both checksums, and run.sh re-binds the pin to the mutant in its
// disposable copy of the tests (never in the repository).
//
// `expect` names the test and the beginning of the failure that must appear, or SURVIVES when the safeguard is
// deliberately redundant with another one. `expect` may be a LIST: then every one of those failures must
// appear (a control for a rule that several contract tests pin is only "detected" when each of them says so).
// An entry "a26| case | need | requirement…" requires that test to print exactly that requirement as violated.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n/g, '\n');
const definition = (src, head) => {
  const start = src.indexOf(head);
  if (start < 0 || src.indexOf(head, start + 1) >= 0) throw new Error(`definition not unique: ${head}`);
  return src.slice(start, src.indexOf('\n$$;', start) + 4);
};
const INSTALLED_BY = '20261008120000_card_payment_removal_provenance.sql';
const EVALUATOR_FILE = '20261006110000_card_payment_pair_counterpart_removed.sql';
const REVISION5_FILE = '20261006120000_lim_removal_card_payment_matching.sql';
const INSTALLED = read(INSTALLED_BY);
const REMOVAL = definition(INSTALLED, 'create or replace function public.remove_plaid_item_local(');
const EVALUATOR = definition(read(EVALUATOR_FILE), 'create or replace function public.evaluate_card_payments(');
// Revision 5's removal is NOT mutated. Two controls put back a predicate it merged by; they take it from here.
const REVISION5 = definition(read(REVISION5_FILE), 'create or replace function public.remove_plaid_item_local(');

/** md5 of a definition's body as pg_proc.prosrc holds it: the text between the dollar quotes, LF line endings. */
function checksum(def) {
  const open = def.indexOf('as $$');
  if (open < 0 || !def.endsWith('\n$$;')) throw new Error('not a definition of the form "… as $$ … $$;"');
  return crypto.createHash('md5').update(def.slice(open + 5, def.length - 3), 'utf8').digest('hex');
}
/** The checksum the installing migration's postcondition requires where it raises `message` (exactly one check). */
function required(message) {
  const found = [...INSTALLED.matchAll(new RegExp(`<> '([0-9a-f]{32})' then\\n\\s*raise exception '${message}';`, 'g'))];
  if (found.length !== 1) throw new Error(`${INSTALLED_BY}: expected one postcondition check "${message}", found ${found.length}`);
  return found[0][1];
}
const TARGETS = {
  removal: { text: REMOVAL, file: INSTALLED_BY, signature: 'public.remove_plaid_item_local(uuid, uuid)',
             postcondition: 'remove_plaid_item_local is not the definition this migration installs' },
  evaluator: { text: EVALUATOR, file: EVALUATOR_FILE, signature: 'public.evaluate_card_payments(uuid, timestamp with time zone)',
               postcondition: 'evaluate_card_payments changed' },
};
for (const t of Object.values(TARGETS)) {
  t.md5 = checksum(t.text);
  const installed = required(t.postcondition);
  if (t.md5 !== installed) {
    throw new Error(`${t.signature}: the text in ${t.file} has checksum ${t.md5}, but ${INSTALLED_BY} requires ${installed} of the installed function; refusing to mutate a body that is not the installed one`);
  }
}

/** The text of `src` from `from` up to and including `to` (`from` must be unique). */
function block(src, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0 || src.indexOf(from, a + 1) >= 0) throw new Error(`block not unique: ${from.slice(0, 50)}`);
  return src.slice(a, b + to.length);
}
/** `text`, each line two columns deeper (a statement moved into a nested block). */
const deeper = (text) => text.replace(/^(?=.)/gm, '  ');
// ---- remove_plaid_item_local -------------------------------------------------------------------------
const ACCOUNT_LOCKS = `  perform 1 from public.accounts a where a.item_id = p_item_id order by a.id for update;\n`;
const FIRST_EVAL = block(REMOVAL, '  begin\n    v_evaluated := public.evaluate_card_payments(p_user_id);',
  "before the removal (SQLSTATE %); nothing was removed', sqlstate\n      using errcode = sqlstate;\n  end;\n");
// The whole preservation, in its one fail-closed block: the markers and the generation, the plan and its three
// statements, the decisions and their provenance, the count check.
const PRESERVE = block(REMOVAL, '  begin\n    -- Provenance (20261008120000). First, every EARLIER removal',
  "could not be preserved (SQLSTATE %); nothing was removed', sqlstate\n      using errcode = sqlstate;\n  end;\n");
const PRESERVE_HANDLER = block(REMOVAL, "  exception when others then\n    raise exception 'remove_plaid_item_local: known card-payment destinations could not be preserved",
  '      using errcode = sqlstate;\n  end;\n');
// (a), as it fills the plan.
const USER_PAIRS = block(REMOVAL, '    insert into pg_temp.rpp_plan\n      (decision_id, step, kind, a_account, a_plaid, a_cents, b_plaid, b_cents,', '    order by d.id;\n');
const USER_PAIRS_ROW = `    select gen_random_uuid(), 'a', 'pair_counterpart_removed', o.sv_account, o.sv_plaid, o.sv_cents, o.rm_plaid, o.rm_cents,\n`;
const USER_PAIRS_SOURCE = `           'confirmed_counterpart', o.rm_account, public.card_payment_lineage_row(o.rm_account, o.rm_plaid), o.rm_plaid, d.id\n`;
const USER_PAIRS_ORDER = `    order by d.id;\n`;
// (b), as it fills the plan.
const AUTO_PAIRS_ROW = `    select gen_random_uuid(), 'b', 'destination_removed_card', t.account_id, t.plaid_transaction_id, s.amount_cents,\n`;
const AUTO_PAIRS_SOURCE = `           'automatic_partner', pt.account_id, pt.id, pt.plaid_transaction_id, t.id\n`;
const AUTO_PAIRS_PARTNER = `    join public.transactions pt on pt.id = s.partner_transaction_id\n`;
const AUTO_PAIRS_PARTNER_ITEM = `    join public.plaid_items pi on pi.id = pa.item_id\n`;
const AUTO_PAIRS_NOT_HELD = `      and s.partner_transaction_id is not null\n      and s.decision_id is null\n`;
const AUTO_PAIRS_END = `      and pi.user_id = p_user_id and pi.id = p_item_id\n    order by t.id;\n`;
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
// (c) The ambiguity holds (Trevor's decision of 2026-10-06 on §4.7), as they fill the plan.
const HOLDS_STMT = block(REMOVAL, '    insert into pg_temp.rpp_plan\n      (decision_id, step, kind, a_account, a_plaid, a_cents, b_account, b_plaid, b_cents, counterpart_date,',
  '    ) h;\n');
const HOLDS_ROW = `    select gen_random_uuid(), 'c', h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date,\n`;
const HOLDS_END = `    ) h;\n`;
const HOLD_KIND = `      select case when not o.credit then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,\n`;
const HOLD_RELATION = `             case when t1.partner = rc.id then 'automatic_partner' else 'removed_candidate' end as source_relation,\n`;
const HOLD_SOURCE = `             rc.account_id as source_account, rc.id as source_txn, rt.plaid as source_plaid,\n`;
// Whose candidates are held: a leg with no automatic match, or one whose automatic match is on the removed item.
const HOLD_OWNER = `        and (t1.partner is null or pa.item_id = p_item_id)\n`;
const HOLD_OWNER_ITEM = `      where oi.user_id = p_user_id and oi.id <> p_item_id\n`;
const HOLD_KEPT_ITEM = `        and yi.user_id = p_user_id and yi.id <> p_item_id\n`;
const HOLD_KEPT_EDGE = `      join pg_temp.cpe_pool y on y.id <> o.id and y.credit <> o.credit and y.cents = -o.cents and abs(o.day - y.day) <= 5\n`;
// The same tier 1 edge, restated for the REMOVED candidate, and the "not dismissed" half of it on either side.
const HOLD_RC_EDGE = `      join pg_temp.cpe_pool rc on rc.id <> o.id and rc.credit <> o.credit and rc.cents = -o.cents and abs(o.day - rc.day) <= 5\n`;
const HOLD_RC_NOT_DISMISSED = `        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id))\n`;
const HOLD_Y_NOT_DISMISSED = `        and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, y.id) and dd.hi = greatest(o.id, y.id))\n`;
// Statement (c) as it was in revision 4 — read from the PUBLISHED states (unresolved, no decision, displayed
// candidates) — writing to the plan as the installed statement does: one row per removed candidate, with it as
// the source (an unresolved leg has no automatic match, so no source is one).
const R4_HOLDS_STMT = `    insert into pg_temp.rpp_plan
      (decision_id, step, kind, a_account, a_plaid, a_cents, b_account, b_plaid, b_cents, counterpart_date,
       source_relation, source_account, source_txn, source_plaid, ord)
    select gen_random_uuid(), 'c', h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date,
           h.source_relation, h.source_account, h.source_txn, h.source_plaid, h.source_txn
    from (
      select case when s.side = 'cash' then 'ambiguity_hold_removed_card' else 'ambiguity_hold_removed_cash_account' end as kind,
             case when s.side = 'cash' then yt.account_id else xt.account_id end as a_account,
             case when s.side = 'cash' then yt.plaid_transaction_id else xt.plaid_transaction_id end as a_plaid,
             case when s.side = 'cash' then (yt.amount * 100)::bigint else s.amount_cents end as a_cents,
             case when s.side = 'cash' then xt.account_id else yt.account_id end as b_account,
             case when s.side = 'cash' then xt.plaid_transaction_id else yt.plaid_transaction_id end as b_plaid,
             case when s.side = 'cash' then s.amount_cents else (yt.amount * 100)::bigint end as b_cents,
             'removed_candidate' as source_relation,
             rt.account_id as source_account, rt.id as source_txn, rt.plaid_transaction_id as source_plaid,
             rt.date as removed_date
      from public.card_payment_leg_states s
      join public.transactions xt on xt.id = s.transaction_id
      join public.accounts xa on xa.id = xt.account_id
      join public.plaid_items xi on xi.id = xa.item_id
      cross join lateral jsonb_array_elements(s.candidates) rc
      join public.transactions rt on rt.id = (rc->>'transactionId')::uuid
      join public.accounts ra on ra.id = rt.account_id
      join public.plaid_items ri on ri.id = ra.item_id
      cross join lateral jsonb_array_elements(s.candidates) sc
      join public.transactions yt on yt.id = (sc->>'transactionId')::uuid
      join public.accounts ya on ya.id = yt.account_id
      join public.plaid_items yi on yi.id = ya.item_id
      where s.user_id = p_user_id
        and s.computed_at_version = v_evaluated
        and s.state = 'unresolved'
        and s.decision_id is null
        and rc->>'kind' = 'tier1_competitor'
        and sc->>'kind' = 'tier1_competitor'
        and xi.user_id = p_user_id and xi.id <> p_item_id
        and ri.user_id = p_user_id and ri.id = p_item_id
        and yi.user_id = p_user_id and yi.id <> p_item_id
    ) h;
`;
const HOLD_REMOVED_ITEM = `        and ri.user_id = p_user_id and ri.id = p_item_id\n`;
const HOLD_DATE = `             rt.date as removed_date\n`;
// ---- remove_plaid_item_local: the provenance (20261008120000) ----------------------------------------
// Revision 5 merged: (b) skipped a leg that had a live record, (c) said DISTINCT and skipped a pair and date
// that had a live hold. The installed body does neither; these are revision 5's own predicates, to put back.
const R5_RECORD_DEDUPE = block(REVISION5, '      and not exists (select 1 from public.card_payment_decisions d', '                        and d.a_cents = s.amount_cents)\n');
const R5_HOLD_DEDUPE = block(REVISION5, '    where not exists (select 1 from public.card_payment_decisions d\n                      where d.user_id = p_user_id and d.kind = h.kind',
  '                        and d.counterpart_date = h.removed_date)\n');
// What revision 5's DISTINCT ranged over: the hold's kind, its two legs and the removed date.
const HOLD_KEY = 'h.kind, h.a_account, h.a_plaid, h.a_cents, h.b_account, h.b_plaid, h.b_cents, h.removed_date';
const REPLAY = block(REMOVAL, "  if v_removal.status = 'cleaned' then\n", "'deleted_counts', v_removal.deleted_counts);\n  end if;\n");
const NOT_CONFIRMED = `  if v_removal.status <> 'plaid_removed' then\n`;
const ITEM_MISSING = block(REMOVAL, "  if not found then\n    raise exception 'remove_plaid_item_local: item % is missing", 'p_item_id;\n  end if;\n');
const MARKERS = block(REMOVAL, '    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)\n', '    order by pr.cleaned_at, pr.id;\n');
const GENERATION = `    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)\n    values (v_removal.id, p_user_id, true, v_institution_id);\n`;
const GENERATION_ROW = `    values (v_removal.id, p_user_id, true, v_institution_id);\n`;
const PLAN_EMPTIED = `    truncate pg_temp.rpp_plan;\n`;
// The one statement that writes the provenance, and the same with the count check that follows it.
const PROVENANCE = block(REMOVAL, '    insert into public.card_payment_removal_sources\n', '     and co.consumed_at is null and co.expires_at > now();\n');
const PROVENANCE_ROW = `    select p.decision_id, p_user_id, v_removal.id, p.source_relation,\n`;
const PROVENANCE_END = `     and co.consumed_at is null and co.expires_at > now();\n`;
const PROVENANCE_PENDING = `           case when st.id is not null then coalesce(st.pending, false) end,\n`;
const PROVENANCE_CENTS = `           case when st.id is not null then (st.amount * 100)::bigint when named.n = 0 then (co.pending_amount * 100)::bigint end,\n`;
const COUNT_CHECK = block(REMOVAL, '    select count(*) into v_planned from pg_temp.rpp_plan;\n', '        v_planned, v_written, v_recorded;\n    end if;\n');
const PROVENANCE_AND_CHECK = block(REMOVAL, '    insert into public.card_payment_removal_sources\n', '        v_planned, v_written, v_recorded;\n    end if;\n');
// A statement the removal does not have: every older live record of the user that has no provenance row is
// given one, which names this removal and one of this removal's own sources.
const BACKFILL = `    insert into public.card_payment_removal_sources
      (decision_id, user_id, removal_id, source_relation, source_resolution, source_plaid_account_id,
       source_plaid_transaction_id, source_pending, source_date, source_cents)
    select d.id, p_user_id, v_removal.id, 'automatic_partner', 'row', x.source_plaid_account_id,
           x.source_plaid_transaction_id, x.source_pending, x.source_date, x.source_cents
    from public.card_payment_decisions d
    cross join lateral (select s.* from public.card_payment_removal_sources s
                        where s.removal_id = v_removal.id and s.source_resolution = 'row'
                        order by s.decision_id limit 1) x
    where d.user_id = p_user_id and d.kind = 'destination_removed_card' and d.superseded_by is null
      and not exists (select 1 from public.card_payment_removal_sources s where s.decision_id = d.id);
`;
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
// The refusal of the preservation block: nothing is removed, and only the SQLSTATE of what failed is named.
const refused = (sqlstate) => `remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE ${sqlstate}); nothing was removed`;
// The contract test of the provenance, a26. Its verdict names the cases with a violated requirement and says how
// many requirements are violated; before it, every requirement is printed as ok or VIOLATED. A control expects
// the cases, the number, and EXACTLY these requirements ("case | need | how the requirement begins").
const PROVENANCE_CONTRACT = 'institution removal records the source of everything it preserves; violated in: ';
const provenance = (cases, ...requirements) =>
  [`a26: ${PROVENANCE_CONTRACT}${cases} (${requirements.length} of `, ...requirements.map((r) => `a26| ${r}`)];
const REQ = {
  refusedFixed: 'L | provenance | a removal that cannot write its provenance is refused with the fixed message',
  refusedWhole: 'L | provenance | and it removed nothing and wrote nothing',
  retried: 'L | provenance | retried, the removal runs once and records its one generation',
  retriedReads: 'L | unchanged | the payment then counts as a removed-card payment',
  generation: 'GEN | provenance | the removal has one generation row',
  tieFirst: 'A | provenance | after the first removal: a hold on each surviving candidate',
  identicalRows: 'B | rows | two IDENTICAL removed payments',
  identicalNamed: 'B | provenance | and each hold names its own removed transaction',
  identicalAlike: 'B | provenance | the two sources are described alike in everything but their own id',
  several: 'D | provenance | the record and the four holds of one payment',
  severalShare: 'D | provenance | one source justifies three rows',
  record: 'E | provenance | the record names the removed partner',
  tie: 'F | provenance | the hold names the removed candidate; there is no record',
  mirror: 'G | provenance | the hold of the removed-CASH kind names the removed cash leg',
  excluded: 'H | provenance | a source on an EXCLUDED removed card',
  excludedRecord: 'H2 | provenance | a payment that was matched to an excluded removed card',
  lineage: 'I1 | provenance | a source that had replaced a pending transaction keeps that pending id',
  pendingSurvivor: 'I3 | provenance | a pending surviving payment: its record and its hold',
  nullPending: 'P | provenance | a source row whose pending flag was NULL is recorded as not pending',
  relinkFirst: 'R | provenance | after the first removal: one record',
  relinkDormant: 'R | unchanged | after the relink the payment matches the re-imported leg again',
  outlives: 'O | provenance | the removed accounts and transactions are gone',
  replay: 'C | provenance | a repeated call for a finished removal',
  otherUser: "K | provenance | the other user's removal records its own sources",
  posted: 'I3 | provenance | and the provenance is untouched',
  twoRemovalsRows: 'A | rows | TWO REMOVALS, one surviving pair, one date',
  twoRemovalsNamed: 'A | provenance | each hold names the leg of its OWN removal',
  twoRemovalsAlike: 'A | provenance | the two sources have the same account type, subtype and mask',
  relinkRows: 'R | rows | a second removal after a relink writes its OWN record',
  relinkNamed: 'R | provenance | each record names the leg of its own removal',
  relinkNames: 'R | rows | the decision the payment NAMES is one of its two records',
  everyDecision: 'INV | provenance | every decision a removal wrote has exactly one provenance row',
  generations: 'INV | provenance | five removals, five generations',
  onePerDependency: 'INV | provenance | no two rows of one removal share kind, legs and source',
  neverAfterwards: 'K | provenance | provenance is written by the removal, while it runs, and never afterwards',
  marker: 'U | provenance | the unrecorded removal gets a MARKER',
  otherUsersMarker: "U | provenance | a removal marks only its OWN user's unrecorded removals",
  otherUsersOwn: "U | provenance | the other user's own next removal marks it",
  pendingSource: 'I2 | provenance | a source that was still PENDING at the removal says so',
  pairActive: 'J1 | provenance | an ACTIVE confirmation: the preserved user decision names the removed card leg',
  pairRepriced: 'J2 | provenance | an INACTIVE confirmation (the removed leg was re-priced)',
  pairCardSurvives: 'J4 | provenance | a confirmation whose CARD side survives',
  pairWaiting: 'JW | provenance | a confirmation whose removed leg was WAITING TO POST',
  pairAmbiguous: 'JA | provenance | a confirmation whose reference had become AMBIGUOUS',
  rowsOutlive: 'O | provenance | the removed accounts and transactions are gone',
  unrecorded: 'U | provenance | this removal records its own source',
  unrecordedReads: 'U | unchanged | both payments read as removed-card payments',
};
// Each of these must be the beginning of exactly one requirement of a26 as it stands, and the verdict's text must
// be a26's, or generation fails: a reworded requirement is noticed here, not as a control that "is not detected".
const A26 = fs.readFileSync(path.join(ROOT, 'supabase/tests/access_control/sql/a26_lim_removal_provenance.sql'), 'utf8').replace(/\r\n/g, '\n');
const A26_REQUIREMENTS = [...A26.matchAll(/pg_temp\.req\('([^']+)', '([^']+)', '((?:[^']|'')*)'/g)]
  .map((m) => `${m[1]} | ${m[2]} | ${m[3].replace(/''/g, "'")}`);
for (const r of Object.values(REQ)) {
  const n = A26_REQUIREMENTS.filter((x) => x.startsWith(r)).length;
  if (n !== 1) throw new Error(`a26: ${n} requirements begin with "${r}"; exactly one is expected`);
}
if (A26.split(`'${PROVENANCE_CONTRACT}'`).length !== 2) throw new Error('a26: its verdict does not begin as PROVENANCE_CONTRACT says');

const mutants = [
  // ---- the baseline ----
  { name: 'unmutated', subs: [],
    what: 'THE BASELINE: the installed function re-created from the very text every removal control mutates, unchanged. Every test must pass. A failure in this row is the suite\'s or this harness\'s, not a control\'s, and no other row means anything until it is ok',
    expect: 'SURVIVES (nothing is changed)' },

  // ---- the removal: evaluation, preservation of automatic pairs, freshness (as in the first review) ----
  { name: 'no_preservation', subs: [[PRESERVE, '  null;\n']],
    what: 'DELETION WITHOUT PRESERVATION: the whole preservation block is removed; the removal only evaluates and deletes',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'preservation_after_delete', subs: [[PRESERVE, ''], [DELETE, DELETE + '\n' + PRESERVE]],
    what: 'PRESERVATION AFTER THE DELETE: the same block, moved after the item is deleted (the rows and the pair decisions are gone: the plan is empty)',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'no_first_evaluation', subs: [[FIRST_EVAL, STORED_VERSION], [HOLDS_STMT, '']],
    what: 'no in-transaction evaluation before the preservation: the user pairs and the automatic pairs are read from the STORED states at their stored version (the hold statement, which needs the evaluation\'s own pool, is taken out so that this is what the control shows)',
    expect: 'a19: records: k-a, and k-late (a pair no stored state knew)' },
  { name: 'no_first_evaluation_fails_closed', subs: [[FIRST_EVAL, STORED_VERSION]],
    what: 'no in-transaction evaluation, the hold statement left in: it finds no pool of this transaction (the evaluator\'s scratch tables do not exist), and the removal fails closed instead of preserving from stale states',
    expect: `a18: ${refused('42P01')}` },
  { name: 'first_evaluation_best_effort', subs: [[FIRST_EVAL, `  perform public.try_evaluate_card_payments(p_user_id);\n${STORED_VERSION}`]],
    what: 'PRE-EVALUATION BEST-EFFORT: the first evaluation in a subtransaction whose failure is swallowed (try_evaluate). The removal no longer says that matching could not be evaluated; with the hold statement in, it then fails closed on the missing pool rather than run on stale states',
    expect: `a19: expected an error like remove_plaid_item_local: card-payment matching could not be evaluated before the removal (SQLSTATE 25001); nothing was removed but got: ${refused('42P01')}` },
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
  { name: 'converts_unresolved', subs: [[AUTO_PAIRS_PARTNER, '    join public.transactions pt on pt.amount = -t.amount\n'],
                                        ['      and s.partner_transaction_id is not null\n', '']],
    what: 'REMOVAL TREATED AS EVIDENCE: any surviving cash leg with an opposite-amount leg on the removed item gets a system record, paired or not',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'converts_kept_pairs', subs: [['      and pi.user_id = p_user_id and pi.id = p_item_id\n', '      and pi.user_id = p_user_id\n']],
    what: 'no restriction to the removed item: automatic pairs with a card that stays are planned as records too. Their source is then a leg of an account that is NOT being removed, which the provenance guard refuses: nothing is removed (under revision 5, which kept no source, the extra records were written)',
    expect: `a18: ${refused('42501')}` },
  { name: 'wrong_lineage_key', subs: [[AUTO_PAIRS_ROW, AUTO_PAIRS_ROW.replace('t.plaid_transaction_id', 'pt.plaid_transaction_id')]],
    what: "the system record is keyed by the removed card leg's Plaid id instead of the surviving cash leg's own",
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'raw_errors', subs: [[PRESERVE, PRESERVE.replace('  begin\n', '').replace(/  exception when others then[\s\S]*$/, '')]],
    what: 'the preservation error is not replaced by the fixed message: whatever the failing statement says reaches the caller',
    expect: ['a19: expected an error like remove_plaid_item_local: known card-payment destinations could not be preserved', ...provenance('L', REQ.refusedFixed)] },
  { name: 'version_row_before_advisory_lock', subs: [[L1, `  perform 1 from public.card_payment_eval_versions v where v.user_id = p_user_id for update;\n${L1}`]],
    what: 'LOCK ORDER: the version row (L2) is locked before the per-user advisory lock (L1)',
    expect: 'c33: while waiting on L1, the removal held no lock on the version row' },
  { name: 'no_user_filter', subs: [['      and ci.user_id = p_user_id and ci.id <> p_item_id\n', '      and ci.id <> p_item_id\n'],
                                   ['      and pi.user_id = p_user_id and pi.id = p_item_id\n', '      and pi.id = p_item_id\n']],
    what: 'the automatic-pair statement does not re-check the owner of either account (the evaluator already wrote only this user\'s states, and the insert trigger re-checks the account)',
    expect: 'SURVIVES (defense in depth: redundant with the per-user states and card_payment_decisions_same_user)' },
  { name: 'no_survivor_filter', subs: [['      and ci.user_id = p_user_id and ci.id <> p_item_id\n', '      and ci.user_id = p_user_id\n']],
    what: 'cash legs on the removed item itself get a system record too (deleted with their account by the cascade, and its provenance row with it)',
    expect: 'SURVIVES (redundant with the account cascade: a record on a removed account goes with it)' },

  // ---- the removal: user-confirmed pairs (Trevor's decision 2 and the mirror case) ----
  { name: 'user_pairs_not_preserved', subs: [[USER_PAIRS, '']],
    what: 'USER-STRENGTH PRESERVATION DROPPED: no pair_counterpart_removed decision is planned; a user-confirmed pair is simply deleted with the account',
    expect: `a18: ${USER_RECORDS}` },
  { name: 'user_pairs_downgraded_to_system_record', subs: [[USER_PAIRS, ''], [AUTO_PAIRS_NOT_HELD, `      and s.partner_transaction_id is not null\n`]],
    what: 'DOWNGRADE TO THE SYSTEM RECORD: an active user-confirmed pair gets the ordinary non-reserving destination_removed_card instead — a record written although a user decision holds the leg (the behaviour of the candidate before this decision)',
    expect: `a18: ${AUTO_RECORDS}` },
  { name: 'user_pair_planned_as_system_record', subs: [[USER_PAIRS_ROW, USER_PAIRS_ROW.replace("'pair_counterpart_removed'", "'destination_removed_card'")]],
    what: 'A USER PAIR PLANNED WITH THE SYSTEM KIND: statement (a) plans its rows as destination_removed_card. The decisions table refuses a record that carries a second leg, so a removal that has a confirmed pair to preserve removes nothing',
    expect: `a26: ${refused('23514')}` },
  { name: 'user_pair_recorded_as_automatic_partner', subs: [[USER_PAIRS_SOURCE, USER_PAIRS_SOURCE.replace("'confirmed_counterpart'", "'automatic_partner'")]],
    what: 'A USER DECISION RECORDED AS A SYSTEM DEPENDENCY: the provenance of a preserved confirmation says its source was an automatic partner. The provenance guard ties the relation to the decision kind and refuses it: nothing is removed',
    expect: `a26: ${refused('42501')}` },
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
    what: 'AMBIGUITY HOLD OMITTED: the removal plans no hold; a tie between a removed card and a kept one resolves to the kept card when the other is deleted (the behaviour before this decision)',
    expect: `a22: ${HOLD_CONTRACT}${ALL_HELD}, T (` },
  { name: 'hold_without_a_removed_candidate', subs: [[HOLD_REMOVED_ITEM, `        and ri.user_id = p_user_id\n`]],
    what: 'EVERY UNRESOLVED PAYMENT FROZEN: a hold is planned whether or not one of the candidates is on the removed institution. Its source is then a leg of an account that is NOT being removed, which the provenance guard refuses: nothing is removed (under revision 5, which kept only a date, a tie between two kept cards was held)',
    expect: `a22: ${refused('42501')}` },
  { name: 'hold_records_the_wrong_date', subs: [[HOLD_DATE, `             yt.date as removed_date\n`]],
    what: "WRONG DATE KEPT: the hold records the KEPT candidate's date instead of the removed one's. Where the two differ the hold no longer agrees with its source, which the provenance guard refuses: nothing is removed (under revision 5 a kept card that was strictly closer all along was then withheld like a tie)",
    expect: `a22: ${refused('42501')}` },
  { name: 'hold_kind_swapped', subs: [[HOLD_KIND, `      select case when not o.credit then 'ambiguity_hold_removed_cash_account' else 'ambiguity_hold_removed_card' end as kind,\n`]],
    what: 'WRONG LEG: the hold says the removed candidate competed for the other leg of the pair',
    expect: `a22: ${HOLD_CONTRACT}${ALL_HELD}, T (` },

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

  // ---- the removal: one system row per source (20261008120000). Revision 5 had the opposite controls: it
  // merged, and "no_dedupe" and "hold_not_deduplicated" took a merge away. The installed body does not merge,
  // and these put each merge back; the last one multiplies a row instead ----
  { name: 'record_dedupe_restored', subs: [[AUTO_PAIRS_END, AUTO_PAIRS_END.replace('    order by t.id;\n', R5_RECORD_DEDUPE + '    order by t.id;\n')]],
    what: 'DEDUPE WITHOUT SOURCE IDENTITY, records: statement (b) again skips a leg that has a live record with the same key, whichever removal wrote it (revision 5\'s predicate). After a relink and a second removal the payment has ONE record, and nothing says it also depends on the second removed leg',
    expect: [...provenance('R', REQ.relinkRows, REQ.relinkNamed, REQ.relinkNames),
             'a18: second removal: a leg whose key is unchanged gets a second record', `a25: ${B_CONTRACT}H, O2 (`] },
  { name: 'hold_dedupe_restored', subs: [[HOLDS_END, '    ) h\n' + R5_HOLD_DEDUPE.replace(/\n$/, ';\n')]],
    what: 'DEDUPE WITHOUT SOURCE IDENTITY, holds across removals: statement (c) again skips a pair and date that has a live hold, whichever removal wrote it (revision 5\'s predicate). A second removal with a candidate of the same date writes nothing: the one hold then also stands for a source it does not name',
    expect: [...provenance('A', REQ.twoRemovalsRows, REQ.twoRemovalsNamed, REQ.twoRemovalsAlike),
             `a22: ${HOLD_CONTRACT}G (`, `a25: ${B_CONTRACT}H (`, 'c37: TWO live holds on the pair (yq, q), both dated 09-04'] },
  { name: 'hold_distinct_restored', subs: [[HOLDS_ROW, HOLDS_ROW.replace('    select ', `    select distinct on (${HOLD_KEY})\n           `)],
                                           [HOLDS_END, `    ) h\n    order by ${HOLD_KEY}, h.source_plaid collate "C";\n`]],
    what: 'TWO IDENTICAL TRANSACTIONS COLLAPSED: statement (c) is again DISTINCT over the hold\'s kind, legs and date, as in revision 5 (of several removed candidates with one date, the one with the least Plaid id is kept as the source). Two removed payments on one card on one day become one hold, which names one of them',
    expect: provenance('B, O', REQ.identicalRows, REQ.identicalNamed, REQ.identicalAlike, REQ.outlives) },
  { name: 'record_written_twice', subs: [[AUTO_PAIRS_PARTNER_ITEM, AUTO_PAIRS_PARTNER_ITEM + '    cross join generate_series(1, 2) twice\n']],
    what: 'A DEPENDENCY WRITTEN TWICE: the select of statement (b) is multiplied by a two-row join, so every record is planned twice — two records for one surviving leg and one removed partner, each with its provenance row. Nothing a reader is shown changes and every row passes the provenance guard: the rows are multiplied, where the contract adds one per removal',
    expect: provenance('D, E, H2, I1, I3, INV, K, L, O, R, U', REQ.retried, REQ.several, REQ.severalShare, REQ.record, REQ.excludedRecord, REQ.lineage, REQ.pendingSurvivor,
      REQ.relinkFirst, REQ.outlives, REQ.otherUser, REQ.posted, REQ.relinkDormant, REQ.relinkRows, REQ.relinkNamed, REQ.relinkNames, REQ.onePerDependency, REQ.unrecorded) },

  // ---- the removal: the generation (the scope of a removal's provenance) ----
  { name: 'generation_not_written', subs: [[GENERATION, '']],
    what: 'MISSING REMOVAL-GENERATION SCOPE: the removal writes no generation row. Its first provenance row then has no recorded, running generation to belong to; the guard refuses it, and a removal that preserves anything removes nothing',
    expect: [`a18: ${refused('42501')}`, `a26: ${refused('42501')}`] },
  { name: 'generation_failure_swallowed', subs: [[GENERATION, `    begin\n${deeper(GENERATION)}    exception when others then\n      null;\n    end;\n`]],
    what: 'A FAILED GENERATION WRITE SWALLOWED: the generation insert is in a nested block whose handler ignores the failure. The removal then has no generation that this transaction wrote: where it preserves anything, the provenance guard refuses its first provenance row and nothing is removed — but the refusal no longer names the write that failed (a19, B2-generation: the injected failure; a26, case L: the key of the row that is in the way)',
    expect: [`a19: expected an error like ${refused('TH192')} but got: ${refused('42501')}`, ...provenance('L', REQ.refusedFixed)] },
  { name: 'existing_generation_reused', subs: [[GENERATION_ROW, GENERATION_ROW.replace(';\n', '\n    on conflict (removal_id) do nothing;\n')]],
    what: 'AN EXISTING GENERATION REUSED: the generation insert does nothing where the removal already has a generation row, instead of failing on its key. The removal that finds one (a26, case L) goes on under a row another transaction wrote; the provenance guard refuses its first provenance row, because that generation is not this transaction\'s, and nothing is removed — with the guard\'s SQLSTATE, not the key\'s',
    expect: provenance('L', REQ.refusedFixed) },
  { name: 'marker_not_written', subs: [[MARKERS, '']],
    what: 'MARKER OMITTED: an earlier removal of this user that finished without provenance gets no marker; nothing then says which rows it may have merged into',
    expect: [...provenance('U', REQ.marker, REQ.otherUsersOwn), 'a27: R1: the removal of Bank A first marks the unrecorded removal, then records its own generation'] },
  { name: 'marker_after_own_generation', subs: [[MARKERS, ''], [GENERATION, GENERATION + '\n' + MARKERS]],
    what: 'MARKER IN THE WRONG PLACE: the markers are written AFTER this removal\'s own generation, so the unrecorded removal is ordered after rows it preceded and casts doubt on nothing it may have merged into',
    expect: [...provenance('U', REQ.marker, REQ.otherUsersOwn), 'a27: R1: the removal of Bank A first marks the unrecorded removal, then records its own generation'] },

  { name: 'marker_for_every_user', subs: [[MARKERS, MARKERS.replace("    where pr.user_id = p_user_id and pr.status = 'cleaned'\n", "    where pr.status = 'cleaned'\n")]],
    what: 'MARKERS FOR OTHER USERS: the removal marks every unrecorded removal in the database, not only this user\'s. Another user\'s marker then gets its place in THAT user\'s order while only this user\'s advisory lock is held: the order it is there to record is no longer assigned under the lock that serialises that user\'s removals',
    expect: provenance('U', REQ.otherUsersMarker) },

  // ---- the removal: the source of each row ----
  { name: 'source_joined_across_users', subs: [[AUTO_PAIRS_PARTNER, AUTO_PAIRS_PARTNER + '    join public.transactions sx on sx.amount = pt.amount and sx.date = pt.date\n'],
                                               [AUTO_PAIRS_SOURCE, AUTO_PAIRS_SOURCE.replace('pt.account_id, pt.id, pt.plaid_transaction_id', 'sx.account_id, sx.id, sx.plaid_transaction_id')]],
    what: 'CROSS-USER SOURCE ASSOCIATION: a record\'s source is whichever transaction has the removed partner\'s amount and date, through a join that filters neither the user nor the item. Another user\'s leg with that amount and date becomes a source; its account is not one of the item being removed, the provenance guard refuses it, and nothing is removed (a26, case K: the other user\'s removal, while the first user still has two such legs)',
    expect: `a26: ${refused('42501')}` },
  { name: 'hold_source_is_the_kept_candidate', subs: [[HOLD_SOURCE, `             y.account_id as source_account, y.id as source_txn, yt.plaid as source_plaid,\n`]],
    what: 'PROVENANCE OF THE WRONG LEG, holds: the source of a hold is taken from the kept candidate y instead of the removed candidate rc. Its account is not being removed; the provenance guard refuses it, and a removal that holds anything removes nothing',
    expect: `a26: ${refused('42501')}` },
  { name: 'record_source_is_the_surviving_leg', subs: [[AUTO_PAIRS_SOURCE, AUTO_PAIRS_SOURCE.replace('pt.account_id, pt.id, pt.plaid_transaction_id', 't.account_id, t.id, t.plaid_transaction_id')]],
    what: 'PROVENANCE OF THE WRONG LEG, records: the source of a record is taken from the surviving cash leg instead of its removed partner. Its account is not being removed; the provenance guard refuses it, and a removal that records anything removes nothing',
    expect: [`a18: ${refused('42501')}`, `a26: ${refused('42501')}`] },
  { name: 'record_source_on_another_removed_account', subs: [[AUTO_PAIRS_SOURCE, AUTO_PAIRS_SOURCE.replace('pt.account_id,', '(select a.id from public.accounts a where a.item_id = p_item_id order by a.id limit 1),')]],
    what: 'THE SOURCE\'S ACCOUNT IS NOT ITS OWN: a record names its removed partner, but on the first account of the removed institution, whichever account the partner was on. Where the institution has several accounts, the provenance guard finds no such transaction on the account the row names and refuses it: nothing is removed',
    expect: [`a18: ${refused('42501')}`, `a26: ${refused('42501')}`] },
  { name: 'source_amount_of_the_surviving_leg', subs: [[PROVENANCE_CENTS, PROVENANCE_CENTS.replace('(st.amount * 100)::bigint', 'p.a_cents')]],
    what: 'THE SOURCE\'S AMOUNT IS NOT ITS OWN: a provenance row records the cents of its decision\'s first leg — the surviving leg of a record or of a preserved pair — instead of the removed row\'s. The two have opposite signs: the provenance guard finds no transaction with that amount where the row says there was one and refuses it, and a removal that records a destination or preserves a pair removes nothing',
    expect: [`a18: ${refused('42501')}`, `a26: ${refused('42501')}`] },
  { name: 'older_record_given_a_source', subs: [[COUNT_CHECK, COUNT_CHECK + BACKFILL]],
    what: 'PROVENANCE BACKFILLED: after its own rows, the removal gives a provenance row to every older live record of the user that has none, naming itself and one of its own sources. The provenance guard accepts each of them — written in the transaction that wrote the generation, about a transaction that is on an account of the item being removed — so only a test can say that a removal writes its plan and nothing else (a26, case U: the record of the unrecorded removal stays without a source)',
    expect: [...provenance('U', REQ.unrecorded), 'a27: R1: one decision of each kind a removal writes, each with its source; the marked removal has none'] },
  { name: 'hold_relation_constant', subs: [[HOLD_RELATION, `             'removed_candidate' as source_relation,\n`]],
    what: 'SOURCE RELATION CONSTANT: every hold says its source was a competing candidate, also where it was the leg\'s automatic match. For a surviving CARD leg that is the only place the match is kept',
    expect: provenance('D, G, I3, K', REQ.several, REQ.mirror, REQ.pendingSurvivor, REQ.otherUser, REQ.posted) },
  { name: 'provenance_swapped_between_records', subs: [[PROVENANCE_ROW, PROVENANCE_ROW.replace('p.decision_id,',
      "case when p.step = 'b' then coalesce(lead(p.decision_id) over w, first_value(p.decision_id) over w) else p.decision_id end,")],
                                                       [PROVENANCE_END, PROVENANCE_END.replace(';\n', '\n    window w as (partition by p.step order by p.a_plaid collate "C", p.source_plaid collate "C");\n')]],
    what: 'PROVENANCE ON THE WRONG SURVIVING DECISION: the provenance rows of the records are written under each other\'s decision ids (each record gets the source of the record before it, in the order of the surviving legs\' Plaid ids). Every decision still has exactly one row and every row passes the guard: only the identity of the source is wrong',
    expect: provenance('D, E, H2, I1, I3, R', REQ.several, REQ.record, REQ.excludedRecord, REQ.lineage, REQ.pendingSurvivor, REQ.relinkFirst, REQ.posted, REQ.relinkNamed) },
  { name: 'null_pending_not_coalesced', subs: [[PROVENANCE_PENDING, PROVENANCE_PENDING.replace('coalesce(st.pending, false)', 'st.pending')]],
    what: 'THE NULL-PENDING TRAP: the source\'s pending flag is recorded as it is stored, not as the evaluator reads it. A removed row whose flag is NULL — which the schema allows — then breaks the provenance table\'s own check, and a removal that Plaid has already confirmed is refused for good (a26, case P)',
    expect: `a26: ${refused('23514')}` },
  { name: 'pending_source_recorded_as_posted', subs: [[PROVENANCE_PENDING, PROVENANCE_PENDING.replace('coalesce(st.pending, false)', 'false')]],
    what: 'WHAT WAS OBSERVED, the pending flag: every source row is recorded as not pending, whatever it was. A source that was still pending at the removal (a26, case I2) is then recorded as posted',
    expect: provenance('I2', REQ.pendingSource) },
  { name: 'pair_source_row_not_looked_up', subs: [[USER_PAIRS_SOURCE, USER_PAIRS_SOURCE.replace('public.card_payment_lineage_row(o.rm_account, o.rm_plaid)', 'null::uuid')]],
    what: 'WHAT WAS OBSERVED, a confirmed pair\'s row: the removed leg of a preserved pair is never resolved to its current row. Where the reference still names rows the source is then recorded as ambiguous, with no transaction id, date or amount, although one row was there (a26: an active pair, a re-priced one, a pair whose card side survives; and the count of rows that have a transaction id)',
    expect: provenance('J1, J2, J4, O', REQ.pairActive, REQ.pairRepriced, REQ.pairCardSurvives, REQ.rowsOutlive) },
  { name: 'ambiguous_reference_recorded_as_gone', subs: [[PROVENANCE, PROVENANCE.replace("                when named.n > 0 then 'ambiguous'\n", '')]],
    what: 'WHAT WAS OBSERVED, an ambiguous reference: a confirmed pair whose reference several rows named is recorded as if nothing had been there (gone), although rows were (a26, case JA)',
    expect: provenance('JA', REQ.pairAmbiguous) },
  { name: 'carry_over_not_read', subs: [[PROVENANCE_END, "     and false;\n"]],
    what: 'WHAT WAS OBSERVED, a waiting pending row: the carry-over of a removed pending row is never read. A confirmed pair whose card leg was waiting to post is recorded as gone, and the carry-over\'s date and amount — which the removal deletes with the account — are lost (a26, case JW)',
    expect: provenance('JW', REQ.pairWaiting) },

  // ---- the removal: no decision without its provenance, and nothing removed without it ----
  { name: 'provenance_not_written', subs: [[PROVENANCE, '']],
    what: 'MISSING SOURCE EVIDENCE: the provenance statement is removed. The count check that follows then reads the row count of the statement before it — the holds: a removal that preserves a pair or a record removes nothing (a18, a26), but one that writes holds only is not noticed by the check. The two removals of c37 commit, and c37 finds their holds without a source',
    expect: [`a18: ${refused('P0001')}`, `a26: ${refused('P0001')}`, 'c37: the hold the first removal wrote names (removal of item 1, account X1, x1q)'] },
  { name: 'provenance_best_effort', subs: [[PROVENANCE, `    begin\n${deeper(PROVENANCE)}    exception when others then\n      null;\n    end;\n`]],
    what: 'PROVENANCE BEST-EFFORT: the provenance statement is in a nested block whose handler ignores its failure. Nothing differs while the statement succeeds. When it fails (a19, B2-source), the count check that follows reads the row count of the statement before it — the holds — and refuses a removal that planned anything else: nothing is removed, but the refusal names the check, not the failure',
    expect: `a19: expected an error like ${refused('TH191')} but got: ${refused('P0001')}` },
  { name: 'hold_provenance_not_written', subs: [[PROVENANCE_END, PROVENANCE_END.replace(';\n', "\n    where p.step <> 'c';\n")]],
    what: 'PARTIAL PROVENANCE: the provenance statement leaves out the holds. The count check finds fewer provenance rows than planned decisions, and a removal that holds anything removes nothing',
    expect: `a26: ${refused('P0001')}` },
  { name: 'hold_provenance_not_written_unchecked', subs: [[PROVENANCE_END, PROVENANCE_END.replace(';\n', "\n    where p.step <> 'c';\n")], [COUNT_CHECK, '']],
    what: 'PARTIAL PROVENANCE, UNCHECKED: the provenance statement leaves out the holds and the count check is removed. Every removal commits, and every hold it writes is unattributed; a provenance row that is silently not written (a19, B2-count) is no longer noticed either',
    expect: [`a19: expected an error like ${refused('P0001')} but the statement succeeded`,
             ...provenance('A, B, C, D, F, G, H, I3, INV, K, O, P', REQ.tieFirst, REQ.identicalNamed, REQ.identicalAlike, REQ.several, REQ.severalShare, REQ.tie,
               REQ.mirror, REQ.excluded, REQ.pendingSurvivor, REQ.nullPending, REQ.outlives, REQ.replay, REQ.otherUser, REQ.posted, REQ.twoRemovalsNamed,
               REQ.twoRemovalsAlike, REQ.everyDecision, REQ.neverAfterwards)] },
  { name: 'provenance_after_delete', subs: [[PROVENANCE_AND_CHECK, ''], [DELETE, DELETE + '\n' + PROVENANCE_AND_CHECK]],
    what: 'SOURCE CAPTURED AFTER THE DELETE: the provenance statement and its count check are moved after the item is deleted. The removed accounts and transactions are gone, no provenance row can be read from them, and the check — now outside the preservation block, so with its own message — refuses',
    expect: 'a26: remove_plaid_item_local: 25 decisions were planned, 25 written, 0 given a provenance row' },
  { name: 'preservation_failure_swallowed', subs: [[PRESERVE_HANDLER, '  exception when others then\n    null;\n  end;\n']],
    what: 'A FAILED PRESERVATION SWALLOWED: the handler of the preservation block ignores the failure instead of refusing. The block\'s own writes are rolled back and the removal goes on: it deletes the institution and commits with nothing preserved and no provenance',
    expect: [`a19: expected an error like ${refused('P0001')} but the statement succeeded`,
             ...provenance('GEN, INV, L, U', REQ.refusedFixed, REQ.refusedWhole, REQ.retried, REQ.retriedReads, REQ.generation, REQ.generations, REQ.unrecorded, REQ.unrecordedReads)] },

  // ---- the removal: a second execution ----
  { name: 'replay_removed', subs: [[REPLAY, '']],
    what: 'NO REPLAY OF A FINISHED REMOVAL: the early return for a cleaned removal is removed. A repeated call no longer returns the stored result; the next check refuses it (the removal is not plaid_removed), before anything is written',
    expect: ['a19: remove_plaid_item_local: Plaid removal is not confirmed for item', ...provenance('C', REQ.replay)] },
  { name: 'second_execution_reaches_the_generation', subs: [[REPLAY, ''], [NOT_CONFIRMED, `  if v_removal.status not in ('plaid_removed', 'cleaned') then\n`], [ITEM_MISSING, '']],
    what: 'A SECOND EXECUTION THAT GETS PAST EVERY EARLIER CHECK: no replay, a cleaned removal accepted, a missing item accepted. It reaches the generation insert, which is refused (the generations guard: a recorded generation is written only while its removal is running), so no second set of rows can be written',
    expect: [`a18: ${refused('42501')}`, ...provenance('C', REQ.replay)] },
  { name: 'plan_not_emptied', subs: [[PLAN_EMPTIED, '']],
    what: 'PLAN NOT EMPTIED: the scratch table of the plan is not truncated before it is filled. It is dropped at commit and a refused call\'s rows are rolled back with it, so only a second removal in the SAME transaction finds rows of the first: it plans the first removal\'s decisions again, and their primary key refuses them — nothing is written twice, and the second institution is not removed (a27, section 8)',
    expect: `a27: ${refused('23505')}` },

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
  const t = TARGETS[m.target || 'removal'];
  let s = t.text;
  for (const [from, to, n = 1] of m.subs) {
    const found = s.split(from).length - 1;
    if (found !== n) throw new Error(`${m.name}: expected ${n} match(es) of ${JSON.stringify(from.slice(0, 70))}, found ${found}`);
    s = s.split(from).join(to);
  }
  if ((s === t.text) !== (m.subs.length === 0)) throw new Error(`${m.name}: the substitutions leave the definition as it is`);
  m.replaces = t.md5;
  m.installs = checksum(s);
  if (m.definer) {
    // The mutation itself needs privileges the real function never has; it is not a change under test.
    if (!s.includes('security invoker')) throw new Error(`${m.name}: security clause not found`);
    s = s.replace('security invoker', 'security definer');
  }
  // In the database: BOTH functions are the installed definitions this manifest was derived from — the one this
  // file replaces and the other, which the tests run it against — or nothing is replaced.
  const guard = 'do $$\nbegin\n' + Object.values(TARGETS).map((g) =>
    "  if (select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = '" + g.signature + "'::regprocedure) <> '" + g.md5 + "' then\n" +
    "    raise exception 'MUTANT " + m.name + ": the installed function is not the definition this mutant was derived from (" + g.file + ")';\n  end if;\n").join('') + 'end\n$$;\n';
  return `-- Derived from ${t.signature} as ${t.file} defines it (body md5 ${t.md5}); replaces that function and nothing else.\n${guard}${s}\n`;
}
const out = process.argv[2];
if (!out) throw new Error('usage: node mutants.cjs <out-dir>');
if (new Set(mutants.map((m) => m.name)).size !== mutants.length) throw new Error('two mutants have the same name');
fs.mkdirSync(out, { recursive: true });
const manifest = [];
for (const m of mutants) {
  const wrong = m.subs.length ? 'deliberately wrong' : 'the baseline, not a mutant';
  fs.writeFileSync(path.join(out, `${m.name}.sql`), `-- MUTANT ${m.name} (${wrong}; disposable test databases only): ${m.what}\n${apply(m)}`);
  manifest.push([m.name, [].concat(m.expect).join(' && '), m.what, m.replaces, m.installs].join('\t'));
}
fs.writeFileSync(path.join(out, 'manifest.tsv'), manifest.join('\n') + '\n');
for (const t of Object.values(TARGETS)) {
  console.log(`mutating ${t.signature} as ${t.file} defines it: body md5 ${t.md5}, the one ${INSTALLED_BY} requires of the installed function`);
}
console.log(`wrote ${mutants.length} mutants to ${out}`);
