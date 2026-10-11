// Compares what the SQL evaluator published with what the TypeScript reference evaluator computes from the
// same rows — legs, decisions, superseded rows AND review states — for every database state the harness left
// behind (reference/export.sql, one REF line per test and user).
//
//   node compare.cjs <compiled backend dir> <reference.txt> [<minimum number of comparisons>]
//
// This is SUPPLEMENTARY: the two evaluators could share a mistake. What each state must read is asserted by
// hand in sql/*.sql and in backend/src/services/cardPaymentMatching.relinkReview.test.ts.
// Exit status 1 on any difference, on an unreadable line, or when fewer states were compared than required.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const [compiled, file, minimumArg] = process.argv.slice(2);
if (!compiled || !file) {
  console.error('usage: node compare.cjs <compiled backend dir> <reference.txt> [<minimum>]');
  process.exit(2);
}
const { evaluateCardPayments } = require(path.join(compiled, 'services', 'cardPaymentMatching.js'));
const minimum = Number(minimumArg ?? 1);

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('REF|'));
let compared = 0;
let failures = 0;
const seen = { guarded: 0, reviews: 0, holds: 0, userDecisions: 0, gaps: 0 };
for (const line of lines) {
  const [, test, user, ...rest] = line.split('|');
  let record;
  try {
    record = JSON.parse(rest.join('|'));
  } catch {
    failures += 1;
    console.log(`FAIL  ${test} ${user}: the exported line is not JSON`);
    continue;
  }
  const { input, sql } = record;
  if (!sql.fresh) {
    failures += 1;
    console.log(`FAIL  ${test} ${user}: exported although not fresh`);
    continue;
  }
  compared += 1;
  let want;
  try {
    const ev = evaluateCardPayments(input);
    want = { legs: ev.legs, decisions: ev.decisions, supersededTransactionIds: ev.supersededTransactionIds, reviews: ev.reviews };
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${test} ${user}: the reference evaluator refused the input: ${err.message}`);
    continue;
  }
  const got = { legs: sql.legs, decisions: sql.decisions, supersededTransactionIds: sql.supersededTransactionIds, reviews: sql.reviews };
  seen.guarded += got.legs.filter((l) => l.reason === 'relink_review_required').length;
  seen.reviews += got.reviews.length;
  seen.holds += got.decisions.filter((d) => d.kind.startsWith('ambiguity_hold_')).length;
  seen.userDecisions += got.decisions.filter((d) => ['pair', 'destination_unlinked', 'pair_counterpart_removed', 'not_this_pair'].includes(d.kind)).length;
  seen.gaps += input.reviewObligations.filter((o) => o.gap).length;
  try {
    assert.deepStrictEqual(got, want);
  } catch (err) {
    failures += 1;
    const byId = new Map(want.legs.map((l) => [l.transactionId, l]));
    const differing = got.legs.find((l) => {
      try {
        assert.deepStrictEqual(l, byId.get(l.transactionId));
        return false;
      } catch {
        return true;
      }
    });
    console.log(
      `FAIL  ${test} ${user}: ` +
        (differing
          ? `leg ${differing.transactionId}\n    sql:       ${JSON.stringify(differing)}\n    reference: ${JSON.stringify(byId.get(differing.transactionId))}`
          : `reviews or decisions differ: ${err.message.split('\n').slice(0, 14).join('\n')}`)
    );
  }
}
console.log(
  `reference comparison: ${compared} database states compared, ${failures} differ ` +
    `(covering ${seen.guarded} guarded legs, ${seen.reviews} review states, ${seen.holds} holds, ${seen.userDecisions} user decisions, ${seen.gaps} gap obligations)`
);
if (compared < minimum) {
  console.log(`FAIL  only ${compared} states were compared; at least ${minimum} are required`);
  process.exit(1);
}
process.exit(failures > 0 ? 1 : 0);
