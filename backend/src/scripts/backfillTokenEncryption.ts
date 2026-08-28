/**
 * One-off, manually-invoked backfill for Plaid access-token encryption (Phase 3).
 * See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §22 for the full design this implements — read
 * that before changing anything here.
 *
 * This script is intentionally locked to one exact, known production operation — exactly two
 * named target rows, out of an exactly-three-row table, encrypted under exactly one known key —
 * not a general-purpose "backfill whatever needs it" tool. That is a deliberate safety property,
 * not a limitation to work around: there is no flag or code path that selects rows by a query
 * rather than by an explicit, pre-validated id supplied on the command line.
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
 *
 * Before running this for real, verify the two Phase 1 check constraints exist by hand (this
 * script cannot verify them itself — see "Constraints attestation" below):
 *
 *   select conname from pg_constraint
 *   where conrelid = 'public.plaid_items'::regclass
 *     and conname in ('plaid_items_token_present', 'plaid_items_encrypted_token_complete');
 *
 * Both names must come back. Only after confirming this by hand does `--constraints-confirmed
 * PLAID_PHASE1_CONSTRAINTS_VERIFIED` become an honest attestation rather than a rubber stamp.
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

// ---- Constants locking this script to the one operation it exists for -------------------------

const CONFIRM_TOKEN = 'BACKFILL_PLAID_TOKENS';
const CONSTRAINTS_ATTESTATION_TOKEN = 'PLAID_PHASE1_CONSTRAINTS_VERIFIED';
const EXPECTED_CURRENT_KEY_ID = 'RAILWAY_PROD_V1';
const EXPECTED_ENC_VERSION = 1; // mirrors tokenEncryption.ts's own (unexported) ENC_VERSION
const REQUIRED_EXPECTED_TOTAL = 3;
const REQUIRED_EXPECTED_PLAID_ENV = 'sandbox';
const REQUIRED_TARGET_COUNT = 2;
const TRANSIENT_RETRY_LIMIT = 3;
const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

// RFC 4122-shaped UUID (version 1-5, variant 8/9/a/b) — matches what `crypto.randomUUID()`
// (used by `insertPlaidItem` for every `plaid_items.id`) actually produces.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
// Every log line is built from exactly these three named fields, and `outcome` is always a fixed
// code from a small enum — never free text, never a raw error message, never an unrecognized CLI
// argument echoed back. `id` is only ever a value already proven to be a canonical UUID (validated
// at parse time, or read back from a row keyed by one) — nothing else is ever logged as `id`.

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

export type ArgErrorCode =
  | 'unrecognized_argument'
  | 'repeated_flag'
  | 'missing_flag_value'
  | 'target_ids_required'
  | 'target_ids_wrong_count'
  | 'target_ids_duplicate'
  | 'target_ids_malformed'
  | 'expected_total_required'
  | 'expected_total_invalid'
  | 'expected_plaid_env_required'
  | 'expected_plaid_env_invalid'
  | 'constraints_confirmed_required'
  | 'constraints_confirmed_invalid'
  | 'apply_requires_confirm';

export class ArgError extends Error {
  code: ArgErrorCode;
  constructor(code: ArgErrorCode, message: string) {
    // `message` is for a human operator reading direct script/stderr output only — the
    // structured log (main()'s catch) uses `code` exclusively, never this message.
    super(message);
    this.code = code;
  }
}

const KNOWN_FLAGS = ['target-ids', 'expected-total', 'expected-plaid-env', 'constraints-confirmed', 'confirm', 'apply'];

export function parseArgs(argv: string[]): ParsedArgs {
  const opts: Record<string, string | true> = {};
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let key: string;
    let value: string | true;

    if (arg === '--apply') {
      key = 'apply';
      value = true;
    } else {
      if (!arg.startsWith('--')) {
        throw new ArgError('unrecognized_argument', 'Unrecognized argument.');
      }
      key = arg.slice(2);
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) {
        throw new ArgError('missing_flag_value', `Missing value for --${key}.`);
      }
      value = raw;
      i++;
    }

    if (!KNOWN_FLAGS.includes(key)) {
      throw new ArgError('unrecognized_argument', 'Unrecognized argument.');
    }
    if (seen.has(key)) {
      throw new ArgError('repeated_flag', `--${key} was supplied more than once.`);
    }
    seen.add(key);
    opts[key] = value;
  }

  const targetIdsRaw = opts['target-ids'];
  if (typeof targetIdsRaw !== 'string' || targetIdsRaw.trim() === '') {
    throw new ArgError('target_ids_required', '--target-ids is required: a comma-separated list of exact plaid_items.id values.');
  }
  const targetIds = targetIdsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (targetIds.length !== REQUIRED_TARGET_COUNT) {
    throw new ArgError('target_ids_wrong_count', `--target-ids must name exactly ${REQUIRED_TARGET_COUNT} rows.`);
  }
  if (new Set(targetIds).size !== targetIds.length) {
    throw new ArgError('target_ids_duplicate', '--target-ids contains a duplicate id.');
  }
  for (const id of targetIds) {
    if (!UUID_RE.test(id)) {
      // Deliberately never echoes the malformed value itself.
      throw new ArgError('target_ids_malformed', 'One or more --target-ids values is not a canonical UUID.');
    }
  }

  const expectedTotalRaw = opts['expected-total'];
  if (typeof expectedTotalRaw !== 'string') {
    throw new ArgError('expected_total_required', '--expected-total is required.');
  }
  if (expectedTotalRaw !== String(REQUIRED_EXPECTED_TOTAL)) {
    throw new ArgError('expected_total_invalid', `--expected-total must be exactly ${REQUIRED_EXPECTED_TOTAL}.`);
  }

  const expectedPlaidEnvRaw = opts['expected-plaid-env'];
  if (typeof expectedPlaidEnvRaw !== 'string') {
    throw new ArgError('expected_plaid_env_required', '--expected-plaid-env is required.');
  }
  if (expectedPlaidEnvRaw !== REQUIRED_EXPECTED_PLAID_ENV) {
    throw new ArgError('expected_plaid_env_invalid', `--expected-plaid-env must be exactly "${REQUIRED_EXPECTED_PLAID_ENV}".`);
  }

  const constraintsConfirmedRaw = opts['constraints-confirmed'];
  if (typeof constraintsConfirmedRaw !== 'string') {
    throw new ArgError('constraints_confirmed_required', '--constraints-confirmed is required.');
  }
  if (constraintsConfirmedRaw !== CONSTRAINTS_ATTESTATION_TOKEN) {
    throw new ArgError('constraints_confirmed_invalid', `--constraints-confirmed must be exactly ${CONSTRAINTS_ATTESTATION_TOKEN}.`);
  }

  const apply = opts.apply === true;
  const confirmRaw = opts.confirm;
  if (apply && (typeof confirmRaw !== 'string' || confirmRaw !== CONFIRM_TOKEN)) {
    throw new ArgError('apply_requires_confirm', `--apply requires --confirm ${CONFIRM_TOKEN} (exact match).`);
  }

  return {
    targetIds,
    expectedTotal: REQUIRED_EXPECTED_TOTAL,
    expectedPlaidEnv: REQUIRED_EXPECTED_PLAID_ENV,
    apply,
    confirm: typeof confirmRaw === 'string' ? confirmRaw : null,
  };
}

// ---- Preflight (§22 "Preflight") ---------------------------------------------------------------
//
// Runs identically for dry-run and apply — apply is "dry-run, plus writes if it passes," not a
// separate, less-checked path. Nothing here writes anything.

export type PreflightFailureCode =
  | 'unexpected_plaid_environment'
  | 'key_ring_unavailable'
  | 'unexpected_current_key_id'
  | 'plaid_items_read_failed'
  | 'unexpected_total_count'
  | 'target_not_found'
  | 'partial_or_missing_representation'
  | 'unexpected_plaintext_only_row'
  | 'non_target_not_encrypted'
  | 'unexpected_encrypted_only_row'
  | 'unexpected_key_id'
  | 'unexpected_enc_version';

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailureCode[];
  targetStates: Map<string, StorageState>;
}

export async function runPreflight(args: ParsedArgs): Promise<PreflightResult> {
  const failures: PreflightFailureCode[] = [];
  const targetStates = new Map<string, StorageState>();

  if (env.plaidEnv !== args.expectedPlaidEnv) {
    failures.push('unexpected_plaid_environment');
  }

  let currentKeyId = '';
  try {
    currentKeyId = getKeyRing().currentKeyId;
  } catch {
    failures.push('key_ring_unavailable');
  }
  if (currentKeyId && currentKeyId !== EXPECTED_CURRENT_KEY_ID) {
    failures.push('unexpected_current_key_id');
  }

  const { data: allRows, error: fetchError } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS);
  if (fetchError) {
    failures.push('plaid_items_read_failed');
    return { ok: false, failures, targetStates };
  }
  const rows = (allRows ?? []) as TokenRow[];

  if (rows.length !== args.expectedTotal) {
    failures.push('unexpected_total_count');
  }

  const targetIdSet = new Set(args.targetIds);
  let anyPartialOrMissing = false;
  let anyUnexpectedPlaintextOnly = false;
  let anyEncryptedOnlyRow = false;
  let anyUnexpectedKeyId = false;
  let anyUnexpectedVersion = false;
  let nonTargetRowCount = 0;
  let nonTargetEncryptedCount = 0;

  for (const row of rows) {
    const state = classifyStorageState(row);
    const isTarget = targetIdSet.has(row.id);
    if (isTarget) targetStates.set(row.id, state);

    if (state.kind === 'partial' || state.kind === 'missing_both') anyPartialOrMissing = true;
    if (state.kind === 'plaintext_only' && !isTarget) anyUnexpectedPlaintextOnly = true;
    if (state.kind === 'encrypted') {
      if (!state.plaintextAlsoPresent) anyEncryptedOnlyRow = true;
      if (state.keyId !== EXPECTED_CURRENT_KEY_ID) anyUnexpectedKeyId = true;
      if (state.encVersion !== EXPECTED_ENC_VERSION) anyUnexpectedVersion = true;
    }

    if (!isTarget) {
      nonTargetRowCount++;
      if (state.kind === 'encrypted') nonTargetEncryptedCount++;
    }
  }

  if (anyPartialOrMissing) failures.push('partial_or_missing_representation');
  if (anyUnexpectedPlaintextOnly) failures.push('unexpected_plaintext_only_row');
  if (anyEncryptedOnlyRow) failures.push('unexpected_encrypted_only_row');
  if (anyUnexpectedKeyId) failures.push('unexpected_key_id');
  if (anyUnexpectedVersion) failures.push('unexpected_enc_version');
  // Every row that isn't a supplied target must already be fully (dual-write) encrypted — the
  // one-non-target-row shape this script is locked to (§22 point 3). Skipped when there's no
  // non-target row at all (already caught by the total-count check above in that case).
  if (nonTargetRowCount > 0 && nonTargetEncryptedCount !== nonTargetRowCount) {
    failures.push('non_target_not_encrypted');
  }

  for (const id of args.targetIds) {
    if (!rows.some((r) => r.id === id)) failures.push('target_not_found');
  }

  return { ok: failures.length === 0, failures, targetStates };
}

// ---- Final global postflight (§22 point 7) -----------------------------------------------------

export type PostflightFailureCode =
  | 'plaid_items_read_failed'
  | 'unexpected_total_count'
  | 'unexpected_encrypted_count'
  | 'plaintext_only_remaining'
  | 'plaintext_missing_items'
  | 'partial_encrypted_items'
  | 'unexpected_key_id'
  | 'unexpected_enc_version'
  | 'duplicate_nonce'
  | 'plaintext_missing_after_backfill';

export interface PostflightResult {
  ok: boolean;
  failures: PostflightFailureCode[];
}

/** Reread everything, from scratch, after every target has individually verified — a successful
 *  apply run means both "every supplied target verified this invocation" AND "the whole table's
 *  integrity holds," not just the former. */
export async function runPostflight(expectedTotal: number): Promise<PostflightResult> {
  const failures: PostflightFailureCode[] = [];
  const { data: allRows, error } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS);
  if (error) {
    failures.push('plaid_items_read_failed');
    return { ok: false, failures };
  }
  const rows = (allRows ?? []) as TokenRow[];

  if (rows.length !== expectedTotal) failures.push('unexpected_total_count');

  let encryptedCount = 0;
  let plaintextOnlyCount = 0;
  let missingBothCount = 0;
  let partialCount = 0;
  let anyUnexpectedKeyId = false;
  let anyUnexpectedVersion = false;
  let anyMissingPlaintext = false;
  const nonces = new Set<string>();

  for (const row of rows) {
    const state = classifyStorageState(row);
    if (state.kind === 'encrypted') {
      encryptedCount++;
      if (state.keyId !== EXPECTED_CURRENT_KEY_ID) anyUnexpectedKeyId = true;
      if (state.encVersion !== EXPECTED_ENC_VERSION) anyUnexpectedVersion = true;
      if (!state.plaintextAlsoPresent) anyMissingPlaintext = true;
      if (row.access_token_nonce) nonces.add(row.access_token_nonce);
    } else if (state.kind === 'plaintext_only') {
      plaintextOnlyCount++;
    } else if (state.kind === 'missing_both') {
      missingBothCount++;
    } else {
      partialCount++;
    }
  }

  if (encryptedCount !== expectedTotal) failures.push('unexpected_encrypted_count');
  if (plaintextOnlyCount !== 0) failures.push('plaintext_only_remaining');
  if (missingBothCount !== 0) failures.push('plaintext_missing_items');
  if (partialCount !== 0) failures.push('partial_encrypted_items');
  if (anyUnexpectedKeyId) failures.push('unexpected_key_id');
  if (anyUnexpectedVersion) failures.push('unexpected_enc_version');
  if (nonces.size !== encryptedCount) failures.push('duplicate_nonce');
  if (anyMissingPlaintext) failures.push('plaintext_missing_after_backfill');

  return { ok: failures.length === 0, failures };
}

// ---- Verification helpers ----------------------------------------------------------------------

async function rereadRow(id: string): Promise<TokenRow | null> {
  const { data, error } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

/** The guarded conditional update (§22 "Verification model"): updates *only* the five encrypted
 *  columns — `access_token` never appears here, and neither does `updated_at` — the script is
 *  structurally incapable of writing or clearing plaintext, or touching anything beyond exactly
 *  these five columns. Returns the number of rows actually affected so the caller can tell a win
 *  from a lost race. */
async function guardedEncryptUpdate(id: string, enc: EncryptedAccessToken): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .update({
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
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

// ---- Per-target processing (§22 "Resumable processing" / point 8 "Improve dry-run usefulness") -

export interface TargetOutcome {
  id: string;
  outcome: 'verified' | 'dry_run_verified';
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
    // Local crypto exercise — runs for dry-run and apply alike, and writes nothing: proves the
    // encrypt/decrypt round trip works for this exact plaintext + row id before anything is
    // persisted (§22 point 8).
    logEntry({ id, stage: 'local_crypto_check', outcome: 'started' });
    const keyRing = getKeyRing();
    const enc = encryptAccessToken(plaintextForCompare, keyRing, id);
    const localDecrypted = decryptAccessToken(enc, keyRing, id);
    if (localDecrypted !== plaintextForCompare) {
      logEntry({ id, stage: 'local_crypto_check', outcome: 'failed:local_precheck_mismatch' });
      throw new HaltError(id, 'local_precheck_mismatch');
    }

    // Read-only Plaid liveness check against the *current* plaintext token — runs for dry-run
    // and apply alike, and (for apply) deliberately happens before any write, so a dead
    // credential is caught before it's ever encrypted and stored, not only after.
    logEntry({ id, stage: 'verify_plaid_pre_write', outcome: 'started' });
    await verifyLiveWithRetry(id, plaintextForCompare);

    if (!apply) {
      logEntry({ id, stage: 'done', outcome: 'dry_run_verified' });
      return { id, outcome: 'dry_run_verified' };
    }

    logEntry({ id, stage: 'write', outcome: 'started' });
    const affected = await guardedEncryptUpdate(id, enc);
    logEntry({ id, stage: 'write', outcome: affected === 1 ? 'committed' : 'lost_race' });

    // Whether we won or lost the race, always reread the database's own current value — the
    // local `enc` object computed above is never itself the thing that gets verified next.
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
  const currentState = classifyStorageState(verifyRow);
  if (currentState.kind === 'encrypted') {
    // This one-off backfill is locked to one known-good key/version — historical-key support
    // stays in the general crypto layer (tokenEncryption.ts), but this script rejects anything
    // else outright, even a self-consistent, genuinely decryptable representation under a
    // different key or version (§22 point 4).
    if (currentState.keyId !== EXPECTED_CURRENT_KEY_ID) {
      logEntry({ id, stage: 'verify_state_check', outcome: 'failed:unexpected_key_id' });
      throw new HaltError(id, 'unexpected_key_id');
    }
    if (currentState.encVersion !== EXPECTED_ENC_VERSION) {
      logEntry({ id, stage: 'verify_state_check', outcome: 'failed:unexpected_enc_version' });
      throw new HaltError(id, 'unexpected_enc_version');
    }
  }

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
    logEntry({ stage: 'signal', outcome: `received_${signal.toLowerCase()}` });
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
    const code = err instanceof ArgError ? err.code : 'invalid_arguments';
    logEntry({ stage: 'startup', outcome: `failed:${code}` });
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
  // rereads and reverifies any target that's already encrypted, and now also exercises the local
  // crypto path + a read-only Plaid check for a still-plaintext target (§22 point 8).
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
        logEntry({ id, stage: 'run', outcome: 'halted:unexpected_error' });
      }
      return 1;
    }
  }

  if (interruptRequested) {
    logEntry({ stage: 'run', outcome: 'interrupted' });
    return 1;
  }

  if (!args.apply) {
    logEntry({ stage: 'done', outcome: 'dry_run_complete' });
    return 0;
  }

  // A successful apply exit means every supplied target verified *this* invocation AND the
  // whole table's integrity holds afterward — not just the former (§22 point 7).
  logEntry({ stage: 'postflight', outcome: 'started' });
  const postflight = await runPostflight(args.expectedTotal);
  for (const failure of postflight.failures) {
    logEntry({ stage: 'postflight', outcome: `failed:${failure}` });
  }
  if (!postflight.ok) {
    logEntry({ stage: 'postflight', outcome: 'failed' });
    return 1;
  }

  logEntry({ stage: 'done', outcome: 'all_targets_verified_and_postflight_passed' });
  return 0;
}

/* istanbul ignore next -- exercised via processes spawned in manual/production use, not unit tests */
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      logEntry({ stage: 'fatal', outcome: 'failed:unexpected_error' });
      process.exitCode = 1;
    });
}
