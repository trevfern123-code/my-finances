// Compares RPC-written decision sequences (rpc_sequences.sql) with the TypeScript reference evaluator.
//
//   node compare_rpc.cjs <compiled-dir> <actual_rpc.txt>
//
// For every scenario and user: the reference evaluator, run on the database inputs exactly as the RPCs left
// them (I line — superseded and undone decisions included), must equal the SQL evaluator's states (R line).
// Then the scenario's expectations (E line) are checked against the reference result: each RPC step's
// outcome, named legs' state/reason, and the number of live decisions. Exit status 1 on any difference.
// A sequence may also print checkpoints (CI / CR lines: the inputs and the SQL states at a named stage inside
// it): the reference evaluator must equal the SQL states at each, and the stages must be exactly the ones the
// E line lists (`checkpoints`; none when it lists none).
// Since 20261008120000 an institution removal writes one system row per source, so decisions that differ in
// nothing but their id are routine. An E line may state them (`sameKeyRows`: "<kind>:<leg a's Plaid id>[+<leg
// b's>][@<removed candidate's date>]" → how many live decisions of user aa have that key at the end of the
// sequence): every one of them must have reached the reference evaluator under its own id, the same in
// every other field it reads, and come out of it with one status.
// Since 20261009120000 the inputs carry the owner's review obligations (reviewObligations), and the reader
// returns review metadata (`reviews`: which legs are under review, which partner the guard withheld, under
// which obligations, whether a coverage gap). The metadata is compared ON ITS OWN, after the legs: a reader
// that returns none, or a reference result that differs, is a failure named "review metadata". An E line may
// state by hand — at the end (`figures`, `reviews`) and at named checkpoints (`checkpointLegs`,
// `checkpointFigures`, `checkpointReviews`) — each leg's effect, bounds and partner, and EXACTLY which of
// aa's legs are under review and how. Those are checked against the reference result, which the SQL states
// were just required to equal.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const [compiled, actualPath] = process.argv.slice(2);
const { evaluateCardPayments } = require(path.join(compiled, 'services', 'cardPaymentMatching.js'));
const lines = fs.readFileSync(actualPath, 'utf8').split(/\r?\n/);
const AA = '00000000-0000-4000-8000-0000000000aa';

const scenarios = new Map();
const get = (name) => {
  if (!scenarios.has(name)) scenarios.set(name, { steps: [], inputs: {}, states: {}, expect: null, checkpoints: new Map() });
  return scenarios.get(name);
};
for (const line of lines) {
  const [tag, name, a, ...rest] = line.split('|');
  if (tag === 'S') get(name).steps.push(rest.join('|'));
  else if (tag === 'I') get(name).inputs[a] = JSON.parse(rest.join('|'));
  else if (tag === 'R') get(name).states[a] = JSON.parse(rest.join('|'));
  else if (tag === 'E') get(name).expect = JSON.parse([a, ...rest].join('|'));
  else if (tag === 'CI' || tag === 'CR') {
    // <scenario>|<stage>|<user>|<json>
    const stage = get(name).checkpoints.get(a) ?? { inputs: {}, states: {} };
    stage[tag === 'CI' ? 'inputs' : 'states'][rest[0]] = JSON.parse(rest.slice(1).join('|'));
    get(name).checkpoints.set(a, stage);
  }
}

let failures = 0;
let compared = 0;
let atCheckpoints = 0;
const fail = (msg) => {
  failures += 1;
  console.log(`FAIL  ${msg}`);
};
// One user's SQL states (a reader's result) against the reference evaluator's output for the same inputs.
const sameAsReference = (label, got, want) => {
  compared += 1;
  if (!got || !got.fresh) {
    fail(`${label}: the reader returned no fresh states`);
    return false;
  }
  try {
    assert.deepStrictEqual(
      { legs: got.legs, decisions: got.decisions, supersededTransactionIds: got.supersededTransactionIds },
      { legs: want.legs, decisions: want.decisions, supersededTransactionIds: want.supersededTransactionIds }
    );
  } catch (err) {
    fail(`${label}: SQL states differ from the reference evaluator on the RPC-written decisions\n${err.message.split('\n').slice(0, 20).join('\n')}`);
  }
  // The review metadata, on its own. A reader that returns none has not said which legs the guard withheld.
  if (!Array.isArray(got.reviews)) {
    fail(`${label}: review metadata: the reader returned no \`reviews\``);
  } else {
    try {
      assert.deepStrictEqual(got.reviews, want.reviews);
    } catch (err) {
      fail(`${label}: review metadata: SQL \`reviews\` differ from the reference evaluator\n${err.message.split('\n').slice(0, 20).join('\n')}`);
    }
  }
  return true;
};
// Hand-written expectations of one evaluation of user aa (the end of a sequence, or a checkpoint), checked
// against the reference result: state/reason, figures, and the review metadata.
const plaidOf = (input) => new Map(input.transactions.map((t) => [t.id, t.plaidTransactionId]));
const idOf = (input) => new Map(input.transactions.map((t) => [t.plaidTransactionId, t.id]));
const checkExpected = (label, input, want, expected) => {
  const ids = idOf(input);
  const plaids = plaidOf(input);
  const legs = new Map(want.legs.map((l) => [l.transactionId, l]));
  const name = (id) => (id === null || id === undefined ? '-' : plaids.get(id) ?? `(unknown ${id})`);
  for (const [plaid, expectedLeg] of Object.entries(expected.legs ?? {})) {
    const leg = legs.get(ids.get(plaid));
    const got = leg ? `${leg.state}/${leg.reason}` : '(no leg)';
    if (got !== expectedLeg) fail(`${label}: leg ${plaid} is ${got} under the reference evaluator, expected ${expectedLeg}`);
  }
  for (const [plaid, expectedFigure] of Object.entries(expected.figures ?? {})) {
    const leg = legs.get(ids.get(plaid));
    const got = leg ? `${leg.effectCents === null ? 'null' : leg.effectCents}[${leg.lowCents}..${leg.highCents}]>${name(leg.partnerTransactionId)}` : '(no leg)';
    if (got !== expectedFigure) fail(`${label}: figures: leg ${plaid} is ${got} under the reference evaluator, expected ${expectedFigure}`);
  }
  if (expected.reviews !== undefined) {
    const got = Object.fromEntries(
      (want.reviews ?? []).map((r) => [name(r.transactionId), `withheld=${name(r.withheldPartnerTransactionId)},obligations=${r.obligationIds.length},gap=${r.coverageGap ? 't' : 'f'}`])
    );
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    try {
      assert.deepStrictEqual(sorted(got), sorted(expected.reviews));
    } catch {
      fail(`${label}: review metadata: the legs under review are ${JSON.stringify(sorted(got))} under the reference evaluator, expected EXACTLY ${JSON.stringify(sorted(expected.reviews))}`);
    }
  }
};
for (const [name, sc] of scenarios) {
  if (!sc.expect) {
    fail(`${name}: no expectation line`);
    continue;
  }
  const byPlaid = new Map();
  const oracleLegs = new Map();
  let live = 0;
  // aa's live decisions by kind, leg references and removed-candidate date, each with the reference evaluator's result.
  const sameKey = new Map();
  for (const [user, input] of Object.entries(sc.inputs)) {
    const want = evaluateCardPayments(input);
    if (!sameAsReference(`${name} user ${user}`, sc.states[user], want)) continue;
    for (const t of input.transactions) byPlaid.set(t.plaidTransactionId, t.id);
    for (const l of want.legs) oracleLegs.set(l.transactionId, l);
    if (user !== AA) continue;
    checkExpected(name, input, want, { figures: sc.expect.figures, reviews: sc.expect.reviews });
    // Only user aa calls the RPCs; count aa's live (non-superseded) decisions.
    const liveDecisions = input.decisions.filter((d) => d.userId === AA && d.supersededBy === null);
    live = liveDecisions.length;
    for (const d of liveDecisions) {
      const key = `${d.kind}:${d.a.plaidTransactionId}${d.b ? `+${d.b.plaidTransactionId}` : ''}${d.counterpartDate ? `@${d.counterpartDate}` : ''}`;
      const result = want.decisions.find((r) => r.decisionId === d.id);
      sameKey.set(key, [...(sameKey.get(key) ?? []), { d, status: result ? `${result.status}${result.detail === null ? '' : `/${result.detail}`}` : '(not reported)' }]);
    }
  }
  for (const [key, n] of Object.entries(sc.expect.sameKeyRows ?? {})) {
    const rows = sameKey.get(key) ?? [];
    const ids = new Set(rows.map((r) => r.d.id));
    const contents = new Set(rows.map((r) => JSON.stringify({ ...r.d, id: null, decidedSeq: null })));
    const statuses = new Set(rows.map((r) => r.status));
    if (rows.length !== n || ids.size !== n) fail(`${name}: ${rows.length} live decisions (${ids.size} ids) reached the reference evaluator as ${key}, expected ${n}`);
    else if (contents.size !== 1) fail(`${name}: the ${n} decisions ${key} differ in more than their id`);
    else if (statuses.size !== 1 || statuses.has('(not reported)')) fail(`${name}: the ${n} decisions ${key} come out of the reference evaluator as ${[...statuses].join(', ')}`);
  }
  // Checkpoints inside the sequence: exactly the stages the E line lists, each with both users' inputs and states.
  for (const [stage, cp] of sc.checkpoints) {
    for (const [user, input] of Object.entries(cp.inputs)) {
      atCheckpoints += 1;
      const want = evaluateCardPayments(input);
      if (!sameAsReference(`${name} at checkpoint '${stage}' user ${user}`, cp.states[user], want) || user !== AA) continue;
      checkExpected(`${name} at checkpoint '${stage}'`, input, want, {
        legs: sc.expect.checkpointLegs?.[stage],
        figures: sc.expect.checkpointFigures?.[stage],
        reviews: sc.expect.checkpointReviews?.[stage],
      });
    }
    if (Object.keys(cp.inputs).length !== 2) fail(`${name} at checkpoint '${stage}': the inputs of ${Object.keys(cp.inputs).length} users, expected 2`);
  }
  for (const key of ['checkpointLegs', 'checkpointFigures', 'checkpointReviews']) {
    for (const stage of Object.keys(sc.expect[key] ?? {})) {
      if (!sc.checkpoints.has(stage)) fail(`${name}: ${key} names the checkpoint '${stage}', which the sequence did not print`);
    }
  }
  try {
    assert.deepStrictEqual([...sc.checkpoints.keys()], sc.expect.checkpoints ?? []);
  } catch {
    fail(`${name}: checkpoints ${JSON.stringify([...sc.checkpoints.keys()])}, expected ${JSON.stringify(sc.expect.checkpoints ?? [])}`);
  }
  try {
    assert.deepStrictEqual(sc.steps, sc.expect.steps);
  } catch {
    fail(`${name}: RPC step outcomes ${JSON.stringify(sc.steps)}, expected ${JSON.stringify(sc.expect.steps)}`);
  }
  for (const [plaid, want] of Object.entries(sc.expect.legs)) {
    const leg = oracleLegs.get(byPlaid.get(plaid));
    const got = leg ? `${leg.state}/${leg.reason}` : '(no leg)';
    if (got !== want) fail(`${name}: leg ${plaid} is ${got} under the reference evaluator, expected ${want}`);
  }
  if (live !== sc.expect.liveDecisions) fail(`${name}: ${live} live decisions, expected ${sc.expect.liveDecisions}`);
}
console.log(
  `RPC sequences: ${scenarios.size} scenarios, ${compared} user evaluations compared ` +
    `(${compared - atCheckpoints} at the end of a sequence, ${atCheckpoints} at checkpoints inside one); ${failures} failures`
);
if (scenarios.size === 0 || failures > 0) process.exit(1);
console.log('PASS  RPC-written decisions evaluate identically in SQL and in the reference evaluator, with the expected outcomes');
