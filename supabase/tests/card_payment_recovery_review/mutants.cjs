// Negative controls for the packet 2-A database code: each MUTANT removes or weakens ONE safety property of
// 20261009120000_card_payment_recovery_review.sql, and names the test and the assertion that must then fail.
//
//   node mutants.cjs <migration file> <output dir>
//
// writes, per mutant, <id>.apply.sql (the altered function definitions, or DDL) and <id>.restore.sql (the
// originals), and plan.tsv:  id <TAB> tests <TAB> expected <TAB> description
// `expected` is a regular expression that the failing test's transcript must match on an ERROR line: a mutant
// counts as DETECTED only when the NAMED assertion fails — a test that fails for another reason is reported
// apart. mutations.sh applies each mutant to a database that holds the unmutated history, runs the named
// tests, and restores.
//
// Every replacement must match its function's text exactly once; a mutant whose anchor is gone stops the run
// (the control would otherwise test nothing).
const fs = require('node:fs');
const path = require('node:path');

const [migrationPath, out] = process.argv.slice(2);
if (!migrationPath || !out) {
  console.error('usage: node mutants.cjs <migration file> <output dir>');
  process.exit(2);
}
const migration = fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');

function definition(name) {
  const m = new RegExp(`^create (?:or replace )?function public\\.${name}\\(`, 'm').exec(migration);
  if (!m) throw new Error(`function ${name} not found`);
  const end = migration.indexOf('\n$$;', m.index);
  if (end < 0) throw new Error(`function ${name}: end not found`);
  return migration.slice(m.index, end + 4) + '\n';
}
function statement(startsWith) {
  const i = migration.indexOf(startsWith);
  if (i < 0) throw new Error(`statement not found: ${startsWith}`);
  return migration.slice(i, migration.indexOf(';\n', i) + 2);
}
function replaceOnce(text, from, to, id) {
  const i = text.indexOf(from);
  if (i < 0) throw new Error(`${id}: anchor not found: ${from.slice(0, 70)}`);
  if (text.indexOf(from, i + 1) >= 0) throw new Error(`${id}: anchor found more than once: ${from.slice(0, 70)}`);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

const EV = 'evaluate_card_payments';
const CAPTURE = 'card_payment_review_capture';
const APPLY = 'apply_card_payment_recovery_action';
const RECEIPT = 'card_payment_recovery_receipt';
const READER = 'get_card_payment_states';
const REFRESH = 'refresh_card_payment_recovery_owner';
const REMOVAL = 'remove_plaid_item_local';

const GUARD_PREDICATE = `    where a.row_id in (t1.id, t1.partner)
      and not exists (`;
const GUARD_END = `          and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end));
  delete from pg_temp.cpe_tier1 t1 using pg_temp.cpe_guard g where g.id = t1.id;
`;
const RECEIPT_INSERT_START = `  insert into public.card_payment_recovery_actions
    (user_id, operation_id, action, payload, payload_hash, expected_input_version, expected_review_revision, outcome, reason,`;
const RECEIPT_INSERT_END = `          coalesce((select r.revision from public.card_payment_review_revisions r where r.user_id = p_user_id), 0));
`;

/** { id, description, tests, expected, fn + edits [[from, to]…]  |  apply + restore (SQL text) } */
const MUTANTS = [
  {
    id: 'm01_asymmetric_suppression',
    description: 'the guard withholds only the affected leg\'s side of the pair; the other leg stays matched',
    tests: 'r01', expected: 'E7: the unrelated card leg is unresolved, effect 0',
    fn: EV, edits: [[GUARD_PREDICATE, `    where a.row_id = t1.id\n      and not exists (`]],
  },
  {
    id: 'm02_record_overrides_guard',
    description: 'a withheld payment that has a removed-destination record reads the record, not the range',
    tests: 'r01', expected: 'E7: the payment is a range, with no partner and no decision named',
    fn: EV,
    edits: [[
      `    elsif exists (select 1 from pg_temp.cpe_guard g where g.id = l.id) then\n`,
      `    elsif exists (select 1 from pg_temp.cpe_guard g where g.id = l.id)\n          and not exists (select 1 from pg_temp.cpe_removed r where r.row_id = l.id) then\n`,
    ]],
  },
  {
    id: 'm03_fallback_reselection',
    description: 'after the guard withholds a pair, tier 1 is run again without it: a next-best match is selected',
    tests: 'r02', expected: 'NOFALL: the selected pair is withheld and the payment is the range|NOFALL: nothing is selected in the withheld pair',
    fn: EV,
    edits: [[GUARD_END, `          and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end));
  delete from pg_temp.cpe_tier1 t1 using pg_temp.cpe_guard g where g.id = t1.id;
  insert into pg_temp.cpe_tier1 (id, partner)
  with e as (
    select x.id as x_id, y.id as y_id, abs(x.day - y.day) as dist
    from pg_temp.cpe_pool x join pg_temp.cpe_pool y
      on y.id <> x.id and y.credit <> x.credit and y.cents = -x.cents and abs(x.day - y.day) <= 5
    where not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(x.id, y.id) and dd.hi = greatest(x.id, y.id))
      and not exists (select 1 from pg_temp.cpe_guard g where g.id = x.id and g.partner = y.id)
      and not exists (select 1 from pg_temp.cpe_tier1 t where t.id in (x.id, y.id))
      -- the holds are left alone: a pair a hold withholds on the dates as they are is not re-selected
      and not exists (select 1 from pg_temp.cpe_hold h
                      join pg_temp.cpe_txn ho on ho.id = h.owner_id join pg_temp.cpe_txn hx on hx.id = h.other_id
                      where ((h.owner_id = x.id and h.other_id = y.id) or (h.owner_id = y.id and h.other_id = x.id))
                        and abs(h.day - ho.day) <= abs(ho.day - hx.day))
  ), ranked as (
    select e.x_id, e.y_id, e.dist, min(e.dist) over (partition by e.x_id) as dmin, count(*) over (partition by e.x_id, e.dist) as n_at_dist from e
  ), best as (select r.x_id, r.y_id from ranked r where r.dist = r.dmin and r.n_at_dist = 1)
  select b1.x_id, b1.y_id from best b1 join best b2 on b2.x_id = b1.y_id and b2.y_id = b1.x_id;
`]],
  },
  {
    id: 'm04_similarity_is_consent',
    description: 'a transaction with the amount and date of a recorded removed source is admitted without review',
    tests: 'r01', expected: 'E7: the payment is a range, with no partner and no decision named',
    fn: EV,
    edits: [[GUARD_END, `          and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end))
    and not exists (select 1 from public.card_payment_review_obligation_sources src
                    join pg_temp.cpe_txn leg on leg.id in (t1.id, t1.partner)
                    where src.user_id = p_user_id and src.source_date = leg.date and src.source_cents = leg.cents);
  delete from pg_temp.cpe_tier1 t1 using pg_temp.cpe_guard g where g.id = t1.id;
`]],
  },
  {
    id: 'm05_one_endpoint',
    description: 'only an affected CASH leg is guarded: a new cash leg pairs with an affected card leg',
    tests: 'r02', expected: 'EITHER: a new cash leg does not become "tracked, 0" against an affected card leg',
    fn: EV,
    edits: [[GUARD_PREDICATE, `    where a.row_id in (t1.id, t1.partner)\n      and not (select x.credit from pg_temp.cpe_txn x where x.id = a.row_id)\n      and not exists (`]],
  },
  {
    id: 'm06_one_obligation',
    description: 'a pair stays when ANY obligation lists it, instead of every obligation',
    tests: 'r02', expected: 'LEGACY: unknown attribution withholds even the hold\'s own pair|EVERY: a pair one obligation lists and the other does not is withheld',
    fn: EV,
    edits: [[
      `  where exists (
    select 1 from pg_temp.cpe_review_anchor a
    where a.row_id in (t1.id, t1.partner)
      and not exists (
        select 1 from pg_temp.cpe_review_member m
        where m.obligation_id = a.obligation_id
          and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end));`,
      `  where exists (select 1 from pg_temp.cpe_review_anchor a where a.row_id in (t1.id, t1.partner))
    and not exists (
      select 1 from pg_temp.cpe_review_anchor a join pg_temp.cpe_review_member m on m.obligation_id = a.obligation_id
      where a.row_id in (t1.id, t1.partner) and m.row_id = case when a.row_id = t1.id then t1.partner else t1.id end);`,
    ]],
  },
  {
    id: 'm07_gap_ignored',
    description: 'coverage gaps are not obligations of the guard',
    tests: 'r02', expected: 'LEGACY: under review, with a coverage gap',
    fn: EV,
    edits: [[
      `  where o.user_id = p_user_id;\n  -- The surviving edges those obligations positively list`,
      `  where o.user_id = p_user_id and o.origin <> 'gap';\n  -- The surviving edges those obligations positively list`,
    ]],
  },
  {
    id: 'm08_sources_merged',
    description: 'the capture keeps one source per obligation (A and B merged); its own count check must refuse the removal',
    tests: 'r01', expected: 'known card-payment destinations could not be preserved',
    fn: CAPTURE,
    edits: [[`  select o.id, p_user_id,\n         case p.kind when 'destination_removed_card' then 'removed_destination'`, `  select distinct on (o.id) o.id, p_user_id,\n         case p.kind when 'destination_removed_card' then 'removed_destination'`]],
  },
  {
    id: 'm09_sources_cascade_with_decision',
    description: 'an obligation source references its decision with a cascading foreign key: it is lost when the decision\'s account goes',
    tests: 'r02', expected: 'removal 2, EVERY: a second obligation with its own source; the first is untouched',
    apply: `alter table public.card_payment_review_obligation_sources add constraint mutant_decision_fkey foreign key (decision_id) references public.card_payment_decisions(id) on delete cascade not valid;\n`,
    restore: `alter table public.card_payment_review_obligation_sources drop constraint if exists mutant_decision_fkey;\n`,
  },
  {
    id: 'm10_edges_from_winners_only',
    description: 'the capture lists only the automatic match of the affected payment, not every surviving edge of the pool',
    tests: 'r01', expected: 'the obligation, its sources and its surviving edge were captured',
    fn: CAPTURE,
    edits: [[
      `  join pg_temp.cpe_pool y on y.id <> ap.id and y.credit <> ap.credit and y.cents = -ap.cents and abs(ap.day - y.day) <= 5\n`,
      `  join pg_temp.cpe_pool y on y.id <> ap.id and y.credit <> ap.credit and y.cents = -ap.cents and abs(ap.day - y.day) <= 5\n  join pg_temp.cpe_tier1 won on won.id = ap.id and won.partner = y.id\n`,
    ]],
  },
  {
    id: 'm11_excluded_accounts_dropped',
    description: 'the capture skips surviving legs on accounts excluded from cash flow',
    tests: 'r01', expected: 'NOC: the edge to the EXCLUDED kept card is captured too',
    fn: CAPTURE,
    edits: [[`    and ya.item_id <> v_item\n`, `    and ya.item_id <> v_item and not ya.exclude_from_cash_flow\n`]],
  },
  {
    id: 'm12_capture_omitted',
    description: 'the removal does not capture review obligations at all',
    tests: 'r01', expected: 'the obligation, its sources and its surviving edge were captured',
    fn: REMOVAL,
    edits: [[`    perform public.card_payment_review_capture(p_user_id, v_removal.id);\n`, `    null;\n`]],
  },
  // ---- Capture from the eligible graph (correction C1; sql/r08_graph_capture.sql) ---------------------------------
  {
    id: 'm25_anchors_from_plan_only',
    description: 'anchor discovery returns to the plan: the capture reads no edge from the graph and checks itself against nothing but the plan (the v1 defect)',
    tests: 'r08', expected: 'TIE / GRAPH CAPTURE: K keeps its obligation and BOTH removed candidates as sources',
    fn: CAPTURE,
    edits: [
      ["    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n", "    and false\n    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n"],
      [`  if v_cut_again <> v_cut or v_uncovered <> 0 then\n`, `  if false then\n`],
    ],
  },
  {
    id: 'm26_cut_missed_but_recounted',
    description: 'the capture reads no edge from the graph, with its completeness check intact: the independent recount of the cut must refuse the removal',
    tests: 'r08', expected: 'known card-payment destinations could not be preserved',
    fn: CAPTURE,
    edits: [["    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n", "    and false\n    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n"]],
  },
  {
    id: 'm27_graph_sources_merged',
    description: 'one graph-observed source per obligation (A and B merged); every edge of the cut must be covered, so the removal is refused',
    tests: 'r08', expected: 'known card-payment destinations could not be preserved',
    fn: CAPTURE,
    edits: [[`  select o.id, p_user_id, 'graph_source', null, null, p_removal_id,`, `  select distinct on (o.id) o.id, p_user_id, 'graph_source', null, null, p_removal_id,`]],
  },
  {
    id: 'm28_cut_cash_anchors_only',
    description: 'only a surviving CASH leg is an anchor: a surviving card leg whose removed cash candidates leave no hold is not captured (the mirror)',
    tests: 'r08', expected: 'MIRROR / GRAPH CAPTURE: the surviving CARD leg keeps its obligation and both removed cash legs as sources',
    fn: CAPTURE,
    edits: [
      ["    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n", "    and not o.credit\n    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n"],
      ["  where not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  select count(*) into v_uncovered\n", "  where not o.credit\n    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  select count(*) into v_uncovered\n"],
    ],
  },
  {
    id: 'm29_graph_source_beside_its_decision',
    description: 'a removed candidate gets a graph-observed source although a decision of this removal already names it: one real source, two rows',
    tests: 'r08', expected: 'REPEAT, removal 1: X is ONE source',
    fn: CAPTURE,
    edits: [[`  where not exists (\n    select 1 from pg_temp.rpp_plan p\n    where p.source_txn = c.source_id\n`, `  where not exists (\n    select 1 from pg_temp.rpp_plan p\n    where false and p.source_txn = c.source_id\n`]],
  },
  {
    id: 'm30_match_that_stays_is_not_affected',
    description: 'a payment whose automatic match stays is not an anchor, although the removal cuts another of its eligible edges',
    tests: 'r08', expected: 'STAYS / GRAPH CAPTURE: the removed candidate is a source, and the surviving match is a known edge',
    fn: CAPTURE,
    edits: [
      ["    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n", "    and (t1.partner is null or t1.partner = rc.id)\n    and not exists (select 1 from pg_temp.cpe_dismissed dd where dd.lo = least(o.id, rc.id) and dd.hi = greatest(o.id, rc.id));\n  get diagnostics v_cut = row_count;\n"],
      [`  if v_cut_again <> v_cut or v_uncovered <> 0 then\n`, `  if v_uncovered <> 0 then\n`],
    ],
  },
  {
    id: 'm13_action_retires_record',
    description: 'an explicit pair also ends the hold and the record of the payment (a current-payment action retiring history)',
    tests: 'r01', expected: 'PAIR: the action commits with a fresh evaluation|PAIR: H and D remain, live',
    fn: APPLY,
    edits: [[
      `  v_outcome := v_inner->>'status';\n`,
      `  if v_kind = 'pair_current' then
    update public.card_payment_decisions d set superseded_by = d.id
    where d.user_id = p_user_id and d.superseded_by is null
      and d.kind in ('destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')
      and (public.card_payment_lineage_row(d.a_account_id, d.a_plaid_transaction_id) = any (v_targets)
           or public.card_payment_lineage_row(d.b_account_id, d.b_plaid_transaction_id) = any (v_targets));
  end if;
  v_outcome := v_inner->>'status';\n`,
    ]],
  },
  {
    id: 'm14_receipt_read_without_owner',
    description: 'a receipt is looked up by operation id alone',
    tests: 'r04', expected: 'bb asking for aa\'s operation id finds nothing',
    fn: RECEIPT,
    edits: [[`  where a.user_id = p_user_id and a.operation_id = p_operation_id\n`, `  where a.operation_id = p_operation_id\n`]],
  },
  {
    id: 'm15_operation_id_without_owner',
    description: 'the replay check looks the operation id up across users',
    tests: 'r04', expected: 'bb may use the same operation id for its own request',
    fn: APPLY,
    edits: [[
      `  from public.card_payment_recovery_actions a\n  where a.user_id = p_user_id and a.operation_id = p_operation_id;\n  if found then\n    if v_existing_hash <> v_hash then`,
      `  from public.card_payment_recovery_actions a\n  where a.operation_id = p_operation_id;\n  if found then\n    if v_existing_hash <> v_hash then`,
    ]],
  },
  {
    id: 'm16_review_revision_unchecked',
    description: 'the review revision the user saw is not compared',
    tests: 'r05', expected: 'each refusal has its own code',
    fn: APPLY,
    edits: [[`  if p_expected_review_revision is distinct from v_review then\n`, `  if false then\n`]],
  },
  {
    id: 'm17_version_unchecked_for_notes',
    description: 'the wrapper does not compare the input version itself (it relies on the decision RPC, which a note never calls)',
    tests: 'r05', expected: 'a note sent with an old input version is refused as stale',
    fn: APPLY,
    edits: [[
      `     or v_evaluated <> v_input or p_expected_input_version <> v_input or v_contract is distinct from 2 then\n`,
      `     or v_evaluated <> v_input or v_contract is distinct from 2 then\n`,
    ]],
  },
  {
    id: 'm18_receipt_failure_swallowed',
    description: 'a failure while writing the receipt is swallowed: the decision commits without its receipt (a split write)',
    tests: 'r05', expected: 'the injected failure at the receipt surfaces|receipt failure: the decision, the evaluation and the versions were rolled back',
    fn: APPLY,
    edits: [
      [RECEIPT_INSERT_START, `  begin\n${RECEIPT_INSERT_START}`],
      [RECEIPT_INSERT_END, `${RECEIPT_INSERT_END}  exception when others then\n    null;\n  end;\n`],
    ],
  },
  {
    id: 'm19_replay_executes_again',
    description: 'an operation id that was already committed is executed again instead of answered from its receipt',
    tests: 'r05', expected: 'unknown outcome: sending the same operation again returns the same receipt',
    fn: APPLY,
    edits: [[
      `    return jsonb_build_object('status', 'replayed',
                              'receipt', public.card_payment_recovery_receipt(p_user_id, p_operation_id),
                              'freshness', public.card_payment_recovery_freshness(p_user_id));
  end if;

  -- The review revision the user saw.`,
      `    null;
  end if;

  -- The review revision the user saw.`,
    ]],
  },
  {
    id: 'm20_no_semantic_invalidation',
    description: 'new obligations and known edges do not make the owner stale',
    tests: 'r07', expected: 'SEED: seeding advances the matching input version',
    apply: `drop trigger card_payment_review_obligations_changed on public.card_payment_review_obligations;\ndrop trigger card_payment_review_memberships_changed on public.card_payment_review_memberships;\n`,
    restore: () => statement('create trigger card_payment_review_obligations_changed') + statement('create trigger card_payment_review_memberships_changed'),
  },
  {
    id: 'm21_stamp_ignored',
    description: 'the reader returns states for a user whose result this evaluator did not publish (stale marked fresh)',
    tests: 'r07', expected: 'STAMP: with equal versions but no stamp of this evaluator, nothing is readable',
    fn: READER,
    edits: [[
      `    when v.user_id is null or v.evaluated_version is distinct from v.input_version or c.contract is distinct from 2 then\n`,
      `    when v.user_id is null or v.evaluated_version is distinct from v.input_version then\n`,
    ]],
  },
  {
    id: 'm22_ack_removes_newer_work',
    description: 'a refresh acknowledgement removes the queue row whatever version it was registered for',
    tests: 'r06', expected: 'the worker reports that later work remains',
    fn: REFRESH,
    edits: [[
      `    where q.user_id = p_user_id and q.lease_token = p_lease_token and q.target_version <= v_evaluated;\n`,
      `    where q.user_id = p_user_id and q.lease_token = p_lease_token;\n`,
    ]],
  },
  {
    id: 'm23_refresh_without_lease',
    description: 'a refresh runs and acknowledges whatever lease token it is given',
    tests: 'r06', expected: 'a wrong lease token does nothing',
    fn: REFRESH,
    edits: [
      [
        `  if not exists (select 1 from public.card_payment_recovery_refresh_queue q
                 where q.user_id = p_user_id and q.lease_token = p_lease_token and q.lease_expires_at > now()) then`,
        `  if false then`,
      ],
    ],
  },
  {
    id: 'm24_no_registration_on_invalidation',
    description: 'refresh work is registered by recovery actions only, not when an affected owner\'s inputs change (sync-only delivery)',
    tests: 'r06', expected: 'an input change of an owner under review registers refresh work in the writer\'s own transaction',
    apply: `drop trigger card_payment_recovery_enqueue on public.card_payment_eval_versions;\n`,
    restore: () => statement('create trigger card_payment_recovery_enqueue'),
  },
];

fs.mkdirSync(out, { recursive: true });
const plan = [];
for (const m of MUTANTS) {
  let apply;
  let restore;
  if (m.fn) {
    const original = definition(m.fn);
    let mutated = original;
    for (const [from, to] of m.edits) mutated = replaceOnce(mutated, from, to, m.id);
    if (mutated === original) throw new Error(`${m.id}: the mutant is identical to the original`);
    apply = mutated;
    restore = original;
  } else {
    apply = m.apply;
    restore = typeof m.restore === 'function' ? m.restore() : m.restore;
  }
  fs.writeFileSync(path.join(out, `${m.id}.apply.sql`), apply);
  fs.writeFileSync(path.join(out, `${m.id}.restore.sql`), restore);
  plan.push([m.id, m.tests, m.expected, m.description].join('\t'));
}
fs.writeFileSync(path.join(out, 'plan.tsv'), plan.join('\n') + '\n');
console.log(`${MUTANTS.length} database mutants written to ${out}`);
