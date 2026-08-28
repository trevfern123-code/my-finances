/**
 * One-off, manually-invoked backfill for Plaid access-token encryption (Phase 3).
 * See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §22 for the full design this implements — read
 * that before changing anything here.
 *
 * NOT part of the request-serving code path. Never imported by `index.ts` or anything else the
 * running Express server's module graph reaches — its presence in a deploy is inert. As a second,
 * redundant safety net, this file also refuses to do anything unless invoked directly as the
 * process's own entrypoint (`require.main === module`, checked at the bottom of this file) — an
 * accidental future `import` of this module from elsewhere in the codebase would load its
 * functions but never trigger `main()`.
 *
 * Manual, one-off, idempotent, concurrency-safe, safe to interrupt and rerun, structurally
 * incapable of writing or clearing plaintext, and halts on the first verification failure rather
 * than continuing past it. Defaults to a dry run — no `--apply` flag means no writes, ever.
 */

import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import {
  decryptAccessToken,
  encryptAccessToken,
  getKeyRing,
  GcmAuthenticationError,
  MalformedAuthTagError,
  MalformedCiphertextError,
  MalformedNonceError,
  UnknownKeyIdError,
  type EncryptedAccessToken,
} from '../services/tokenEncryption';
import { verifyAccessTokenLive } from '../services/plaidService';
import { summarizeErrorSafely } from '../services/errorSanitizer';

const CONFIRM_TOKEN = 'BACKFILL_PLAID_TOKENS';
const EXPECTED_CURRENT_KEY_ID = 'RAILWAY_PROD_V1';
const CONSTRAINT_TOKEN_PRESENT = 'plaid_items_token_present';
const CONSTRAINT_ENCRYPTED_COMPLETE = 'plaid_items_encrypted_token_complete';
const TRANSIENT_RETRY_LIMIT = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

const TOKEN_ROW_COLUMNS =
  'id, access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version';

interface TokenRow {
  id: string;
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

// ---- Structured, allow-listed logging (§22 "Logging") ----------------------------------------
//
// Every log line is built from exactly these three named fields — never a spread of a row, a raw
// error, or `process.env`. Deliberately stricter than the rest of this codebase (which does log
// the *external* Plaid item_id in a couple of places, e.g. webhookController.ts): this script
// never logs it at all, since it has no operational need to here and the smaller allow-list is
// easy to audit in isolation.

interface LogFields {
  id?: string;
  stage: string;
  outcome: string;
}

export function logEntry(fields: LogFields): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      id: fields.id,
      stage: fields.stage,
      outcome: fields.outcome,
    })
  );
}

// ---- Three separate concepts (§22) ------------------------------------------------------------
//
// Target identity (a `plaid_items.id`) is supplied explicitly by the caller and never discovered
// by a broad query. Storage state is always read fresh from the database — never cached across
// an invocation, and never treated as a proxy for verification result. Verification result is
// always computed fresh too, every invocation, for every target, regardless of storage state.

export type StorageState =
  | { kind: 'plaintext_only' }
  | { kind: 'encrypted'; keyId: string; encVersion: number; plaintextAlsoPresent: boolean }
  | { kind: 'partial' }
  | { kind: 'missing_both' };

export function classifyStorageState(row: TokenRow): StorageState {
  const encFields = [
    row.access_token_ciphertext,
    row.access_token_nonce,
    row.access_token_auth_tag,
    row.access_token_key_id,
    row.access_token_enc_version,
  ];
  const encCount = encFields.filter((f) => f !== null).length;

  if (encCount === 5) {
    return {
      kind: 'encrypted',
      keyId: row.access_token_key_id as string,
      encVersion: row.access_token_enc_version as number,
      plaintextAlsoPresent: row.access_token !== null,
    };
  }
  if (encCount === 0) {
    return row.access_token === null ? { kind: 'missing_both' } : { kind: 'plaintext_only' };
  }
  // Shouldn't be reachable given the plaid_items_encrypted_token_complete check constraint, but
  // detected explicitly rather than assumed impossible — see the constraint-existence preflight
  // check below, which is exactly what's meant to prevent this from ever being reachable.
  return { kind: 'partial' };
}

// ---- CLI parsing (pure, no I/O — §22 "Command-line interface") --------------------------------

export interface ParsedArgs {
  targetIds: string[];
  expectedTotal: number;
  expectedPlaidEnv: string;
  apply: boolean;
  confirm: string | null;
}

export class ArgError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new ArgError(`Unrecognized argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ArgError(`Missing value for --${key}.`);
    }
    opts[key] = value;
    i++;
  }

  const targetIdsRaw = opts['target-ids'];
  if (typeof targetIdsRaw !== 'string' || targetIdsRaw.trim() === '') {
    throw new ArgError('--target-ids is required: a comma-separated list of exact plaid_items.id values.');
  }
  const targetIds = targetIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (targetIds.length === 0) {
    throw new ArgError('--target-ids must name at least one row.');
  }
  if (new Set(targetIds).size !== targetIds.length) {
    throw new ArgError('--target-ids contains a duplicate id.');
  }

  const expectedTotalRaw = opts['expected-total'];
  if (typeof expectedTotalRaw !== 'string') {
    throw new ArgError('--expected-total is required.');
  }
  const expectedTotal = Number(expectedTotalRaw);
  if (!Number.isInteger(expectedTotal) || expectedTotal < 0) {
    throw new ArgError('--expected-total must be a non-negative integer.');
  }

  const expectedPlaidEnv = opts['expected-plaid-env'];
  if (typeof expectedPlaidEnv !== 'string' || expectedPlaidEnv.trim() === '') {
    throw new ArgError('--expected-plaid-env is required.');
  }

  const apply = opts.apply === true;
  const confirm = typeof opts.confirm === 'string' ? opts.confirm : null;

  if (apply && confirm !== CONFIRM_TOKEN) {
    throw new ArgError(`--apply requires --confirm ${CONFIRM_TOKEN} (exact match) to also be present.`);
  }

  return { targetIds, expectedTotal, expectedPlaidEnv, apply, confirm };
}

// ---- Preflight (§22 "Command-line interface" / "Preflight") -----------------------------------
//
// Runs identically for dry-run and apply — apply is "dry-run, plus writes if it passes," not a
// separate, less-checked path. Nothing here writes anything.

export interface PreflightResult {
  ok: boolean;
  failures: string[];
  targetStates: Map<string, StorageState>;
}

async function checkPhase1ConstraintsExist(): Promise<{ ok: boolean; detail: string }> {
  // Best-effort and deliberately fails closed: PostgREST only exposes information_schema if the
  // project's exposed-schema configuration includes it, which this script has no way to guarantee
  // from the client side without adding a new database function — itself a Supabase schema
  // change, out of scope for a read-only preflight check. If this query fails for *any* reason
  // (schema not exposed, permission denied, network error), we do NOT assume the constraints are
  // fine — we report the check as failed and ask for manual confirmation instead, exactly like
  // every other unverifiable safety check in this script.
  try {
    const { data, error } = await supabaseAdmin
      .from('information_schema.table_constraints')
      .select('constraint_name')
      .eq('table_name', 'plaid_items')
      .in('constraint_name', [CONSTRAINT_TOKEN_PRESENT, CONSTRAINT_ENCRYPTED_COMPLETE]);
    if (error) throw error;
    const found = new Set((data ?? []).map((r: { constraint_name: string }) => r.constraint_name));
    const missing = [CONSTRAINT_TOKEN_PRESENT, CONSTRAINT_ENCRYPTED_COMPLETE].filter((c) => !found.has(c));
    if (missing.length > 0) {
      return { ok: false, detail: `Missing expected Phase 1 constraint(s): ${missing.join(', ')}.` };
    }
    return { ok: true, detail: 'Both Phase 1 constraints confirmed present.' };
  } catch {
    return {
      ok: false,
      detail:
        'Unable to verify Phase 1 constraints via the Supabase REST API (information_schema may not be exposed to this client). Confirm manually before proceeding.',
    };
  }
}

export async function runPreflight(args: ParsedArgs): Promise<PreflightResult> {
  const failures: string[] = [];
  const targetStates = new Map<string, StorageState>();

  if (env.plaidEnv !== args.expectedPlaidEnv) {
    failures.push(`Expected Plaid environment "${args.expectedPlaidEnv}", configured environment is "${env.plaidEnv}".`);
  }

  let currentKeyId: string;
  try {
    currentKeyId = getKeyRing().currentKeyId;
  } catch (err) {
    failures.push(`Unable to load the encryption key ring: ${summarizeErrorSafely(err).message}`);
    currentKeyId = '';
  }
  if (currentKeyId && currentKeyId !== EXPECTED_CURRENT_KEY_ID) {
    failures.push(`Expected current key id "${EXPECTED_CURRENT_KEY_ID}", configured current key id is "${currentKeyId}".`);
  }

  const { data: allRows, error: fetchError } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS);
  if (fetchError) {
    failures.push(`Unable to read plaid_items: ${fetchError.message}`);
    return { ok: false, failures, targetStates };
  }
  const rows = (allRows ?? []) as TokenRow[];

  if (rows.length !== args.expectedTotal) {
    failures.push(`Expected total plaid_items count ${args.expectedTotal}, found ${rows.length}.`);
  }

  let anyPartialOrMissing = false;
  let anyEncryptedOnly = false;
  for (const row of rows) {
    const state = classifyStorageState(row);
    if (state.kind === 'partial' || state.kind === 'missing_both') anyPartialOrMissing = true;
    if (state.kind === 'encrypted' && !state.plaintextAlsoPresent) anyEncryptedOnly = true;
  }
  if (anyPartialOrMissing) {
    failures.push('At least one plaid_items row has a partial or missing token representation.');
  }
  if (anyEncryptedOnly) {
    // The documented data-level proxy for "Phase 2b hasn't begun yet" (§22): this *infers*
    // Phase 2a is still the deployed write behavior from the absence of any encrypted-only row —
    // it does not, and cannot, directly inspect the deployed server's source code.
    failures.push(
      'At least one plaid_items row is already encrypted-only (no plaintext). This is the data-level signal that Phase 2b may already be active — stop and confirm before proceeding, since this proposal assumes Phase 2a dual-write is still the deployed behavior.'
    );
  }

  const rowsById = new Map(rows.map((r) => [r.id, r]));
  for (const id of args.targetIds) {
    const row = rowsById.get(id);
    if (!row) {
      failures.push(`Target ${id} was not found.`);
      continue;
    }
    const state = classifyStorageState(row);
    targetStates.set(id, state);
    if (row.access_token === null) {
      failures.push(`Target ${id} has no plaintext present — cannot verify against it.`);
    }
  }

  const constraintCheck = await checkPhase1ConstraintsExist();
  if (!constraintCheck.ok) {
    failures.push(constraintCheck.detail);
  }

  return { ok: failures.length === 0, failures, targetStates };
}

// ---- Verification helpers ----------------------------------------------------------------------

async function rereadRow(id: string): Promise<TokenRow | null> {
  const { data, error } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

/** The guarded conditional update (§22 "Verification model"): `access_token` never appears in
 *  this `set` list — the script is structurally incapable of writing or clearing plaintext, not
 *  merely instructed not to. Returns the number of rows actually affected so the caller can tell
 *  a win from a lost race. */
async function guardedEncryptUpdate(id: string, enc: EncryptedAccessToken): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .update({
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('access_token_key_id', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length;
}

function classifyDecryptError(err: unknown): string {
  if (err instanceof UnknownKeyIdError) return 'unknown_key';
  if (err instanceof MalformedNonceError || err instanceof MalformedAuthTagError || err instanceof MalformedCiphertextError) {
    return 'malformed_ciphertext';
  }
  if (err instanceof GcmAuthenticationError) return 'crypto_mismatch';
  return 'decrypt_error';
}

function isNetworkLikeError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  const message = (err as { message?: unknown })?.message;
  return typeof message === 'string' && /timeout/i.test(message);
}

/** Only Plaid's `itemGet` call (network) can fail transiently — every other step in this script
 *  is pure local computation with no transient-failure category at all (§22 "Retry policy"). */
function classifyPlaidFailure(err: unknown): 'transient' | 'non_transient' {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number' && (status === 429 || status >= 500)) return 'transient';
  if (isNetworkLikeError(err)) return 'transient';
  return 'non_transient';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HaltError extends Error {
  targetId: string;
  reason: string;
  constructor(targetId: string, reason: string) {
    super(`Halting on target ${targetId}: ${reason}`);
    this.targetId = targetId;
    this.reason = reason;
  }
}

/** Bounded retry, transient failures only (§22 "Retry policy"). Any non-transient failure, or a
 *  transient one that exhausts its retry budget, throws `HaltError` — never silently skipped,
 *  never allowed to fall through as a false "verified." `baseDelayMs` is a parameter (rather than
 *  always reading the module constant) specifically so tests can exercise real retry attempts
 *  without real waiting. */
export async function verifyLiveWithRetry(id: string, accessToken: string, baseDelayMs = TRANSIENT_RETRY_BASE_DELAY_MS): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await verifyAccessTokenLive(accessToken);
      return;
    } catch (err) {
      attempt++;
      const classification = classifyPlaidFailure(err);
      if (classification === 'transient' && attempt <= TRANSIENT_RETRY_LIMIT) {
        logEntry({ id, stage: 'verify_plaid_retry', outcome: `retrying_attempt_${attempt}` });
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      const reason = classification === 'transient' ? 'transient_retry_exhausted' : 'credential_rejected';
      throw new HaltError(id, reason);
    }
  }
}

// ---- Per-target processing (§22 "Resumable processing") ---------------------------------------

export interface TargetOutcome {
  id: string;
  outcome: 'verified' | 'skipped_dry_run';
}

export async function processTarget(id: string, apply: boolean): Promise<TargetOutcome> {
  logEntry({ id, stage: 'reread_initial', outcome: 'started' });
  const initialRow = await rereadRow(id);
  if (!initialRow) throw new HaltError(id, 'target_not_found');

  const initialState = classifyStorageState(initialRow);
  if (initialState.kind === 'partial' || initialState.kind === 'missing_both') {
    logEntry({ id, stage: 'reread_initial', outcome: `failed:${initialState.kind}` });
    throw new HaltError(id, initialState.kind);
  }

  const plaintextForCompare = initialRow.access_token;
  if (plaintextForCompare === null) {
    logEntry({ id, stage: 'reread_initial', outcome: 'failed:plaintext_missing' });
    throw new HaltError(id, 'plaintext_missing');
  }

  let verifyRow = initialRow;

  if (initialState.kind === 'plaintext_only') {
    if (!apply) {
      logEntry({ id, stage: 'done', outcome: 'skipped_dry_run' });
      return { id, outcome: 'skipped_dry_run' };
    }

    logEntry({ id, stage: 'encrypt', outcome: 'started' });
    const keyRing = getKeyRing();
    const enc = encryptAccessToken(plaintextForCompare, keyRing, id);

    // Local precheck: decrypt what we're about to write and compare it to the plaintext we hold
    // in memory, *before* it ever reaches the database — defense in depth against a same-process
    // crypto bug, never a substitute for the mandatory post-write, database-stored-ciphertext
    // verification below.
    const localCheck = decryptAccessToken(enc, keyRing, id);
    if (localCheck !== plaintextForCompare) {
      logEntry({ id, stage: 'encrypt', outcome: 'failed:local_precheck_mismatch' });
      throw new HaltError(id, 'local_precheck_mismatch');
    }

    logEntry({ id, stage: 'write', outcome: 'started' });
    const affected = await guardedEncryptUpdate(id, enc);
    logEntry({ id, stage: 'write', outcome: affected === 1 ? 'committed' : 'lost_race' });

    // Whether we won or lost the race, always reread the database's own current value — the
    // local `enc` object computed above is never itself the thing that gets verified.
    const rereadAfterWrite = await rereadRow(id);
    if (!rereadAfterWrite) throw new HaltError(id, 'target_not_found_after_write');
    verifyRow = rereadAfterWrite;

    const stateAfterWrite = classifyStorageState(verifyRow);
    if (stateAfterWrite.kind !== 'encrypted') {
      logEntry({ id, stage: 'reread_after_write', outcome: `failed:${stateAfterWrite.kind}` });
      throw new HaltError(id, `unexpected_state_after_write:${stateAfterWrite.kind}`);
    }
  }

  // From here on, every target — freshly encrypted just now, already encrypted from a prior run,
  // or the winner of a lost race above — goes through the exact same, unconditional verification.
  // A non-null access_token_key_id is never itself treated as proof a previous run verified it.
  logEntry({ id, stage: 'verify_decrypt', outcome: 'started' });
  const enc: EncryptedAccessToken = {
    ciphertextBase64: verifyRow.access_token_ciphertext as string,
    nonceBase64: verifyRow.access_token_nonce as string,
    authTagBase64: verifyRow.access_token_auth_tag as string,
    keyId: verifyRow.access_token_key_id as string,
    encVersion: verifyRow.access_token_enc_version as number,
  };
  let decrypted: string;
  try {
    decrypted = decryptAccessToken(enc, getKeyRing(), id);
  } catch (err) {
    const reason = classifyDecryptError(err);
    logEntry({ id, stage: 'verify_decrypt', outcome: `failed:${reason}` });
    throw new HaltError(id, reason);
  }

  logEntry({ id, stage: 'verify_compare', outcome: 'started' });
  if (decrypted !== plaintextForCompare) {
    logEntry({ id, stage: 'verify_compare', outcome: 'failed:plaintext_mismatch' });
    throw new HaltError(id, 'plaintext_mismatch');
  }

  logEntry({ id, stage: 'verify_plaid', outcome: 'started' });
  try {
    await verifyLiveWithRetry(id, decrypted);
  } catch (err) {
    if (err instanceof HaltError) {
      logEntry({ id, stage: 'verify_plaid', outcome: `failed:${err.reason}` });
    }
    throw err;
  }

  logEntry({ id, stage: 'done', outcome: 'verified' });
  return { id, outcome: 'verified' };
}

// ---- Signal handling (§22 "Interruption behavior") ---------------------------------------------

let interruptRequested = false;

function installSignalHandlers(): void {
  const onSignal = (signal: string) => {
    interruptRequested = true;
    logEntry({ stage: 'signal', outcome: `received:${signal}` });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

/** Exposed only for tests, which can't send this process a real OS signal. */
export function __setInterruptedForTests(value: boolean): void {
  interruptRequested = value;
}

// ---- Orchestration --------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logEntry({ stage: 'startup', outcome: `failed:${err instanceof Error ? err.message : 'invalid_arguments'}` });
    return 1;
  }

  installSignalHandlers();

  logEntry({ stage: 'preflight', outcome: 'started' });
  const preflight = await runPreflight(args);
  for (const failure of preflight.failures) {
    logEntry({ stage: 'preflight', outcome: `failed:${failure}` });
  }
  if (!preflight.ok) {
    logEntry({ stage: 'preflight', outcome: 'failed' });
    return 1;
  }
  logEntry({ stage: 'preflight', outcome: 'passed' });

  // Every target is processed on every invocation, dry-run or apply — dry-run still fully
  // rereads and reverifies any target that's already encrypted (read-only: `processTarget`'s own
  // `apply` flag governs whether it's allowed to write anything, not whether it verifies). Only
  // a plaintext-only target's *encryption* step is apply-gated.
  for (const id of args.targetIds) {
    if (interruptRequested) {
      logEntry({ id, stage: 'run', outcome: 'interrupted' });
      return 1;
    }
    try {
      await processTarget(id, args.apply);
    } catch (err) {
      if (err instanceof HaltError) {
        logEntry({ id: err.targetId, stage: 'run', outcome: `halted:${err.reason}` });
      } else {
        logEntry({ id, stage: 'run', outcome: `halted:${summarizeErrorSafely(err).name}` });
      }
      return 1;
    }
  }

  if (interruptRequested) {
    logEntry({ stage: 'run', outcome: 'interrupted' });
    return 1;
  }

  logEntry({ stage: 'done', outcome: args.apply ? 'all_targets_verified' : 'dry_run_complete' });
  return 0;
}

/* istanbul ignore next -- exercised via processes spawned in manual/production use, not unit tests */
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      logEntry({ stage: 'fatal', outcome: `failed:${summarizeErrorSafely(err).name}` });
      process.exitCode = 1;
    });
}
