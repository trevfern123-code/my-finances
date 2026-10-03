// Bump-coalescing PERFORMANCE comparison (20261002120000). Synthetic data, disposable database only. Not a
// pass/fail test and not run in CI.
//
//   node perf.cjs [samples] [warmups] > perf.sql     (run.sh does this and runs it in a throwaway container)
//
// run.sh builds the database from every migration BEFORE 20261002120000. This script then:
//   * saves those baseline definitions of card_payment_bump and evaluate_card_payments;
//   * applies the REAL migration file 20261002120000_card_payment_bump_coalescing.sql (embedded verbatim, in
//     one transaction);
//   * saves the definitions it installed.
// Every sample then runs on matched fixtures in one session, interleaved with rotating order:
//   baseline   both functions as the earlier migrations define them;
//   final      both functions as 20261002120000 defines them (C1 coalescing plus the evaluator's marker reset);
//   off        the baseline with the relevant card_payment_bump_* triggers disabled. This is a DIAGNOSTIC LOWER
//              BOUND, never a correctness configuration.
// Before every sample the definitions are switched (create or replace from the saved text), untimed. Each
// switch is verified by checksum and by its security properties.
// Every timed sample is BEGIN … COMMIT, timed with the server clock from just before BEGIN to just after
// COMMIT (one psql session; local round trips are included and identical across modes). Cleanup, fixture
// re-creation and VACUUM are untimed. Each sample records:
//   * the input_version delta;
//   * the version-row updates the transaction made (a delta of pg_stat_xact_user_tables.n_tup_upd, read
//     inside the transaction block).
//
// Cases (committed):
//   insert_batch 5k / 20k           apply_synced_transaction_batch_v2, one user, sync-shaped rows
//   update_batch 5k / 20k           apply_synced_transaction_batch_v2 real amount updates
//   evaluate_only 20k               evaluate_card_payments over a user with 20k rows (the evaluator reset's cost)
//   batch_then_evaluate 5k          a 5k-row insert batch, then try_evaluate_card_payments, in ONE transaction
//   carryover_sweep 1k / 5k         one DELETE of expired carry-overs; re-created untimed after each sample
//   item_delete_cascade 5k / 20k    DELETE of a plaid_items row (6 accounts, N transactions, 50 decisions);
//                                   re-created untimed
//   multi_user_insert 5k            ONE direct INSERT statement spreading 5k rows over 10 users
//   small calls                     each call its own transaction:
//                                     200 × apply_transaction_semantic_roles (1 id),
//                                     100 × link_transaction_to_manual_loan,
//                                     100 × apply_synced_transaction_batch_v2 with one row
//   bump controls 5k / 20k          same user, and 100 users round-robin: N card_payment_bump calls in one transaction
//   bump_one_per_tx_1000_tx         1,000 transactions of one bump each: the fixed per-transaction overhead
// Then, separately (rolled back, instrumented; NOT timings): EXPLAIN (ANALYZE) of the inner multirow INSERT
// under baseline and final, which reports per-trigger time and calls.
// BENCH_CASES=<section,…> limits a run to those sections. Setup, verification and the report always run.
// The rolled-back profile runs only when unfiltered, or when "profile" is named.
//
// SAFETY: truncates auth.users. Refuses to run unless psql is given -v bench_disposable=1 (run.sh does) AND
// auth.users is empty.
const fs = require('fs');
const path = require('path');
const samples = Number(process.argv[2] ?? 6);
const warmups = Number(process.argv[3] ?? 1);
const SIZES = [5000, 20000];
// Checksums of the LF-normalised bodies: the 20260930120000 baseline and the 20261002120000 definitions.
const H = { bump0: '9b67a29937db09a4661f0f906cf80563', eval0: 'c43128295a457d62b83448083eb6f7d2',
            bump1: '3fa11a0ed807dfb54aad20ba576e567c', eval1: 'f620515feaee49b382965cc8b73f02e2' };
const MIGRATION = fs.readFileSync(path.resolve(__dirname, '../../../migrations/20261002120000_card_payment_bump_coalescing.sql'), 'utf8')
  .replace(/\r\n/g, '\n');
const FNS = ['public.card_payment_bump(uuid)', 'public.evaluate_card_payments(uuid, timestamp with time zone)'];
const FN_ARRAY = `array[${FNS.map((f) => `'${f}'`).join(', ')}]`;

const out = [];
const ONLY = (process.env.BENCH_CASES || '').split(',').filter(Boolean);
let on = true;
const section = (name) => { on = name === null || ONLY.length === 0 || ONLY.includes(name); };
const p = (s) => { if (on) out.push(s); };
const uid = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const U1 = uid(0xb001), U2 = uid(0xb002), U3 = uid(0xb003), U4 = uid(0xb004), U5 = uid(0xb005), U6 = uid(0xb006), U7 = uid(0xb007), U8 = uid(0xb008);
const MANY = Array.from({ length: 100 }, (_, i) => uid(0xc000 + i));
const MULTI = MANY.slice(0, 10); // the multi-user statement's owners (items 0x20..0x29)
const ITEM = (n) => `00000000-0000-0000-0000-0000000b${n.toString(16).padStart(2, '0')}a0`;
const ACC = (n, k) => `00000000-0000-0000-0000-0000000b${n.toString(16).padStart(2, '0')}${k.toString(16).padStart(2, '0')}`;
const md5Of = (fn) => `(select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = '${fn}'::regprocedure)`;

// ---- guard + setup -------------------------------------------------------------------------------------
p('\\set ON_ERROR_STOP 1');
p('\\if :{?bench_disposable}');
p('\\else');
p("do $$ begin raise exception 'REFUSING: run only through supabase/tests/card_payment_benchmark/coalescing/run.sh (a throwaway container)'; end $$;");
p('\\endif');
p("do $$ begin if exists (select 1 from auth.users) then raise exception 'REFUSING: auth.users is not empty; this run truncates it and must only run on a fresh throwaway database'; end if; end $$;");
p('set client_min_messages = warning;');
p('create schema bench;');
p('create table bench.results (case_name text, size integer, mode text, sample integer, seconds double precision, iv_delta bigint, version_updates bigint);');
p('create table bench.payload (name text primary key, body jsonb not null);');
p('create table bench.defs (name text, fn text, def text not null, src_md5 text not null, primary key (name, fn));');
p(`do $g$ begin if ${md5Of(FNS[0])} <> '${H.bump0}' or ${md5Of(FNS[1])} <> '${H.eval0}' then raise exception 'the database is not at the pre-20261002120000 baseline'; end if; end $g$;`);
p(`insert into bench.defs select 'baseline', f, pg_get_functiondef(f::regprocedure), md5(replace(p.prosrc, E'\\r', '')) from unnest(${FN_ARRAY}) f join pg_proc p on p.oid = f::regprocedure;`);
p(`\\echo 'applying the real migration file 20261002120000_card_payment_bump_coalescing.sql (one transaction)'`);
p('begin;');
p(MIGRATION);
p('commit;');
p(`insert into bench.defs select 'final', f, pg_get_functiondef(f::regprocedure), md5(replace(p.prosrc, E'\\r', '')) from unnest(${FN_ARRAY}) f join pg_proc p on p.oid = f::regprocedure;`);
p(`do $g$ begin if ${md5Of(FNS[0])} <> '${H.bump1}' or ${md5Of(FNS[1])} <> '${H.eval1}' then raise exception 'the migration did not install the expected definitions'; end if; end $g$;`);
p(`create function bench.use(p_name text) returns void language plpgsql as $u$
declare d record;
begin
  for d in select * from bench.defs where name = p_name loop
    execute d.def;
    if (select md5(replace(prosrc, E'\\r', '')) from pg_proc where oid = d.fn::regprocedure) <> d.src_md5
       or not exists (select 1 from pg_proc where oid = d.fn::regprocedure and not prosecdef and proconfig = array['search_path=""']
                        and has_function_privilege('service_role', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')) then
      raise exception 'definition switch to % (%) not verified', p_name, d.fn;
    end if;
  end loop;
  if (select count(*) from bench.defs where name = p_name) <> 2 then raise exception 'missing definitions for %', p_name; end if;
end $u$;`);
p(`select bench.use('baseline');`);
p(`select name || ': ' || string_agg(split_part(fn, '(', 1) || ' ' || src_md5, ', ' order by fn) from bench.defs group by name order by name;`);
p('truncate auth.users cascade;');
const users = [U1, U2, U3, U4, U5, U6, U7, U8, ...MANY];
p(`insert into auth.users (id, email) select u, 'cb-' || u || '@example.test' from unnest(array[${users.map((u) => `'${u}'::uuid`).join(', ')}]) u;`);
const owners = [[U1, 1], [U2, 2], [U4, 4], [U5, 5], [U6, 6], [U7, 7], [U8, 8], ...MULTI.map((u, i) => [u, 0x20 + i])];
for (const [u, n] of owners) {
  p(`insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('${ITEM(n)}', '${u}', 'cb-item-${n}', 'placeholder');`);
  p(`insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) select ('00000000-0000-0000-0000-0000000b${n.toString(16).padStart(2, '0')}' || lpad(g::text, 2, '0'))::uuid, '${ITEM(n)}', 'cb-${n}-' || g, 'Account ' || g, case when g in (4, 5) then 'credit' else 'depository' end, false from generate_series(1, 6) g;`);
}
p(`insert into public.card_payment_eval_versions (user_id) select u from unnest(array[${users.map((u) => `'${u}'::uuid`).join(', ')}]) u on conflict do nothing;`);

// A sync-shaped insert object: 2% card-payment legs, the rest spending (same generator as bench.cjs and P0).
const rowSql = (n, prefix, g) => `jsonb_build_object('plaid_transaction_id', '${prefix}' || ${g}, 'account_id', ('00000000-0000-0000-0000-0000000b${n.toString(16).padStart(2, '0')}' || lpad((case when ${g} % 50 = 0 then (case when (${g} / 50) % 2 = 0 then 1 else 4 end) else 1 + ${g} % 3 end)::text, 2, '0'))::uuid, 'amount', case when ${g} % 50 = 0 then (case when (${g} / 50) % 2 = 0 then 1 else -1 end) * (100 + (${g} % 7) * 25) else 10 + (${g} % 400) end, 'iso_currency_code', 'USD', 'date', (date '2024-01-01' + (${g} % 900))::text, 'name', 'Synthetic', 'merchant_name', null, 'category', null, 'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', case when ${g} % 50 = 0 then 'credit_card_payment' else 'expense' end, 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1, 'pending_transaction_id', null)`;

const ALL_TRIGGERS = [
  ['transactions', 'card_payment_bump_transactions_ins_del'], ['transactions', 'card_payment_bump_transactions_upd'],
  ['accounts', 'card_payment_bump_accounts_ins_del'], ['accounts', 'card_payment_bump_accounts_upd'],
  ['plaid_items', 'card_payment_bump_plaid_items_del'], ['plaid_items', 'card_payment_bump_plaid_items_upd'],
  ['transaction_carryovers', 'card_payment_bump_carryovers_ins_del'], ['transaction_carryovers', 'card_payment_bump_carryovers_upd'],
  ['card_payment_decisions', 'card_payment_bump_decisions'],
];
const TX_TRIGGERS = ALL_TRIGGERS.filter(([t]) => t === 'transactions');
const CARRY_TRIGGERS = ALL_TRIGGERS.filter(([t]) => t === 'transaction_carryovers');
const setTriggers = (list, enable) => list.map(([t, g]) => `alter table public.${t} ${enable ? 'enable' : 'disable'} trigger ${g};`).join(' ');
// Untimed and committed before each sample. 'off' runs with the baseline definition and the triggers disabled.
const enterMode = (mode, triggers) => {
  p(`select bench.use('${mode === 'final' ? 'final' : 'baseline'}') \\g /dev/null`);
  if (mode === 'off') p(setTriggers(triggers, false));
};
const leaveMode = (mode, triggers) => {
  if (mode === 'off') p(setTriggers(triggers, true));
};
const iv = (u) => `(select input_version from public.card_payment_eval_versions where user_id = '${u}')`;
const ivSum = (us) => `(select sum(input_version) from public.card_payment_eval_versions where user_id = any (array[${us.map((u) => `'${u}'::uuid`).join(', ')}]))`;
// Version-row updates made by THIS transaction, as a delta read inside the transaction block: the backend's
// pending counters also hold earlier transactions' not-yet-flushed counts, and are flushed only while idle
// outside a transaction block, so the in-block delta is exact.
const UPD = `coalesce((select n_tup_upd from pg_stat_xact_user_tables where relid = 'public.card_payment_eval_versions'::regclass), 0)`;
// One committed transaction, timed BEGIN → COMMIT.
const timed = (caseName, size, mode, sample, ivExpr, body) => {
  p(`select extract(epoch from clock_timestamp()) as t0, coalesce(${ivExpr}, 0) as iv0 \\gset`);
  p(`begin;`);
  p(`select ${UPD} as vu0 \\gset`);
  p(body);
  p(`select ${UPD} - :vu0 as vu \\gset`);
  p(`commit;`);
  p(`select extract(epoch from clock_timestamp()) - :t0 as dt, coalesce(${ivExpr}, 0) - :iv0 as ivd \\gset`);
  if (sample > 0) p(`insert into bench.results values ('${caseName}', ${size}, '${mode}', ${sample}, :dt, :ivd, :vu);`);
};
// Many small calls, each its own committed transaction (psql autocommit), timed as a group.
const timedCalls = (caseName, size, mode, sample, ivExpr, calls) => {
  p(`select extract(epoch from clock_timestamp()) as t0, coalesce(${ivExpr}, 0) as iv0 \\gset`);
  for (const c of calls) p(c);
  p(`select extract(epoch from clock_timestamp()) - :t0 as dt, coalesce(${ivExpr}, 0) - :iv0 as ivd \\gset`);
  if (sample > 0) p(`insert into bench.results values ('${caseName}', ${size}, '${mode}', ${sample}, :dt, :ivd, :ivd);`);
};
const vacuumAll = `vacuum public.transactions; vacuum public.card_payment_eval_versions; vacuum public.transaction_carryovers; vacuum public.accounts; vacuum public.plaid_items; vacuum public.card_payment_decisions;`;
const rotate = (modes, s) => modes.map((_, i) => modes[(i + s + modes.length * 4) % modes.length]);
const MODES = ['baseline', 'final', 'off'];
const loop = (fn) => { for (let s = 1 - warmups; s <= samples; s++) for (const mode of rotate(MODES, s)) fn(mode, s); };

section('insert_batch');
// ---- insert batches ------------------------------------------------------------------------------------
p(`select public.apply_synced_transaction_batch_v2('${U1}', (select jsonb_agg(${rowSql(1, 'base1-', 'g')}) from generate_series(1, 1000) g), '[]', '{}') \\g /dev/null`);
for (const n of SIZES) p(`insert into bench.payload values ('ins-${n}', (select jsonb_agg(${rowSql(1, `ins${n}-`, 'g')}) from generate_series(1, ${n}) g));`);
p(vacuumAll);
for (const n of SIZES) {
  loop((mode, s) => {
    enterMode(mode, TX_TRIGGERS);
    timed('insert_batch', n, mode, s, iv(U1), `select public.apply_synced_transaction_batch_v2('${U1}', (select body from bench.payload where name = 'ins-${n}'), '[]', '{}') \\g /dev/null`);
    leaveMode(mode, TX_TRIGGERS);
    p(`delete from public.transactions where plaid_transaction_id like 'ins${n}-%';`);
    p(vacuumAll);
  });
}

section('update_batch');
// ---- update batches ------------------------------------------------------------------------------------
const upd = (u, delta) => `(select jsonb_agg(jsonb_build_object('id', t.id, 'account_id', t.account_id, 'amount', t.amount + ${delta}, 'iso_currency_code', t.iso_currency_code, 'date', t.date, 'name', t.name, 'merchant_name', t.merchant_name, 'category', t.category, 'personal_finance_category_detailed', t.personal_finance_category_detailed, 'personal_finance_category_confidence', t.personal_finance_category_confidence, 'plaid_category', t.plaid_category, 'pending', t.pending, 'auto_role', null, 'role_source', null, 'role_confidence', null, 'classifier_version', null, 'exp_account_id', t.account_id, 'exp_amount', t.amount, 'exp_date', t.date, 'exp_name', t.name, 'exp_merchant_name', t.merchant_name, 'exp_category', t.category, 'exp_pfc_detailed', t.personal_finance_category_detailed, 'exp_pfc_confidence', t.personal_finance_category_confidence, 'exp_manual_loan_id', t.manual_loan_id, 'exp_auto_role', t.auto_role, 'exp_principal_portion', t.principal_portion)) from public.transactions t join public.accounts a on a.id = t.account_id join public.plaid_items i on i.id = a.item_id where i.user_id = '${u}')`;
let have = 0;
let k = 0;
for (const n of SIZES) {
  p(`select public.apply_synced_transaction_batch_v2('${U2}', (select jsonb_agg(${rowSql(2, 'u2-', 'g')}) from generate_series(${have + 1}, ${n}) g), '[]', '{}') \\g /dev/null`);
  have = n;
  p(vacuumAll);
  loop((mode, s) => {
    p(`delete from bench.payload where name = 'upd'; insert into bench.payload values ('upd', ${upd(U2, k++ % 2 === 0 ? '0.01' : '-0.01')});`);
    enterMode(mode, TX_TRIGGERS);
    timed('update_batch', n, mode, s, iv(U2), `select public.apply_synced_transaction_batch_v2('${U2}', '[]', (select body from bench.payload where name = 'upd'), '{}') \\g /dev/null`);
    leaveMode(mode, TX_TRIGGERS);
    p(vacuumAll);
  });
}
// ---- evaluator paths (the marker reset runs at every version capture) --------------------------------------
section('evaluator');
p(`select public.apply_synced_transaction_batch_v2('${U8}', (select jsonb_agg(${rowSql(8, 'ev8-', 'g')}) from generate_series(1, 20000) g), '[]', '{}') \\g /dev/null`);
p(`insert into bench.payload values ('bte-5000', (select jsonb_agg(${rowSql(8, 'bte-', 'g')}) from generate_series(1, 5000) g));`);
p(vacuumAll);
for (let s = 1 - warmups; s <= samples; s++) {
  for (const mode of rotate(['baseline', 'final'], s)) {
    enterMode(mode, []);
    timed('evaluate_only', 20000, mode, s, iv(U8), `select public.evaluate_card_payments('${U8}') \\g /dev/null`);
    p(vacuumAll);
  }
}
loop((mode, s) => {
  enterMode(mode, TX_TRIGGERS);
  timed('batch_then_evaluate', 5000, mode, s, iv(U8), `select public.apply_synced_transaction_batch_v2('${U8}', (select body from bench.payload where name = 'bte-5000'), '[]', '{}') \\g /dev/null\nselect public.try_evaluate_card_payments('${U8}') \\g /dev/null`);
  leaveMode(mode, TX_TRIGGERS);
  p(`delete from public.transactions where plaid_transaction_id like 'bte-%';`);
  p(vacuumAll);
});


section('carryover_sweep');
// ---- carry-over sweep (committed; re-created untimed) ------------------------------------------------------
const makeCarry = (n) => `insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id, pending_amount, pending_date, needs_review, expires_at) select '${U6}', '${ACC(6, 1)}', 'c6-' || g, gen_random_uuid(), 9, date '2025-01-01', false, now() - interval '1 day' from generate_series(1, ${n}) g;`;
for (const n of [1000, 5000]) {
  p(`delete from public.transaction_carryovers where user_id = '${U6}';`);
  p(makeCarry(n));
  p(vacuumAll);
  loop((mode, s) => {
    enterMode(mode, CARRY_TRIGGERS);
    timed('carryover_sweep', n, mode, s, iv(U6), `delete from public.transaction_carryovers where user_id = '${U6}' and consumed_at is null and expires_at < now() and pending_plaid_transaction_id in (select 'c6-' || g from generate_series(1, ${n}) g);`);
    leaveMode(mode, CARRY_TRIGGERS);
    p(makeCarry(n));
    p(vacuumAll);
  });
}
p(`delete from public.transaction_carryovers where user_id = '${U6}';`);

section('item_delete_cascade');
// ---- deletion cascade (committed; re-created untimed) ------------------------------------------------------
const makeItem7 = (n) => [
  `insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('${ITEM(7)}', '${U7}', 'cb-item-7', 'placeholder');`,
  `insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) select ('00000000-0000-0000-0000-0000000b07' || lpad(g::text, 2, '0'))::uuid, '${ITEM(7)}', 'cb-7-' || g, 'Account ' || g, case when g in (4, 5) then 'credit' else 'depository' end, false from generate_series(1, 6) g;`,
  `insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version) select '${ACC(7, 1)}', 'x7-' || g, 10 + g % 50, date '2025-01-01' + g % 300, 'expense', 'sign_default', 'low', 1 from generate_series(1, ${n}) g;`,
  `insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) select '${U7}', 'destination_unlinked', '${ACC(7, 1)}', 'd7-' || g, 1000 from generate_series(1, 50) g;`,
].join('\n');
p(`delete from public.plaid_items where id = '${ITEM(7)}';`);
for (const n of SIZES) {
  p(makeItem7(n));
  p(vacuumAll);
  loop((mode, s) => {
    enterMode(mode, ALL_TRIGGERS);
    timed('item_delete_cascade', n, mode, s, iv(U7), `delete from public.plaid_items where id = '${ITEM(7)}';`);
    leaveMode(mode, ALL_TRIGGERS);
    p(makeItem7(n));
    p(vacuumAll);
  });
  p(`delete from public.plaid_items where id = '${ITEM(7)}';`);
}

section('multi_user_insert_10_users');
// ---- multi-user: one statement spreading 5k rows over 10 users ------------------------------------------------
const multiAcc = `(array[${MULTI.map((_, i) => `'${ACC(0x20 + i, 1)}'::uuid`).join(', ')}])[1 + g % 10]`;
loop((mode, s) => {
  enterMode(mode, TX_TRIGGERS);
  timed('multi_user_insert_10_users', 5000, mode, s, ivSum(MULTI), `insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version) select ${multiAcc}, 'mu-' || g, 10 + g % 50, date '2025-01-01' + g % 300, 'expense', 'sign_default', 'low', 1 from generate_series(1, 5000) g;`);
  leaveMode(mode, TX_TRIGGERS);
  p(`delete from public.transactions where plaid_transaction_id like 'mu-%';`);
  p(vacuumAll);
});

section('small_calls');
// ---- small calls, each its own transaction ----------------------------------------------------------------
p(`insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version) select '${ACC(5, 1)}', 'r5-' || g, 10 + g % 50, date '2025-01-01' + g % 300, 'expense', 'sign_default', 'low', 1 from generate_series(1, 200) g;`);
p(`create temporary table r5ids as select id, plaid_transaction_id from public.transactions where plaid_transaction_id like 'r5-%';`);
p(`create index on r5ids (plaid_transaction_id); analyze r5ids;`);
p(`insert into public.manual_loans (id, user_id, name, current_balance) values ('${uid(0x5a01)}', '${U5}', 'Bench loan', 1000000000);`);
const runs = (samples + warmups) * MODES.length;
p(`insert into public.transactions (account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version) select '${ACC(5, 2)}', 'l5-' || g, 50, date '2025-06-01' + g % 100, 'expense', 'sign_default', 'low', 1 from generate_series(1, ${runs * 100}) g;`);
p(vacuumAll);
let flip = 0;
let nextLoan = 1;
let nextSync = 1;
loop((mode, s) => {
  enterMode(mode, TX_TRIGGERS);
  const role = flip++ % 2 === 0 ? 'income' : 'expense';
  timedCalls('reconcile_200_single_calls', 200, mode, s, iv(U5), Array.from({ length: 200 }, (_, i) =>
    `select public.apply_transaction_semantic_roles('${U5}', array[(select id from r5ids where plaid_transaction_id = 'r5-${i + 1}')], array['sign_default'], '${role}', 'sign_default', 'low', 1::smallint) \\g /dev/null`));
  timedCalls('loan_link_100_single_calls', 100, mode, s, iv(U5), Array.from({ length: 100 }, () =>
    `select public.link_transaction_to_manual_loan('${U5}', (select id from public.transactions where plaid_transaction_id = 'l5-${nextLoan++}'), '${uid(0x5a01)}', 20, 1::smallint) \\g /dev/null`));
  timedCalls('sync_one_row_100_calls', 100, mode, s, iv(U4), Array.from({ length: 100 }, () =>
    `select public.apply_synced_transaction_batch_v2('${U4}', (select jsonb_agg(${rowSql(4, 'sr-', 'g')}) from generate_series(${nextSync}, ${nextSync++}) g), '[]', '{}') \\g /dev/null`));
  leaveMode(mode, TX_TRIGGERS);
  p(vacuumAll);
});
p(`select 'loan links made: ' || count(*) from public.transactions where plaid_transaction_id like 'l5-%' and manual_loan_id is not null;`);

section('bump_controls');
// ---- bump controls: N card_payment_bump calls in one transaction ----------------------------------------------
const many = `array[${MANY.map((u) => `'${u}'::uuid`).join(', ')}]`;
for (const n of SIZES) {
  for (let s = 1 - warmups; s <= samples; s++) {
    for (const mode of rotate(['baseline', 'final'], s)) {
      enterMode(mode, []);
      timed('bump_same_user_one_tx', n, mode, s, iv(U3), `do $d$ begin for i in 1 .. ${n} loop perform public.card_payment_bump('${U3}'); end loop; end $d$;`);
      p(vacuumAll);
      timed('bump_100_users_one_tx', n, mode, s, ivSum(MANY), `do $d$ declare u uuid[] := ${many}; begin for i in 1 .. ${n} loop perform public.card_payment_bump(u[1 + (i % 100)]); end loop; end $d$;`);
      p(vacuumAll);
    }
  }
}

section('bump_one_per_tx_1000_tx');
// ---- per-transaction overhead control: 1,000 transactions of ONE bump each (CALL commits per iteration) ----------
p(`create procedure bench.bump_each(p_user uuid, p_n integer) language plpgsql as $b$ begin for i in 1 .. p_n loop perform public.card_payment_bump(p_user); commit; end loop; end $b$;`);
for (let s = 1 - warmups; s <= samples; s++) {
  for (const mode of rotate(['baseline', 'final'], s)) {
    enterMode(mode, []);
    p(`select extract(epoch from clock_timestamp()) as t0, ${iv(U3)} as iv0 \\gset`);
    p(`call bench.bump_each('${U3}', 1000);`);
    p(`select extract(epoch from clock_timestamp()) - :t0 as dt, ${iv(U3)} - :iv0 as ivd \\gset`);
    if (s > 0) p(`insert into bench.results values ('bump_one_per_tx_1000_tx', 1000, '${mode}', ${s}, :dt, :ivd, :ivd);`);
    p(vacuumAll);
  }
}

section(null);
// ---- verify the run left the database as installed ----------------------------------------------------------
p(`select bench.use('baseline');`);
p(`select 'both functions are the baseline at end: ' || (${md5Of(FNS[0])} = '${H.bump0}' and ${md5Of(FNS[1])} = '${H.eval0}');`);
p(`select 'card_payment_bump_* triggers enabled: ' || count(*) filter (where tgenabled = 'O') || ' of ' || count(*) from pg_trigger where tgname like 'card\\_payment\\_bump\\_%' escape '\\';`);

// ---- report -------------------------------------------------------------------------------------------------
p(`\\echo`);
p(`\\echo '=== timings, committed (ms; n = measured samples; p25/p75 = interquartile; iv_delta and version_updates per sample, min-max)'`);
p(`select case_name, size, mode, count(*) as n, round((percentile_cont(0.5) within group (order by seconds) * 1000)::numeric, 1) as median_ms, round((percentile_cont(0.25) within group (order by seconds) * 1000)::numeric, 1) as p25_ms, round((percentile_cont(0.75) within group (order by seconds) * 1000)::numeric, 1) as p75_ms, round((min(seconds) * 1000)::numeric, 1) as min_ms, round((max(seconds) * 1000)::numeric, 1) as max_ms, min(iv_delta) || '-' || max(iv_delta) as iv_delta, min(version_updates) || '-' || max(version_updates) as version_updates from bench.results group by 1, 2, 3 order by 1, 2, case mode when 'baseline' then 1 when 'final' then 2 else 3 end;`);
p(`\\echo '=== baseline vs final (medians; off = diagnostic lower bound with the triggers disabled)'`);
p(`with m as (select case_name, size, mode, percentile_cont(0.5) within group (order by seconds) as med from bench.results group by 1, 2, 3) select b.case_name, b.size, round((b.med * 1000)::numeric, 1) as baseline_ms, round((c.med * 1000)::numeric, 1) as final_ms, round((o.med * 1000)::numeric, 1) as off_ms, round(((c.med - b.med) * 1000)::numeric, 1) as final_minus_baseline_ms, round((100 * (c.med - b.med) / nullif(b.med, 0))::numeric, 1) as final_vs_baseline_pct, round(((b.med - o.med) * 1000)::numeric, 1) as baseline_added_ms, round(((c.med - o.med) * 1000)::numeric, 1) as final_added_ms from m b join m c on c.case_name = b.case_name and c.size = b.size and c.mode = 'final' left join m o on o.case_name = b.case_name and o.size = b.size and o.mode = 'off' where b.mode = 'baseline' order by 1, 2;`);
p(`\\echo '=== per-sample paired difference final - baseline (same sample index; ms): median, min, max'`);
p(`select b.case_name, b.size, count(*) as pairs, round((percentile_cont(0.5) within group (order by c.seconds - b.seconds) * 1000)::numeric, 1) as median_diff_ms, round((min(c.seconds - b.seconds) * 1000)::numeric, 1) as min_diff_ms, round((max(c.seconds - b.seconds) * 1000)::numeric, 1) as max_diff_ms, count(*) filter (where c.seconds < b.seconds) as final_faster_in from bench.results b join bench.results c on c.case_name = b.case_name and c.size = b.size and c.sample = b.sample and c.mode = 'final' where b.mode = 'baseline' group by 1, 2 order by 1, 2;`);

section('profile');
// ---- profiling (rolled back, instrumented; NOT a timing result) -------------------------------------------------
for (const mode of ['baseline', 'final']) {
  for (const n of SIZES) {
    p(`select bench.use('${mode}') \\g /dev/null`);
    p(`\\echo '--- PROFILE (rolled back): EXPLAIN ANALYZE of the inner multirow INSERT shape, ${n} rows, ${mode}'`);
    p(`begin;`);
    p(`select ${UPD} as pu0 \\gset`);
    p(`explain (analyze, costs off, summary on) insert into public.transactions (plaid_transaction_id, account_id, amount, iso_currency_code, date, name, pending, needs_review, auto_role, role_source, role_confidence, classifier_version) select 'ex${n}-' || g, '${ACC(1, 1)}', 10 + g % 400, 'USD', date '2024-01-01' + g % 900, 'Synthetic', false, false, 'expense', 'sign_default', 'low', 1 from generate_series(1, ${n}) g;`);
    p(`select 'version-row updates in this transaction: ' || (${UPD} - :pu0);`);
    p(`rollback;`);
  }
}
section(null);
p(`select bench.use('baseline');`);
p(`select 'both functions are the baseline after profiling: ' || (${md5Of(FNS[0])} = '${H.bump0}' and ${md5Of(FNS[1])} = '${H.eval0}');`);
process.stdout.write(out.join('\n') + '\n');
