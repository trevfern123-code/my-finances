// Phase B integration slice I1 — the read path against a real local Data API (run by run.sh).
//
// The backend's COMPILED services are loaded with SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY pointing at
// the throwaway local stack, so every read below goes through the real supabase-js service-role client,
// Kong and PostgREST. The truth each result is compared with is computed by direct SQL (psql in the
// database container) — counts and integer cents, never floats.
//
// `fetch` is instrumented before the backend is loaded: every Data API request is recorded (kind,
// status, bytes, milliseconds), and a test can schedule a mutation to COMMIT immediately after a named
// response has been received — the explicit barrier of the scheduled cases.
'use strict';

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = process.env.I1_ROOT;
const HERE = process.env.I1_HERE;
const CONTAINER = process.env.I1_DB_CONTAINER;
const API_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.I1_ANON_KEY;
if (!ROOT || !HERE || !CONTAINER || !API_URL || !SERVICE_KEY || !ANON_KEY) {
  console.error('check.cjs must be started by run.sh');
  process.exit(2);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(API_URL)) {
  console.error('refusing to run: the API URL is not a local address');
  process.exit(2);
}

// ---- Instrumented fetch (installed BEFORE the backend creates its client) -----------------------------
const realFetch = globalThis.fetch;
let requestLog = [];
let barrier = null; // { match, run }
let lastSnapshotBody = '';
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const started = performance.now();
  const response = await realFetch(input, init);
  if (!url.startsWith(`${API_URL}/rest/v1/`)) return response;
  const body = await response.clone().text();
  const rest = url.slice(`${API_URL}/rest/v1/`.length).split('?')[0];
  const kind = rest.startsWith('rpc/') ? `rpc:${rest.slice(4)}` : `table:${rest}`;
  requestLog.push({ kind, status: response.status, bytes: Buffer.byteLength(body), ms: Math.round(performance.now() - started) });
  if (kind === 'rpc:get_financial_read_snapshot') lastSnapshotBody = body;
  if (barrier !== null && kind === barrier.match) {
    const run = barrier.run;
    barrier = null;
    await run(); // the mutation commits after this response exists and before the caller sees it
  }
  return response;
};
/** Runs `fn`, returning its result and the Data API requests it made. */
async function observed(fn) {
  requestLog = [];
  const result = await fn();
  const requests = requestLog;
  requestLog = [];
  return { result, requests };
}
const kinds = (requests) => requests.map((r) => r.kind);
function afterResponse(match, run) {
  barrier = { match, run };
}

// ---- The backend, compiled, with its real client -------------------------------------------------------
const dist = (file) => require(path.join(ROOT, 'backend', 'dist', file));
const dataService = dist('services/dataService.js');
const { readFinancialSnapshot } = dist('services/financialSnapshot.js');
const readPath = dist('services/semanticReadPath.js');
const { supabaseAdmin } = dist('config/supabase.js');
const { AggregateSnapshotUnavailableError, AggregateTooLargeError } = dist('services/fetchAllPages.js');
// A second service-role client for the mutations, on the UNinstrumented fetch.
// (Resolved the way the backend resolves it: the package may be hoisted to the workspace root.)
const { createClient } = require(require.resolve('@supabase/supabase-js', { paths: [path.join(ROOT, 'backend')] }));
const writer = createClient(API_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: realFetch } });

// ---- Direct SQL (the truth) -----------------------------------------------------------------------------
function sql(query, { allowFail = false } = {}) {
  const run = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-At', '-q', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: query,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0 && !allowFail) throw new Error(`psql failed: ${run.stderr.slice(0, 500)}`);
  return run.stdout.trim();
}
const sqlJson = (query) => JSON.parse(sql(query));

const A = '00000000-0000-0000-0000-0000000000aa';
const B = '00000000-0000-0000-0000-0000000000bb';
const C = '00000000-0000-0000-0000-0000000000cc';
const A_CHECKING = '00000000-0000-0000-0000-00000000a001';
const LOAN = '00000000-0000-0000-0000-00000000d001';
const FULL = { start: '2025-09-01', end: '2026-10-01' };
const SEPT = { start: '2026-09-01', end: '2026-10-01' };
const AUG = { start: '2026-08-01', end: '2026-09-01' };
const CATEGORIES = ['00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-00000000ca04'];

const INCLUDED = (user, range) => `
  from public.transactions t
  join public.accounts a on a.id = t.account_id
  join public.plaid_items i on i.id = a.item_id
  where i.user_id = '${user}' and a.exclude_from_cash_flow = false
    and t.date >= '${range.start}' ${range.end ? `and t.date < '${range.end}'` : ''}`;

/** Counts and integer-cent totals of one committed state, straight from SQL. */
function truth(user, range) {
  return sqlJson(`
    select json_build_object(
      'count', count(*),
      'cents', coalesce(sum(round(t.amount * 100)), 0)::bigint,
      'ids_md5', md5(coalesce(string_agg(t.id::text, ',' order by t.date, t.id), '')),
      'spent', coalesce(sum(round(t.amount * 100)) filter (where t.amount >= 0), 0)::bigint,
      'income', coalesce(-sum(round(t.amount * 100)) filter (where t.amount < 0), 0)::bigint,
      'sem_spending', (coalesce(sum(round(t.amount * 100)) filter (where t.effective_role in ('expense', 'refund')
                                                                    and (t.manual_loan_id is null or t.user_role_override is not null)), 0)
                     + coalesce(sum(round((t.amount - t.principal_portion) * 100)) filter (where t.manual_loan_id is not null and t.user_role_override is null), 0))::bigint,
      'sem_income', coalesce(-sum(round(t.amount * 100)) filter (where t.effective_role = 'income'), 0)::bigint,
      'known_principal', coalesce(sum(round(t.principal_portion * 100)) filter (where t.manual_loan_id is not null and t.user_role_override is null), 0)::bigint,
      'months', coalesce(array_agg(distinct to_char(t.date, 'YYYY-MM')), '{}')
    ) ${INCLUDED(user, range)}`);
}
function splitTruth(user, range) {
  return sqlJson(`
    select json_build_object('count', count(*), 'cents', coalesce(sum(round(s.amount * 100)), 0)::bigint,
                             'ids_md5', md5(coalesce(string_agg(s.id::text, ',' order by s.transaction_id, s.id), '')))
    from public.transaction_splits s where s.transaction_id in (select t.id ${INCLUDED(user, range)})`);
}
/** Role-aware spend per budget category (cents), by SQL: splits for split parents, the row otherwise,
 *  a loan payment's interest unassigned. */
function budgetTruth(user, range) {
  return sqlJson(`
    with rows as (select t.* ${INCLUDED(user, range)}),
    spend as (select * from rows where effective_role in ('expense', 'refund') and (manual_loan_id is null or user_role_override is not null)),
    alloc as (
      select s.budget_category_id as cat, round(s.amount * 100) as c from spend r join public.transaction_splits s on s.transaction_id = r.id
      union all
      select r.budget_category_id, round(r.amount * 100) from spend r where not exists (select 1 from public.transaction_splits s where s.transaction_id = r.id)
      union all
      select null, round((r.amount - r.principal_portion) * 100) from rows r where r.manual_loan_id is not null and r.user_role_override is null
    )
    select coalesce(json_object_agg(coalesce(cat::text, 'unassigned'), c), '{}'::json)
    from (select cat, sum(c)::bigint as c from alloc group by cat) x`);
}
const inputVersion = (user) => Number(sql(`select input_version from public.card_payment_eval_versions where user_id = '${user}'`));

// ---- A tiny reporter --------------------------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passes += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (title) => console.log(`\n== ${title}`);
const cents = (dollars) => Math.round(dollars * 100);
const sumCents = (rows) => rows.reduce((sum, row) => sum + cents(row.amount), 0);
const md5 = (text) => require('node:crypto').createHash('md5').update(text).digest('hex');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noWait = { sleep: async () => {} };

async function rpcOk(name, args) {
  const { data, error } = await writer.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.code ?? ''} ${error.message}`);
  return data;
}
const evaluate = (user) => rpcOk('try_evaluate_card_payments', { p_user_id: user });
/** One sync-shaped insert object — the batch RPC's own input format. */
const syncRow = (plaid, amount, date, extra = {}) => ({
  plaid_transaction_id: plaid,
  account_id: A_CHECKING,
  amount,
  iso_currency_code: 'USD',
  date,
  name: 'Synthetic sync row',
  merchant_name: null,
  category: 'GENERAL_MERCHANDISE',
  personal_finance_category_detailed: null,
  personal_finance_category_confidence: null,
  plaid_category: null,
  pending: false,
  needs_review: false,
  budget_category_id: null,
  auto_role: 'expense',
  role_source: 'sign_default',
  role_confidence: 'low',
  classifier_version: 1,
  pending_transaction_id: null,
  ...extra,
});
const syncBatch = (inserts, removed = []) => rpcOk('apply_synced_transaction_batch_v2', { p_user_id: A, p_inserts: inserts, p_updates: [], p_removed_plaid_ids: removed });

const summaryOf = (options = noWait) => readPath.readSummary(A, { range: { start: FULL.start }, currentMonth: SEPT }, options);
const frozenCents = (rows) => ({
  spent: rows.filter((r) => r.amount >= 0).reduce((s, r) => s + cents(r.amount), 0),
  income: rows.filter((r) => r.amount < 0).reduce((s, r) => s - cents(r.amount), 0),
});

async function main() {
  // ============================================================================================
  section('1. Static dataset: the snapshot against direct SQL');
  const full = truth(A, FULL);
  const fullSplits = splitTruth(A, FULL);
  check('the dataset has at least 1 500 transactions for user A across 13 months', full.count >= 1500 && full.months.length === 13, JSON.stringify({ count: full.count, months: full.months.length }));
  check('the dataset has at least 1 001 splits', fullSplits.count >= 1001, String(fullSplits.count));

  const snapshotRequest = { rows: FULL, splits: true, budgetCategories: true, cardStates: { from: FULL.start, to: FULL.end } };
  const first = await observed(() => readFinancialSnapshot(A, snapshotRequest));
  eq('the snapshot is ONE Data API request', kinds(first.requests), ['rpc:get_financial_read_snapshot']);
  check('the snapshot was read', first.result.kind === 'snapshot', JSON.stringify(first.result).slice(0, 200));
  const snap = first.result.snapshot;
  const rawA = lastSnapshotBody;
  eq('transaction count equals SQL', snap.transactions.length, full.count);
  check('transaction count exceeds the Data API row cap (1 000): the snapshot is not capped', snap.transactions.length > 1000);
  eq('Σ transaction cents equals SQL', sumCents(snap.transactions), full.cents);
  eq('the transactions are exactly SQL\'s rows, in (date, id) order', md5(snap.transactions.map((t) => t.id).join(',')), full.ids_md5);
  eq('split count equals SQL', snap.splits.length, fullSplits.count);
  eq('Σ split cents equals SQL', sumCents(snap.splits), fullSplits.cents);
  eq('the splits are exactly SQL\'s rows, in (transaction_id, id) order', md5(snap.splits.map((s) => s.id).join(',')), fullSplits.ids_md5);
  eq('budget categories are user A\'s four, in sort order', snap.budgetCategories.map((c) => c.id), CATEGORIES);
  const second = await readFinancialSnapshot(A, snapshotRequest);
  check('ordering is deterministic: a second read returns byte-identical rows', JSON.stringify(second.snapshot) === JSON.stringify(snap));

  // Ownership and exclusion.
  check('nothing of user B is in user A\'s payload', !rawA.includes('999999.99') && !rawA.includes('OTHER USER SENTINEL') && !rawA.includes('i1-b-'));
  check('nothing on the excluded account is in the payload (rows or splits)', !rawA.includes('777777.77') && !rawA.includes('EXCLUDED SENTINEL') && !rawA.includes('i1-a-excluded'));
  const forB = await readFinancialSnapshot(B, { rows: FULL, splits: true, budgetCategories: true });
  eq('user B\'s snapshot holds exactly user B\'s rows', [forB.snapshot.transactions.length, forB.snapshot.splits.length, forB.snapshot.budgetCategories.length], [5, 1, 1]);
  check('user B\'s snapshot holds none of user A\'s rows', !lastSnapshotBody.includes('i1-a-'));
  const forNobody = await readFinancialSnapshot('00000000-0000-0000-0000-0000000000ee', { rows: FULL });
  eq('an unknown user gets an empty snapshot', forNobody.snapshot.transactions.length, 0);

  // Nested filters: a sub-range, and an open-ended range.
  const sept = truth(A, SEPT);
  const septSnap = await readFinancialSnapshot(A, { rows: SEPT });
  eq('a one-month snapshot: count and cents equal SQL', [septSnap.snapshot.transactions.length, sumCents(septSnap.snapshot.transactions)], [sept.count, sept.cents]);
  const openEnded = truth(A, { start: '2026-06-01' });
  const openSnap = await readFinancialSnapshot(A, { rows: { start: '2026-06-01' } });
  eq('an open-ended snapshot: count and cents equal SQL', [openSnap.snapshot.transactions.length, sumCents(openSnap.snapshot.transactions)], [openEnded.count, openEnded.cents]);

  // Card-payment states inside the snapshot.
  const legCount = Number(sql(`select count(*) from public.card_payment_leg_states where user_id = '${A}' and date >= '${FULL.start}' and date < '${FULL.end}'`));
  check('card states are fresh and are the stored legs', snap.cardPayments.kind === 'fresh' && snap.cardPayments.states.legs.length === legCount && legCount === 3, JSON.stringify({ kind: snap.cardPayments.kind, legCount }));
  eq('the snapshot\'s matching version is the stored input version', snap.cardPayments.inputVersion, inputVersion(A));

  // Privileges through the Data API: a client key cannot call the function.
  for (const [label, key] of [['anon', ANON_KEY]]) {
    const denied = await realFetch(`${API_URL}/rest/v1/rpc/get_financial_read_snapshot`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user_id: A, p_from: FULL.start, p_to: FULL.end }),
    });
    const text = await denied.text();
    check(`the ${label} key cannot call the snapshot function (HTTP ${denied.status})`, denied.status >= 400 && denied.status < 500 && !text.includes('transactionCount'), text.slice(0, 160));
  }

  // ============================================================================================
  section('2. The row cap and the exact-count completeness proof (frozen reads)');
  const capped = await supabaseAdmin
    .from('transactions')
    .select('id, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))', { count: 'exact' })
    .eq('accounts.plaid_items.user_id', A)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', FULL.start)
    .lt('date', FULL.end)
    .order('date', { ascending: true })
    .order('id', { ascending: true });
  eq('a plain Data API read is capped at 1 000 rows', capped.data.length, 1000);
  eq('…and its exact count is the SQL count of the SAME nested filters (owner, included, range)', capped.count, full.count);
  const everything = Number(sql('select count(*) from public.transactions'));
  check('…which is fewer than every transaction in the table (user B and the excluded account exist)', capped.count < everything, `${capped.count} vs ${everything}`);

  const smallLegacy = await observed(() => dataService.getTransactionsSince(A, SEPT.start, SEPT.end));
  eq('a frozen read that fits one response: ONE table request, no snapshot', kinds(smallLegacy.requests), ['table:transactions']);
  eq('…its rows are complete: count, spent and income equal SQL', [smallLegacy.result.length, frozenCents(smallLegacy.result)], [sept.count, { spent: sept.spent, income: sept.income }]);

  const bigLegacy = await observed(() => dataService.getTransactionsSince(A, FULL.start, FULL.end));
  eq('a frozen read beyond one response: one capped request, then ONE snapshot — never pages', kinds(bigLegacy.requests), ['table:transactions', 'rpc:get_financial_read_snapshot']);
  eq('…count, spent and income over 13 months equal SQL', [bigLegacy.result.length, frozenCents(bigLegacy.result)], [full.count, { spent: full.spent, income: full.income }]);

  const bigCategorized = await dataService.getCategorizedTransactionsSince(A, FULL.start, FULL.end);
  eq('getCategorizedTransactionsSince over 13 months: count and cents equal SQL', [bigCategorized.length, sumCents(bigCategorized)], [full.count, full.cents]);

  const smallSpend = await observed(() => dataService.getCategorySpendRows(A, SEPT));
  eq('frozen category spend that fits: two table requests (transactions, splits), no snapshot', kinds(smallSpend.requests), ['table:transactions', 'table:transaction_splits']);
  eq('…it allocates every transaction\'s whole amount exactly once', sumCents(smallSpend.result), sept.cents);
  const bigSpend = await observed(() => dataService.getCategorySpendRows(A, FULL));
  eq('frozen category spend beyond one response: one capped request, then ONE snapshot of both', kinds(bigSpend.requests), ['table:transactions', 'rpc:get_financial_read_snapshot']);
  eq('…it allocates every transaction\'s whole amount exactly once', sumCents(bigSpend.result), full.cents);

  // ============================================================================================
  section('3. The level-2 read path against direct SQL');
  const summary = await observed(() => summaryOf());
  eq('readSummary is ONE Data API request', kinds(summary.requests), ['rpc:get_financial_read_snapshot']);
  check('readSummary is ok', summary.result.status === 'ok', JSON.stringify(summary.result).slice(0, 200));
  const month = summary.result.value.currentMonth;
  eq('September: role-aware spending, income and known principal equal SQL', [cents(month.spending), cents(month.income), cents(month.knownPrincipal)], [sept.sem_spending, sept.sem_income, sept.known_principal]);
  eq('September: the tracked card payment and the unresolved one', [cents(month.creditCardPaymentsTracked), month.cardPaymentsUnresolved.count, cents(month.cardPaymentsUnresolved.paymentsAmount), month.cashFlow], [30000, 1, 8000, null]);
  eq('September: the frozen inputs from the same snapshot equal SQL\'s sign-based totals', frozenCents(summary.result.frozen.currentMonth), { spent: sept.spent, income: sept.income });
  eq('the monthly view has exactly SQL\'s months', summary.result.value.monthly.map((m) => m.month), [...full.months].sort());
  eq('the frozen range rows are complete over 13 months', [summary.result.frozen.range.length, frozenCents(summary.result.frozen.range)], [full.count, { spent: full.spent, income: full.income }]);

  const budget = await observed(() => readPath.readBudget(A, { current: SEPT, recent: AUG }));
  eq('readBudget is ONE Data API request', kinds(budget.requests), ['rpc:get_financial_read_snapshot']);
  const septBudget = budgetTruth(A, SEPT);
  const actualBudget = Object.fromEntries([...budget.result.value.current.byCategory.entries()].map(([k, v]) => [k, cents(v)]));
  if (cents(budget.result.value.current.unassigned) !== 0) actualBudget.unassigned = cents(budget.result.value.current.unassigned);
  const expectedBudget = Object.fromEntries(Object.entries(septBudget).filter(([, v]) => v !== 0 || true));
  eq('September role-aware spend per budget category equals SQL (splits, rows, loan interest)', Object.fromEntries(Object.entries(actualBudget).sort()), Object.fromEntries(Object.entries(expectedBudget).sort()));
  eq('the frozen budget inputs: four categories, and the whole of September allocated once', [budget.result.frozen.categories.length, sumCents(budget.result.frozen.spendRows.current)], [4, sept.cents]);
  // The category rows inside the snapshot are the same rows the frozen list read returns through PostgREST.
  const listed = await dataService.listBudgetCategories(A);
  // Compared field by field, independent of key order: jsonb returns an object's keys in its own order,
  // PostgREST in column order. JSON does not treat that order as significant; the fields and values must match.
  const sortedKeys = (row) => Object.fromEntries(Object.entries(row).sort(([x], [y]) => (x < y ? -1 : 1)));
  eq('the category rows in the snapshot equal the frozen category list, field for field', budget.result.frozen.categories.map(sortedKeys), listed.map(sortedKeys));
  console.log(`NOTE  key order inside a category object: snapshot [${Object.keys(budget.result.frozen.categories[0]).join(', ')}] vs frozen list [${Object.keys(listed[0]).join(', ')}]`);

  // Drill-downs, paged through the real API.
  async function allPages(query) {
    const rows = [];
    let cursor = null;
    let total = null;
    for (let guard = 0; guard < 200; guard++) {
      const page = await readPath.readEffectRows(A, { ...query, cursor }, noWait);
      if (page.status !== 'ok') throw new Error(`effects: ${page.status}`);
      rows.push(...page.value.rows);
      total = page.value.total_amount;
      cursor = page.value.next_cursor;
      if (cursor === null) break;
    }
    return { rows, total };
  }
  const spendingRows = await allPages({ ...SEPT, measure: 'spending', limit: 25 });
  eq('unbucketed spending drill-down: Σ rows over all pages = total = SQL', [spendingRows.rows.reduce((s, r) => s + cents(r.effect_amount), 0), cents(spendingRows.total)], [sept.sem_spending, sept.sem_spending]);
  const groceries = await allPages({ ...SEPT, measure: 'spending', bucket: { kind: 'budget_category', id: CATEGORIES[0] }, limit: 25 });
  eq('a budget-category drill-down: Σ rows = total = SQL', [groceries.rows.reduce((s, r) => s + cents(r.effect_amount), 0), cents(groceries.total)], [septBudget[CATEGORIES[0]], septBudget[CATEGORIES[0]]]);
  const principal = await allPages({ ...SEPT, measure: 'known_principal', limit: 25 });
  eq('the known-principal drill-down equals SQL', cents(principal.total), sept.known_principal);

  // ============================================================================================
  section('4. Scheduled case 1 — a pending row replaced by its posted row around the read');
  await syncBatch([syncRow('i1-pend-1', 100, '2026-09-20', { pending: true })]);
  await evaluate(A);
  const beforeReplace = truth(A, SEPT);
  // Barrier: the sync's replacement COMMITS the moment the snapshot's response exists.
  afterResponse('rpc:get_financial_read_snapshot', async () => {
    await syncBatch([syncRow('i1-post-1', 100, '2026-09-22', { pending_transaction_id: 'i1-pend-1' })]);
    await evaluate(A);
  });
  const during = await observed(() => summaryOf());
  const afterReplace = truth(A, SEPT);
  check('the replacement really happened: same count and cents, different rows', afterReplace.count === beforeReplace.count && afterReplace.cents === beforeReplace.cents && afterReplace.ids_md5 !== beforeReplace.ids_md5,
    JSON.stringify({ before: [beforeReplace.count, beforeReplace.cents], after: [afterReplace.count, afterReplace.cents] }));
  eq('the read made ONE request, so nothing was read after the commit', kinds(during.requests), ['rpc:get_financial_read_snapshot']);
  eq('the response is exactly the committed BEFORE state (spending and sign-based spent)', [cents(during.result.value.currentMonth.spending), frozenCents(during.result.frozen.currentMonth).spent], [beforeReplace.sem_spending, beforeReplace.spent]);
  const later = await summaryOf();
  eq('the next read is exactly the committed AFTER state', [cents(later.value.currentMonth.spending), frozenCents(later.frozen.currentMonth).spent], [afterReplace.sem_spending, afterReplace.spent]);
  check('neither response counts the $100 twice', cents(during.result.value.currentMonth.spending) !== beforeReplace.sem_spending + 10000 && cents(later.value.currentMonth.spending) !== beforeReplace.sem_spending + 10000);

  // The same replacement, held OPEN (uncommitted) by another session while the read runs.
  await syncBatch([syncRow('i1-pend-2', 100, '2026-09-21', { pending: true })]);
  await evaluate(A);
  const beforeOpen = truth(A, SEPT);
  const openWriter = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-X', '-q', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let writerError = '';
  openWriter.stderr.on('data', (chunk) => (writerError += chunk));
  openWriter.stdin.end(`begin;
    select public.apply_synced_transaction_batch_v2('${A}', '${JSON.stringify([syncRow('i1-post-2', 100, '2026-09-23', { pending_transaction_id: 'i1-pend-2' })])}'::jsonb, '[]'::jsonb, '{}'::text[]);
    select pg_sleep(4);
    commit;`);
  const writerDone = new Promise((resolve) => openWriter.on('exit', resolve));
  let sleeping = false;
  for (let i = 0; i < 100 && !sleeping; i++) {
    sleeping = sql(`select count(*) from pg_stat_activity where state = 'active' and query like '%pg_sleep(4)%' and pid <> pg_backend_pid()`) === '1';
    if (!sleeping) await sleep(50);
  }
  check('a writer holds the replacement open (uncommitted)', sleeping, writerError);
  const whileOpen = await summaryOf();
  eq('while it is uncommitted the read sees the BEFORE state', cents(whileOpen.value.currentMonth.spending), beforeOpen.sem_spending);
  const exitCode = await writerDone;
  check('the writer committed', exitCode === 0, writerError);
  await evaluate(A);
  const afterOpen = truth(A, SEPT);
  const afterCommit = await summaryOf();
  eq('after the commit the read sees the AFTER state — the posted row once', [cents(afterCommit.value.currentMonth.spending), afterOpen.count], [afterOpen.sem_spending, beforeOpen.count]);

  // A frozen level-1 read around the same kind of commit: one statement, one state.
  await syncBatch([syncRow('i1-pend-3', 100, '2026-09-24', { pending: true })]);
  const beforeFrozen = truth(A, SEPT);
  afterResponse('table:transactions', async () => {
    await syncBatch([syncRow('i1-post-3', 100, '2026-09-25', { pending_transaction_id: 'i1-pend-3' })]);
  });
  const frozenDuring = await observed(() => dataService.getTransactionsSince(A, SEPT.start, SEPT.end));
  eq('a frozen read around the replacement: ONE request, exactly the BEFORE state', [kinds(frozenDuring.requests), frozenDuring.result.length, frozenCents(frozenDuring.result).spent], [['table:transactions'], beforeFrozen.count, beforeFrozen.spent]);
  await evaluate(A);

  // ============================================================================================
  section('5. Scheduled case 2 — principal-only edits (not watched by the matching version)');
  const L1 = '00000000-0000-4000-8000-000000009001';
  const L2 = '00000000-0000-4000-8000-000000009002';
  const setPrincipal = (id, value) => rpcOk('update_linked_payment_principal', { p_user_id: A, p_transaction_id: id, p_loan_id: LOAN, p_new_principal_portion: value });
  const versionBefore = inputVersion(A);
  const state0 = truth(A, SEPT);
  eq('starting state: both payments carry principal 350', state0.known_principal, 70000);
  afterResponse('rpc:get_financial_read_snapshot', () => setPrincipal(L1, 250));
  const read0 = await observed(() => summaryOf());
  const state1 = truth(A, SEPT);
  afterResponse('rpc:get_financial_read_snapshot', () => setPrincipal(L2, 300));
  const read1 = await summaryOf();
  const state2 = truth(A, SEPT);
  const read2 = await summaryOf();
  const figures = (r) => [cents(r.value.currentMonth.knownPrincipal), cents(r.value.currentMonth.spending)];
  const committed = [state0, state1, state2].map((s) => [s.known_principal, s.sem_spending]);
  eq('the three committed states are principal 700 → 600 → 550', committed.map((c) => c[0]), [70000, 60000, 55000]);
  eq('each response is exactly one committed state, in order (never a mixed principal)', [figures(read0.result), figures(read1), figures(read2)], committed);
  eq('each of those reads was ONE request', kinds(read0.requests), ['rpc:get_financial_read_snapshot']);
  eq('the matching input version never moved: the edits are invisible to it', inputVersion(A), versionBefore);
  check('…and the responses were still `ok` (fresh card states) throughout', [read0.result, read1, read2].every((r) => r.status === 'ok'));

  // ============================================================================================
  section('6. Scheduled case 3 — a watched input changes around the snapshot; later-read observation');
  const LONE = '00000000-0000-4000-8000-000000009103';
  const beforeWatched = truth(A, SEPT);
  const versionAtRead = inputVersion(A);
  // Barrier: a direct write to a matching input (the amount of a card leg) commits right after the
  // snapshot's response exists. It bumps the matching version and evaluates nothing.
  afterResponse('rpc:get_financial_read_snapshot', async () => {
    const { error } = await writer.from('transactions').update({ amount: 85 }).eq('id', LONE);
    if (error) throw new Error(error.message);
  });
  const freshRead = await observed(() => summaryOf());
  check('the write bumped the matching version', inputVersion(A) > versionAtRead, `${versionAtRead} → ${inputVersion(A)}`);
  eq('the read that preceded the commit is `ok` and is exactly the BEFORE state (states and rows from one snapshot)',
    [freshRead.result.status, cents(freshRead.result.value.currentMonth.cardPaymentsUnresolved.paymentsAmount), frozenCents(freshRead.result.frozen.currentMonth).spent],
    ['ok', 8000, beforeWatched.spent]);
  const afterWatched = truth(A, SEPT);
  const staleRead = await observed(() => summaryOf({ sleep: async () => {} }));
  eq('the next read is `updating` (matching_pending) with no role-aware figure', [staleRead.result.status, staleRead.result.reason, 'value' in staleRead.result], ['updating', 'matching_pending', false]);
  eq('…its frozen inputs are the AFTER state', frozenCents(staleRead.result.frozen.currentMonth).spent, afterWatched.spent);
  eq('…it took one snapshot and two version polls — it did not evaluate', kinds(staleRead.requests), ['rpc:get_financial_read_snapshot', 'rpc:get_card_payment_states', 'rpc:get_card_payment_states']);
  const stillStale = await summaryOf();
  eq('reading again does not make it fresh: the read path never evaluates', stillStale.status, 'updating');
  const drillStale = await readPath.readEffectRows(A, { ...SEPT, measure: 'credit_card_payments_tracked', limit: 50 }, noWait);
  eq('a card drill-down is `updating` too, with no rows and no total', [drillStale.status, 'value' in drillStale], ['updating', false]);
  const spendingWhileStale = await readPath.readEffectRows(A, { ...SEPT, measure: 'spending', limit: 5 }, noWait);
  eq('a spending drill-down does not depend on matching and is still served', spendingWhileStale.status, 'ok');
  // A standalone evaluation — no sync — and the next read observes the fresh state.
  check('a standalone evaluation succeeds', (await evaluate(A)) === true);
  const recovered = await summaryOf();
  eq('the next read is `ok` and reflects the new amount, with no Plaid sync', [recovered.status, cents(recovered.value.currentMonth.cardPaymentsUnresolved.paymentsAmount)], ['ok', 8500]);

  // A drill-down continuation across a change: restart required.
  const page1 = await readPath.readEffectRows(A, { ...SEPT, measure: 'spending', limit: 5 }, noWait);
  await syncBatch([syncRow('i1-new-row', 12.34, '2026-09-26')]);
  let restart = null;
  try {
    await readPath.readEffectRows(A, { ...SEPT, measure: 'spending', limit: 5, cursor: page1.value.next_cursor }, noWait);
  } catch (err) {
    restart = err;
  }
  eq('a drill-down continued after an insert is refused: effects_restart_required / snapshot_changed', [restart && restart.code, restart && restart.reason], ['effects_restart_required', 'snapshot_changed']);
  await evaluate(A);

  // ============================================================================================
  section('7. Payload size and time (measurements, not pass/fail thresholds)');
  const timed = [];
  for (let i = 0; i < 5; i++) {
    const run = await observed(() => readFinancialSnapshot(A, snapshotRequest));
    timed.push(run.requests[0]);
  }
  const fullNow = truth(A, FULL);
  console.log(`MEASURE  user A full snapshot (${fullNow.count} transactions, ${fullSplits.count} splits, categories, card states): ` +
    `${timed[0].bytes} bytes; ms per request ${timed.map((t) => t.ms).join(', ')} (median ${median(timed.map((t) => t.ms))})`);
  const serverMs = sql(`explain (analyze, timing off, summary on, format text)
    select public.get_financial_read_snapshot('${A}', '${FULL.start}', '${FULL.end}', true, true, true, '${FULL.start}', '${FULL.end}')`).split('\n').find((l) => l.includes('Execution Time'));
  console.log(`MEASURE  server side, same call: ${serverMs ? serverMs.trim() : 'n/a'}`);
  const legacyTimed = await observed(() => dataService.getTransactionsSince(A, SEPT.start, SEPT.end));
  console.log(`MEASURE  frozen one-month read: ${legacyTimed.requests[0].bytes} bytes, ${legacyTimed.requests[0].ms} ms, ${legacyTimed.requests.length} request`);

  // At the limits: user C with exactly 10 000 transactions and 25 000 splits.
  sql(`
    insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, category, auto_role, role_source, role_confidence, classifier_version)
    select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, '00000000-0000-0000-0000-00000000c001', 'i1-c-' || g,
           10 + (g % 50) + (g % 100) / 100.0, date '2025-09-01' + (g % 395), 'Limit row ' || g, 'GENERAL_MERCHANDISE', 'expense', 'sign_default', 'low', 1
    from generate_series(1, 10000) g;
    insert into public.transaction_splits (transaction_id, budget_category_id, amount, note)
    select ('00000000-0000-4000-9000-' || lpad(((g % 10000) + 1)::text, 12, '0'))::uuid, '00000000-0000-0000-0000-00000000cc01', 0.01, null
    from generate_series(1, 25000) g;`);
  const limitRequest = { rows: FULL, splits: true, budgetCategories: true };
  const atLimit = [];
  let atLimitRead = null;
  for (let i = 0; i < 3; i++) {
    const run = await observed(() => readFinancialSnapshot(C, limitRequest));
    atLimit.push(run.requests[0]);
    atLimitRead = run.result;
  }
  eq('exactly at the limits (10 000 transactions, 25 000 splits) the snapshot is returned in full', [atLimitRead.kind, atLimitRead.snapshot.transactions.length, atLimitRead.snapshot.splits.length], ['snapshot', 10000, 25000]);
  console.log(`MEASURE  at the limits (10 000 transactions + 25 000 splits): ${atLimit[0].bytes} bytes; ms per request ${atLimit.map((t) => t.ms).join(', ')} (median ${median(atLimit.map((t) => t.ms))})`);
  const limitServerMs = sql(`explain (analyze, timing off, summary on, format text)
    select public.get_financial_read_snapshot('${C}', '${FULL.start}', '${FULL.end}', true, true)`).split('\n').find((l) => l.includes('Execution Time'));
  console.log(`MEASURE  server side at the limits: ${limitServerMs ? limitServerMs.trim() : 'n/a'}`);

  const expectTooLarge = async (label) => {
    const run = await observed(() => readFinancialSnapshot(C, limitRequest).then(() => null, (err) => err));
    check(`${label}: the read fails with aggregate_too_large`, run.result instanceof AggregateTooLargeError && run.result.code === 'aggregate_too_large', String(run.result));
    check(`${label}: the response carries counts only — no rows (${run.requests[0].bytes} bytes)`, run.requests[0].bytes < 400 && !lastSnapshotBody.includes('"transactions"'));
  };
  sql(`insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, auto_role, role_source, role_confidence, classifier_version)
       values ('00000000-0000-4000-9000-000000010001', '00000000-0000-0000-0000-00000000c001', 'i1-c-10001', 1, '2026-01-15', 'expense', 'sign_default', 'low', 1)`);
  await expectTooLarge('10 001 transactions');
  sql(`delete from public.transactions where id = '00000000-0000-4000-9000-000000010001';
       insert into public.transaction_splits (transaction_id, budget_category_id, amount) values ('00000000-0000-4000-9000-000000000001', '00000000-0000-0000-0000-00000000cc01', 0.01)`);
  await expectTooLarge('25 001 splits');
  const frozenTooLarge = await dataService.getTransactionsSince(C, FULL.start, FULL.end).then(() => null, (err) => err);
  check('a frozen read over 10 000 rows is complete (the transaction limit is not exceeded without splits)', frozenTooLarge === null, String(frozenTooLarge));

  // ============================================================================================
  section('8. Without the function: level-1 fits-one-response reads work; everything else fails closed');
  sql(require('node:fs').readFileSync(path.join(ROOT, 'supabase', 'rollback', '20261004120000_financial_read_snapshot_rollback.sql'), 'utf8') + `\nnotify pgrst, 'reload schema';`);
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    const probe = await writer.rpc('get_financial_read_snapshot', { p_user_id: A, p_from: SEPT.start });
    gone = probe.error !== null && (probe.error.code === 'PGRST202' || probe.error.code === '42883');
    if (!gone) await sleep(100);
  }
  check('the rollback script removed the function from the Data API', gone);
  const withoutFn = await summaryOf();
  eq('a level-2 read reports `unavailable` / objects_missing — distinct from updating, no figures', [withoutFn.status, withoutFn.reason, 'value' in withoutFn, 'frozen' in withoutFn], ['unavailable', 'objects_missing', false, false]);
  const smallWithout = await observed(() => dataService.getTransactionsSince(A, SEPT.start, SEPT.end));
  const septNow = truth(A, SEPT);
  eq('a level-1 read that fits one response is unaffected', [kinds(smallWithout.requests), smallWithout.result.length, frozenCents(smallWithout.result).spent], [['table:transactions'], septNow.count, septNow.spent]);
  const bigWithout = await dataService.getTransactionsSince(A, FULL.start, FULL.end).then(() => null, (err) => err);
  check('a level-1 read beyond one response FAILS CLOSED (aggregate_snapshot_unavailable) — never truncated', bigWithout instanceof AggregateSnapshotUnavailableError && bigWithout.reason === 'objects_missing', String(bigWithout));
  // The migration applies again on top of the rollback.
  sql(require('node:fs').readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261004120000_financial_read_snapshot.sql'), 'utf8') + `\nnotify pgrst, 'reload schema';`);
  let back = false;
  for (let i = 0; i < 100 && !back; i++) {
    const probe = await writer.rpc('get_financial_read_snapshot', { p_user_id: A, p_from: SEPT.start });
    back = probe.error === null;
    if (!back) await sleep(100);
  }
  check('the migration re-applies after the rollback and the function is served again', back);
  const restored = await summaryOf();
  eq('the read path works again', restored.status, 'ok');

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nERROR  ${err && err.stack ? err.stack : err}`);
  console.log(`\n${passes} passed, ${failures + 1} failed (aborted)`);
  process.exit(1);
});
