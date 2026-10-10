// Negative controls of the packet 2-A TypeScript code (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §11): the backend
// service, controller, worker and readers, the reference evaluator, and the review screen.
//
//   node supabase/tests/card_payment_recovery_review/mutations_ts.cjs            every mutant
//   node supabase/tests/card_payment_recovery_review/mutations_ts.cjs t05 t13    only ids starting with a prefix
//
// Each mutant alters ONE source file IN PLACE, runs ONE test file with vitest, and puts the original bytes back.
// After every mutant — and at the end, and when interrupted — the file's sha256 is compared with the one taken
// before: a file that is not restored stops the run with its path. Do not edit the sources while this runs.
//   DETECTED            the test file fails, and the NAMED test is among the failing ones
//   FAILED DIFFERENTLY  the test file fails, but the named test is not among the failing ones
//   SURVIVED            the test file passes
// Before any mutant, every test file a mutant names is run unmutated and must pass.
// Exit status 0 only when every mutant was DETECTED.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const filters = process.argv.slice(2);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const B = 'backend';
const F = 'frontend';
const SERVICE = 'backend/src/services/cardPaymentRecovery.ts';
const CONTROLLER = 'backend/src/controllers/cardPaymentRecoveryController.ts';
const WORKER = 'backend/src/workers/cardPaymentRecoveryWorker.ts';
const READER = 'backend/src/services/cardPaymentStateReader.ts';
const EVALUATOR = 'backend/src/services/cardPaymentMatching.ts';
const SCREEN = 'frontend/src/components/CardPaymentRecoveryReview.tsx';
const MODEL = 'frontend/src/lib/semanticModel.ts';

/** { id, description, file, edits [[from, to]…], workspace, test (file), expected (a failing test's name) } */
const MUTANTS = [
  {
    id: 't01_timeout_is_a_refusal', description: 'a request abandoned after its timeout is reported as "nothing was written, retry" (timeout treated as rollback)',
    file: SERVICE, workspace: B, test: 'src/services/cardPaymentRecovery.test.ts', expected: 'a timeout is an UNKNOWN outcome',
    edits: [[
      `    return { kind: 'outcome_unknown' };\n  }\n  if (code !== undefined && CANCELLED_CODES.has(code)) {`,
      `    return { kind: 'refused', code: 'retry', detail: null };\n  }\n  if (code !== undefined && CANCELLED_CODES.has(code)) {`,
    ]],
  },
  {
    id: 't02_cancel_is_an_error', description: 'a statement cancelled on the server is reported as an ordinary error, not an unknown outcome',
    file: SERVICE, workspace: B, test: 'src/services/cardPaymentRecovery.test.ts', expected: 'a statement cancelled on the server (57014) is an unknown outcome too',
    edits: [[`const CANCELLED_CODES = new Set(['57014', '57P01']);`, `const CANCELLED_CODES = new Set<string>([]);`]],
  },
  {
    id: 't03_database_message_forwarded', description: 'a refusal forwards the database\'s own message',
    file: SERVICE, workspace: B, test: 'src/services/cardPaymentRecovery.test.ts', expected: 'a refusal becomes a code and a fixed word, never the message',
    edits: [[`      return { kind: 'refused', code: refusal, detail };`, `      return { kind: 'refused', code: refusal, detail: message };`]],
  },
  {
    id: 't04_actions_switch_ignored', description: 'POST /actions runs although changes are switched off',
    file: CONTROLLER, workspace: B, test: 'src/controllers/cardPaymentRecoveryController.test.ts', expected: 'is refused with 403 recovery_actions_disabled and makes no database call',
    edits: [[`    if (!env.cardPaymentRecoveryActionsEnabled) {\n      res.status(403).json({\n        error: 'Changing a payment from review is switched off.`, `    if (env.cardPaymentRecoveryActionsEnabled === null) {\n      res.status(403).json({\n        error: 'Changing a payment from review is switched off.`]],
  },
  {
    id: 't05_switch_blocks_the_refresh', description: 'switching changes off also refuses the refresh-only retry (unsafe action-disable)',
    file: CONTROLLER, workspace: B, test: 'src/controllers/cardPaymentRecoveryController.test.ts', expected: 'the review, a receipt and the refresh-only retry stay available',
    edits: [[
      `export async function postRefreshRetry(req: Request, res: Response, next: NextFunction) {\n  try {\n`,
      `export async function postRefreshRetry(req: Request, res: Response, next: NextFunction) {\n  try {\n    if (!env.cardPaymentRecoveryActionsEnabled) {\n      res.status(403).json({ error: 'off', code: 'recovery_actions_disabled' });\n      return;\n    }\n`,
    ]],
  },
  {
    id: 't06_owner_from_the_body', description: 'the owner of an action is read from the request body when it names one',
    file: CONTROLLER, workspace: B, test: 'src/controllers/cardPaymentRecoveryController.test.ts', expected: 'a forged owner anywhere in the body changes nothing',
    edits: [[
      `    const result = await applyRecoveryAction(req.user!.id, request);`,
      `    const result = await applyRecoveryAction((req.body as { userId?: string }).userId ?? req.user!.id, request);`,
    ]],
  },
  {
    id: 't07_worker_needs_the_sync_flag', description: 'the worker does nothing unless sync evaluation is enabled (sync-dependent delivery)',
    file: WORKER, workspace: B, test: 'src/workers/cardPaymentRecoveryWorker.test.ts', expected: 'claims once with its token and the bounded limit',
    edits: [[
      `    const summary: RecoveryPollSummary = { claim: 'ok', claimed: 0, fresh: 0, pending: 0, superseded: 0, leaseLost: 0, unanswered: 0 };\n`,
      `    const summary: RecoveryPollSummary = { claim: 'ok', claimed: 0, fresh: 0, pending: 0, superseded: 0, leaseLost: 0, unanswered: 0 };\n    if (!(await import('../config/env')).env.cardPaymentSyncEvaluationEnabled) return summary;\n`,
    ]],
  },
  {
    id: 't08_unbounded_claims', description: 'the worker asks for as many claims as it is configured with',
    file: WORKER, workspace: B, test: 'src/workers/cardPaymentRecoveryWorker.test.ts', expected: 'never asks for more than ten claims',
    edits: [[
      `  const claimLimit = Math.max(1, Math.min(options.claimLimit ?? RECOVERY_WORKER_CLAIM_LIMIT, RECOVERY_WORKER_CLAIM_LIMIT));`,
      `  const claimLimit = options.claimLimit ?? RECOVERY_WORKER_CLAIM_LIMIT;`,
    ]],
  },
  {
    id: 't09_no_poll_at_start', description: 'the worker waits a poll interval before its first poll: outstanding work is not found at restart',
    file: WORKER, workspace: B, test: 'src/workers/cardPaymentRecoveryWorker.test.ts', expected: 'start polls AT ONCE',
    edits: [[
      `      // The first poll runs now: whatever was outstanding before this process started is found here.\n      void poll();`,
      `      // The first poll runs now: whatever was outstanding before this process started is found here.\n      scheduleNext(pollIntervalMs);`,
    ]],
  },
  {
    id: 't10_unknown_contract_accepted', description: 'the state reader accepts a payload of an evaluator contract it does not know (stale or unknown rules read as figures)',
    file: READER, workspace: B, test: 'src/services/cardPaymentStateReader.contract.test.ts', expected: 'refuses a contract this backend does not know',
    edits: [[`  if (payload.evaluatorContract !== undefined && payload.evaluatorContract !== SUPPORTED_EVALUATOR_CONTRACT) return null;\n`, ``]],
  },
  {
    id: 't11_reference_asymmetric', description: 'the reference evaluator withholds only the affected leg\'s side of the pair',
    file: EVALUATOR, workspace: B, test: 'src/services/cardPaymentMatching.relinkReview.test.ts', expected: 'E7 — an UNRELATED payment on the 11th would win',
    edits: [[
      `  for (const legId of guardWithheld.keys()) tier1.delete(legId);`,
      `  for (const legId of guardWithheld.keys()) if (reviewAnchors.some((a) => a.rowId === legId)) tier1.delete(legId);`,
    ]],
  },
  {
    id: 't12_reference_record_first', description: 'the reference evaluator reads a removed-card record before the guard result',
    file: EVALUATOR, workspace: B, test: 'src/services/cardPaymentMatching.relinkReview.test.ts', expected: 'E7 — an UNRELATED payment on the 11th would win',
    edits: [[`    } else if (guardWithheld.has(leg.txn.id)) {`, `    } else if (guardWithheld.has(leg.txn.id) && !removedCard.has(leg.txn.id)) {`]],
  },
  {
    id: 't13_unknown_outcome_shown_as_failure', description: 'the screen reports a request that got no answer as "nothing was saved"',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'a timeout: it says the outcome is not known',
    edits: [[`        } else if (code === OUTCOME_UNKNOWN || status === null || status >= 500) {`, `        } else if (code === 'never') {`]],
  },
  {
    id: 't19_no_receipt_means_not_saved', description: 'the screen takes "no receipt is visible" for "it was not saved" and drops the operation (the v1 defect)',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'NO RECEIPT IS NOT A "NO"',
    edits: [[
      `      else await stillUnknownOperation(recordedFor, pending, 'no_record');`,
      `      else await settleOperation(recordedFor, pending, 'It was not saved.', 'status', false);`,
    ]],
  },
  {
    id: 't20_resend_under_a_new_operation_id', description: 'sending again uses a NEW operation id: a second action instead of a replay of the first',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'the SAME request can be sent again under the SAME operation id',
    edits: [[
      `void send(operation.operationId, operation.label, operation.request, true)`,
      `void send(newOperationId(), operation.label, operation.request === null ? null : { ...operation.request, operationId: newOperationId() }, true)`,
    ]],
  },
  {
    id: 't21_queued_shown_as_running', description: 'a queued refresh is described as being carried out',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'shows no review and no figure, says so, and offers the refresh',
    edits: [[
      `'A refresh is queued. The figures are not up to date. No figure is shown.'`,
      `'The figures are being brought up to date. No figure is shown.'`,
    ]],
  },
  {
    id: 't22_lookup_under_any_login', description: 'the receipt of an operation is asked for under whatever login is current',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'a different login since the request was sent',
    edits: [[`getRecoveryAction(pending.operationId, verifyOwnership)`, `getRecoveryAction(pending.operationId)`]],
  },
  {
    id: 't23_try_again_ends_the_unknown', description: 'a "try again later" answer to a resent operation is taken for "nothing was saved"',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'sending it again: "try again later" leaves it unknown',
    edits: [[`        } else if (again && (code === null || UNDECIDED_REFUSALS.has(code))) {`, `        } else if (again && code === 'never') {`]],
  },
  {
    id: 't24_graph_source_may_name_a_decision', description: 'the backend accepts a graph-observed source that names a decision (a decision invented for it)',
    file: SERVICE, workspace: B, test: 'src/services/cardPaymentRecovery.test.ts', expected: 'refuses a graph-observed source that names a decision',
    edits: [[`    if (decisionId !== null || decisionKind !== null) return null;`, `    if (decisionKind === 'never') return null;`]],
  },
  {
    id: 't25_source_without_its_decision', description: 'the screen model accepts a decision-backed source that names no decision',
    file: MODEL, workspace: F, test: 'src/lib/semanticModel.recovery.test.ts', expected: 'is invalid for a decision-backed source with no decision',
    edits: [[
      `  if (value.evidence_kind === 'graph_source' ? value.decision_id !== null : !isId(value.decision_id)) return null;`,
      `  if (value.evidence_kind === 'graph_source' ? value.decision_id !== null : value.decision_id !== null && !isId(value.decision_id)) return null;`,
    ]],
  },
  {
    id: 't14_screen_sends_under_any_login', description: 'the screen sends a change under whatever login is current',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: '"Match with this" sends ONE request',
    edits: [[
      `    (session: Session) => owner !== null && owner.sessionId !== null && session.user.id === owner.userId && decodeSessionId(session.access_token) === owner.sessionId,`,
      `    (session: Session) => owner !== null && session !== null,`,
    ]],
  },
  {
    id: 't15_stale_list_shown_as_empty', description: 'while the figures are not current the screen shows an ordinary (empty) review and no refresh',
    file: SCREEN, workspace: F, test: 'src/components/CardPaymentRecoveryReview.test.tsx', expected: 'shows no review and no figure, says so, and offers the refresh',
    edits: [[`  if (!data.fresh) {\n    return (`, `  if (!data.fresh && data.affected_payment_count < 0) {\n    return (`]],
  },
  {
    id: 't16_unknown_reading_shown', description: 'the screen model accepts a reading (state/reason) this build does not know',
    file: MODEL, workspace: F, test: 'src/lib/semanticModel.recovery.test.ts', expected: 'is invalid for a reason this build does not know',
    edits: [[`  if (!KNOWN_REVIEW_READINGS.has(\`\${value.state}/\${value.reason}\`)) return null;\n`, ``]],
  },
  {
    id: 't17_candidate_not_a_suggestion', description: 'the screen model accepts a candidate that is not marked as a suggestion',
    file: MODEL, workspace: F, test: 'src/lib/semanticModel.recovery.test.ts', expected: 'is invalid for a candidate not marked as a suggestion',
    edits: [[`  if (value.suggestion_only !== true) return null;\n`, ``]],
  },
  {
    id: 't18_unknown_summary_reason_counted', description: 'the summary accepts an unresolved reason this build does not know',
    file: MODEL, workspace: F, test: 'src/lib/semanticModel.recovery.test.ts', expected: 'an unknown reason makes the whole summary unusable',
    edits: [[`    if (!KNOWN_UNRESOLVED_REASONS.has(reason)) return null;\n`, ``]],
  },
];

const ENV = {
  ...process.env,
  FRONTEND_URL: 'http://localhost:5173',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  PLAID_CLIENT_ID: 'test-client-id',
  PLAID_SECRET: 'test-secret',
};
function vitest(workspace, test) {
  const result = spawnSync('npx', ['vitest', 'run', test], { cwd: path.join(ROOT, workspace), env: ENV, encoding: 'utf8', shell: true, timeout: 600000 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
function mutate(text, edits, id) {
  // The sources are checked out with CRLF on Windows; the anchors are written with LF.
  const crlf = text.includes('\r\n');
  let s = text.replace(/\r\n/g, '\n');
  for (const [from, to] of edits) {
    const i = s.indexOf(from);
    if (i < 0) throw new Error(`${id}: anchor not found: ${from.slice(0, 70)}`);
    if (s.indexOf(from, i + 1) >= 0) throw new Error(`${id}: anchor found more than once: ${from.slice(0, 70)}`);
    s = s.slice(0, i) + to + s.slice(i + from.length);
  }
  return crlf ? s.replace(/\n/g, '\r\n') : s;
}

const selected = MUTANTS.filter((m) => filters.length === 0 || filters.some((f) => m.id.startsWith(f)));
if (selected.length === 0) {
  console.log('FAILED: no mutant matched');
  process.exit(1);
}
// Every anchor must exist before anything is touched.
const originals = new Map();
for (const m of selected) {
  const file = path.join(ROOT, m.file);
  if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(file));
  mutate(originals.get(m.file).toString('utf8'), m.edits, m.id);
}
const digests = new Map([...originals].map(([file, bytes]) => [file, sha(bytes)]));
function restoreAll() {
  for (const [file, bytes] of originals) {
    const p = path.join(ROOT, file);
    if (sha(fs.readFileSync(p)) !== digests.get(file)) fs.writeFileSync(p, bytes);
    if (sha(fs.readFileSync(p)) !== digests.get(file)) {
      console.log(`FAILED: ${file} could not be restored to its original bytes`);
      process.exit(3);
    }
  }
}
process.on('SIGINT', () => {
  restoreAll();
  process.exit(130);
});

console.log('1. BASELINE (unmutated)');
const baselines = new Map();
for (const m of selected) {
  const key = `${m.workspace}|${m.test}`;
  if (baselines.has(key)) continue;
  const run = vitest(m.workspace, m.test);
  baselines.set(key, run.status === 0);
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'}  ${m.workspace}/${m.test} (unmutated)`);
  if (run.status !== 0) {
    console.log(run.output.split('\n').slice(-25).join('\n'));
    console.log('the controls cannot be run');
    process.exit(1);
  }
}

console.log('\n2. MUTANTS');
const counts = { detected: 0, different: 0, survived: 0 };
const rows = [];
try {
  for (const m of selected) {
    const file = path.join(ROOT, m.file);
    const original = originals.get(m.file);
    let result;
    let seen = '';
    try {
      fs.writeFileSync(file, mutate(original.toString('utf8'), m.edits, m.id));
      const run = vitest(m.workspace, m.test);
      if (run.status === 0) result = 'survived';
      else {
        const failing = run.output.split('\n').filter((line) => /^\s*(×|FAIL)\s/.test(line) || line.includes(' × '));
        seen = (failing[0] ?? run.output.split('\n').find((l) => /Error/.test(l)) ?? '').trim().slice(0, 200);
        result = failing.some((line) => line.includes(m.expected)) ? 'detected' : 'different';
      }
    } finally {
      fs.writeFileSync(file, original);
      if (sha(fs.readFileSync(file)) !== digests.get(m.file)) {
        console.log(`FAILED: ${m.file} was not restored after ${m.id}`);
        process.exit(3);
      }
    }
    counts[result] += 1;
    rows.push([m.id, result, `${m.workspace}/${m.test}`, m.description].join('\t'));
    if (result === 'detected') console.log(`DETECTED            ${m.id} — ${m.description}\n                    by: ${m.expected}`);
    else if (result === 'different') console.log(`FAILED DIFFERENTLY  ${m.id} — ${m.description}\n                    expected: ${m.expected}\n                    got:      ${seen}`);
    else console.log(`SURVIVED            ${m.id} — ${m.description}\n                    expected: ${m.expected}`);
  }
} finally {
  restoreAll();
}

console.log('\n3. RESTORED');
for (const [file, digest] of digests) console.log(`sha256 ${digest}  ${file}  (as before the run)`);
if (process.env.LOGDIR) {
  fs.mkdirSync(process.env.LOGDIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.LOGDIR, 'summary_ts.tsv'), rows.join('\n') + '\n');
}
console.log(`\nTypeScript mutants: ${selected.length} run — ${counts.detected} detected, ${counts.different} failed differently, ${counts.survived} survived`);
process.exit(counts.detected === selected.length ? 0 : 1);
