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
// One hand-built scenario keeps a foreign decision (`keepForeign`), in the one way the database can hold it:
// the accounts it names belonged to the deciding user when it was written and moved to their owner afterwards.
//
// HAND-DERIVED EXPECTATIONS (revision 5). The oracle and the SQL evaluator agreeing proves only that they
// agree: a bug both share would pass. A scenario may therefore also carry what a person derived from the rules,
// as data, and it is checked against BOTH: here against the oracle (the export fails), and in compare.cjs
// against the SQL result. Every scenario from S77 on must carry one.
//   expect: { '<user>': { legs: { <txn id>: '<state>/<reason>/<effect>[ key=value]...' },
//                         decisions: { <decision id>: '<status>[/<detail>]' } } }
//   a leg's keys: detail=<inactive reason>  partner=<txn id>  decision=<decision id>  range=<low>..<high>
//                 cands=<txn id>:<kind>[,...]
// NOTHING IS LEFT UNSTATED: an omitted key asserts "none" (an omitted range, that both bounds equal the
// effect; an unresolved effect must state its range), and the legs and decisions listed must be ALL of that
// user's — a user who is not listed must have none.
const fs = require('node:fs');
const path = require('node:path');

const [compiled, out] = process.argv.slice(2);
const { generate, acct, tx, ref, mkDecision, mkPreserved, mkHold, U, V } = require(path.join(compiled, 'testUtils', 'cardPaymentHistories.js'));
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

// ---- Hand-derived expectations: one canonical line per leg and per decision ---------------------------
// (compare.cjs builds the same two lines from the SQL result; keep the two copies identical.)
const legLine = (l) =>
  `${l.state}/${l.reason}/${l.effectCents} detail=${l.detail ?? '-'} partner=${l.partnerTransactionId ?? '-'} decision=${l.decisionId ?? '-'} ` +
  `range=${l.lowCents}..${l.highCents} cands=${l.candidates.map((c) => `${c.transactionId}:${c.kind}`).sort().join(',') || '-'}`;
const decisionLine = (d) => `${d.status}${d.detail === null ? '' : `/${d.detail}`}`;
function handMismatches(hand, got) {
  const out = [];
  const check = (what, wanted, actual) => {
    for (const [id, w] of Object.entries(wanted)) {
      if (actual.get(id) !== w.line) out.push(`${what} ${w.name}: ${actual.get(id) ?? '(none)'}\n      by hand: ${w.line}   (written: ${w.text})`);
    }
    for (const [id, line] of actual) if (!(id in wanted)) out.push(`${what} ${id} is not in the hand-derived expectation: ${line}`);
  };
  check('leg', hand.legs, new Map(got.legs.map((l) => [l.transactionId, legLine(l)])));
  check('decision', hand.decisions, new Map(got.decisions.map((d) => [d.decisionId, decisionLine(d)])));
  return out;
}
// A scenario's hand-written expectation for one user → the canonical lines, keyed by the database ids.
const HAND_KEYS = ['detail', 'partner', 'decision', 'range', 'cands'];
function handFor(seed, written, txnUuid, decisionUuid) {
  const hand = { legs: {}, decisions: {} };
  for (const [name, text] of Object.entries(written.legs ?? {})) {
    const [head, ...rest] = text.split(' ');
    const given = Object.fromEntries(rest.map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    const parts = head.split('/');
    const unknown = Object.keys(given).filter((k) => !HAND_KEYS.includes(k));
    if (parts.length !== 3 || unknown.length > 0) throw new Error(`${seed}: malformed expectation for leg ${name}: '${text}'`);
    if (given.range === undefined && parts[2] === 'null') throw new Error(`${seed}: leg ${name}: an unresolved effect must state its range`);
    const cands = given.cands === undefined ? '-' : given.cands.split(',').map((c) => `${txnUuid(c.slice(0, c.indexOf(':')))}:${c.slice(c.indexOf(':') + 1)}`).sort().join(',');
    hand.legs[txnUuid(name)] = {
      name,
      text,
      line:
        `${head} detail=${given.detail ?? '-'} partner=${given.partner === undefined ? '-' : txnUuid(given.partner)} ` +
        `decision=${given.decision === undefined ? '-' : decisionUuid(given.decision)} range=${given.range ?? `${parts[2]}..${parts[2]}`} cands=${cands}`,
    };
  }
  for (const [name, text] of Object.entries(written.decisions ?? {})) hand.decisions[decisionUuid(name)] = { name, text, line: text };
  return hand;
}
const handFailures = [];
let handChecked = 0;

// One history → database rows + the oracle's expected output, keyed by `seed` (a number for generated
// histories, a name for the hand-built scenarios below).
function emit(seed, input) {
  const accountId = uuidFactory();
  const txnId = uuidFactory();
  const decisionId = uuidFactory();
  const ownerOf = new Map(input.accounts.map((a) => [a.id, a.userId]));
  const isForeign = (d) => ![d.a, d.b].filter(Boolean).every((r) => ownerOf.get(r.accountId) === d.userId);

  const accounts = input.accounts.map((a) => ({ ...a, id: accountId(a.id), userId: USERS[a.userId] }));
  const transactions = input.transactions.map((t) => ({ ...t, id: txnId(t.id), accountId: accountId(t.accountId) }));
  // `keepForeign` (one scenario): a decision naming another user's accounts. The ownership trigger refuses to
  // write one, so its accounts are inserted under the DECIDING user's item, the decision is written, and the
  // accounts then move to their owner — the only way such a row comes to exist (a10 does the same).
  const kept = input.decisions.filter((d) => input.keepForeign || !isForeign(d));
  const decisions = kept
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
  // Kept foreign decisions (database ids), and the accounts they name: account → the deciding user's key.
  const foreignIds = new Set(kept.filter(isForeign).map((d) => decisionId(d.id)));
  const lentTo = new Map();
  for (const d of kept.filter(isForeign)) {
    for (const r of [d.a, d.b].filter(Boolean)) if (ownerOf.get(r.accountId) !== d.userId) lentTo.set(accountId(r.accountId), d.userId);
  }

  // Expected: the TypeScript reference evaluator on exactly the rows inserted below.
  expected[seed] = {};
  const named = (what, known, uuid) => (name) => {
    if (!known.has(name)) throw new Error(`${seed}: the expectation names an unknown ${what} '${name}'`);
    return uuid(name);
  };
  const txnUuid = named('transaction', new Set(input.transactions.map((t) => t.id)), txnId);
  const decisionUuid = named('decision', new Set(kept.map((d) => d.id)), decisionId);
  for (const [userKey, user] of Object.entries(USERS)) {
    const ev = evaluateCardPayments({ ...dbInput, userId: user });
    expected[seed][user] = { legs: ev.legs, decisions: ev.decisions, supersededTransactionIds: ev.supersededTransactionIds };
    if (input.expect) {
      // A scenario with an expectation states EVERY user's legs and decisions (an unlisted user has none).
      const hand = handFor(seed, input.expect[userKey] ?? {}, txnUuid, decisionUuid);
      expected[seed][user].hand = hand;
      handChecked += 1;
      for (const m of handMismatches(hand, ev)) handFailures.push(`${seed} ${userKey}: the reference evaluator disagrees with the hand-derived expectation\n    ${m}`);
    }
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
        .map((a) => `(${q(a.id)}, ${q(ITEMS[lentTo.get(a.id) ?? userKeyOf[a.userId]])}, ${q(`acct-${seed}-${a.id}`)}, 'Account', ${q(a.type)}, ${a.excludeFromCashFlow})`)
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
  // Kept foreign decisions first, while their accounts are the deciding user's; then those accounts move to
  // their owner; then every other decision.
  for (const d of [...decisions.filter((x) => foreignIds.has(x.id)), null, ...decisions.filter((x) => !foreignIds.has(x.id))]) {
    if (d === null) {
      for (const a of accounts.filter((x) => lentTo.has(x.id))) sql.push(`update public.accounts set item_id = ${q(ITEMS[userKeyOf[a.userId]])} where id = ${q(a.id)};`);
      continue;
    }
    sql.push(
      // A preserved pair (pair_counterpart_removed) keeps its removed leg's reference in b_* with NO account. An
      // ambiguity hold has two ordinary legs and the removed candidate's date.
      `insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, accepted_difference_cents, counterpart_status, counterpart_date, decided_seq, superseded_by) values ` +
        `(${q(d.id)}, ${q(d.userId)}, ${q(d.kind)}, ${q(d.a.accountId)}, ${q(d.a.plaidTransactionId)}, ${d.a.cents}, ` +
        `${q(d.b?.accountId ?? null)}, ${q(d.b?.plaidTransactionId ?? d.counterpart?.plaidTransactionId ?? null)}, ${d.b ? d.b.cents : d.counterpart ? d.counterpart.cents : 'null'}, ` +
        `${d.acceptedDifferenceCents === null ? 'null' : d.acceptedDifferenceCents}, ${q(d.counterpart?.status ?? null)}, ${q(d.counterpartDate ?? null)}, ${d.decidedSeq}, ${q(d.supersededBy)});`
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
// matched_leg_not_posted, a reference whose own lineage is gone, and return-of-pair suggestions never occur
// there; partner_gone does occur, as the FROZEN status of a preserved pair), plus the
// approved-rule cases of CARD_PAYMENT_PAIRING_DESIGN.md. Expected values come from the oracle; from S77 on a
// scenario also carries its hand-derived outcome, which both the oracle and the SQL result must meet.
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
// The ambiguity-hold scenarios' rows: the payment, the kept card's leg, and the hold a removal writes (card leg first).
const hc = (date = '2026-09-10', cents = 10000) => tx('c', 'C', date, cents);
const hy = (date = '2026-09-11', cents = -10000) => tx('y', 'Y', date, cents);
const hold = (date = '2026-09-11', kind = 'ambiguity_hold_removed_card') => mkHold('h', kind, ref('Y', 'p-y', -10000), ref('C', 'p-c', 10000), date);
// Revision 5. A hand-derived expectation for user-a alone (user-b must then have no leg and no decision).
const A = (legs, decisions = {}) => ({ [U]: { legs, decisions } });
// The Option B scenarios' rows: the payment, the kept card's leg, and what a removal writes for a payment it had
// matched automatically to the removed card — the record on the payment and a hold on (kept card leg, payment).
const bk = (date = '2026-09-10', cents = 10000) => tx('k', 'C', date, cents);
const bb = (date = '2026-09-13', cents = -10000) => tx('b', 'Y', date, cents);
const bRecord = () => mkDecision('r', 'destination_removed_card', ref('C', 'p-k', 10000));
const bHold = (id = 'h', date = '2026-09-11') => mkHold(id, 'ambiguity_hold_removed_card', ref('Y', 'p-b', -10000), ref('C', 'p-k', 10000), date);
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
  // A user-confirmed pair whose other account was removed (pair_counterpart_removed; 2026-10-06). The surviving
  // leg is held by the user's decision; the removed side's frozen status says whether it proves an effect.
  'S32-preserved-valid-cash-with-competitor': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid')] },
  'S33-preserved-valid-credit-mirror-with-competitor': { transactions: [tx('y', 'Y', '2026-09-02', -10000), tx('c2', 'C2', '2026-09-03', 10000)], decisions: [mkPreserved('k', ref('Y', 'p-y', -10000), 'valid')] },
  'S34-preserved-counterpart-amount-changed': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'amount_changed')] },
  'S35-preserved-amount-changed-no-included-card': { accounts: noIncludedCard(), transactions: [tx('c', 'C', '2026-09-01', 10000), tx('e', 'E', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'amount_changed')] },
  'S36-preserved-surviving-amount-changed': { transactions: [tx('c', 'C', '2026-09-01', 9800), tx('y', 'Y', '2026-09-02', -9800)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid')] },
  'S37-preserved-surviving-amount-changed-no-included-card': { accounts: noIncludedCard(), transactions: [tx('c', 'C', '2026-09-01', 9800)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid')] },
  'S38-preserved-counterpart-waiting-is-not-invalid': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'waiting_to_post')] },
  'S39-preserved-counterpart-lineage-ambiguous': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'lineage_ambiguous')] },
  'S40-preserved-surviving-leg-waiting': { transactions: [tx('y', 'Y', '2026-09-02', -10000)], carryovers: [waiting('C', 'pc')], decisions: [mkPreserved('k', ref('C', 'pc', 10000), 'valid')] },
  'S41-preserved-surviving-leg-posted-through-lineage': { transactions: [Tc(), tx('y', 'Y', '2026-09-03', -10000)], decisions: [mkPreserved('k', ref('C', 'pc', 10000), 'valid')] },
  'S42-preserved-surviving-lineage-conflict': {
    transactions: [tx('T1', 'C', '2026-09-01', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-10', 10000, { plaid: 't2', pendingOf: 'pc' }), tx('y', 'Y', '2026-09-02', -10000)],
    decisions: [mkPreserved('k', ref('C', 'pc', 10000), 'valid')],
  },
  'S43-preserved-and-a-pair-on-the-same-leg-conflict': {
    transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid'), mkDecision('p', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000))],
  },
  'S44-preserved-superseded-is-ignored': { transactions: [tx('c', 'C', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [{ ...mkPreserved('k', ref('C', 'p-c', 10000), 'valid'), supersededBy: 'undone' }] },
  'S45-preserved-outranks-the-system-record': {
    transactions: [tx('c', 'C', '2026-09-01', 10000)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'amount_changed'), mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000))],
  },
  'S46-preserved-on-excluded-cash-account': { transactions: [tx('f', 'F', '2026-09-01', 10000), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('F', 'p-f', 10000), 'valid')] },
  'S47-preserved-credit-mirror-invalid-no-exception': { accounts: noIncludedCard(), transactions: [tx('e', 'E', '2026-09-02', -10000), tx('c', 'C', '2026-09-03', 10000)], decisions: [mkPreserved('k', ref('E', 'p-e', -10000), 'amount_changed')] },
  'S48-preserved-with-accepted-difference-counts-in-full': { transactions: [tx('c', 'C', '2026-09-01', 8000)], decisions: [mkPreserved('k', ref('C', 'p-c', 8000), 'valid', 200)] },
  'S49-preserved-return-direction': { transactions: [tx('c', 'C', '2026-09-01', -3500), tx('y', 'Y', '2026-09-02', 3500)], decisions: [mkPreserved('k', ref('C', 'p-c', -3500), 'valid')] },
  'S50-preserved-role-changed-on-the-surviving-leg': { transactions: [tx('c', 'C', '2026-09-01', 10000, { role: 'expense' }), tx('y', 'Y', '2026-09-02', -10000)], decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid')] },
  // The system ambiguity hold (2026-10-06): institution removal is not evidence. What a removal leaves for a
  // payment (c, 09-10) that a removed card's leg and the kept card's leg (y, 09-11) both fitted.
  'S51-hold-withholds-the-pair-left-by-a-removal': { transactions: [hc(), hy()], decisions: [hold()] },
  'S52-hold-removed-candidate-strictly-farther-pair-stands': { transactions: [hc(), hy()], decisions: [hold('2026-09-12')] },
  'S53-hold-removed-candidate-closer-withheld': { transactions: [hc(), hy()], decisions: [hold('2026-09-10')] },
  'S54-hold-date-change-brings-partner-closer-released': { transactions: [hc(), hy('2026-09-10')], decisions: [hold()] },
  'S55-hold-date-change-farther-still-withheld': { transactions: [hc(), hy('2026-09-13')], decisions: [hold()] },
  'S56-hold-both-amounts-changed-inactive-pairs': { transactions: [hc('2026-09-10', 9800), hy('2026-09-11', -9800)], decisions: [hold()] },
  'S57-hold-new-strictly-closer-candidate-pairs': { transactions: [hc(), hy(), tx('n', 'X', '2026-09-10', -10000)], decisions: [hold()] },
  'S58-hold-new-equally-close-candidate-ties': { transactions: [hc(), hy(), tx('n', 'X', '2026-09-11', -10000)], decisions: [hold()] },
  'S59-hold-relinked-leg-pairs-once-the-kept-card-no-longer-fits': { transactions: [hc(), hy('2026-09-11', -9900), tx('x2', 'X', '2026-09-11', -10000)], decisions: [hold()] },
  'S60-hold-user-pair-wins': { transactions: [hc(), hy()], decisions: [hold(), mkDecision('p', 'pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000))] },
  'S61-hold-user-unlinked-wins': { transactions: [hc(), hy()], decisions: [hold(), mkDecision('u', 'destination_unlinked', ref('C', 'p-c', 10000))] },
  'S62-hold-user-dismissal': { transactions: [hc(), hy()], decisions: [hold(), mkDecision('n', 'not_this_pair', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000))] },
  'S63-hold-is-not-a-claim-second-payment-does-not-take-the-card-leg': { transactions: [hc(), hy(), tx('c2', 'C2', '2026-09-13', 10000)], decisions: [hold()] },
  'S64-hold-mirror-removed-cash-leg-competed-for-the-card-leg': { transactions: [hc(), hy('2026-09-12')], decisions: [hold('2026-09-13', 'ambiguity_hold_removed_cash_account')] },
  'S65-hold-same-date-other-kind-pair-stands': { transactions: [hc(), hy('2026-09-12')], decisions: [hold('2026-09-13', 'ambiguity_hold_removed_card')] },
  'S66-hold-legs-recorded-cash-first': { transactions: [hc(), hy()], decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('C', 'p-c', 10000), ref('Y', 'p-y', -10000), '2026-09-11')] },
  'S67-hold-follows-a-posted-row-with-the-same-amount': { transactions: [tx('Tc', 'C', '2026-09-10', 10000, { plaid: 'tc', pendingOf: 'pc' }), hy()], decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'pc', 10000), '2026-09-11')] },
  'S68-hold-waiting-leg': { transactions: [hy()], carryovers: [waiting('C', 'pc')], decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'pc', 10000), '2026-09-11')] },
  'S69-hold-conflicting-replacements-not-named': {
    transactions: [tx('T1', 'C', '2026-09-10', 10000, { plaid: 't1', pendingOf: 'pc' }), tx('T2', 'C', '2026-09-12', 10000, { plaid: 't2', pendingOf: 'pc' }), hy()],
    decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('C', 'pc', 10000), '2026-09-11')],
  },
  'S70-hold-earlier-system-record-applies-once-tier1-is-withheld': { transactions: [hc(), hy()], decisions: [hold(), mkDecision('r', 'destination_removed_card', ref('C', 'p-c', 10000))] },
  'S71-hold-excluded-card-partner-withheld': { transactions: [hc(), tx('e', 'E', '2026-09-11', -10000)], decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('E', 'p-e', -10000), ref('C', 'p-c', 10000), '2026-09-11')] },
  'S72-hold-return-direction': { transactions: [tx('c', 'C', '2026-09-10', -3500), tx('y', 'Y', '2026-09-11', 3500)], decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', 3500), ref('C', 'p-c', -3500), '2026-09-11')] },
  'S73-hold-superseded-is-ignored': { transactions: [hc(), hy()], decisions: [{ ...hold(), supersededBy: 'undone' }] },
  'S74-hold-role-changed-leg': { transactions: [hc(), tx('y', 'Y', '2026-09-11', -10000, { role: 'expense' })], decisions: [hold()] },
  'S76-hold-kept-leg-withdrawn-by-the-bank': { transactions: [hc(), tx('x2', 'X', '2026-09-11', -10000)], decisions: [hold()] },
  'S75-hold-three-candidates-two-left': {
    transactions: [hc(), hy(), tx('y2', 'X', '2026-09-11', -10000)],
    decisions: [hold(), mkHold('h2', 'ambiguity_hold_removed_card', ref('X', 'p-y2', -10000), ref('C', 'p-c', 10000), '2026-09-11')],
  },

  // ---- Revision 5 (2026-10-07): S77–S97, each with its hand-derived outcome in `expect` (see the header).
  // P2 — a preserved pair's FROZEN status (what was wrong with the side that is gone) is the decision's reason
  // whatever the surviving row's amount or role is now; only a frozen valid / waiting_to_post / amount_changed
  // can read amount_changed, the one reason the known-effect exception accepts.
  // S77: frozen lineage_ambiguous, payment corrected 100.00 → 98.00, no included card: reserved and unresolved, range −98.00..0, reason lineage_ambiguous (revision 4: untracked / no_included_card).
  'S77-preserved-frozen-lineage-ambiguous-amount-corrected-no-included-card': {
    accounts: noIncludedCard(),
    transactions: [tx('c', 'C', '2026-09-01', 9800)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'lineage_ambiguous')],
    expect: A({ c: 'unresolved/decision_invalidated/null detail=lineage_ambiguous decision=k range=-9800..0' }, { k: 'inactive/lineage_ambiguous' }),
  },
  // S78: the same with frozen valid: the amount is the only thing wrong, so the exception applies — untracked / no_included_card, −98.00, detail amount_changed; the decision inactive / amount_changed.
  'S78-preserved-frozen-valid-amount-corrected-no-included-card-exception': {
    accounts: noIncludedCard(),
    transactions: [tx('c', 'C', '2026-09-01', 9800)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'valid')],
    expect: A({ c: 'untracked/no_included_card/-9800 detail=amount_changed decision=k' }, { k: 'inactive/amount_changed' }),
  },
  // S79: frozen partner_gone, the surviving row re-classified (expense) AND re-priced: it is no card leg, so there is no leg at all; the decision is inactive / partner_gone (not amount_changed, not role_changed).
  'S79-preserved-frozen-partner-gone-surviving-row-reclassified-and-repriced': {
    transactions: [tx('c', 'C', '2026-09-01', 9800, { role: 'expense' })],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'partner_gone')],
    expect: A({}, { k: 'inactive/partner_gone' }),
  },
  // S80: frozen role_changed, payment corrected to 98.00, a kept card's leg of exactly −98.00 one day away: the payment is reserved (unresolved / decision_invalidated / role_changed, the card leg listed), the card leg unpaired with no candidates.
  'S80-preserved-frozen-role-changed-corrected-amount-fits-a-kept-card': {
    transactions: [tx('c', 'C', '2026-09-01', 9800), tx('y', 'Y', '2026-09-02', -9800)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'role_changed')],
    expect: A(
      { c: 'unresolved/decision_invalidated/null detail=role_changed decision=k range=-9800..0 cands=y:tier1_competitor', y: 'unresolved/no_candidate/0' },
      { k: 'inactive/role_changed' }
    ),
  },
  // S81: the mirror — the surviving leg is the CARD leg, frozen lineage_ambiguous, corrected to −98.00, a cash leg of 98.00 one day away: the card leg reserved (unresolved / decision_invalidated / lineage_ambiguous, 0), the cash leg unresolved with no candidate, range −98.00..0.
  'S81-preserved-credit-mirror-frozen-lineage-ambiguous-corrected-amount-fits-a-cash-leg': {
    transactions: [tx('y', 'Y', '2026-09-02', -9800), tx('c2', 'C2', '2026-09-03', 9800)],
    decisions: [mkPreserved('k', ref('Y', 'p-y', -10000), 'lineage_ambiguous')],
    expect: A(
      { y: 'unresolved/decision_invalidated/0 detail=lineage_ambiguous decision=k cands=c2:tier1_competitor', c2: 'unresolved/no_candidate/null range=-9800..0' },
      { k: 'inactive/lineage_ambiguous' }
    ),
  },
  // S82: frozen amount_changed AND the payment corrected to 98.00, no included card: amounts are all that is wrong — the exception, untracked / no_included_card at the current amount (−98.00).
  'S82-preserved-frozen-amount-changed-and-surviving-amount-corrected-no-included-card': {
    accounts: noIncludedCard(),
    transactions: [tx('c', 'C', '2026-09-01', 9800)],
    decisions: [mkPreserved('k', ref('C', 'p-c', 10000), 'amount_changed')],
    expect: A({ c: 'untracked/no_included_card/-9800 detail=amount_changed decision=k' }, { k: 'inactive/amount_changed' }),
  },
  // P1 — a hold on a pair with a leg on an EXCLUDED account withholds it like any other.
  // S83: removed-cash hold on (excluded card leg e, payment k), same day, an included card elsewhere: the pair is withheld — k unresolved / ambiguous, range −100.00..0; e not_counted; neither has a partner; the hold active.
  'S83-hold-removed-cash-on-an-excluded-card-leg-withholds-the-payment': {
    transactions: [tx('k', 'C', '2026-09-10', 10000), tx('e', 'E', '2026-09-10', -10000)],
    decisions: [mkHold('h', 'ambiguity_hold_removed_cash_account', ref('E', 'p-e', -10000), ref('C', 'p-k', 10000), '2026-09-10')],
    expect: A({ k: 'unresolved/ambiguous/null range=-10000..0 cands=e:tier1_competitor', e: 'not_counted/excluded_account/0' }, { h: 'active' }),
  },
  // S84: the same rows without the hold: the automatic pair with the excluded card stands — k untracked / partner_excluded, −100.00 (the hold is what changes it).
  'S84-no-hold-the-payment-pairs-with-the-excluded-card': {
    transactions: [tx('k', 'C', '2026-09-10', 10000), tx('e', 'E', '2026-09-10', -10000)],
    expect: A({ k: 'untracked/partner_excluded/-10000 partner=e', e: 'not_counted/excluded_account/0 partner=k' }),
  },
  // S85: removed-card hold on (included card leg y, excluded checking's leg f): y unresolved / ambiguous, 0 (not funded_from_excluded); f not_counted; no partner.
  'S85-hold-removed-card-on-an-excluded-cash-leg-withholds-the-card-leg': {
    transactions: [tx('y', 'Y', '2026-09-10', -10000), tx('f', 'F', '2026-09-10', 10000)],
    decisions: [mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-y', -10000), ref('F', 'p-f', 10000), '2026-09-10')],
    expect: A({ y: 'unresolved/ambiguous/0 cands=f:tier1_competitor', f: 'not_counted/excluded_account/0' }, { h: 'active' }),
  },
  // S86: S83 for a user with NO included card: the pair is withheld and the lower rule decides — k untracked / no_included_card, −100.00 (not partner_excluded, no partner).
  'S86-hold-removed-cash-no-included-card-the-lower-rule-decides': {
    accounts: noIncludedCard(),
    transactions: [tx('k', 'C', '2026-09-10', 10000), tx('e', 'E', '2026-09-10', -10000)],
    decisions: [mkHold('h', 'ambiguity_hold_removed_cash_account', ref('E', 'p-e', -10000), ref('C', 'p-k', 10000), '2026-09-10')],
    expect: A({ k: 'untracked/no_included_card/-10000', e: 'not_counted/excluded_account/0' }, { h: 'active' }),
  },
  // Option B — what a removal leaves for a payment (k, 09-10) it had matched automatically to the removed card's
  // leg (09-11, one day) while a kept card's leg (b, 09-13, three days) also fitted: the record on k and a hold
  // on (b, k) dated by the removed leg.
  // S87: the removed leg would still be closer (1 <= 3): the pair is withheld; k reads its record — untracked / removed_card, −100.00; b unresolved / ambiguous, 0, no decision.
  'S87-option-b-record-and-hold-the-kept-card-does-not-take-the-payment': {
    transactions: [bk(), bb()],
    decisions: [bRecord(), bHold()],
    expect: A({ k: 'untracked/removed_card/-10000 decision=r', b: 'unresolved/ambiguous/0 cands=k:tier1_competitor' }, { r: 'active', h: 'active' }),
  },
  // S88: S87 plus a NEW card leg z on the payment's own day: strictly closer than b, so k pairs with z by the ordinary rule (tracked / auto_pair, 0); the record is active but not applied; b unresolved.
  'S88-option-b-new-strictly-closer-card-leg-pairs': {
    transactions: [bk(), bb(), tx('z', 'X', '2026-09-10', -10000)],
    decisions: [bRecord(), bHold()],
    expect: A(
      { k: 'tracked/auto_pair/0 partner=z', z: 'paired/auto_pair/0 partner=k', b: 'unresolved/ambiguous/0 cands=k:tier1_competitor' },
      { r: 'active', h: 'active' }
    ),
  },
  // S89: S87 with b re-dated to the payment's day: now strictly closer than the removed leg was (1 > 0), so the hold withholds nothing — k tracked / auto_pair with b.
  'S89-option-b-kept-leg-redated-strictly-closer-pairs': {
    transactions: [bk(), bb('2026-09-10')],
    decisions: [bRecord(), bHold()],
    expect: A({ k: 'tracked/auto_pair/0 partner=b', b: 'paired/auto_pair/0 partner=k' }, { r: 'active', h: 'active' }),
  },
  // S90: S87 with both amounts corrected to 98.00: the hold and the record are inactive / amount_changed (new evidence), and k pairs with b.
  'S90-option-b-both-amounts-corrected-pairs': {
    transactions: [bk('2026-09-10', 9800), bb('2026-09-13', -9800)],
    decisions: [bRecord(), bHold()],
    expect: A({ k: 'tracked/auto_pair/0 partner=b', b: 'paired/auto_pair/0 partner=k' }, { r: 'inactive/amount_changed', h: 'inactive/amount_changed' }),
  },
  // S91: S87 plus a second hold on the same pair dated ten days away (it alone would withhold nothing): still withheld — one applicable hold that withholds is enough.
  'S91-option-b-a-second-hold-that-would-not-withhold-changes-nothing': {
    transactions: [bk(), bb()],
    decisions: [bRecord(), bHold('h2', '2026-09-20'), bHold()],
    expect: A({ k: 'untracked/removed_card/-10000 decision=r', b: 'unresolved/ambiguous/0 cands=k:tier1_competitor' }, { r: 'active', h: 'active', h2: 'active' }),
  },
  // S92: S87 plus the user's own pair (k, b): tracked / user_pair; the hold and the record stay active and conflict with nothing.
  'S92-option-b-user-pair-wins': {
    transactions: [bk(), bb()],
    decisions: [bRecord(), bHold(), mkDecision('p', 'pair', ref('C', 'p-k', 10000), ref('Y', 'p-b', -10000))],
    expect: A({ k: 'tracked/user_pair/0 partner=b decision=p', b: 'paired/user_pair/0 partner=k decision=p' }, { r: 'active', h: 'active', p: 'active' }),
  },
  // S93: the record and the hold name the payment's PENDING id; only its posted row exists (same amount, same day): the same leg — as S87, on the posted row.
  'S93-option-b-record-and-hold-follow-the-posted-row': {
    transactions: [tx('Tk', 'C', '2026-09-10', 10000, { plaid: 'tk', pendingOf: 'pk' }), bb()],
    decisions: [mkDecision('r', 'destination_removed_card', ref('C', 'pk', 10000)), mkHold('h', 'ambiguity_hold_removed_card', ref('Y', 'p-b', -10000), ref('C', 'pk', 10000), '2026-09-11')],
    expect: A({ Tk: 'untracked/removed_card/-10000 decision=r', b: 'unresolved/ambiguous/0 cands=Tk:tier1_competitor' }, { r: 'active', h: 'active' }),
  },
  // S94: the mirror — a card leg b (09-10) that a removed cash leg (09-11) was matched to, a kept cash leg k2 (09-13) also fitting; no record exists for a card leg: b unresolved / ambiguous, 0; k2 unresolved / ambiguous, range −100.00..0 (not tracked).
  'S94-option-b-mirror-kept-cash-leg-is-not-tracked': {
    transactions: [tx('b', 'Y', '2026-09-10', -10000), tx('k2', 'C2', '2026-09-13', 10000)],
    decisions: [mkHold('h', 'ambiguity_hold_removed_cash_account', ref('Y', 'p-b', -10000), ref('C2', 'p-k2', 10000), '2026-09-11')],
    expect: A({ b: 'unresolved/ambiguous/0 cands=k2:tier1_competitor', k2: 'unresolved/ambiguous/null range=-10000..0 cands=b:tier1_competitor' }, { h: 'active' }),
  },
  // S95: two users with the same rows. user-a's own hold is dated ten days away (it withholds nothing): k tracked / auto_pair with b. user-b's own hold withholds user-b's pair. A hold recorded under user-b naming
  // user-a's two accounts would withhold user-a's pair if it applied; it is rejected (foreign_account for user-b, foreign_user for user-a) and changes nothing for either.
  'S95-hold-under-another-user-is-rejected-and-changes-nothing': {
    accounts: [...baseAccounts(), acct('VC', 'depository', false, V), acct('VY', 'credit', false, V)],
    transactions: [bk(), bb(), tx('vk', 'VC', '2026-09-10', 10000), tx('vb', 'VY', '2026-09-13', -10000)],
    decisions: [
      bHold('h', '2026-09-20'),
      mkHold('hv', 'ambiguity_hold_removed_card', ref('VY', 'p-vb', -10000), ref('VC', 'p-vk', 10000), '2026-09-11', V),
      mkHold('hf', 'ambiguity_hold_removed_card', ref('Y', 'p-b', -10000), ref('C', 'p-k', 10000), '2026-09-11', V),
    ],
    keepForeign: true,
    expect: {
      [U]: { legs: { k: 'tracked/auto_pair/0 partner=b', b: 'paired/auto_pair/0 partner=k' }, decisions: { h: 'active', hf: 'rejected/foreign_user' } },
      [V]: {
        legs: { vk: 'unresolved/ambiguous/null range=-10000..0 cands=vb:tier1_competitor', vb: 'unresolved/ambiguous/0 cands=vk:tier1_competitor' },
        decisions: { hv: 'active', hf: 'rejected/foreign_account' },
      },
    },
  },
  // P2 — a preserved pair with a frozen disqualifier whose SURVIVING reference has no current row: the reference's
  // own lineage is read first and alone gives the reason (two replacements: lineage_ambiguous; a live carry-over:
  // waiting_to_post; nothing: partner_gone); the frozen status is not reached. The generated histories reach only
  // lineage_ambiguous there.
  // S96: frozen lineage_ambiguous; the reference (C, pc) has no row, no replacement and no carry-over: the decision inactive / partner_gone (not lineage_ambiguous); no leg carries it; the kept card's leg y is unresolved / no_candidate, 0.
  'S96-preserved-frozen-lineage-ambiguous-surviving-reference-gone': {
    transactions: [tx('y', 'Y', '2026-09-02', -10000)],
    decisions: [mkPreserved('k', ref('C', 'pc', 10000), 'lineage_ambiguous')],
    expect: A({ y: 'unresolved/no_candidate/0' }, { k: 'inactive/partner_gone' }),
  },
  // S97: S96 plus a carry-over for (C, pc) that is neither consumed nor expired: the decision inactive / waiting_to_post (not lineage_ambiguous, not partner_gone); still no leg carries it.
  'S97-preserved-frozen-lineage-ambiguous-surviving-reference-waiting': {
    transactions: [tx('y', 'Y', '2026-09-02', -10000)],
    carryovers: [waiting('C', 'pc')],
    decisions: [mkPreserved('k', ref('C', 'pc', 10000), 'lineage_ambiguous')],
    expect: A({ y: 'unresolved/no_candidate/0' }, { k: 'inactive/waiting_to_post' }),
  },
};
for (const [name, parts] of Object.entries(SCENARIOS)) {
  if (Number(name.slice(1, 3)) >= 77 && !parts.expect) throw new Error(`${name}: every scenario from S77 on must carry its hand-derived expectation`);
  if (parts.expect && !Object.keys(parts.expect).every((k) => k in USERS)) throw new Error(`${name}: the expectation names an unknown user`);
  emit(name, {
    asOf: AS_OF,
    accounts: parts.accounts ?? baseAccounts(),
    transactions: parts.transactions,
    carryovers: parts.carryovers ?? [],
    decisions: parts.decisions ?? [],
    expect: parts.expect,
    keepForeign: parts.keepForeign ?? false,
  });
}

if (handFailures.length > 0) {
  for (const f of handFailures) console.log(`FAIL  ${f}`);
  console.log(`${handFailures.length} hand-derived expectation(s) are not what the reference evaluator computes`);
  process.exit(1);
}
fs.writeFileSync(path.join(out, 'seed.sql'), sql.join('\n') + '\n');
fs.writeFileSync(path.join(out, 'expected.json'), JSON.stringify(expected));
console.log(
  `exported ${SEEDS.length} generated histories and ${Object.keys(SCENARIOS).length} scenarios (${(SEEDS.length + Object.keys(SCENARIOS).length) * 2} user evaluations); ` +
    `${handChecked} of them carry a hand-derived expectation, which the reference evaluator meets`
);
