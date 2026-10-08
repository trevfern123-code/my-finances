// Compares the SQL evaluator's stored states (read through get_card_payment_states) with the
// TypeScript reference evaluator's output, field by field.
//
//   node compare.cjs <expected.json> <actual.txt>
//
// actual.txt holds psql lines "R|<seed>|<user>|<json>". Exit status 1 on any difference.
//
// Where a scenario carries a hand-derived expectation (export.cjs, S77 on: `hand`, already checked there against
// the reference evaluator), the SQL result must meet it too — agreement between the two evaluators alone would
// not show a bug they share.
const fs = require('node:fs');
const assert = require('node:assert');

const [expectedPath, actualPath] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const lines = fs.readFileSync(actualPath, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('R|'));

// ---- Hand-derived expectations: one canonical line per leg and per decision ---------------------------
// (the same two lines and the same check as in export.cjs; keep the two copies identical.)
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

let compared = 0;
let failures = 0;
let handCompared = 0;
let handFailures = 0;
const seen = new Set();
const shown = [];
for (const line of lines) {
  const [, seed, user, ...rest] = line.split('|');
  const actual = JSON.parse(rest.join('|'));
  const { hand, ...want } = expected[seed][user];
  compared += 1;
  if (!actual.fresh) {
    failures += 1;
    if (shown.length < 5) shown.push(`seed ${seed} user ${user}: reader returned fresh=false after evaluation`);
    continue;
  }
  const got = { legs: actual.legs, decisions: actual.decisions, supersededTransactionIds: actual.supersededTransactionIds };
  if (hand) {
    // Independent of the comparison with the oracle below: the SQL result against what was derived by hand.
    handCompared += 1;
    const wrong = handMismatches(hand, got);
    if (wrong.length > 0) {
      handFailures += 1;
      console.log(`FAIL  seed ${seed} user ${user}: the SQL evaluator disagrees with the hand-derived expectation\n    ${wrong.join('\n    ')}`);
    }
  }
  for (const d of got.decisions) if (d.kind.startsWith('ambiguity_hold_')) seen.add(`decision:${d.kind}:${d.status}${d.detail === null ? '' : `:${d.detail}`}`);
  for (const leg of got.legs) {
    seen.add(`${leg.state}/${leg.reason}`);
    if (leg.candidates.length > 0) seen.add(`candidates:${leg.candidates.map((c) => c.kind).sort().join(',')}`);
    if (leg.candidates.some((c) => c.contradictsDecision)) seen.add('contradiction');
    if (leg.detail !== null) seen.add(`detail:${leg.detail}`);
    for (const c of leg.candidates) seen.add(`kind:${c.kind}`);
  }
  try {
    assert.deepStrictEqual(got, want);
  } catch (err) {
    failures += 1;
    if (shown.length < 5) {
      // Name the first differing leg to make a failure actionable.
      const byId = new Map(want.legs.map((l) => [l.transactionId, l]));
      const differs = (l) => {
        try {
          assert.deepStrictEqual(l, byId.get(l.transactionId));
          return false;
        } catch {
          return true;
        }
      };
      const diffLeg = got.legs.find(differs);
      shown.push(
        `seed ${seed} user ${user}: ` +
          (diffLeg
            ? `leg ${diffLeg.transactionId}\n    sql:    ${JSON.stringify(diffLeg)}\n    oracle: ${JSON.stringify(byId.get(diffLeg.transactionId))}`
            : `legs/decisions differ: ${err.message.split('\n').slice(0, 12).join('\n')}`)
      );
    }
  }
}

const expectedCount = Object.values(expected).reduce((n, users) => n + Object.keys(users).length, 0);
if (compared !== expectedCount) {
  console.log(`FAIL  compared ${compared} evaluations, expected ${expectedCount}`);
  process.exit(1);
}
// Guard against a vacuous run: the generated histories and the hand-built scenarios together must reach
// every interesting state, detail and candidate kind (measured: the generator alone misses some).
const needed = [
  'tracked/auto_pair', 'tracked/user_pair', 'untracked/partner_excluded', 'untracked/no_included_card',
  'untracked/user_confirmed_unlinked', 'untracked/removed_card', 'unresolved/ambiguous', 'unresolved/possible_match',
  'unresolved/amount_differs', 'unresolved/no_candidate', 'unresolved/decision_invalidated',
  'unresolved/ambiguous_replacement', 'not_counted/excluded_account', 'paired/auto_pair', 'contradiction',
  // reached only by the hand-built scenarios
  'unresolved/matched_leg_not_posted', 'detail:partner_gone', 'kind:return_of_pair', 'detail:not_cash_side',
  'detail:difference_not_accepted', 'detail:amount_changed', 'detail:lineage_ambiguous', 'kind:near_amount',
  'funded_from_excluded/user_pair', 'funded_from_excluded/auto_pair',
  // a preserved pair whose cash account was removed (pair_counterpart_removed, the credit side)
  'funded_from_excluded/removed_cash_account',
  // the system ambiguity hold: both kinds applying, and inactive for each reason the scenarios build
  'decision:ambiguity_hold_removed_card:active', 'decision:ambiguity_hold_removed_cash_account:active',
  'decision:ambiguity_hold_removed_card:inactive:amount_changed', 'decision:ambiguity_hold_removed_card:inactive:role_changed',
  'decision:ambiguity_hold_removed_card:inactive:lineage_ambiguous', 'decision:ambiguity_hold_removed_card:inactive:waiting_to_post',
  'decision:ambiguity_hold_removed_card:inactive:partner_gone', 'decision:ambiguity_hold_removed_card:superseded',
  // a hold recorded under another user (S95): rejected for the user it is recorded under, and for the accounts' owner
  'decision:ambiguity_hold_removed_card:rejected:foreign_account', 'decision:ambiguity_hold_removed_card:rejected:foreign_user',
];
const missing = needed.filter((k) => !seen.has(k));
// The hand-derived expectations must all have been reached too (and there must be some).
const handExpected = Object.values(expected).reduce((n, users) => n + Object.values(users).filter((u) => u.hand).length, 0);
for (const s of shown) console.log(s);
console.log(`compared ${compared} user evaluations; ${failures} differ; ${seen.size} distinct state/candidate shapes seen`);
console.log(`hand-derived expectations: ${handCompared} user evaluations (${handExpected / 2} scenarios) checked against the SQL result; ${handFailures} differ`);
if (missing.length > 0) console.log(`FAIL  not exercised: ${missing.join(', ')}`);
if (handExpected === 0 || handCompared !== handExpected) console.log(`FAIL  ${handCompared} of ${handExpected} hand-derived expectations were checked`);
if (failures > 0 || missing.length > 0 || handFailures > 0 || handExpected === 0 || handCompared !== handExpected) process.exit(1);
console.log('PASS  SQL evaluator output is identical to the TypeScript reference evaluator, and both meet the hand-derived expectations');
