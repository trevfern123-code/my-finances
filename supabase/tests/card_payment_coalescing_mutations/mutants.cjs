// Mutants for the bump-coalescing safeguards (20261002120000) and the revised a09 account-insert contract.
//
//   node mutants.cjs <out-dir>     writes <name>.sql per mutant, plus manifest.tsv
//
// Each mutant re-creates one function (or, for a combined mutant, several) from the real migration text,
// with exact substitutions. Every substitution must match exactly the stated number of times, or
// generation fails. run.sh applies each mutant as the last migration of a disposable database and records
// which tests detect it. `expect` names the test file and the assertion that should fail, or SURVIVES when
// the safeguard is deliberately redundant with another one.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n/g, '\n');
const MIG = read('20261002120000_card_payment_bump_coalescing.sql');
const BASE = read('20260930120000_card_payment_matching_state.sql');

function definition(text, head) {
  const start = text.indexOf(head);
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw new Error(`definition not unique: ${head}`);
  return text.slice(start, text.indexOf('\n$$;', start) + 4);
}
const BUMP = definition(MIG, 'create or replace function public.card_payment_bump(');
const EVAL = definition(MIG, 'create or replace function public.evaluate_card_payments(');
const ACCOUNTS = definition(BASE, 'create function public.card_payment_bump_accounts(').replace('create function', 'create or replace function');

const SKIP_TEST = `  if current_setting(v_marker, true) = v_xact then`;
const SKIP_BLOCK = `${SKIP_TEST}
    select v.input_version, v.evaluated_version into v_input, v_evaluated
    from public.card_payment_eval_versions v where v.user_id = p_user_id;
    if found and v_evaluated is distinct from v_input then
      return;
    end if;
  end if;`;
const MARK = `perform set_config(v_marker, v_xact, true);`;
const RESET = `  perform set_config('card_payment.bumped_' || replace(p_user_id::text, '-', ''), '', true);\n`;
const UNBOUND = `  if coalesce(current_setting(v_marker, true), '') <> '' then`;
const NAIVE = [BUMP, [SKIP_BLOCK, `${SKIP_TEST}\n    return;\n  end if;`]];
const NO_RESET = [EVAL, [RESET, '']];

// parts: [source definition, ...substitutions], one part per function the mutant re-creates.
const mutants = [
  { name: 'naive_once_per_tx', parts: [NAIVE],
    what: 'skip whenever this transaction already bumped the user, with no staleness re-check: the negative control. The evaluator reset still re-arms after every evaluation, so only freshness published WITHOUT clearing the marker exposes it',
    expect: 'a14: 17: the next input write still invalidates (a skip requires a stale row)' },
  { name: 'naive_once_per_tx_without_reset', parts: [NAIVE, NO_RESET],
    what: 'the negative control with the evaluator reset ALSO removed (the P1 prototype\'s naive control): nothing re-arms after an in-transaction evaluation',
    expect: 'a14: 4: stale after the second write (post-evaluation write re-invalidates)' },
  { name: 'stale_only_skip', parts: [[BUMP, [SKIP_TEST, `  if true then`]]],
    what: 'skip whenever the row is stale, with no marker at all: a writer in a new transaction skips without taking L2 (c25 times out: the evaluator is never blocked)',
    expect: 'a14: 5: the surviving write advanced input_version in its own transaction' },
  { name: 'unbound_marker', parts: [[BUMP, [SKIP_TEST, UNBOUND]]],
    what: 'any marker value counts (not bound to the current transaction id)',
    expect: 'a14: 8: a leftover session-level value did not suppress the bump' },
  { name: 'unkeyed_marker', parts: [[BUMP, [`v_marker := 'card_payment.bumped_' || replace(p_user_id::text, '-', '');`, `v_marker := 'card_payment.bumped_any';`]]],
    what: 'one marker for every user (not keyed by user)',
    expect: 'a14: 10: each user written in the transaction advanced in that transaction' },
  { name: 'session_marker', parts: [[BUMP, [MARK, `perform set_config(v_marker, v_xact, false);`, 2]]],
    what: 'marker written at session scope (survives commit); the transaction-id binding alone still protects',
    expect: 'SURVIVES a14; a15: no marker after commit' },
  { name: 'session_unbound', parts: [[BUMP, [MARK, `perform set_config(v_marker, v_xact, false);`, 2], [SKIP_TEST, UNBOUND]]],
    what: 'session scope AND no transaction binding: a marker from an earlier transaction suppresses its bump',
    expect: 'a14: 5: the surviving write advanced input_version in its own transaction' },
  { name: 'no_row_check', parts: [[BUMP, [`    if found and v_evaluated is distinct from v_input then`, `    if v_evaluated is distinct from v_input then`]]],
    what: 'drop the explicit "row exists" check (a missing row reads as NULL = NULL, i.e. not stale)',
    expect: 'SURVIVES a14 (redundant with the staleness check)' },
  { name: 'no_evaluator_reset', parts: [NO_RESET],
    what: 'the evaluator does not clear the marker at version capture',
    expect: 'a14: 14a: a write after the capture leaves the publication stale, inside the transaction' },
  { name: 'late_evaluator_reset', parts: [[EVAL, [RESET, ''], ['  where user_id = p_user_id;\n  return v_version;\nend;', `  where user_id = p_user_id;\n${RESET}  return v_version;\nend;`]]],
    what: 'the evaluator clears the marker only after publishing (too late for a write between capture and publication)',
    expect: 'a14: 14a: a write after the capture leaves the publication stale, inside the transaction' },
  { name: 'wrong_key_reset', parts: [[EVAL, [RESET, `  perform set_config('card_payment.bumped_' || md5(p_user_id::text), '', true);\n`]]],
    what: 'the evaluator clears a valid but different key, not the user\'s marker',
    expect: 'a14: 14a: a write after the capture leaves the publication stale, inside the transaction' },
  { name: 'account_insert_no_bump', parts: [[ACCOUNTS, [`  if tg_op in ('INSERT', 'UPDATE') then`, `  if tg_op = 'UPDATE' then`]]],
    what: 'an account INSERT no longer invalidates its owner',
    expect: 'a09: account inserts advanced each owner' },
  { name: 'account_insert_single_owner', parts: [[ACCOUNTS, [`    select i.user_id into v_new from public.plaid_items i where i.id = new.item_id;`, `    select i.user_id into v_new from public.plaid_items i order by i.user_id limit 1;`]]],
    what: 'account writes invalidate one fixed owner instead of the row\'s owner',
    expect: 'a09: account inserts advanced each owner' },
  { name: 'account_insert_overbroad', parts: [[ACCOUNTS, [`      perform public.card_payment_bump(v_new);\n`, `      perform public.card_payment_bump(v_new);\n      perform public.card_payment_bump(v.user_id) from public.card_payment_eval_versions v;\n`]]],
    what: 'account writes invalidate every user, not only the owner',
    expect: 'a09: an unrelated owner did not advance and stays fresh' },
];

function apply([src, ...subs]) {
  let s = src;
  for (const [from, to, n = 1] of subs) {
    const found = s.split(from).length - 1;
    if (found !== n) throw new Error(`expected ${n} match(es) of ${JSON.stringify(from.slice(0, 60))}, found ${found}`);
    s = s.split(from).join(to);
  }
  return s;
}
const out = process.argv[2];
if (!out) throw new Error('usage: node mutants.cjs <out-dir>');
fs.mkdirSync(out, { recursive: true });
const manifest = [];
for (const m of mutants) {
  const sql = m.parts.map(apply).join('\n\n');
  fs.writeFileSync(path.join(out, `${m.name}.sql`), `-- MUTANT ${m.name} (deliberately wrong; disposable test databases only): ${m.what}\n${sql}\n`);
  manifest.push([m.name, m.expect, m.what].join('\t'));
}
fs.writeFileSync(path.join(out, 'manifest.tsv'), manifest.join('\n') + '\n');
console.log(`wrote ${mutants.length} mutants to ${out}`);
