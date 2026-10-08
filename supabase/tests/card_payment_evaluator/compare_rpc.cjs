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
  return true;
};
for (const [name, sc] of scenarios) {
  if (!sc.expect) {
    fail(`${name}: no expectation line`);
    continue;
  }
  const byPlaid = new Map();
  const oracleLegs = new Map();
  let live = 0;
  for (const [user, input] of Object.entries(sc.inputs)) {
    const want = evaluateCardPayments(input);
    if (!sameAsReference(`${name} user ${user}`, sc.states[user], want)) continue;
    for (const t of input.transactions) byPlaid.set(t.plaidTransactionId, t.id);
    for (const l of want.legs) oracleLegs.set(l.transactionId, l);
    // Only user aa calls the RPCs; count aa's live (non-superseded) decisions.
    if (user === AA) live = input.decisions.filter((d) => d.userId === AA && d.supersededBy === null).length;
  }
  // Checkpoints inside the sequence: exactly the stages the E line lists, each with both users' inputs and states.
  for (const [stage, cp] of sc.checkpoints) {
    for (const [user, input] of Object.entries(cp.inputs)) {
      atCheckpoints += 1;
      sameAsReference(`${name} at checkpoint '${stage}' user ${user}`, cp.states[user], evaluateCardPayments(input));
    }
    if (Object.keys(cp.inputs).length !== 2) fail(`${name} at checkpoint '${stage}': the inputs of ${Object.keys(cp.inputs).length} users, expected 2`);
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
