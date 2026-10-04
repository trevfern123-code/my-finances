// Compares the SQL evaluator's stored states (read through get_card_payment_states) with the
// TypeScript reference evaluator's output, field by field.
//
//   node compare.cjs <expected.json> <actual.txt>
//
// actual.txt holds psql lines "R|<seed>|<user>|<json>". Exit status 1 on any difference.
const fs = require('node:fs');
const assert = require('node:assert');

const [expectedPath, actualPath] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const lines = fs.readFileSync(actualPath, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('R|'));

let compared = 0;
let failures = 0;
const seen = new Set();
const shown = [];
for (const line of lines) {
  const [, seed, user, ...rest] = line.split('|');
  const actual = JSON.parse(rest.join('|'));
  const want = expected[seed][user];
  compared += 1;
  if (!actual.fresh) {
    failures += 1;
    if (shown.length < 5) shown.push(`seed ${seed} user ${user}: reader returned fresh=false after evaluation`);
    continue;
  }
  const got = { legs: actual.legs, decisions: actual.decisions, supersededTransactionIds: actual.supersededTransactionIds };
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
];
const missing = needed.filter((k) => !seen.has(k));
for (const s of shown) console.log(s);
console.log(`compared ${compared} user evaluations; ${failures} differ; ${seen.size} distinct state/candidate shapes seen`);
if (missing.length > 0) console.log(`FAIL  not exercised: ${missing.join(', ')}`);
if (failures > 0 || missing.length > 0) process.exit(1);
console.log('PASS  SQL evaluator output is identical to the TypeScript reference evaluator');
