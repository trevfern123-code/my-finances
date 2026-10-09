// Generates the psql benchmark script for institution removal with card-payment conversion and its
// provenance (20261006120000, 20261008120000; synthetic data, disposable database only).
//
//   node bench.cjs [samples] [warmups] [sizes] > bench.sql        (defaults 5, 1, and the variant's sizes)
//   BENCH_FIXTURE=<variant> node bench.cjs ...                    (one variant per generated script; default "base")
//
// THE BODIES MEASURED. Three bodies of remove_plaid_item_local, each on its own fixture:
//   previous   the 20260926120000 function (installed in this throwaway database under another name, from the
//              real migration text): no evaluation, no conversion — what a removal cost before;
//   revision5  the 20261006120000 function (installed the same way, from its migration text): it evaluates,
//              preserves, deletes and evaluates again; it merges system rows by pair and date and records no
//              provenance. Run where the provenance tables exist, it is what the rollback of 20261008120000
//              leaves installed;
//   current    public.remove_plaid_item_local as 20261008120000 installs it: one system row per source, and a
//              provenance row for every decision it writes. The script refuses to run unless the installed
//              function is the body in that file, and the statements timed one by one below are sliced from
//              that same text (so the benchmark cannot drift from it; a statement of the preservation block
//              that is not sliced stops the generator).
// "added by 20261008120000" is current against revision5, measured in the same run.
//
// THE FIXTURES (the environment variable BENCH_FIXTURE). Every sample builds its fixture again for a brand-new
// user: a REMOVED institution (a card X and a checking RC) and a KEPT one (a checking C and a card Y).
//   base              size = N transactions on each institution. N/100 card payments from the kept checking C
//                     to the removed card X (tier 1 pairs: these are the conversions) and as many from C to the
//                     kept card Y (pairs that must stay untouched). Every payment amount is distinct: no
//                     payment to X has a second candidate. Unchanged since the first measurement, so its
//                     numbers stay comparable. A removal writes N/100 destination records and NO hold.
//   hold_heavy        base, and every payment to X ALSO has a leg of the same amount on the kept card Y, three
//                     days after the payment (X's own leg is one day after, so X stays the automatic match and
//                     the Y leg is an unmatched competitor). These legs replace as many ordinary rows of the
//                     kept institution. A removal writes N/100 records AND N/100 holds.
//   provenance_heavy  hold_heavy with BENCH_KEPT (default 4) kept competitors for every payment to X, two to
//                     five days after it: many surviving payments, each with a removed partner and several
//                     kept competitors. A removal writes N/100 records and BENCH_KEPT * N/100 holds — the same
//                     decisions under revision5 and current (one removed candidate per payment: nothing to
//                     merge) — and current writes one provenance row for each.
//   same_date         size = R, the removed candidates of each kept payment. BENCH_CLUSTERS (default 100)
//                     amounts; for each amount ONE kept payment, R legs on the removed card X ALL ON ONE DATE,
//                     and BENCH_KEPT (default 4) legs on the kept card Y. R >= 2, so the payment is tied and
//                     has no automatic match. current writes clusters * R * kept holds; revision5 writes
//                     clusters * kept (it keeps one hold for a pair and a date). BENCH_ROWS (default 2000)
//                     ordinary rows on each institution.
//   dense             size = n: BENCH_CLUSTERS (default 20) amounts, and for each amount n kept payments (on
//                     three consecutive days), n legs on the removed card (one date) and n on the kept card
//                     (two dates) — every leg within five days of every other, so their windows overlap.
//                     current writes clusters * n^3 holds, revision5 clusters * n^2.
//   cycles            size = P, the removals of ONE institution that already ran for this user: it was linked
//                     again each time (new item, new ids, the same legs) and removed again by the body under
//                     test, and the rows those removals wrote are still live. BENCH_PAIRS (default 100)
//                     payments to the removed card, each with BENCH_KEPT (default 2) kept competitors;
//                     BENCH_ROWS (default 2000) ordinary rows on each institution. Measured: the removal after
//                     those P. A third series, "current, prior unrecorded", runs the P earlier removals with
//                     revision5 and the measured one with current: the path that writes P markers.
//
// MEASURED, for each body, on its own fixture (previous only for base and hold_heavy unless BENCH_BODIES says
// otherwise):
//   removal             one committed transaction: BEGIN, the user's advisory lock (taken explicitly, with the
//                       key the function uses — the function's own first statement takes it again), the
//                       function, COMMIT. The server's clock_timestamp() is read before BEGIN and after COMMIT.
//                       Three local round trips more than the single statement the files before 2026-10-08
//                       timed (BEGIN, the lock, a clock read).
//   lock held to commit the same sample, from the clock read right after the advisory lock was granted to the
//                       one after COMMIT returned: how long this removal keeps every other writer of the user
//                       that takes the advisory lock waiting.
//   evaluate after      evaluate_card_payments for the user, once, right after the removal committed: what the
//                       next evaluation costs with the rows the removal left.
//   read after          get_card_payment_states for the user, once, after that (the whole answer is sent to
//                       the client and discarded).
// And, in one transaction that is rolled back, the statements of the function one by one with the clock read
// between them:
//   current steps       first evaluation; the preservation block — markers and generation, the plan table
//                       (create, truncate), the three plan statements (a) (b) (c), the three decision inserts,
//                       the provenance insert; delete (the cascade and its triggers); final evaluation
//                       (best-effort: try_evaluate_card_payments, as the function calls it).
//   current guard       between the provenance insert and the delete, and in no step: the three lookups that the
//                       guard trigger of card_payment_removal_sources makes for every row, run AGAIN for every
//                       provenance row just written — the trigger's own text, one statement per row as the
//                       trigger runs it — each lookup in a loop of its own, and the loop alone. The difference
//                       is what that lookup costs per row inside the provenance insert.
//   revision5 steps     first evaluation; its three preservation statements; delete; final evaluation.
// Not timed in the steps: the loan restoration, the counts and the ledger update (unchanged since 20260926120000).
// Between samples the fixture's user is deleted and the affected tables vacuumed, untimed.
// THE ORDER. A ROUND measures every size once, and at each size every body, one directly after the other, then
// the two step transactions. So a drift of the machine during a run reaches every size and every body alike,
// and the report also compares the bodies ROUND BY ROUND (the difference and the ratio of the two samples of
// one round), which a busy machine disturbs less than the difference of two medians. Every sample is printed.
//
// ALSO PRINTED, from two more fixtures per size and body that are not timed:
//   counts   the rows the removal wrote — decisions by kind, generations, markers, sources — checked against what
//            the variant describes (for current also WHICH sources: the removed account and transactions, and
//            what each was to the surviving leg); the bytes of those rows in two measures (the sum of
//            pg_column_size over the rows; and the growth of pg_total_relation_size, heap and indexes, after a
//            VACUUM FULL of the three tables); what the evaluation after it read and what the reader returns;
//            and the WORK of the removal, of one evaluation after it and of one read after that, as
//            pg_stat_statements counted it for the top-level statement: shared and temporary-table buffers,
//            WAL records and bytes. Those do not depend on how busy the machine is; the timings do.
//   plans    EXPLAIN (ANALYZE) of every statement of current's preservation block, and of every lookup the two
//            guard triggers make (two for a generation row, three for a provenance row), at the largest size
//            (BENCH_PLANS=all for every size, none for none). In the cycles variant they are taken after
//            earlier removals that ran without provenance, so that the marker statement writes its rows.
//            This database holds ONE user at a time, so every table but transactions is a few rows long and is
//            scanned whatever indexes it has: those scans say nothing about a database with other users. The
//            indexes of the tables these statements read are listed at the start, and BENCH_BACKGROUND=<users>
//            (default 0) first gives the database that many OTHER users, each with a kept institution and one
//            removal that current ran (its ledger row, its generation, a record and a hold with their
//            provenance rows). No table is then small, and the plans and the timings of the guard are what a
//            database with other users gets. The default stays 0 so that the timings stay comparable with the
//            files recorded before.
//
// These are local measurements for a report. Not a pass/fail test, never correctness evidence.
//
// SAFETY: the generated script truncates auth.users. It refuses to run unless psql is given
// -v bench_disposable=1 (run.sh does) AND auth.users is empty (a fresh throwaway database).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VARIANTS = {
  base: { family: 'payments', sizes: '1000,10000,50000', bodies: 'previous,revision5,current' },
  hold_heavy: { family: 'payments', sizes: '1000,10000,50000', bodies: 'previous,revision5,current' },
  provenance_heavy: { family: 'payments', sizes: '1000,10000,50000', bodies: 'revision5,current' },
  same_date: { family: 'cluster', sizes: '2,8,32', bodies: 'revision5,current' },
  dense: { family: 'cluster', sizes: '2,4,8', bodies: 'revision5,current' },
  cycles: { family: 'cycles', sizes: '0,1,3,5', bodies: 'revision5,current,unrecorded' },
};
const BODIES = {
  previous: { label: 'previous', fn: 'bench.remove_previous', prior: 'bench.remove_previous' },
  revision5: { label: 'revision5', fn: 'bench.remove_revision5', prior: 'bench.remove_revision5' },
  current: { label: 'current', fn: 'public.remove_plaid_item_local', prior: 'public.remove_plaid_item_local' },
  // cycles only: the earlier removals ran without provenance, the measured one records it and marks them.
  unrecorded: { label: 'current, prior unrecorded', fn: 'public.remove_plaid_item_local', prior: 'bench.remove_revision5' },
};

const VARIANT = process.env.BENCH_FIXTURE || 'base';
if (!VARIANTS[VARIANT]) throw new Error(`BENCH_FIXTURE must be one of ${Object.keys(VARIANTS).join(', ')}, not ${VARIANT}`);
const FAMILY = VARIANTS[VARIANT].family;
const samples = Number(process.argv[2] || 5);
const warmups = Number(process.argv[3] || 1);
const SIZES = (process.argv[4] || VARIANTS[VARIANT].sizes).split(',').map(Number);
const MEASURED = (process.env.BENCH_BODIES || VARIANTS[VARIANT].bodies).split(',');
const PLANS = process.env.BENCH_PLANS || 'largest';
const env = (name, fallback) => Number(process.env[name] || fallback);
const KEPT = VARIANT === 'base' ? 0 : VARIANT === 'hold_heavy' ? 1 : env('BENCH_KEPT', FAMILY === 'cycles' ? 2 : 4);
const CLUSTERS = env('BENCH_CLUSTERS', VARIANT === 'dense' ? 20 : 100);
const ROWS = env('BENCH_ROWS', 2000);
const PAIRS = env('BENCH_PAIRS', 100);
const BACKGROUND = env('BENCH_BACKGROUND', 0);
if (![samples, warmups, KEPT, CLUSTERS, ROWS, PAIRS, BACKGROUND, ...SIZES].every((x) => Number.isInteger(x) && x >= 0) || samples < 1) throw new Error('samples, warm-ups, sizes and BENCH_* must be whole numbers');
for (const b of MEASURED) {
  if (!BODIES[b] || (b === 'unrecorded' && FAMILY !== 'cycles')) throw new Error(`BENCH_BODIES: ${b} is not a body of the ${VARIANT} variant`);
}
if (!['largest', 'all', 'none'].includes(PLANS)) throw new Error('BENCH_PLANS must be largest, all or none');
if (FAMILY === 'cluster' && SIZES.some((n) => n < 2)) throw new Error(`${VARIANT}: every size must be at least 2 (one removed candidate would be the automatic match)`);
if (FAMILY === 'payments' && SIZES.some((n) => n < (3 + KEPT) * Math.max(Math.floor(n / 100), 1))) throw new Error(`${VARIANT}: a size is too small for its card legs`);
if (FAMILY !== 'payments' && ROWS < 2) throw new Error('BENCH_ROWS must be at least 2');

const ROOT = path.resolve(__dirname, '../../../..');
const migration = (name) => fs.readFileSync(path.join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n/g, '\n');
const OLD = migration('20260926120000_linked_institution_management.sql');
const REV5 = migration('20261006120000_lim_removal_card_payment_matching.sql');
const NEW = migration('20261008120000_card_payment_removal_provenance.sql');

function definition(text, head) {
  const start = text.indexOf(head);
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw new Error(`definition not unique: ${head}`);
  return text.slice(start, text.indexOf('\n$$;', start) + 4);
}
// The checksum a migration's postcondition requires of the body it installs, and the same checksum computed
// from the function text taken here: they must agree, or the text below is not the function.
function bodyChecksum(file, text, def) {
  const m = text.match(/<> '([0-9a-f]{32})' then\s+raise exception 'remove_plaid_item_local is not the definition this migration installs'/);
  if (!m) throw new Error(`${file}: the postcondition's checksum of remove_plaid_item_local was not found`);
  const body = def.slice(def.indexOf('as $$\n') + 5, def.length - 3);
  if (crypto.createHash('md5').update(body, 'utf8').digest('hex') !== m[1]) throw new Error(`${file}: the function text taken here is not the body its postcondition names`);
  return m[1];
}
const previous = definition(OLD, 'create function public.remove_plaid_item_local(')
  .replace('create function public.remove_plaid_item_local(', 'create function bench.remove_previous(');
const revision5Definition = definition(REV5, 'create or replace function public.remove_plaid_item_local(');
bodyChecksum('20261006120000', REV5, revision5Definition);
const revision5 = revision5Definition.replace('create or replace function public.remove_plaid_item_local(', 'create function bench.remove_revision5(');
const current = definition(NEW, 'create or replace function public.remove_plaid_item_local(');
const CURRENT_MD5 = bodyChecksum('20261008120000', NEW, current);

// A statement of a function, taken from its text by its first and last line, as psql runs it: the function's
// parameters and variables become psql variables (u, item, v, removal), and the removed item's institution id
// is read where the function has it in a variable.
const used = [];
function slice(text, first, last) {
  const start = text.indexOf(first);
  if (start < 0 || text.indexOf(first, start + 1) >= 0) throw new Error(`statement not found, or not unique: ${first.split('\n')[0].trim()}`);
  const end = text.indexOf(last, start);
  if (end < 0) throw new Error(`end of statement not found: ${last.trim()}`);
  return text.slice(start, end + last.length);
}
function statement(text, first, last, record) {
  const raw = slice(text, first, last);
  if (record) used.push(raw);
  return raw
    .replace(/p_user_id/g, ":'u'::uuid").replace(/p_item_id/g, ":'item'::uuid").replace(/v_evaluated/g, ':v')
    .replace(/v_removal\.id/g, ":'removal'::uuid")
    .replace(/v_institution_id/g, "(select pi.institution_id from public.plaid_items pi where pi.id = :'item'::uuid)");
}

// ---- current (20261008120000): every statement of the preservation block ---------------------------------
const NEW_STATEMENTS = [
  ['markers', 'the markers of earlier removals without provenance',
    '    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded)\n    select pr.id', '    order by pr.cleaned_at, pr.id;'],
  ['generation', 'the generation of this removal',
    '    insert into public.card_payment_removal_generations (removal_id, user_id, sources_recorded, institution_id)', '    values (v_removal.id, p_user_id, true, v_institution_id);'],
  ['table', 'the plan table (create, truncate)',
    '    create temporary table if not exists pg_temp.rpp_plan (', '    truncate pg_temp.rpp_plan;'],
  ['plan_a', 'plan (a): user-confirmed pairs',
    '    insert into pg_temp.rpp_plan\n      (decision_id, step, kind, a_account, a_plaid, a_cents, b_plaid, b_cents,', '    order by d.id;'],
  ['plan_b', 'plan (b): automatic pairs',
    '    insert into pg_temp.rpp_plan\n      (decision_id, step, kind, a_account, a_plaid, a_cents, source_relation, source_account, source_txn, source_plaid, ord)', '    order by t.id;'],
  ['plan_c', 'plan (c): ambiguity holds',
    '    insert into pg_temp.rpp_plan\n      (decision_id, step, kind, a_account, a_plaid, a_cents, b_account, b_plaid, b_cents, counterpart_date,', '    ) h;'],
  ['write_a', 'decisions of (a)',
    '    insert into public.card_payment_decisions\n      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,', "    where p.step = 'a'\n    order by p.ord;"],
  ['write_b', 'decisions of (b)',
    '    insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)', "    where p.step = 'b'\n    order by p.ord;"],
  ['write_c', 'decisions of (c)',
    '    insert into public.card_payment_decisions\n      (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,\n       counterpart_date)', 'p.source_plaid collate "C";'],
  ['provenance', 'the provenance rows',
    '    insert into public.card_payment_removal_sources', '     and co.consumed_at is null and co.expires_at > now();'],
];
const S = {};
const TITLE = {};
for (const [key, title, first, last] of NEW_STATEMENTS) {
  S[key] = statement(current, first, last, true);
  TITLE[key] = title;
}
// Nothing of the block may be left unmeasured: without the statements above and its comments, what remains of
// it is control flow only. If the function gains a statement, this stops the generator.
{
  // The block is found by its handler and the BEGIN before it, not by a comment: comments may be reworded.
  const to = current.indexOf("  exception when others then\n    raise exception 'remove_plaid_item_local: known card-payment destinations could not be preserved");
  const from = current.lastIndexOf('\n  begin\n', to);
  if (from < 0 || to < 0) throw new Error('the preservation block was not found in the 20261008120000 function');
  let rest = current.slice(from, to);
  for (const raw of used) {
    if (!rest.includes(raw)) throw new Error('a sliced statement is not inside the preservation block');
    rest = rest.replace(raw, '');
  }
  const left = rest.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('--'));
  const control = [
    'begin',
    'get diagnostics v_written = row_count;',
    'get diagnostics v_recorded = row_count;',
    'v_written := v_written + v_recorded;',
    'get diagnostics v_recorded = row_count;',
    'v_written := v_written + v_recorded;',
    'get diagnostics v_recorded = row_count;',
    'select count(*) into v_planned from pg_temp.rpp_plan;',
    'if v_written <> v_planned or v_recorded <> v_planned then',
    "raise exception 'remove_plaid_item_local: % decisions were planned, % written, % given a provenance row',",
    'v_planned, v_written, v_recorded;',
    'end if;',
  ];
  if (left.join('\n') !== control.join('\n')) {
    throw new Error(`the preservation block of 20261008120000 has text this benchmark does not time:\n${left.filter((l) => !control.includes(l)).join('\n')}`);
  }
}

// ---- current (20261008120000): what the two guard triggers look up for every row -------------------------
// Taken from the trigger functions in the same file, so that a guard that changes stops the generator instead
// of being measured as it used to be. The generation guard runs twice in a removal that marks nothing (once
// per generation row); the source guard runs once for EVERY provenance row, on the removal's critical path.
const generationsGuard = definition(NEW, 'create or replace function public.card_payment_removal_generations_guard()');
const sourcesGuard = definition(NEW, 'create or replace function public.card_payment_removal_sources_guard()');
const GUARD = {
  // The generation guard: the removal's ledger row, and the user's last ordinal.
  ledger: slice(generationsGuard, 'select r.status into v_status from public.plaid_item_removals r', 'r.user_id = new.user_id;'),
  ordinal: slice(generationsGuard, 'select max(g.ordinal) from public.card_payment_removal_generations g', 'where g.user_id = new.user_id'),
  // The source guard: (1) the decision the row is attached to; (2) the generation, written in this transaction
  // for a removal that is running, and the named account on the item being removed; (3) the removed
  // transaction itself, by its Plaid id, on that account.
  decision: slice(sourcesGuard, 'select d.kind, d.b_plaid_transaction_id, d.counterpart_date into v_kind, v_reference, v_date',
    "'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account');"),
  moment: slice(sourcesGuard, 'not exists (select 1 from public.card_payment_removal_generations g', 'a.plaid_account_id = new.source_plaid_account_id)'),
  row: slice(sourcesGuard, "new.source_resolution = 'row'\n     and not exists (select 1 from public.transactions t", '(t.amount * 100)::bigint = new.source_cents)'),
};
// Nothing else in either guard may read a table: with the lookups above taken out, no query is left.
for (const [text, keys] of [[generationsGuard, ['ledger', 'ordinal']], [sourcesGuard, ['decision', 'moment', 'row']]]) {
  let rest = text;
  for (const key of keys) rest = rest.replace(GUARD[key], '');
  if (/\b(select|perform|execute)\b/.test(rest.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))) {
    throw new Error('a guard trigger of 20261008120000 has a lookup this benchmark does not measure');
  }
}
// A lookup as a statement of its own: the trigger's NEW row becomes psql variables (a provenance row of the
// measured removal, read back after the insert), and a PL/pgSQL INTO clause is dropped.
const GUARD_VARIABLES = {
  removal_id: ":'removal'::uuid", user_id: ":'u'::uuid", decision_id: ":'g_decision'::uuid", source_resolution: ":'g_resolution'",
  source_plaid_account_id: ":'g_account'", source_plaid_transaction_id: ":'g_txn'", source_date: ":'g_date'::date", source_cents: ":'g_cents'::bigint",
};
function lookup(key) {
  const sql = GUARD[key].replace(/ into v_\w+(, v_\w+)*/, '').replace(/;$/, '').replace(/new\.(\w+)/g, (m, column) => {
    if (!GUARD_VARIABLES[column]) throw new Error(`the guard reads new.${column}, which this benchmark does not supply`);
    return GUARD_VARIABLES[column];
  });
  return /^select /.test(sql) ? sql : `select ${sql}`;
}
// The same lookup as the trigger's PL/pgSQL has it, with the loop row s of bench.replay_source_guard for NEW.
const replayed = (key) => GUARD[key].replace(/new\./g, 's.');

// ---- revision5 (20261006120000): its three preservation statements ---------------------------------------
const R5 = {
  a: statement(revision5Definition,
    '    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_plaid_transaction_id, b_cents,', '    order by d.id;'),
  b: statement(revision5Definition,
    '    insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)', '    order by t.id;'),
  c: statement(revision5Definition,
    '    insert into public.card_payment_decisions\n      (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents,\n       counterpart_date)', '    order by 2, 3, 4, 6, 7, 9;'),
};

// ---- What a variant describes (derived from the fixture and the two functions, not from a run) -----------
const pairsOf = (n) => (FAMILY === 'cycles' ? PAIRS : Math.max(Math.floor(n / 100), 1));
const shape = (n) => (VARIANT === 'dense' ? { q: n, r: n, k: n } : { q: 1, r: n, k: KEPT });
/** Before the measured removal: automatic pairs, card legs, unresolved legs, live system rows, cleaned removals. */
function before(n, body) {
  if (FAMILY === 'cluster') {
    const { q, r, k } = shape(n);
    return { autoPairs: 0, legs: CLUSTERS * (q + r + k), unresolved: CLUSTERS * (q + r + k), system: 0, cleaned: 0 };
  }
  const p = pairsOf(n);
  const perRemoval = p * (1 + KEPT);
  // Earlier removals (cycles): current keeps every removal's rows; revision5 wrote them once.
  const system = FAMILY !== 'cycles' || n === 0 ? 0 : (body === 'current' ? n : 1) * perRemoval;
  return { autoPairs: 2 * p, legs: (4 + KEPT) * p, unresolved: KEPT * p, system, cleaned: FAMILY === 'cycles' ? n : 0 };
}
/** What the measured removal writes, and what is left to read after it. */
function after(n, body) {
  const recording = body === 'current' || body === 'unrecorded';
  if (body === 'previous') return { records: 0, holds: 0, generations: 0, markers: 0, sources: 0, sourceTxns: 0 };
  if (FAMILY === 'cluster') {
    const { q, r, k } = shape(n);
    const holds = CLUSTERS * q * k * (recording ? r : 1);
    return {
      records: 0, holds, generations: recording ? 1 : 0, markers: 0, sources: recording ? holds : 0, sourceTxns: recording ? CLUSTERS * r : 0,
      relation: 'removed_candidate', liveHolds: holds, legsAfter: CLUSTERS * (q + k), autoPairsAfter: 0, removedCard: 0, system: holds,
    };
  }
  const p = pairsOf(n);
  const writes = recording || FAMILY !== 'cycles' || n === 0;
  const records = writes ? p : 0;
  const holds = writes ? KEPT * p : 0;
  const removals = FAMILY !== 'cycles' ? 1 : body === 'current' ? n + 1 : body === 'unrecorded' && n > 0 ? 2 : 1;
  return {
    records, holds, generations: recording ? 1 : 0, markers: body === 'unrecorded' ? n : 0,
    sources: recording ? records + holds : 0, sourceTxns: recording ? p : 0, relation: 'automatic_partner',
    liveHolds: removals * KEPT * p, legsAfter: (3 + KEPT) * p, autoPairsAfter: p, removedCard: p, system: removals * p * (1 + KEPT),
  };
}

const out = [];
const p = (s) => out.push(s);
p('\\set ON_ERROR_STOP 1');
p('\\if :{?bench_disposable}');
p('\\else');
p("do $$ begin raise exception 'REFUSING: run only through supabase/tests/card_payment_benchmark/removal/run.sh (a throwaway container)'; end $$;");
p('\\endif');
p("do $$ begin if exists (select 1 from auth.users) then raise exception 'REFUSING: auth.users is not empty; this benchmark truncates it and must only run on a fresh throwaway database'; end if; end $$;");
p(`do $$ begin if (select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure) <> '${CURRENT_MD5}' then raise exception 'REFUSING: public.remove_plaid_item_local is not the body of 20261008120000 that this script''s statements were taken from'; end if; end $$;`);
p('set client_min_messages = warning;');
p('create schema bench;');
p('grant usage on schema bench to service_role;');
p('create table bench.results (phase text, size integer, sample integer, seconds double precision);');
p('create table bench.counts (seq integer generated always as identity, size integer, body text, what text, n bigint);');
p('truncate auth.users cascade;');
p(previous);
p(revision5);
p('grant execute on function bench.remove_previous(uuid, uuid), bench.remove_revision5(uuid, uuid) to service_role;');
p(`create function bench.require(p_ok boolean, p_message text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'the fixture or the removal is not what the ${VARIANT} variant describes: %', p_message; end if;
end $$;`);
// The source guard's lookups again, for the provenance rows of one removal: one statement per row, as the
// trigger runs them, and each lookup must find what the guard found. p_lookup 0 is the loop alone.
p(`create function bench.replay_source_guard(p_removal uuid, p_lookup integer) returns bigint language plpgsql as $$
declare
  s public.card_payment_removal_sources;
  v_kind text;
  v_reference text;
  v_date date;
  v_rows bigint := 0;
begin
  for s in select x.* from public.card_payment_removal_sources x where x.removal_id = p_removal loop
    if p_lookup = 1 then
      ${replayed('decision')}
      if not found then raise exception 'replayed source guard: the decision lookup found nothing'; end if;
    elsif p_lookup = 2 then
      if ${replayed('moment')} then raise exception 'replayed source guard: the generation lookup found nothing'; end if;
    elsif p_lookup = 3 then
      if ${replayed('row')} then raise exception 'replayed source guard: the transaction lookup found nothing'; end if;
    end if;
    v_rows := v_rows + 1;
  end loop;
  return v_rows;
end $$;`);
p('grant execute on function bench.replay_source_guard(uuid, integer) to service_role;');
const describe = {
  base: 'no payment to the removed card has a second candidate',
  hold_heavy: 'every payment to the removed card also has a same-amount leg on the kept card, three days later',
  provenance_heavy: `every payment to the removed card also has ${KEPT} same-amount legs on the kept card, two to five days later`,
  same_date: `${CLUSTERS} amounts; for each: 1 kept payment, <size> legs on the removed card on ONE date, ${KEPT} legs on the kept card; ${ROWS} ordinary rows on each institution`,
  dense: `${CLUSTERS} amounts; for each: <size> kept payments, <size> legs on the removed card on ONE date, <size> legs on the kept card, all within five days; ${ROWS} ordinary rows on each institution`,
  cycles: `<size> earlier removals of the same institution, relinked each time; ${PAIRS} payments to the removed card, each with ${KEPT} kept competitors; ${ROWS} ordinary rows on each institution`,
}[VARIANT];
const sizeMeans = { payments: 'transactions on the removed institution; as many again on the kept one', cluster: VARIANT === 'dense' ? 'legs of each kind for one amount' : 'removed candidates of each kept payment', cycles: 'earlier removals of the institution' }[FAMILY];
p(`\\echo fixture variant: ${VARIANT} (${describe})`);
p(`\\echo sizes: ${SIZES.join(',')} (${sizeMeans}); bodies: ${MEASURED.map((b) => BODIES[b].label).join(' / ')}`);
p('\\echo function bodies measured (md5 of the LF-normalised source)');
p(`select p.oid::regprocedure as function, md5(replace(p.prosrc, E'\\r', '')) as body_md5 from pg_proc p where p.oid in ('bench.remove_previous(uuid, uuid)'::regprocedure, 'bench.remove_revision5(uuid, uuid)'::regprocedure, 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure, 'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure, 'public.try_evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure) order by 1;`);
p('\\echo indexes of the tables that the statements added by 20261008120000 and its two guards read');
p(`select tablename as table, indexname as index, regexp_replace(indexdef, '^.* USING ', '') as definition from pg_indexes where schemaname = 'public' and tablename in ('plaid_item_removals', 'card_payment_removal_generations', 'card_payment_removal_sources', 'card_payment_decisions', 'plaid_items', 'accounts', 'transactions', 'transaction_carryovers') order by 1, 2;`);

// The fixtures. Ids are derived from the user's uuid so every sample is independent.
const LEG = "'Payment', 'credit_card_payment', 'category_detailed', 'high', 1";
const ROW = "'Row', 'expense', 'sign_default', 'low', 1";
const COLUMNS = '(account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version)';
p(`create function bench.ready(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform public.evaluate_card_payments(p_user);
  perform public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item));
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
end $$;`);
if (FAMILY === 'payments') {
  p(`create function bench.build(p_user uuid, p_n integer) returns uuid language plpgsql as $$
declare
  v_removed uuid := gen_random_uuid();
  v_kept uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_y uuid := gen_random_uuid();
  v_pairs integer := greatest(p_n / 100, 1);
  v_tag text := replace(p_user::text, '-', '');
begin
  insert into auth.users (id, email) values (p_user, v_tag || '@example.test');
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
    (v_removed, p_user, 'bench-removed-' || v_tag, 'placeholder', 'Removed'), (v_kept, p_user, 'bench-kept-' || v_tag, 'placeholder', 'Kept');
  insert into public.accounts (id, item_id, plaid_account_id, name, type) values
    (v_x, v_removed, 'x-' || v_tag, 'Card X', 'credit'), (v_rc, v_removed, 'rc-' || v_tag, 'Checking RC', 'depository'),
    (v_c, v_kept, 'c-' || v_tag, 'Checking C', 'depository'), (v_y, v_kept, 'y-' || v_tag, 'Card Y', 'credit');
  -- Ordinary rows: p_n on the removed institution, p_n on the kept one (minus the card legs below).
  insert into public.transactions ${COLUMNS}
  select case when g % 2 = 0 then v_x else v_rc end, 'r-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, p_n - v_pairs) g;
  insert into public.transactions ${COLUMNS}
  select case when g % 4 = 0 then v_y else v_c end, 'k-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, p_n - ${3 + KEPT} * v_pairs) g;
  -- Card payments: C -> X (the pairs a removal converts) and C -> Y (pairs that stay). Distinct cents per pair.
  insert into public.transactions ${COLUMNS}
  select v_c, 'kx-' || v_tag || '-' || g, 1000 + g * 0.01, date '2024-01-01' + (g % 700), ${LEG} from generate_series(1, v_pairs) g
  union all
  select v_x, 'x-' || v_tag || '-' || g, -(1000 + g * 0.01), date '2024-01-02' + (g % 700), ${LEG} from generate_series(1, v_pairs) g
  union all
  select v_c, 'ky-' || v_tag || '-' || g, 5000 + g * 0.01, date '2024-01-01' + (g % 700), ${LEG} from generate_series(1, v_pairs) g
  union all
  select v_y, 'y-' || v_tag || '-' || g, -(5000 + g * 0.01), date '2024-01-02' + (g % 700), ${LEG} from generate_series(1, v_pairs) g${KEPT > 0 ? `
  union all
  -- Kept competitors: ${KEPT} leg(s) on the kept card Y of the same amount as each C -> X payment, two to five days
  -- after the payment (the first one three days after; the leg on X is one day after it: X is the closest
  -- candidate and stays the automatic match).
  select v_y, 'yh-' || v_tag || '-' || g || '-' || j, -(1000 + g * 0.01), date '2024-01-03' + (g % 700) + ((j + 1) % 4), ${LEG}
  from generate_series(1, v_pairs) g cross join generate_series(0, ${KEPT - 1}) j` : ''};
  perform bench.ready(p_user, v_removed);
  return v_removed;
end $$;`);
} else if (FAMILY === 'cluster') {
  p(`create function bench.build(p_user uuid, p_q integer, p_r integer, p_k integer) returns uuid language plpgsql as $$
declare
  v_removed uuid := gen_random_uuid();
  v_kept uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_y uuid := gen_random_uuid();
  v_tag text := replace(p_user::text, '-', '');
begin
  insert into auth.users (id, email) values (p_user, v_tag || '@example.test');
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
    (v_removed, p_user, 'bench-removed-' || v_tag, 'placeholder', 'Removed'), (v_kept, p_user, 'bench-kept-' || v_tag, 'placeholder', 'Kept');
  insert into public.accounts (id, item_id, plaid_account_id, name, type) values
    (v_x, v_removed, 'x-' || v_tag, 'Card X', 'credit'), (v_rc, v_removed, 'rc-' || v_tag, 'Checking RC', 'depository'),
    (v_c, v_kept, 'c-' || v_tag, 'Checking C', 'depository'), (v_y, v_kept, 'y-' || v_tag, 'Card Y', 'credit');
  -- Ordinary rows: ${ROWS} on each institution.
  insert into public.transactions ${COLUMNS}
  select case when g % 2 = 0 then v_x else v_rc end, 'r-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, ${ROWS}) g;
  insert into public.transactions ${COLUMNS}
  select case when g % 4 = 0 then v_y else v_c end, 'k-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, ${ROWS}) g;
  -- One amount per cluster g (6.00 apart, so no leg is a near-amount candidate of another cluster's), first day
  -- d = 2024-01-01 + g. p_q kept payments on C on the days d, d+1, d+2 in turn; p_r legs on the removed card X,
  -- ALL on d+2; p_k legs on the kept card Y on d+4 and d+5 in turn. Every card leg is within five days of every
  -- payment, and with two or more removed legs on one date no payment has a closest candidate: nothing is
  -- matched automatically.
  insert into public.transactions ${COLUMNS}
  select v_c, 'o-' || v_tag || '-' || g || '-' || i, 2000 + g * 6, date '2024-01-01' + (g % 700) + (i % 3), ${LEG}
  from generate_series(1, ${CLUSTERS}) g cross join generate_series(0, p_q - 1) i
  union all
  select v_x, 'x-' || v_tag || '-' || g || '-' || i, -(2000 + g * 6), date '2024-01-03' + (g % 700), ${LEG}
  from generate_series(1, ${CLUSTERS}) g cross join generate_series(0, p_r - 1) i
  union all
  select v_y, 'y-' || v_tag || '-' || g || '-' || i, -(2000 + g * 6), date '2024-01-05' + (g % 700) + (i % 2), ${LEG}
  from generate_series(1, ${CLUSTERS}) g cross join generate_series(0, p_k - 1) i;
  perform bench.ready(p_user, v_removed);
  return v_removed;
end $$;`);
} else {
  p(`create function bench.base(p_user uuid) returns void language plpgsql as $$
declare
  v_kept uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_y uuid := gen_random_uuid();
  v_tag text := replace(p_user::text, '-', '');
begin
  insert into auth.users (id, email) values (p_user, v_tag || '@example.test');
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
    (v_kept, p_user, 'bench-kept-' || v_tag, 'placeholder', 'Kept');
  insert into public.accounts (id, item_id, plaid_account_id, name, type) values
    (v_c, v_kept, 'c-' || v_tag, 'Checking C', 'depository'), (v_y, v_kept, 'y-' || v_tag, 'Card Y', 'credit');
  insert into public.transactions ${COLUMNS}
  select case when g % 4 = 0 then v_y else v_c end, 'k-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, ${ROWS}) g;
  -- The kept side of every card payment: ${PAIRS} payments C -> X (their card legs come with each link of the removed
  -- institution), ${PAIRS} payments C -> Y with their legs on Y (pairs that stay), and ${KEPT} competitor(s) on Y for
  -- each payment to X, three and more days after it. Amounts are 6.00 apart: no leg is a near-amount candidate
  -- of another payment's.
  insert into public.transactions ${COLUMNS}
  select v_c, 'kx-' || v_tag || '-' || g, 1000 + g * 6, date '2024-01-01' + (g % 700), ${LEG} from generate_series(1, ${PAIRS}) g
  union all
  select v_c, 'ky-' || v_tag || '-' || g, 50000 + g * 6, date '2024-01-01' + (g % 700), ${LEG} from generate_series(1, ${PAIRS}) g
  union all
  select v_y, 'y-' || v_tag || '-' || g, -(50000 + g * 6), date '2024-01-02' + (g % 700), ${LEG} from generate_series(1, ${PAIRS}) g
  union all
  select v_y, 'yh-' || v_tag || '-' || g || '-' || j, -(1000 + g * 6), date '2024-01-04' + (g % 700) + (j % 3), ${LEG}
  from generate_series(1, ${PAIRS}) g cross join generate_series(0, ${KEPT - 1}) j;
end $$;`);
  p(`create function bench.link(p_user uuid, p_cycle integer) returns uuid language plpgsql as $$
declare
  v_removed uuid := gen_random_uuid();
  v_x uuid := gen_random_uuid();
  v_rc uuid := gen_random_uuid();
  v_tag text := replace(p_user::text, '-', '') || '-c' || p_cycle;
begin
  -- The institution that is removed, linked (again): a new item, new accounts, new transaction ids, and the
  -- same legs — amounts and dates — every time. Evaluated, and its removal taken to plaid_removed.
  insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
    (v_removed, p_user, 'bench-removed-' || v_tag, 'placeholder', 'Removed');
  insert into public.accounts (id, item_id, plaid_account_id, name, type) values
    (v_x, v_removed, 'x-' || v_tag, 'Card X', 'credit'), (v_rc, v_removed, 'rc-' || v_tag, 'Checking RC', 'depository');
  insert into public.transactions ${COLUMNS}
  select case when g % 2 = 0 then v_x else v_rc end, 'r-' || v_tag || '-' || g, 5 + (g % 400), date '2024-01-01' + (g % 700), ${ROW}
  from generate_series(1, ${ROWS}) g
  union all
  select v_x, 'x-' || v_tag || '-' || g, -(1000 + g * 6), date '2024-01-02' + (g % 700), ${LEG} from generate_series(1, ${PAIRS}) g;
  perform bench.ready(p_user, v_removed);
  return v_removed;
end $$;`);
}
// BENCH_BACKGROUND: other users, so that no table the new statements read is a few rows long. Each has a kept
// institution (a checking and a card) and had another one, removed by current: one payment that was matched to
// the removed card and has one kept competitor, so the removal wrote a record and a hold with their provenance.
p(`create function bench.background(p_first integer, p_users integer) returns void language plpgsql as $$
declare
  v_user uuid;
  v_removed uuid;
  v_kept uuid;
  v_x uuid;
  v_c uuid;
  v_y uuid;
  v_tag text;
begin
  for g in p_first .. p_first + p_users - 1 loop
    v_user := ('bbbbbbbb-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid;
    v_tag := 'bg' || g;
    v_removed := gen_random_uuid();
    v_kept := gen_random_uuid();
    v_x := gen_random_uuid();
    v_c := gen_random_uuid();
    v_y := gen_random_uuid();
    insert into auth.users (id, email) values (v_user, v_tag || '@example.test');
    insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
      (v_removed, v_user, 'bench-removed-' || v_tag, 'placeholder', 'Removed'), (v_kept, v_user, 'bench-kept-' || v_tag, 'placeholder', 'Kept');
    insert into public.accounts (id, item_id, plaid_account_id, name, type) values
      (v_x, v_removed, 'x-' || v_tag, 'Card X', 'credit'), (v_c, v_kept, 'c-' || v_tag, 'Checking C', 'depository'), (v_y, v_kept, 'y-' || v_tag, 'Card Y', 'credit');
    insert into public.transactions ${COLUMNS} values
      (v_c, 'kx-' || v_tag, 1000, date '2024-01-01', ${LEG}), (v_x, 'x-' || v_tag, -1000, date '2024-01-02', ${LEG}),
      (v_y, 'yh-' || v_tag, -1000, date '2024-01-04', ${LEG});
    perform bench.ready(v_user, v_removed);
    perform public.remove_plaid_item_local(v_user, v_removed);
  end loop;
end $$;`);
// The fixture is what the variant describes, before the measured removal.
p(`create function bench.check_fixture(p_user uuid, p_auto_pairs bigint, p_legs bigint, p_unresolved bigint, p_system bigint, p_cleaned bigint) returns void language plpgsql as $$
begin
  perform bench.require((select count(*) from public.card_payment_auto_pairs where user_id = p_user) = p_auto_pairs, 'automatic pairs before the removal');
  perform bench.require((select count(*) from public.card_payment_leg_states where user_id = p_user) = p_legs, 'card legs before the removal');
  perform bench.require((select count(*) from public.card_payment_leg_states where user_id = p_user and state = 'unresolved') = p_unresolved, 'unresolved legs before the removal');
  perform bench.require((select count(*) from public.card_payment_decisions where user_id = p_user and superseded_by is null) = p_system, 'live system rows of earlier removals');
  perform bench.require((select count(*) from public.plaid_item_removals where user_id = p_user and status = 'cleaned') = p_cleaned, 'earlier removals');
  perform bench.require(coalesce((public.get_card_payment_states(p_user)->>'fresh')::boolean, false), 'the user is fresh before the removal');
end $$;`);

const vacuum = 'vacuum (analyze) public.transactions, public.accounts, public.plaid_items, public.card_payment_leg_states, public.card_payment_auto_pairs, public.card_payment_decision_states, public.card_payment_decisions, public.card_payment_eval_versions, public.plaid_item_removals, public.card_payment_removal_generations, public.card_payment_removal_sources;';
let serial = 0;
/** A new user and its fixture for one body; sets psql variables u, item and removal. */
function fixture(n, body) {
  serial += 1;
  const u = `00000000-0000-0000-0000-${String(serial).padStart(12, '0')}`;
  p(`\\set u '${u}'`);
  if (FAMILY === 'payments') {
    p(`select bench.build(:'u'::uuid, ${n}) as item \\gset`);
  } else if (FAMILY === 'cluster') {
    const { q, r, k } = shape(n);
    p(`select bench.build(:'u'::uuid, ${q}, ${r}, ${k}) as item \\gset`);
  } else {
    p(`select bench.base(:'u'::uuid) \\g /dev/null`);
    for (let c = 1; c <= n; c++) {
      p(`select bench.link(:'u'::uuid, ${c}) as item \\gset`);
      p('set role service_role;');
      p(`select ${BODIES[body].prior}(:'u'::uuid, :'item'::uuid) \\g /dev/null`);
      p('reset role;');
    }
    p(`select bench.link(:'u'::uuid, ${n + 1}) as item \\gset`);
  }
  p(`select id as removal from public.plaid_item_removals where item_id = :'item'::uuid \\gset`);
  const b = before(n, body === 'unrecorded' ? 'revision5' : body);
  p(`select bench.check_fixture(:'u'::uuid, ${b.autoPairs}, ${b.legs}, ${b.unresolved}, ${b.system}, ${b.cleaned}) \\g /dev/null`);
  p(vacuum);
}
// plaid_items does not cascade from auth.users: delete the user's items first (accounts and rows cascade).
const cleanup = () => {
  p(`delete from public.plaid_items where user_id = :'u'::uuid;`);
  p(`delete from auth.users where id = :'u'::uuid;`);
  p(vacuum);
};
const clock = (name) => p(`select clock_timestamp() as ${name} \\gset`);
const between = (a, b) => `extract(epoch from :'${b}'::timestamptz - :'${a}'::timestamptz)`;

/** One committed removal by one body, then one evaluation and one read. */
function timed(n, s, body) {
  const { label, fn } = BODIES[body];
  fixture(n, body);
  p('set role service_role;');
  clock('t0');
  p('begin;');
  p(`select pg_advisory_xact_lock(hashtext(:'u'::uuid::text)) \\g /dev/null`);
  clock('tl');
  p(`select ${fn}(:'u'::uuid, :'item'::uuid) \\g /dev/null`);
  p('commit;');
  clock('tc');
  p(`select public.evaluate_card_payments(:'u'::uuid) \\g /dev/null`);
  clock('te');
  p(`select public.get_card_payment_states(:'u'::uuid) \\g /dev/null`);
  clock('tr');
  p('reset role;');
  if (s >= 1) {
    p(`insert into bench.results values ('${label}: removal', ${n}, ${s}, ${between('t0', 'tc')}),`);
    p(`  ('${label}: lock held to commit', ${n}, ${s}, ${between('tl', 'tc')}),`);
    p(`  ('${label}: evaluate after', ${n}, ${s}, ${between('tc', 'te')}),`);
    p(`  ('${label}: read after', ${n}, ${s}, ${between('te', 'tr')});`);
  }
  cleanup();
}

/** current, statement by statement, in one transaction (rolled back). */
function stepsCurrent(n, s) {
  fixture(n, 'current');
  p('begin;');
  p('set local role service_role;');
  clock('t0');
  p(`select public.evaluate_card_payments(:'u'::uuid) as v \\gset`);
  clock('t1');
  p(S.markers);
  p(S.generation);
  clock('s1');
  p(S.table);
  clock('s2');
  p(S.plan_a);
  clock('s3');
  p(S.plan_b);
  clock('s4');
  p(S.plan_c);
  clock('s5');
  p(S.write_a);
  p(S.write_b);
  p(S.write_c);
  clock('s6');
  p(S.provenance);
  clock('t2');
  // The source guard's lookups once more for every provenance row just written, while the rows they read are
  // still there. Not a statement of the function: it separates what each lookup costs inside step 2.7.
  for (const k of [0, 1, 2, 3]) {
    p(`select bench.replay_source_guard(:'removal'::uuid, ${k}) \\g /dev/null`);
    clock(`g${k}`);
  }
  p(`delete from public.plaid_items where id = :'item'::uuid and user_id = :'u'::uuid;`);
  clock('t3');
  p(`select public.try_evaluate_card_payments(:'u'::uuid) \\g /dev/null`);
  clock('t4');
  p('rollback;');
  if (s >= 1) {
    p(`insert into bench.results values ('current guard replay 0: the loop over the provenance rows alone', ${n}, ${s}, ${between('t2', 'g0')}),`);
    p(`  ('current guard replay 1: the decision lookup', ${n}, ${s}, ${between('g0', 'g1')}),`);
    p(`  ('current guard replay 2: the generation and account lookup', ${n}, ${s}, ${between('g1', 'g2')}),`);
    p(`  ('current guard replay 3: the removed transaction lookup', ${n}, ${s}, ${between('g2', 'g3')});`);
    p(`insert into bench.results values ('current step 1: first evaluation', ${n}, ${s}, ${between('t0', 't1')}),`);
    p(`  ('current step 2: preservation, all of it', ${n}, ${s}, ${between('t1', 't2')}),`);
    p(`  ('current step 2.1: markers and generation', ${n}, ${s}, ${between('t1', 's1')}),`);
    p(`  ('current step 2.2: plan table (create, truncate)', ${n}, ${s}, ${between('s1', 's2')}),`);
    p(`  ('current step 2.3: plan (a) user pairs', ${n}, ${s}, ${between('s2', 's3')}),`);
    p(`  ('current step 2.4: plan (b) automatic pairs', ${n}, ${s}, ${between('s3', 's4')}),`);
    p(`  ('current step 2.5: plan (c) ambiguity holds', ${n}, ${s}, ${between('s4', 's5')}),`);
    p(`  ('current step 2.6: decisions (three inserts)', ${n}, ${s}, ${between('s5', 's6')}),`);
    p(`  ('current step 2.7: provenance rows', ${n}, ${s}, ${between('s6', 't2')}),`);
    p(`  ('current step 3: delete (cascade + triggers)', ${n}, ${s}, ${between('g3', 't3')}),`);
    p(`  ('current step 4: final evaluation', ${n}, ${s}, ${between('t3', 't4')});`);
  }
  cleanup();
}

/** revision5, statement by statement, in one transaction (rolled back). */
function stepsRevision5(n, s) {
  fixture(n, 'revision5');
  p('begin;');
  p('set local role service_role;');
  clock('t0');
  p(`select public.evaluate_card_payments(:'u'::uuid) as v \\gset`);
  clock('t1');
  p(R5.a);
  clock('s1');
  p(R5.b);
  clock('s2');
  p(R5.c);
  clock('t2');
  p(`delete from public.plaid_items where id = :'item'::uuid and user_id = :'u'::uuid;`);
  clock('t3');
  p(`select public.try_evaluate_card_payments(:'u'::uuid) \\g /dev/null`);
  clock('t4');
  p('rollback;');
  if (s >= 1) {
    p(`insert into bench.results values ('revision5 step 1: first evaluation', ${n}, ${s}, ${between('t0', 't1')}),`);
    p(`  ('revision5 step 2: preservation, all of it', ${n}, ${s}, ${between('t1', 't2')}),`);
    p(`  ('revision5 step 2a: user-pair statement', ${n}, ${s}, ${between('t1', 's1')}),`);
    p(`  ('revision5 step 2b: automatic-pair statement', ${n}, ${s}, ${between('s1', 's2')}),`);
    p(`  ('revision5 step 2c: ambiguity-hold statement', ${n}, ${s}, ${between('s2', 't2')}),`);
    p(`  ('revision5 step 3: delete (cascade + triggers)', ${n}, ${s}, ${between('t2', 't3')}),`);
    p(`  ('revision5 step 4: final evaluation', ${n}, ${s}, ${between('t3', 't4')});`);
  }
  cleanup();
}

/** What one removal by one body writes, checked against the variant, with its bytes. Not timed. */
function accounting(n, body) {
  const { label, fn } = BODIES[body];
  const a = after(n, body);
  const count = (what, expr) => p(`insert into bench.counts (size, body, what, n) select ${n}, '${label}', '${what}', ${expr};`);
  const SYSTEM = "('pair_counterpart_removed', 'destination_removed_card', 'ambiguity_hold_removed_card', 'ambiguity_hold_removed_cash_account')";
  fixture(n, body);
  p(`create temporary table acct as
  select (select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind = 'pair_counterpart_removed') as pairs,
         (select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind = 'destination_removed_card') as records,
         (select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind like 'ambiguity_hold_%') as holds,
         (select coalesce(sum(pg_column_size(d.*)), 0) from public.card_payment_decisions d where d.user_id = :'u'::uuid) as decision_bytes,
         (select count(*) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid and g.sources_recorded) as generations,
         (select count(*) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid and not g.sources_recorded) as markers,
         (select coalesce(sum(pg_column_size(g.*)), 0) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid) as generation_bytes,
         (select count(*) from public.card_payment_removal_sources s where s.user_id = :'u'::uuid) as sources,
         (select coalesce(sum(pg_column_size(s.*)), 0) from public.card_payment_removal_sources s where s.user_id = :'u'::uuid) as source_bytes,
         0::bigint as decisions_relation, 0::bigint as generations_relation, 0::bigint as sources_relation;`);
  // Packed, so that the growth of each relation is the pages these rows need (heap and indexes).
  p('vacuum full public.card_payment_decisions, public.card_payment_removal_generations, public.card_payment_removal_sources;');
  p(`update acct set decisions_relation = pg_total_relation_size('public.card_payment_decisions'), generations_relation = pg_total_relation_size('public.card_payment_removal_generations'), sources_relation = pg_total_relation_size('public.card_payment_removal_sources');`);
  // The work of the call as the server counted it (pg_stat_statements, the top-level statement with everything
  // it ran): pages and write-ahead log, which do not depend on how busy the machine is.
  const work = (of, statement) => {
    p(`select bench.require((select count(*) from extensions.pg_stat_statements s where s.query like 'select ${statement}(%') = 1, '${label}, size ${n}: one statement of ${statement} was counted') \\g /dev/null`);
    p(`insert into bench.counts (size, body, what, n) select ${n}, '${label}', 'work of ${of}: ' || w.what, w.n from extensions.pg_stat_statements s
  cross join lateral (values ('shared buffers hit', s.shared_blks_hit), ('shared buffers read', s.shared_blks_read), ('shared buffers dirtied', s.shared_blks_dirtied),
                             ('temporary-table buffers hit', s.local_blks_hit), ('WAL records', s.wal_records), ('WAL full-page images', s.wal_fpi), ('WAL bytes', s.wal_bytes::bigint)) w(what, n)
  where s.query like 'select ${statement}(%';`);
  };
  p('select extensions.pg_stat_statements_reset() \\g /dev/null');
  p('set role service_role;');
  p(`select ${fn}(:'u'::uuid, :'item'::uuid) \\g /dev/null`);
  p('reset role;');
  work('the removal', fn);
  count('written: user pairs (pair_counterpart_removed)', `(select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind = 'pair_counterpart_removed') - b.pairs from acct b`);
  count('written: destination records', `(select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind = 'destination_removed_card') - b.records from acct b`);
  count('written: ambiguity holds', `(select count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.kind like 'ambiguity_hold_%') - b.holds from acct b`);
  count('written: generation rows (recorded)', `(select count(*) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid and g.sources_recorded) - b.generations from acct b`);
  count('written: generation rows (markers)', `(select count(*) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid and not g.sources_recorded) - b.markers from acct b`);
  count('written: provenance rows (sources)', `(select count(*) from public.card_payment_removal_sources s where s.user_id = :'u'::uuid) - b.sources from acct b`);
  count('bytes of the decision rows written (sum of pg_column_size)', `(select coalesce(sum(pg_column_size(d.*)), 0) from public.card_payment_decisions d where d.user_id = :'u'::uuid) - b.decision_bytes from acct b`);
  count('bytes of the generation rows written (sum of pg_column_size)', `(select coalesce(sum(pg_column_size(g.*)), 0) from public.card_payment_removal_generations g where g.user_id = :'u'::uuid) - b.generation_bytes from acct b`);
  count('bytes of the provenance rows written (sum of pg_column_size)', `(select coalesce(sum(pg_column_size(s.*)), 0) from public.card_payment_removal_sources s where s.user_id = :'u'::uuid) - b.source_bytes from acct b`);
  count('bytes added to card_payment_decisions (pg_total_relation_size)', `pg_total_relation_size('public.card_payment_decisions') - b.decisions_relation from acct b`);
  count('bytes added to card_payment_removal_generations (pg_total_relation_size)', `pg_total_relation_size('public.card_payment_removal_generations') - b.generations_relation from acct b`);
  count('bytes added to card_payment_removal_sources (pg_total_relation_size)', `pg_total_relation_size('public.card_payment_removal_sources') - b.sources_relation from acct b`);
  for (const [what, want] of [['written: user pairs (pair_counterpart_removed)', 0], ['written: destination records', a.records], ['written: ambiguity holds', a.holds],
    ['written: generation rows (recorded)', a.generations], ['written: generation rows (markers)', a.markers], ['written: provenance rows (sources)', a.sources]]) {
    p(`select bench.require((select c.n from bench.counts c where c.size = ${n} and c.body = '${label}' and c.what = '${what}') = ${want}, '${label}, size ${n}: ${what} is not ${want}') \\g /dev/null`);
  }
  if (a.sources > 0) {
    // WHICH sources: every provenance row of this removal is on a decision of this user that this removal wrote,
    // names the removed card and one of its legs, and says what that leg was to the surviving one.
    const tag = "replace(:'u', '-', '')";
    const account = FAMILY === 'cycles' ? `'x-' || ${tag} || '-c${n + 1}'` : `'x-' || ${tag}`;
    p(`select bench.require((select count(*) = ${a.sources} and count(distinct s.source_plaid_transaction_id) = ${a.sourceTxns}
         and bool_and(d.user_id = :'u'::uuid and d.superseded_by is null and d.kind in ${SYSTEM} and s.user_id = :'u'::uuid
                      and s.source_relation = '${a.relation}' and s.source_resolution = 'row'
                      and s.source_plaid_account_id = ${account} and s.source_plaid_transaction_id like ${account} || '-%'
                      and s.source_account_type = 'credit' and s.source_pending = false and s.source_cents < 0
                      and (d.kind not like 'ambiguity_hold_%' or d.counterpart_date = s.source_date))
       from public.card_payment_removal_sources s join public.card_payment_decisions d on d.id = s.decision_id
       where s.removal_id = :'removal'::uuid),
    '${label}, size ${n}: the provenance rows do not name the removed card, its legs and their relation') \\g /dev/null`);
    p(`select bench.require((select count(*) = 1 and bool_and(g.user_id = :'u'::uuid and g.sources_recorded and g.ordinal = ${a.markers + (body === 'current' && FAMILY === 'cycles' ? n : 0) + 1})
       from public.card_payment_removal_generations g where g.removal_id = :'removal'::uuid),
    '${label}, size ${n}: the generation of the measured removal') \\g /dev/null`);
  }
  if (body !== 'previous') {
    // One evaluation and one read after the removal, counted the same way.
    p('select extensions.pg_stat_statements_reset() \\g /dev/null');
    p('set role service_role;');
    p(`select public.evaluate_card_payments(:'u'::uuid) \\g /dev/null`);
    p(`select public.get_card_payment_states(:'u'::uuid) \\g /dev/null`);
    p('reset role;');
    work('the evaluation after', 'public.evaluate_card_payments');
    work('the read after', 'public.get_card_payment_states');
    count('after: live system rows of the user (decisions a removal wrote)', `count(*) from public.card_payment_decisions d where d.user_id = :'u'::uuid and d.superseded_by is null and d.kind in ${SYSTEM}`);
    count('after: live holds applied by the evaluation', `count(*) from public.card_payment_decision_states where user_id = :'u'::uuid and kind like 'ambiguity_hold_%' and status = 'active'`);
    count('after: card legs evaluated', `count(*) from public.card_payment_leg_states where user_id = :'u'::uuid`);
    count('after: automatic pairs', `count(*) from public.card_payment_auto_pairs where user_id = :'u'::uuid`);
    count('after: payments read untracked / removed_card', `count(*) from public.card_payment_leg_states where user_id = :'u'::uuid and state = 'untracked' and reason = 'removed_card'`);
    count('after: decisions the reader lists', `jsonb_array_length(public.get_card_payment_states(:'u'::uuid)->'decisions')`);
    count('after: bytes of the answer the reader returns (as text)', `octet_length(public.get_card_payment_states(:'u'::uuid)::text)`);
    for (const [what, want] of [['after: live system rows of the user (decisions a removal wrote)', a.system], ['after: live holds applied by the evaluation', a.liveHolds],
      ['after: card legs evaluated', a.legsAfter], ['after: automatic pairs', a.autoPairsAfter], ['after: payments read untracked / removed_card', a.removedCard],
      ['after: decisions the reader lists', a.system]]) {
      p(`select bench.require((select c.n from bench.counts c where c.size = ${n} and c.body = '${label}' and c.what = '${what}') = ${want}, '${label}, size ${n}: ${what} is not ${want}') \\g /dev/null`);
    }
    p(`select bench.require(coalesce((public.get_card_payment_states(:'u'::uuid)->>'fresh')::boolean, false), '${label}, size ${n}: the removal did not end fresh') \\g /dev/null`);
  }
  p('drop table acct;');
  cleanup();
}

/** The plans of current's statements, where each runs (one transaction, rolled back). Not timed. */
function plans(n) {
  // cycles: after earlier removals that ran without provenance, so that the marker statement has rows to write.
  fixture(n, MEASURED.includes('unrecorded') ? 'unrecorded' : 'current');
  p(`insert into bench.counts (size, body, what, n) select ${n}, 'fixture', 'transactions of the user', count(*) from public.transactions t join public.accounts a on a.id = t.account_id join public.plaid_items i on i.id = a.item_id where i.user_id = :'u'::uuid;`);
  p(`insert into bench.counts (size, body, what, n) select ${n}, 'fixture', 'transactions on the removed institution', count(*) from public.transactions t join public.accounts a on a.id = t.account_id where a.item_id = :'item'::uuid;`);
  p(`insert into bench.counts (size, body, what, n) select ${n}, 'fixture', 'card legs of the user (leg states)', count(*) from public.card_payment_leg_states where user_id = :'u'::uuid;`);
  if (PLANS === 'none' || (PLANS === 'largest' && n !== Math.max(...SIZES))) {
    cleanup();
    return;
  }
  const explain = (key) => {
    p(`\\echo plan at size ${n} - ${TITLE[key]}:`);
    p(`explain (analyze, costs off)\n${S[key]}`);
  };
  p('begin;');
  p('set local role service_role;');
  p(`select public.evaluate_card_payments(:'u'::uuid) as v \\gset`);
  explain('markers');
  explain('generation');
  p(S.table);
  explain('plan_a');
  explain('plan_b');
  explain('plan_c');
  p(`\\echo plan at size ${n} - rows planned:`);
  p("select step, kind, source_relation, count(*) as n from pg_temp.rpp_plan group by 1, 2, 3 order by 1, 2, 3;");
  explain('write_a');
  explain('write_b');
  explain('write_c');
  explain('provenance');
  // What the two guard triggers look up for every row (their time is in the Trigger lines above): each lookup
  // as a statement of its own, for one provenance row of this removal.
  p(`select min(s.decision_id::text) as g_decision from public.card_payment_removal_sources s where s.removal_id = :'removal'::uuid and s.source_resolution = 'row' \\gset`);
  p('\\if :{?g_decision}');
  p(`select s.source_resolution as g_resolution, s.source_plaid_account_id as g_account, s.source_plaid_transaction_id as g_txn, s.source_date as g_date, s.source_cents as g_cents from public.card_payment_removal_sources s where s.decision_id = :'g_decision'::uuid \\gset`);
  const guards = [['ledger', 'the generation guard, the ledger row of the removal (once per generation row)'], ['ordinal', 'the generation guard, the last ordinal of the user (once per generation row)'],
    ['decision', 'the source guard, lookup 1: the decision (once per provenance row)'], ['moment', 'the source guard, lookup 2: the generation of this transaction and the account on the item being removed (once per provenance row)'],
    ['row', 'the source guard, lookup 3: the removed transaction on that account (once per provenance row)']];
  for (const [key, title] of guards) {
    p(`\\echo plan at size ${n} - ${title}:`);
    p(`explain (analyze, costs off) ${lookup(key)};`);
  }
  p('\\unset g_decision');
  p('\\endif');
  p('rollback;');
  cleanup();
}

if (BACKGROUND > 0) {
  for (let first = 1; first <= BACKGROUND; first += 250) p(`select bench.background(${first}, ${Math.min(250, BACKGROUND - first + 1)}) \\g /dev/null`);
  p(`select bench.require((select count(*) from public.card_payment_removal_generations where sources_recorded) = ${BACKGROUND} and (select count(*) from public.card_payment_removal_sources) = ${2 * BACKGROUND}, 'the background: one recorded generation and two provenance rows for each of its users') \\g /dev/null`);
  p(`\\echo background: ${BACKGROUND} other users, each with a kept institution and one removal that recorded provenance (rows in the tables before any fixture)`);
  p('select (select count(*) from auth.users) as users, (select count(*) from public.plaid_items) as plaid_items, (select count(*) from public.accounts) as accounts, (select count(*) from public.transactions) as transactions, (select count(*) from public.plaid_item_removals) as plaid_item_removals, (select count(*) from public.card_payment_removal_generations) as generations, (select count(*) from public.card_payment_decisions) as decisions, (select count(*) from public.card_payment_removal_sources) as sources;');
}
for (const n of SIZES) {
  p(`\\echo size ${n} - plans and counts`);
  plans(n);
  for (const body of MEASURED) accounting(n, body);
}
// Every round measures every size and every body once. The sizes are interleaved, so that a drift of the
// machine during the run is not read as an effect of the size; the bodies of one size follow each other
// directly, so that a round compares them under the same conditions.
for (let s = 1 - warmups; s <= samples; s++) {
  p(`select to_char(clock_timestamp() at time zone 'UTC', 'HH24:MI:SS') as started \\gset`);
  p(`\\echo round ${s}${s < 1 ? ' (warm-up)' : ''} started :started UTC`);
  for (const n of SIZES) {
    for (const body of MEASURED) timed(n, s, body);
    if (MEASURED.includes('current')) stepsCurrent(n, s);
    if (MEASURED.includes('revision5')) stepsRevision5(n, s);
  }
}

// Report.
const ms = (expr) => `round(((${expr}) * 1000)::numeric, 1)`;
p('\\echo');
p('\\echo counts (one removal of each size and body, on a fixture of its own; checked against what the variant describes)');
p('select size, body, what, n from bench.counts order by size, case body when \'fixture\' then 0 when \'previous\' then 1 when \'revision5\' then 2 when \'current\' then 3 else 4 end, seq;');
p('\\echo');
p('\\echo timings (milliseconds)');
p(`select size, phase, count(*) as n, ${ms('percentile_cont(0.5) within group (order by seconds)')} as median_ms, ${ms('percentile_cont(0.95) within group (order by seconds)')} as p95_ms, ${ms('min(seconds)')} as min_ms, ${ms('max(seconds)')} as max_ms from bench.results group by size, phase order by size, phase;`);
if (MEASURED.includes('current')) {
  // What the provenance statement costs for each row it writes, and what each lookup of its guard costs when it
  // is run again for that row: the replay's time less the loop's, over the rows.
  p('\\echo');
  p('\\echo the provenance statement (current step 2.7) and the lookups of its guard, per provenance row (medians; microseconds)');
  p(`with m as (select size, phase, percentile_cont(0.5) within group (order by seconds) as med from bench.results where phase = 'current step 2.7: provenance rows' or phase like 'current guard replay %' group by 1, 2), loop as (select size, med from m where phase like 'current guard replay 0:%'), n as (select size, n from bench.counts where body = 'current' and what = 'written: provenance rows (sources)') select m.size, n.n as provenance_rows, m.phase, ${ms('m.med')} as median_ms, round(((case when m.phase like 'current guard replay %' and m.phase not like 'current guard replay 0:%' then m.med - loop.med else m.med end) * 1000000 / nullif(n.n, 0))::numeric, 1) as microseconds_per_row from m join loop using (size) join n using (size) order by m.size, m.phase;`);
}
const added = (title, base, top) => {
  p('\\echo');
  p(`\\echo ${title}`);
  p(`with m as (select size, split_part(phase, ': ', 1) as body, split_part(phase, ': ', 2) as what, percentile_cont(0.5) within group (order by seconds) as med, percentile_cont(0.95) within group (order by seconds) as p95 from bench.results where phase not like '% step %' group by 1, 2, 3) select c.size, c.what, ${ms('o.med')} as ${base}_ms, ${ms('c.med')} as ${top.replace(/[^a-z0-9]/g, '_')}_ms, ${ms('c.med - o.med')} as added_ms, round(((c.med / o.med - 1) * 100)::numeric, 0) as added_pct, ${ms('o.p95')} as ${base}_p95_ms, ${ms('c.p95')} as ${top.replace(/[^a-z0-9]/g, '_')}_p95_ms from m c join m o on o.size = c.size and o.what = c.what and o.body = '${base}' where c.body = '${top}' order by c.size, c.what;`);
};
// The same comparison round by round: the two bodies of one round ran one after the other, so their difference
// is less exposed to a drift of the machine than the difference of two medians. "step N" rows compare the two
// bodies' statement-by-statement transactions.
const paired = (title, base, top) => {
  p('\\echo');
  p(`\\echo ${title}`);
  p(`with r as (select size, sample, seconds, case when phase like '% step %' then split_part(phase, ' step ', 1) else split_part(phase, ': ', 1) end as body, case when phase like '% step %' then 'step ' || split_part(phase, ' step ', 2) else split_part(phase, ': ', 2) end as what from bench.results) select c.size, c.what, count(*) as rounds, ${ms('percentile_cont(0.5) within group (order by c.seconds - o.seconds)')} as median_added_ms, ${ms('min(c.seconds - o.seconds)')} as least_ms, ${ms('max(c.seconds - o.seconds)')} as most_ms, count(*) filter (where c.seconds > o.seconds) as rounds_slower, round((percentile_cont(0.5) within group (order by c.seconds / o.seconds))::numeric, 2) as median_ratio from r c join r o on o.size = c.size and o.sample = c.sample and o.what = c.what and o.body = '${base}' where c.body = '${top}' group by c.size, c.what order by c.size, c.what;`);
};
if (MEASURED.includes('revision5') && MEASURED.includes('current')) {
  added('added by 20261008120000 (median current - median revision5)', 'revision5', 'current');
  paired('added by 20261008120000, round by round (current - revision5 of the same round)', 'revision5', 'current');
}
if (MEASURED.includes('revision5') && MEASURED.includes('unrecorded')) {
  added('added by 20261008120000 when the earlier removals ran without provenance (median - median revision5)', 'revision5', 'current, prior unrecorded');
  paired('the same, round by round', 'revision5', 'current, prior unrecorded');
}
if (MEASURED.includes('previous') && MEASURED.includes('revision5')) added('added by 20261006120000 (median revision5 - median previous)', 'previous', 'revision5');
p('\\echo');
p('\\echo every sample (milliseconds, in the order of the rounds)');
p(`select size, phase, string_agg(round((seconds * 1000)::numeric)::text, ' ' order by sample) as samples_ms from bench.results group by size, phase order by size, phase;`);
process.stdout.write(out.join('\n') + '\n');
