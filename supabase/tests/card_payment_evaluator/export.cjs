// Builds the oracle-equivalence fixtures: the Stage 2 generated histories (the same generator the
// adversarial vitest suite uses), converted to database rows, plus the TypeScript reference
// evaluator's output for each user — the expected result the SQL evaluator must reproduce exactly.
//
//   node export.cjs <compiled-dir> <out-dir>
//
// <compiled-dir> holds backend/src compiled by tsc (run.sh does this): testUtils/cardPaymentHistories.js
// and services/cardPaymentMatching.js. Writes <out-dir>/seed.sql and <out-dir>/expected.json.
//
// Only DATABASE-VALID histories are exported. The migration's ownership trigger refuses a decision
// naming another user's account, so the generator's deliberately foreign decisions are dropped here
// (their rejection is covered by the access-control test a09 instead). Everything else is kept.
const fs = require('node:fs');
const path = require('node:path');

const [compiled, out] = process.argv.slice(2);
const { generate, acct, tx, ref, mkDecision, U } = require(path.join(compiled, 'testUtils', 'cardPaymentHistories.js'));
const { evaluateCardPayments } = require(path.join(compiled, 'services', 'cardPaymentMatching.js'));

const SEEDS = Array.from({ length: 300 }, (_, i) => 1000 + i);
const AS_OF = '2026-11-15T00:00:00Z';
const USERS = { 'user-a': '00000000-0000-4000-8000-0000000000aa', 'user-b': '00000000-0000-4000-8000-0000000000bb' };
const ITEMS = { 'user-a': '00000000-0000-4000-8000-00000000a001', 'user-b': '00000000-0000-4000-8000-00000000b001' };
const UNDONE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const money = (cents) => (cents / 100).toFixed(2);

function uuidFactory() {
  // Lowercase canonical uuids from a counter: both evaluators order ids as these strings.
  let n = 0;
  const map = new Map();
  return (key) => {
    if (!map.has(key)) map.set(key, `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`);
    return map.get(key);
  };
}

const sql = ['\\set ON_ERROR_STOP 1', "set client_min_messages = warning;"];
const expected = {};

// One history → database rows + the oracle's expected output, keyed by `seed` (a number for generated
// histories, a name for the hand-built scenarios below).
function emit(seed, input) {
  const accountId = uuidFactory();
  const txnId = uuidFactory();
  const decisionId = uuidFactory();
  const ownerOf = new Map(input.accounts.map((a) => [a.id, a.userId]));

  const accounts = input.accounts.map((a) => ({ ...a, id: accountId(a.id), userId: USERS[a.userId] }));
  const transactions = input.transactions.map((t) => ({ ...t, id: txnId(t.id), accountId: accountId(t.accountId) }));
  const decisions = input.decisions
    .filter((d) => [d.a, d.b].filter(Boolean).every((r) => ownerOf.get(r.accountId) === d.userId))
    .map((d) => ({
      ...d,
      id: decisionId(d.id),
      userId: USERS[d.userId],
      a: { ...d.a, accountId: accountId(d.a.accountId) },
      b: d.b ? { ...d.b, accountId: accountId(d.b.accountId) } : null,
      supersededBy: d.supersededBy === null ? null : UNDONE,
    }));
  const carryovers = input.carryovers.map((c) => ({ ...c, accountId: accountId(c.accountId) }));
  const dbInput = { asOf: AS_OF, accounts, transactions, carryovers, decisions };

  // Expected: the TypeScript reference evaluator on exactly the rows inserted below.
  expected[seed] = {};
  for (const user of Object.values(USERS)) {
    const ev = evaluateCardPayments({ ...dbInput, userId: user });
    expected[seed][user] = { legs: ev.legs, decisions: ev.decisions, supersededTransactionIds: ev.supersededTransactionIds };
  }

  // Database rows.
  sql.push(`-- seed ${seed}`);
  sql.push('reset role;');
  sql.push('truncate auth.users cascade;');
  sql.push(`insert into auth.users (id, email) values (${q(USERS['user-a'])}, 'a@example.test'), (${q(USERS['user-b'])}, 'b@example.test');`);
  sql.push(
    `insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values ` +
      Object.keys(USERS).map((u) => `(${q(ITEMS[u])}, ${q(USERS[u])}, ${q(`item-${seed}-${u}`)}, 'placeholder')`).join(', ') +
      ';'
  );
  const userKeyOf = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [v, k]));
  sql.push(
    `insert into public.accounts (id, item_id, plaid_account_id, name, type, exclude_from_cash_flow) values ` +
      accounts
        .map((a) => `(${q(a.id)}, ${q(ITEMS[userKeyOf[a.userId]])}, ${q(`acct-${seed}-${a.id}`)}, 'Account', ${q(a.type)}, ${a.excludeFromCashFlow})`)
        .join(', ') +
      ';'
  );
  if (transactions.length > 0) {
    sql.push(
      `insert into public.transactions (id, account_id, plaid_transaction_id, pending_transaction_id, pending, date, amount, user_role_override) values ` +
        transactions
          .map((t) => `(${q(t.id)}, ${q(t.accountId)}, ${q(t.plaidTransactionId)}, ${q(t.pendingTransactionId)}, ${t.pending}, ${q(t.date)}, ${money(t.amountCents)}, ${q(t.effectiveRole)})`)
          .join(', ') +
        ';'
    );
  }
  for (const c of carryovers) {
    const owner = accounts.find((a) => a.id === c.accountId).userId;
    const pendingRow = transactions.find((t) => t.accountId === c.accountId && t.plaidTransactionId === c.pendingPlaidTransactionId);
    const posted = transactions.find((t) => t.accountId === c.accountId && t.pendingTransactionId === c.pendingPlaidTransactionId);
    const amount = (pendingRow ?? posted ?? { amountCents: 0 }).amountCents;
    const date = (pendingRow ?? posted ?? { date: '2026-09-28' }).date;
    if (c.consumed && !posted) throw new Error(`${seed}: consumed carry-over without a posted row`);
    sql.push(
      `insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id, pending_amount, pending_date, needs_review, expires_at, consumed_at, consumed_by_transaction_id) values ` +
        `(${q(owner)}, ${q(c.accountId)}, ${q(c.pendingPlaidTransactionId)}, gen_random_uuid(), ${money(amount)}, ${q(date)}, false, ${q(c.expiresAt)}, ` +
        `${c.consumed ? `'2026-10-01T00:00:00Z'` : 'null'}, ${c.consumed ? q(posted.id) : 'null'});`
    );
  }
  for (const d of decisions) {
    sql.push(
      `insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, accepted_difference_cents, decided_seq, superseded_by) values ` +
        `(${q(d.id)}, ${q(d.userId)}, ${q(d.kind)}, ${q(d.a.accountId)}, ${q(d.a.plaidTransactionId)}, ${d.a.cents}, ` +
        `${q(d.b?.accountId ?? null)}, ${q(d.b?.plaidTransactionId ?? null)}, ${d.b ? d.b.cents : 'null'}, ` +
        `${d.acceptedDifferenceCents === null ? 'null' : d.acceptedDifferenceCents}, ${d.decidedSeq}, ${q(d.supersededBy)});`
    );
  }
  // Evaluate each user as the backend would (service_role), then read through the state reader.
  sql.push('set role service_role;');
  for (const user of Object.values(USERS)) {
    sql.push(`select 'EVAL|' || public.evaluate_card_payments(${q(user)}, ${q(AS_OF)});`);
    sql.push(`select 'R|${seed}|${user}|' || public.get_card_payment_states(${q(user)})::text;`);
  }
}

for (const seed of SEEDS) emit(seed, generate(seed).input);

// Hand-built, database-valid scenarios for rule paths the generated histories do not reach (measured:
// matched_leg_not_posted, partner_gone and return-of-pair suggestions never occur there), plus the
// approved-rule cases of CARD_PAYMENT_PAIRING_DESIGN.md. Expected values still come from the oracle.
const baseAccounts = () => [
  acct('C', 'depository'), acct('C2', 'depository'), acct('X', 'credit'), acct('Y', 'credit'),
  acct('E', 'credit', true), acct('F', 'depository', true), acct('N', null),
];
const noIncludedCard = () => [acct('C', 'depository'), acct('C2', 'depository'), acct('E', 'credit', true), acct('F', 'depository', true)];
const waiting = (accountId, plaid, expiresAt = '2026-12-31T00:00:00Z') => ({ accountId, pendingPlaidTransactionId: plaid, expiresAt, consumed: false });
const pairOnPending = () => mkDecision('d', 'pair', ref('C', 'pc', 10000), ref('X', 'pk', -10000));
const Tc = (cents = 10000) => tx('Tc', 'C', '2026-09-02', cents, { plaid: 'tc', pendingOf: 'pc' });
const feePair = (cash, card, accepted, accounts = baseAccounts()) => ({
  accounts,
  transactions: [tx('c', cash[0], '2026-09-01', cash[1]), tx('k', card[0], '2026-09-02', card[1])],
  decisions: [mkDecision('d', 'pair', ref(cash[0], 'p-c', cash[1]), ref(card[0], 'p-k', card[1]), accepted)],
});
const SCENARIOS = {
  'S01-return-of-pair': { transactions: [tx('p', 'C', '2026-09-01', 10000), tx('k', 'X', '2026-09-02', -10000), tx('rev', 'X', '2026-09-10', 10000), tx('ret', 'C', '2026-09-20', -10000)] },
  'S02-return-of-pair-60-days-older-original': { transactions: [tx('p', 'C', '2026-06-01', 10000), tx('k', 'X', '2026-06-02', -10000), tx('rev', 'X', '2026-09-10', 10000), tx('ret', 'C', '2026-11-09', -10000)] },
  'S03-return-61-days-no-suggestion': { transactions: [tx('p', 'C', '2026-06-01', 10000), tx('k', 'X', '2026-06-02', -10000), tx('rev', 'X', '2026-09-10', 10000), tx('ret', 'C', '2026-11-10', -10000)] },
  'S04-matched-leg-not-posted': { transactions: [Tc()], carryovers: [waiting('X', 'pk')], decisions: [pairOnPending()] },
  'S05-partner-gone-expired': { transactions: [Tc()], carryovers: [waiting('X', 'pk', '2026-10-01T00:00:00Z')], decisions: [pairOnPending()] },
  'S06-partner-gone-no-carryover': { transactions: [Tc()], decisions: [pairOnPending()] },
  'S07-both-posted-pair-active': { transactions: [Tc(), tx('Tk', 'X', '2026-09-09', -10000, { plaid: 'tk', pendingOf: 'pk' })], decisions: [pairOnPending()] },
  'S08-posted-before-pending-removal': { transactions: [tx('Pc', 'C', '2026-09-01', 10000, { plaid: 'pc', pending: true }), Tc(), tx('Tk', 'X', '2026-09-09', -10000, { plaid: 'tk', pendingOf: 'pk' })], decisions: [pairOnPending()] },
  'S09-posted-amount-changed': { transactions: [Tc(9800), tx('Tk', 'X', '2026-09-09', -10000, { plaid: 'tk', pendingOf: 'pk' })], decisions: [pairOnPending()] },
  'S10-fee-payment-cash-larger': feePair(['C', 10000], ['X', -9800], 200),
  'S11-fee-payment-card-larger': feePair(['C', 9800], ['X', -10000], -200),
  'S12-fee-return-cash-larger': feePair(['C', -10000], ['X', 9800], 200),
  'S13-fee-return-card-larger': feePair(['C', -9800], ['X', 10000], -200),
  'S14-fee-excluded-card': feePair(['C', 10000], ['E', -9800], 200),
  'S15-fee-excluded-cash': feePair(['F', 10000], ['X', -9800], 200),
  'S16-fee-not-accepted': feePair(['C', 10000], ['X', -9800], 0),
  'S17-R7-excluded-card-closer': { transactions: [tx('pay', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-03', -10000), tx('e', 'E', '2026-09-02', -10000)] },
  'S18-known-effect-exception': { accounts: noIncludedCard(), transactions: [tx('c', 'C', '2026-09-01', 9800), tx('e', 'E', '2026-09-02', -9800)], decisions: [mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] },
  'S19-known-effect-exception-return': { accounts: noIncludedCard(), transactions: [tx('c', 'C', '2026-09-01', -9800)], decisions: [mkDecision('u', 'destination_unlinked', ref('C', 'p-c', -10000))] },
  'S20-exception-blocked-by-included-card': { transactions: [tx('c', 'C', '2026-09-01', 9800)], decisions: [mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] },
  'S21-exception-blocked-by-direction-change': { accounts: noIncludedCard(), transactions: [tx('c', 'C', '2026-09-01', -9800)], decisions: [mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] },
  'S22-conflicting-replacements-removed-card': {
    transactions: [tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' }), tx('x', 'X', '2026-09-02', -10000)],
    decisions: [mkDecision('r', 'destination_removed_card', ref('C', 'pc', 10000))],
  },
  'S23-conflicting-replacements-no-decision': { transactions: [tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' }), tx('x', 'X', '2026-09-02', -10000), tx('c2', 'C2', '2026-09-20', 10000)] },
  'S24-decision-names-one-replacement-by-posted-id': {
    transactions: [tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' }), tx('x', 'X', '2026-09-02', -10000)],
    decisions: [mkDecision('p', 'pair', ref('C', 't1', 10000), ref('X', 'p-x', -10000))],
  },
  'S25-dismissal-breaks-tie': { transactions: [tx('c1', 'C', '2026-09-01', 10000), tx('c2', 'C2', '2026-09-03', 10000), tx('x', 'X', '2026-09-02', -10000)], decisions: [mkDecision('n', 'not_this_pair', ref('C', 'p-c1', 10000), ref('X', 'p-x', -10000))] },
  'S26-chain-all-ambiguous': { transactions: [tx('c1', 'C', '2026-09-01', 10000), tx('x1', 'X', '2026-09-02', -10000), tx('c2', 'C', '2026-09-03', 10000), tx('x2', 'X', '2026-09-04', -10000)] },
  'S27-not-cash-side': { transactions: [tx('x', 'X', '2026-09-01', -10000)], decisions: [mkDecision('u', 'destination_unlinked', ref('X', 'p-x', -10000))] },
  'S28-contradiction-on-excluded-card': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('e', 'E', '2026-09-08', -10000)], decisions: [mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] },
  'S29-removed-card-reevaluated-tier1': { transactions: [tx('c', 'C', '2026-09-01', 9800), tx('x', 'X', '2026-09-02', -9800)], decisions: [mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000))] },
  'S30-null-type-cash-side': { transactions: [tx('n', 'N', '2026-09-01', 71000), tx('x', 'X', '2026-09-02', -71000)] },
  'S31-changed-confirmation-reserved': {
    transactions: [tx('c', 'C', '2026-09-01', 10000), tx('x', 'X', '2026-09-21', -9800), tx('c2', 'C2', '2026-09-20', 9800)],
    decisions: [mkDecision('d', 'pair', ref('C', 'p-c', 10000), ref('X', 'p-x', -10000))],
  },
};
for (const [name, parts] of Object.entries(SCENARIOS)) {
  emit(name, {
    asOf: AS_OF,
    accounts: parts.accounts ?? baseAccounts(),
    transactions: parts.transactions,
    carryovers: parts.carryovers ?? [],
    decisions: parts.decisions ?? [],
  });
}

fs.writeFileSync(path.join(out, 'seed.sql'), sql.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected));
console.log(`exported ${SEEDS.length} generated histories and ${Object.keys(SCENARIOS).length} scenarios (${(SEEDS.length + Object.keys(SCENARIOS).length) * 2} user evaluations)`);
