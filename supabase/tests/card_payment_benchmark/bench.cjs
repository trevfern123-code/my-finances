// Generates the psql benchmark script for Phase B packet 2b-2a (synthetic data, disposable database only).
//
//   node bench.cjs [samples] [warmups] > bench.sql
//
// Measures, on matched fixtures:
//   A. apply_synced_transaction_batch_v2 inserting N rows (N = 1k / 5k / 10k / 20k) into a user with a
//      fixed 1k-row history;
//   B. the same RPC updating N existing rows' amounts (a real matching input) for a user with N rows;
//   C. a full-user evaluate_card_payments at N rows;
//   D. link_card_payment / dismiss_card_payment_candidate latency with 10 / 100 / 1000 live decisions,
//      against a full-user evaluation of the same user.
// A and B run each sample twice, with the two transactions-table matching-invalidation triggers enabled
// ("on") and disabled ("off"), alternating which goes first. Every sample is its own committed
// transaction (B) or committed-then-cleaned-up transaction (A); D's RPC samples are rolled back so each
// starts from the same state (commit excluded there). Timing is server clock_timestamp() taken just
// before BEGIN and just after COMMIT/ROLLBACK. It includes the commit and the local round trips of the
// BEGIN / SET LOCAL ROLE / body / COMMIT statements (about four, identical in both modes), so the added
// milliseconds are the more reliable figure and the percentage is slightly understated.
// Cleanup and a VACUUM of the two affected tables run untimed between samples, so dead row versions from
// one sample never slow the next. An even sample count balances which mode runs first.
// Only the two card_payment_bump_transactions_* triggers are ever disabled, and only in this throwaway
// database; no other trigger or safeguard is touched. Trigger-disabled results are never correctness
// evidence.
//
// SAFETY: the generated script truncates auth.users. It refuses to run unless psql is given
// -v bench_disposable=1 (run.sh does) AND auth.users is empty (a fresh throwaway database).
const samples = Number(process.argv[2] ?? 6);
const warmups = Number(process.argv[3] ?? 1);
const SIZES = [1000, 5000, 10000, 20000];
const DECISIONS = [10, 100, 1000];
const U1 = '00000000-0000-0000-0000-00000000b001';
const U2 = '00000000-0000-0000-0000-00000000b002';
const U3 = '00000000-0000-0000-0000-00000000b003';
const out = [];
const p = (s) => out.push(s);

p('\\set ON_ERROR_STOP 1');
p('\\if :{?bench_disposable}');
p('\\else');
p("do $$ begin raise exception 'REFUSING: run only through supabase/tests/card_payment_benchmark/run.sh (a throwaway container)'; end $$;");
p('\\endif');
p("do $$ begin if exists (select 1 from auth.users) then raise exception 'REFUSING: auth.users is not empty; this benchmark truncates it and must only run on a fresh throwaway database'; end if; end $$;");
p('set client_min_messages = warning;');
p('create schema bench;');
p('grant usage on schema bench to service_role; alter default privileges in schema bench grant select on tables to service_role;');
p('create table bench.results (phase text, size integer, mode text, sample integer, seconds double precision);');
p(`truncate auth.users cascade;`);
p(`insert into auth.users (id, email) values ('${U1}', 'b1@example.test'), ('${U2}', 'b2@example.test'), ('${U3}', 'b3@example.test');`);
for (const [u, n] of [[U1, 1], [U2, 2], [U3, 3]]) {
  p(`insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ('00000000-0000-0000-0000-0000000b${n}0a0', '${u}', 'bench-item-${n}', 'placeholder');`);
  p(`insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) select ('00000000-0000-0000-0000-0000000b${n}' || lpad(g::text, 3, '0'))::uuid, '00000000-0000-0000-0000-0000000b${n}0a0', 'bench-${n}-' || g, 'Account ' || g, case when g in (4, 5) then 'credit' else 'depository' end, false from generate_series(1, 6) g;`);
}
// A sync-shaped insert object; 2% card-payment legs (alternating cash / card side), the rest spending.
const rowSql = (n, prefix, g) => `jsonb_build_object('plaid_transaction_id', '${prefix}' || ${g}, 'account_id', ('00000000-0000-0000-0000-0000000b${n}' || lpad((case when ${g} % 50 = 0 then (case when (${g} / 50) % 2 = 0 then 1 else 4 end) else 1 + ${g} % 3 end)::text, 3, '0'))::uuid, 'amount', case when ${g} % 50 = 0 then (case when (${g} / 50) % 2 = 0 then 1 else -1 end) * (100 + (${g} % 7) * 25) else 10 + (${g} % 400) end, 'iso_currency_code', 'USD', 'date', (date '2024-01-01' + (${g} % 900))::text, 'name', 'Synthetic', 'merchant_name', null, 'category', null, 'personal_finance_category_detailed', null, 'personal_finance_category_confidence', null, 'plaid_category', null, 'pending', false, 'needs_review', false, 'budget_category_id', null, 'auto_role', case when ${g} % 50 = 0 then 'credit_card_payment' else 'expense' end, 'role_source', 'sign_default', 'role_confidence', 'low', 'classifier_version', 1, 'pending_transaction_id', null)`;
p(`create table bench.payload (name text primary key, body jsonb not null);`);
p(`set role service_role;`);
p(`select public.apply_synced_transaction_batch_v2('${U1}', (select jsonb_agg(${rowSql(1, 'base1-', 'g')}) from generate_series(1, 1000) g), '[]', '{}') \\g /dev/null`);
p(`reset role;`);
for (const n of SIZES) {
  p(`insert into bench.payload values ('ins-${n}', (select jsonb_agg(${rowSql(1, `ins${n}-`, 'g')}) from generate_series(1, ${n}) g));`);
}

const triggers = ['card_payment_bump_transactions_ins_del', 'card_payment_bump_transactions_upd'];
const setTriggers = (mode) => triggers.map((t) => `alter table public.transactions ${mode === 'off' ? 'disable' : 'enable'} trigger ${t};`).join(' ');
const timed = (phase, size, mode, sample, body, endWith = 'commit') => {
  p(setTriggers(mode));
  p(`select extract(epoch from clock_timestamp()) as t0 \\gset`);
  p(`begin;`);
  p(`set local role service_role;`);
  p(body);
  p(`${endWith};`);
  p(`select extract(epoch from clock_timestamp()) - :t0 as dt \\gset`);
  if (sample > 0) p(`insert into bench.results values ('${phase}', ${size}, '${mode}', ${sample}, :dt);`);
};

// A. inserts
for (const n of SIZES) {
  for (let s = 1 - warmups; s <= samples; s++) {
    const order = s % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
    for (const mode of order) {
      timed('insert', n, mode, s, `select public.apply_synced_transaction_batch_v2('${U1}', (select body from bench.payload where name = 'ins-${n}'), '[]', '{}') \\g /dev/null`);
      p(`delete from public.transactions where plaid_transaction_id like 'ins${n}-%';`); // cleanup (untimed)
      p(`vacuum public.transactions; vacuum public.card_payment_eval_versions;`); // untimed
    }
  }
}
p(setTriggers('on'));

// B + C. updates of N rows (amount changes) and full-user evaluation at N rows (user U2 grows to each size)
let have = 0;
for (const n of SIZES) {
  p(`set role service_role;`);
  p(`select public.apply_synced_transaction_batch_v2('${U2}', (select jsonb_agg(${rowSql(2, 'u2-', 'g')}) from generate_series(${have + 1}, ${n}) g), '[]', '{}') \\g /dev/null`);
  p(`reset role;`);
  have = n;
  // Update payload from the CURRENT rows (the RPC's compare-and-swap needs the exact current values):
  // every row's amount moves by one cent, alternating direction between samples.
  const upd = (delta) => `(select jsonb_agg(jsonb_build_object('id', t.id, 'account_id', t.account_id, 'amount', t.amount + ${delta}, 'iso_currency_code', t.iso_currency_code, 'date', t.date, 'name', t.name, 'merchant_name', t.merchant_name, 'category', t.category, 'personal_finance_category_detailed', t.personal_finance_category_detailed, 'personal_finance_category_confidence', t.personal_finance_category_confidence, 'plaid_category', t.plaid_category, 'pending', t.pending, 'auto_role', null, 'role_source', null, 'role_confidence', null, 'classifier_version', null, 'exp_account_id', t.account_id, 'exp_amount', t.amount, 'exp_date', t.date, 'exp_name', t.name, 'exp_merchant_name', t.merchant_name, 'exp_category', t.category, 'exp_pfc_detailed', t.personal_finance_category_detailed, 'exp_pfc_confidence', t.personal_finance_category_confidence, 'exp_manual_loan_id', t.manual_loan_id, 'exp_auto_role', t.auto_role, 'exp_principal_portion', t.principal_portion)) from public.transactions t join public.accounts a on a.id = t.account_id join public.plaid_items i on i.id = a.item_id where i.user_id = '${U2}')`;
  let k = 0;
  for (let s = 1 - warmups; s <= samples; s++) {
    const order = s % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
    for (const mode of order) {
      const delta = k++ % 2 === 0 ? '0.01' : '-0.01';
      p(`delete from bench.payload where name = 'upd'; insert into bench.payload values ('upd', ${upd(delta)});`);
      timed('update', n, mode, s, `select public.apply_synced_transaction_batch_v2('${U2}', '[]', (select body from bench.payload where name = 'upd'), '{}') \\g /dev/null`);
      p(`vacuum public.transactions; vacuum public.card_payment_eval_versions;`); // untimed
    }
  }
  p(setTriggers('on'));
  for (let s = 1 - warmups; s <= samples; s++) {
    timed('evaluate', n, 'on', s, `select public.evaluate_card_payments('${U2}') \\g /dev/null`);
  }
}

// D. decision RPCs with D live decisions. U3: 2k ordinary rows, 40 cash legs (+) and 40 card legs (-) of
// distinct amounts and dates far apart (no automatic pairs), and two target legs for the measured calls.
p(`set role service_role;`);
p(`select public.apply_synced_transaction_batch_v2('${U3}', (select jsonb_agg(${rowSql(3, 'u3-', 'g')}) from generate_series(1, 2000) g), '[]', '{}') \\g /dev/null`);
p(`reset role;`);
p(`insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) select '00000000-0000-0000-0000-0000000b3001', 'd-cash-' || g, 1000 + g, date '2020-01-01' + g * 20, 'credit_card_payment' from generate_series(1, 40) g;`);
p(`insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) select '00000000-0000-0000-0000-0000000b3004', 'd-card-' || g, -(2000 + g), date '2020-01-11' + g * 20, 'credit_card_payment' from generate_series(1, 40) g;`);
p(`insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values ('00000000-0000-0000-0000-0000000b3001', 'd-target-cash', 777, '2019-01-01', 'credit_card_payment'), ('00000000-0000-0000-0000-0000000b3005', 'd-target-card', -777, '2019-02-01', 'credit_card_payment');`);
let haveD = 0;
for (const d of DECISIONS) {
  // Live dismissals on distinct (cash, card) edges — they accumulate and are never purged today.
  p(`insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents) select '${U3}', 'not_this_pair', c.account_id, c.plaid_transaction_id, (c.amount * 100)::bigint, k.account_id, k.plaid_transaction_id, (k.amount * 100)::bigint from (select row_number() over (order by c.plaid_transaction_id, k.plaid_transaction_id) as r, c.id as cid, k.id as kid from public.transactions c, public.transactions k where c.plaid_transaction_id like 'd-cash-%' and k.plaid_transaction_id like 'd-card-%') e join public.transactions c on c.id = e.cid join public.transactions k on k.id = e.kid where e.r > ${haveD} and e.r <= ${d};`);
  haveD = d;
  p(`select public.evaluate_card_payments('${U3}') \\g /dev/null`);
  const v = `(select evaluated_version from public.card_payment_eval_versions where user_id = '${U3}')`;
  const t = (plaid) => `(select id from public.transactions where plaid_transaction_id = '${plaid}')`;
  for (let s = 1 - warmups; s <= samples; s++) {
    timed('rpc_evaluate_only', d, 'on', s, `select public.evaluate_card_payments('${U3}') \\g /dev/null`, 'rollback');
    timed('rpc_link', d, 'on', s, `select public.link_card_payment('${U3}', ${t('d-target-cash')}, ${t('d-target-card')}, 0, ${v}) \\g /dev/null`, 'rollback');
    timed('rpc_dismiss', d, 'on', s, `select public.dismiss_card_payment_candidate('${U3}', ${t('d-target-cash')}, ${t('d-target-card')}, ${v}) \\g /dev/null`, 'rollback');
  }
  p(`select 'live decisions: ' || count(*) from public.card_payment_decisions where user_id = '${U3}' and superseded_by is null;`);
}

// Report.
p(`\\echo`);
p(`select phase, size, mode, count(*) as n, round((percentile_cont(0.5) within group (order by seconds) * 1000)::numeric, 1) as median_ms, round((min(seconds) * 1000)::numeric, 1) as min_ms, round((max(seconds) * 1000)::numeric, 1) as max_ms from bench.results group by 1, 2, 3 order by case phase when 'insert' then 1 when 'update' then 2 when 'evaluate' then 3 else 4 end, phase, size, mode;`);
p(`with m as (select phase, size, mode, percentile_cont(0.5) within group (order by seconds) as med from bench.results where phase in ('insert', 'update') group by 1, 2, 3) select a.phase, a.size, round((a.med * 1000)::numeric, 1) as on_ms, round((b.med * 1000)::numeric, 1) as off_ms, round(((a.med - b.med) * 1000)::numeric, 1) as added_ms, round((100 * (a.med - b.med) / b.med)::numeric, 1) as overhead_pct from m a join m b on b.phase = a.phase and b.size = a.size and b.mode = 'off' where a.mode = 'on' order by a.phase, a.size;`);
process.stdout.write(out.join('\n') + '\n');
