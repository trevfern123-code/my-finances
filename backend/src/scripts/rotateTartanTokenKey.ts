/**
 * One-off, manually-invoked V1 → V2 key rotation for exactly one row: the Tartan Sandbox
 * `plaid_items` item. See PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §22's rotation addendum for the
 * full design this implements — read that before changing anything here.
 *
 * This is a fixed-purpose, one-row operation — not a generic key-rotation engine. The old key id
 * (`RAILWAY_PROD_V1`), the new/current key id (`RAILWAY_PROD_V2`), and the encryption version (1)
 * are all fixed module constants, not configurable flags. There is no code path that rotates any
 * row other than the single, explicit id supplied on the command line.
 *
 * V1 is treated as compromised for this rotation (it was accidentally exposed) — successfully
 * decrypting the existing V1 representation is used *only* as a consistency/corruption check
 * (does our stored ciphertext still agree with the plaintext column we already have), never as
 * evidence the credential itself is still trustworthy. That is the entire reason this rotation
 * exists.
 *
 * NOT part of the request-serving code path. Never imported by `index.ts` or anything else the
 * running Express server's module graph reaches — its presence in a deploy is inert. As a second,
 * redundant safety net, this file also refuses to do anything unless invoked directly as the
 * process's own entrypoint (`require.main === module`, checked at the bottom of this file).
 *
 * Manual, one-off, idempotent, concurrency-safe, safe to interrupt and rerun, structurally
 * incapable of writing or clearing plaintext, and halts on the first verification failure rather
 * than continuing past it. Defaults to a dry run — no `--apply` flag means no writes, ever.
 *
 * Deliberately does not share code with `backfillTokenEncryption.ts` beyond the existing
 * `tokenEncryption.ts`/`plaidService.ts` primitives — each one-off script stays independently
 * small and auditable rather than depending on a shared "rotation engine" module.
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

const OLD_KEY_ID = 'RAILWAY_PROD_V1';
const NEW_KEY_ID = 'RAILWAY_PROD_V2';
const EXPECTED_ENC_VERSION = 1;
const REQUIRED_EXPECTED_TOTAL = 3;
const REQUIRED_EXPECTED_PLAID_ENV = 'sandbox';
const CONFIRM_TOKEN = 'ROTATE_TARTAN_KEY_V1_TO_V2';
const CONSTRAINTS_ATTESTATION_TOKEN = 'PLAID_PHASE1_CONSTRAINTS_VERIFIED';
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

// ---- Structured, allow-listed logging -----------------------------------------------------
//
// Every log line is built from exactly these three named fields, and `outcome` is always a fixed
// code — never free text, never a raw error message, never plaintext, ciphertext, or either key's
// bytes.

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

// ---- Storage state (mirrors backfillTokenEncryption.ts's classification, duplicated
// deliberately — see the header comment on why these scripts don't share a common module) -------

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

function isCleanState(state: StorageState, keyId: string): boolean {
  return state.kind === 'encrypted' && state.keyId === keyId && state.encVersion === EXPECTED_ENC_VERSION && state.plaintextAlsoPresent;
}

// ---- CLI parsing (pure, no I/O) ----------------------------------------------------------------

export interface ParsedArgs {
  tartanId: string;
  expectedTotal: number;
  expectedPlaidEnv: string;
  apply: boolean;
  confirm: string | null;
}

export type ArgErrorCode =
  | 'unrecognized_argument'
  | 'repeated_flag'
  | 'missing_flag_value'
  | 'tartan_id_required'
  | 'tartan_id_malformed'
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

const KNOWN_FLAGS = ['tartan-id', 'expected-total', 'expected-plaid-env', 'constraints-confirmed', 'confirm', 'apply'];

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

  const tartanIdRaw = opts['tartan-id'];
  if (typeof tartanIdRaw !== 'string' || tartanIdRaw.trim() === '') {
    throw new ArgError('tartan_id_required', '--tartan-id is required: the exact internal plaid_items.id of the Tartan item.');
  }
  const tartanId = tartanIdRaw.trim();
  if (!UUID_RE.test(tartanId)) {
    // Deliberately never echoes the malformed value itself.
    throw new ArgError('tartan_id_malformed', '--tartan-id is not a canonical UUID.');
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
    tartanId,
    expectedTotal: REQUIRED_EXPECTED_TOTAL,
    expectedPlaidEnv: REQUIRED_EXPECTED_PLAID_ENV,
    apply,
    confirm: typeof confirmRaw === 'string' ? confirmRaw : null,
  };
}

// ---- Preflight: V1/V2 key-ring policy + row existence ------------------------------------------

export type PreflightFailureCode =
  | 'unexpected_plaid_environment'
  | 'key_ring_unavailable'
  | 'v1_key_missing'
  | 'v2_key_missing'
  | 'v2_not_current'
  | 'v1_v2_identical_keys'
  | 'plaid_items_read_failed'
  | 'unexpected_total_count'
  | 'tartan_not_found';

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailureCode[];
}

export async function runPreflight(args: ParsedArgs): Promise<PreflightResult> {
  const failures: PreflightFailureCode[] = [];

  if (env.plaidEnv !== args.expectedPlaidEnv) {
    failures.push('unexpected_plaid_environment');
  }

  let v1Key: Buffer | undefined;
  let v2Key: Buffer | undefined;
  try {
    const keyRing = getKeyRing();
    v1Key = keyRing.keys.get(OLD_KEY_ID);
    v2Key = keyRing.keys.get(NEW_KEY_ID);
    if (!v1Key) failures.push('v1_key_missing');
    if (!v2Key) failures.push('v2_key_missing');
    if (keyRing.currentKeyId !== NEW_KEY_ID) failures.push('v2_not_current');
    // Compared as raw bytes, never logged or displayed either way — this only ever produces a
    // boolean. A misconfiguration that pointed V2 at the same bytes as V1 would defeat the whole
    // point of rotating away from a compromised key.
    if (v1Key && v2Key && v1Key.equals(v2Key)) failures.push('v1_v2_identical_keys');
  } catch {
    failures.push('key_ring_unavailable');
  }

  const { data: allRows, error: fetchError } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS);
  if (fetchError) {
    failures.push('plaid_items_read_failed');
    return { ok: false, failures };
  }
  const rows = (allRows ?? []) as TokenRow[];

  if (rows.length !== args.expectedTotal) {
    failures.push('unexpected_total_count');
  }
  if (!rows.some((r) => r.id === args.tartanId)) {
    failures.push('tartan_not_found');
  }

  return { ok: failures.length === 0, failures };
}

// ---- DB helpers ---------------------------------------------------------------------------------

async function rereadRow(id: string): Promise<TokenRow | null> {
  const { data, error } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

/** The guarded rotation update: requires the exact row id, that it's still on the old key at the
 *  old version, and that plaintext is present — never filters on the *values* of
 *  plaintext/ciphertext/nonce/tag (only presence/absence and key/version equality). Updates only
 *  the five encrypted columns — `access_token` never appears here, and neither does `updated_at`.
 *  Returns the number of rows actually affected so the caller can tell a win from a lost race. */
async function guardedRotateUpdate(id: string, prospective: EncryptedAccessToken): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .update({
      access_token_ciphertext: prospective.ciphertextBase64,
      access_token_nonce: prospective.nonceBase64,
      access_token_auth_tag: prospective.authTagBase64,
      access_token_key_id: prospective.keyId,
      access_token_enc_version: prospective.encVersion,
    })
    .eq('id', id)
    .eq('access_token_key_id', OLD_KEY_ID)
    .eq('access_token_enc_version', EXPECTED_ENC_VERSION)
    .not('access_token', 'is', null)
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

/** Only Plaid's `itemGet` call (network) can fail transiently — every other step here is pure
 *  local computation with no transient-failure category at all. A structured HTTP status, once
 *  present, is authoritative and the only thing consulted — never overridden by the message-based
 *  network heuristic, so a real HTTP 4xx credential rejection whose message happens to contain
 *  "timeout" is never misclassified as transient. */
function classifyPlaidFailure(err: unknown): 'transient' | 'non_transient' {
  const status = (err as { response?: { status?: unknown } })?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500 ? 'transient' : 'non_transient';
  }
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
    super(`Halting on ${targetId}: ${reason}`);
    this.targetId = targetId;
    this.reason = reason;
  }
}

/** Thrown the moment a SIGINT/SIGTERM is observed — distinct from `HaltError` so an interrupt is
 *  never logged as a `halted:*` failure reason. */
export class InterruptedError extends Error {
  targetId?: string;
  constructor(targetId?: string) {
    super('Interrupted by SIGINT/SIGTERM');
    this.targetId = targetId;
  }
}

let interruptRequested = false;

/** The single interruption checkpoint every other awaited operation and every success/logging
 *  boundary calls through — see the call sites throughout `verifyLiveWithRetry` and
 *  `rotateTartan` for exactly where. */
function throwIfInterrupted(id?: string): void {
  if (interruptRequested) throw new InterruptedError(id);
}

/** Bounded retry, transient failures only. Interruption checkpoints: before every attempt
 *  (including the first), immediately after every awaited Plaid call (success or failure), and
 *  immediately after every retry delay. */
export async function verifyLiveWithRetry(id: string, accessToken: string, baseDelayMs = TRANSIENT_RETRY_BASE_DELAY_MS): Promise<void> {
  let attempt = 0;
  for (;;) {
    throwIfInterrupted(id);
    try {
      await verifyAccessTokenLive(accessToken);
    } catch (err) {
      throwIfInterrupted(id);
      attempt++;
      const classification = classifyPlaidFailure(err);
      if (classification === 'transient' && attempt <= TRANSIENT_RETRY_LIMIT) {
        logEntry({ id, stage: 'verify_plaid_retry', outcome: `retrying_attempt_${attempt}` });
        await sleep(baseDelayMs * 2 ** (attempt - 1));
        throwIfInterrupted(id);
        continue;
      }
      const reason = classification === 'transient' ? 'transient_retry_exhausted' : 'credential_rejected';
      throw new HaltError(id, reason);
    }
    throwIfInterrupted(id);
    return;
  }
}

// ---- Verifying an already-rotated (V2) row, with zero writes -----------------------------------

export interface RotationOutcome {
  outcome: 'verified' | 'dry_run_verified';
}

async function verifyStoredV2(tartanId: string, row: TokenRow, expectedPlaintext: string): Promise<RotationOutcome> {
  if (row.access_token !== expectedPlaintext) {
    logEntry({ id: tartanId, stage: 'verify_compare', outcome: 'failed:plaintext_mismatch' });
    throw new HaltError(tartanId, 'plaintext_mismatch');
  }

  logEntry({ id: tartanId, stage: 'verify_decrypt', outcome: 'started' });
  const enc: EncryptedAccessToken = {
    ciphertextBase64: row.access_token_ciphertext as string,
    nonceBase64: row.access_token_nonce as string,
    authTagBase64: row.access_token_auth_tag as string,
    keyId: row.access_token_key_id as string,
    encVersion: row.access_token_enc_version as number,
  };
  let decrypted: string;
  try {
    decrypted = decryptAccessToken(enc, getKeyRing(), tartanId);
  } catch (err) {
    const reason = classifyDecryptError(err);
    logEntry({ id: tartanId, stage: 'verify_decrypt', outcome: `failed:${reason}` });
    throw new HaltError(tartanId, reason);
  }

  logEntry({ id: tartanId, stage: 'verify_compare', outcome: 'started' });
  if (decrypted !== expectedPlaintext) {
    logEntry({ id: tartanId, stage: 'verify_compare', outcome: 'failed:plaintext_mismatch' });
    throw new HaltError(tartanId, 'plaintext_mismatch');
  }

  logEntry({ id: tartanId, stage: 'verify_plaid', outcome: 'started' });
  try {
    await verifyLiveWithRetry(tartanId, decrypted);
  } catch (err) {
    if (err instanceof HaltError) {
      logEntry({ id: tartanId, stage: 'verify_plaid', outcome: `failed:${err.reason}` });
    }
    throw err; // InterruptedError propagates through untouched — never logged as a halt reason
  }

  throwIfInterrupted(tartanId);
  logEntry({ id: tartanId, stage: 'done', outcome: 'verified' });
  return { outcome: 'verified' };
}

// ---- Main per-row rotation flow ------------------------------------------------------------------

export async function rotateTartan(tartanId: string, apply: boolean): Promise<RotationOutcome> {
  logEntry({ id: tartanId, stage: 'reread_initial', outcome: 'started' });
  const initialRow = await rereadRow(tartanId);
  throwIfInterrupted(tartanId);
  if (!initialRow) throw new HaltError(tartanId, 'tartan_not_found');

  const plaintext = initialRow.access_token;
  if (plaintext === null) {
    logEntry({ id: tartanId, stage: 'reread_initial', outcome: 'failed:plaintext_missing' });
    throw new HaltError(tartanId, 'plaintext_missing');
  }

  const initialState = classifyStorageState(initialRow);

  // A partial or fully-missing representation is a distinct, specific anomaly — never guessed at
  // or repaired, and never collapsed into the generic "not on V1" reason below.
  if (initialState.kind === 'partial' || initialState.kind === 'missing_both') {
    logEntry({ id: tartanId, stage: 'reread_initial', outcome: `failed:${initialState.kind}` });
    throw new HaltError(tartanId, initialState.kind);
  }

  // Already-V2 resume path (§22 rotation "Resume/crash behavior"): never generate or write a
  // replacement ciphertext — reread fresh, then fully reverify with zero writes.
  if (isCleanState(initialState, NEW_KEY_ID)) {
    logEntry({ id: tartanId, stage: 'reread_for_verification', outcome: 'started' });
    const freshRow = await rereadRow(tartanId);
    throwIfInterrupted(tartanId);
    if (!freshRow) throw new HaltError(tartanId, 'tartan_not_found');
    return await verifyStoredV2(tartanId, freshRow, plaintext);
  }

  // Anything other than a clean V1/version-1 dual-write row is refused outright — no guessing.
  if (!isCleanState(initialState, OLD_KEY_ID)) {
    logEntry({ id: tartanId, stage: 'reread_initial', outcome: 'failed:not_v1_dual_write' });
    throw new HaltError(tartanId, 'not_v1_dual_write');
  }

  // Step: decrypt the existing V1 representation and compare to the plaintext column. This is a
  // consistency/corruption check ONLY — V1 is treated as compromised, so a successful decrypt
  // here never establishes that the credential itself is trustworthy, only that our stored V1
  // ciphertext and our plaintext column still agree before we touch anything. If they disagree,
  // halt — never automatically pick one as authoritative.
  logEntry({ id: tartanId, stage: 'verify_v1_consistency', outcome: 'started' });
  const v1Enc: EncryptedAccessToken = {
    ciphertextBase64: initialRow.access_token_ciphertext as string,
    nonceBase64: initialRow.access_token_nonce as string,
    authTagBase64: initialRow.access_token_auth_tag as string,
    keyId: initialRow.access_token_key_id as string,
    encVersion: initialRow.access_token_enc_version as number,
  };
  let v1Decrypted: string;
  try {
    v1Decrypted = decryptAccessToken(v1Enc, getKeyRing(), tartanId);
  } catch (err) {
    const reason = classifyDecryptError(err);
    logEntry({ id: tartanId, stage: 'verify_v1_consistency', outcome: `failed:${reason}` });
    throw new HaltError(tartanId, reason);
  }
  if (v1Decrypted !== plaintext) {
    logEntry({ id: tartanId, stage: 'verify_v1_consistency', outcome: 'failed:v1_plaintext_mismatch' });
    throw new HaltError(tartanId, 'v1_plaintext_mismatch');
  }

  // Pre-write Plaid check against the agreed token — before any write, so a dead credential is
  // caught before it's ever re-encrypted and stored, not only after.
  logEntry({ id: tartanId, stage: 'verify_plaid_pre_write', outcome: 'started' });
  await verifyLiveWithRetry(tartanId, plaintext);
  throwIfInterrupted(tartanId);

  // Prospective V2 representation — local only, still entirely read-only.
  logEntry({ id: tartanId, stage: 'prospective_v2', outcome: 'started' });
  const keyRing = getKeyRing();
  const prospective = encryptAccessToken(plaintext, keyRing, tartanId);
  if (prospective.keyId !== NEW_KEY_ID || prospective.encVersion !== EXPECTED_ENC_VERSION) {
    logEntry({ id: tartanId, stage: 'prospective_v2', outcome: 'failed:unexpected_prospective_metadata' });
    throw new HaltError(tartanId, 'unexpected_prospective_metadata');
  }
  const localDecrypted = decryptAccessToken(prospective, keyRing, tartanId);
  if (localDecrypted !== plaintext) {
    logEntry({ id: tartanId, stage: 'prospective_v2', outcome: 'failed:local_precheck_mismatch' });
    throw new HaltError(tartanId, 'local_precheck_mismatch');
  }

  // Dry-run ends here — a complete, read-only verification path (V1 consistency + live Plaid
  // check + a full local V2 round trip), zero writes.
  if (!apply) {
    throwIfInterrupted(tartanId);
    logEntry({ id: tartanId, stage: 'done', outcome: 'dry_run_verified' });
    return { outcome: 'dry_run_verified' };
  }

  throwIfInterrupted(tartanId); // before the guarded update
  logEntry({ id: tartanId, stage: 'write', outcome: 'started' });
  const affected = await guardedRotateUpdate(tartanId, prospective);
  // If interrupted right here: the write may already have committed (or lost the race to a
  // concurrent writer — either way the row is left exactly as-is) and we stop immediately, before
  // even logging this write's own outcome, before rereading, and before anything could log
  // success. The next invocation's initial reread (top of this function) picks the row's real
  // state back up and reverifies it — either via the already-V2 branch above, or by resuming this
  // same flow if it's still on V1.
  throwIfInterrupted(tartanId);
  logEntry({ id: tartanId, stage: 'write', outcome: affected === 1 ? 'committed' : 'lost_race' });

  const rereadAfterWrite = await rereadRow(tartanId);
  throwIfInterrupted(tartanId);
  if (!rereadAfterWrite) throw new HaltError(tartanId, 'tartan_not_found_after_write');

  const stateAfterWrite = classifyStorageState(rereadAfterWrite);
  if (isCleanState(stateAfterWrite, NEW_KEY_ID)) {
    // Either we won the write, or we lost the race but the winner is itself a valid V2 state —
    // verify what's actually stored either way; the local `prospective` object above is never
    // itself the thing that gets verified.
    return await verifyStoredV2(tartanId, rereadAfterWrite, plaintext);
  }

  // Lost the race to something that ISN'T a clean V2 state — never guess, never retry using our
  // own discarded local ciphertext, just halt with a specific, distinguishable reason.
  let reason: string;
  if (stateAfterWrite.kind === 'partial' || stateAfterWrite.kind === 'missing_both') {
    reason = stateAfterWrite.kind;
  } else if (stateAfterWrite.kind === 'plaintext_only') {
    reason = 'unexpected_plaintext_only_after_write';
  } else if (!stateAfterWrite.plaintextAlsoPresent) {
    reason = 'plaintext_missing_after_write';
  } else if (stateAfterWrite.keyId === OLD_KEY_ID) {
    reason = 'still_v1_after_write';
  } else if (stateAfterWrite.keyId !== NEW_KEY_ID) {
    reason = 'wrong_key_after_write';
  } else {
    reason = 'wrong_version_after_write';
  }
  logEntry({ id: tartanId, stage: 'reread_after_write', outcome: `failed:${reason}` });
  throw new HaltError(tartanId, reason);
}

// ---- Signal handling ------------------------------------------------------------------------

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

  try {
    logEntry({ stage: 'preflight', outcome: 'started' });
    const preflight = await runPreflight(args);
    throwIfInterrupted();
    for (const failure of preflight.failures) {
      logEntry({ stage: 'preflight', outcome: `failed:${failure}` });
    }
    if (!preflight.ok) {
      logEntry({ stage: 'preflight', outcome: 'failed' });
      return 1;
    }
    logEntry({ stage: 'preflight', outcome: 'passed' });

    throwIfInterrupted(args.tartanId);
    const result = await rotateTartan(args.tartanId, args.apply);

    throwIfInterrupted();
    logEntry({ stage: 'done', outcome: args.apply ? 'rotation_complete' : 'dry_run_complete' });
    void result;
    return 0;
  } catch (err) {
    if (err instanceof InterruptedError) {
      logEntry({ id: err.targetId, stage: 'run', outcome: 'interrupted' });
      return 1;
    }
    if (err instanceof HaltError) {
      logEntry({ id: err.targetId, stage: 'run', outcome: `halted:${err.reason}` });
      return 1;
    }
    logEntry({ stage: 'run', outcome: 'halted:unexpected_error' });
    return 1;
  }
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
