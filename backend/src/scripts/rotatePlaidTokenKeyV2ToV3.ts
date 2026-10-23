/**
 * Manually-invoked RAILWAY_PROD_V2 → RENDER_PROD_V3 key rotation for every `plaid_items` access
 * token, plus a read-only gate that proves V2 can be retired. See PLAID_KEY_ROTATION_V2_TO_V3.md
 * for the design, the operator runbook and the recovery instructions — read it before changing
 * anything here.
 *
 * Fixed-purpose, like `rotateTartanTokenKey.ts` (the reviewed V1 → V2 precedent this follows):
 * the old key id, the new key id and the encryption version are module constants, not flags.
 *
 * Two modes, both read-only unless `--apply --confirm ROTATE_PLAID_KEY_V2_TO_V3` is given:
 *
 *   --mode rotate             Preflight (strict record counts, key ring, whole-table state), then
 *                             each row in id order: reread → decrypt V2 → compare with the
 *                             plaintext copy when one exists → encrypt under V3 → local round trip
 *                             → (apply only) guarded update of the five encrypted columns →
 *                             reread → decrypt the STORED V3 value with a V3-only key ring.
 *                             Halts on the first anomaly. Rows already on V3 are reverified with
 *                             zero writes, so an interrupted run is resumed by running it again.
 *   --mode verify-retirement  Never writes. Proves every row is on V3 and decrypts with a key ring
 *                             that contains ONLY the V3 key, and that no stored Hosted Link token
 *                             still references V2 — the gate before PLAID_TOKEN_KEY_RAILWAY_PROD_V2
 *                             may be removed from any environment.
 *
 * What this script never does, by construction:
 *   - writes `access_token` (the legacy plaintext copy): it is neither written nor cleared — no
 *     update payload here contains it;
 *   - writes `status`, `transactions_cursor` or any other column, or any `plaid_link_attempts` row;
 *   - calls Plaid (no import of plaidService at all): rotation re-encrypts the same bytes, which the
 *     decrypt/compare round trips prove; it needs no network check and causes no sync;
 *   - logs or prints a token, ciphertext, nonce, auth tag, key bytes, the Supabase URL or a raw
 *     error message. Every log line is `{ts, id?, stage, outcome, counts?}` with fixed codes.
 *
 * NOT part of the request-serving code path: nothing the Express server imports reaches this file,
 * and it does nothing unless it is the process's own entrypoint (`require.main === module`).
 */

import { createHash } from 'node:crypto';
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
  UnsupportedEncryptionVersionError,
  type EncryptedAccessToken,
  type KeyRing,
} from '../services/tokenEncryption';

// ---- Constants locking this script to the one operation it exists for -------------------------

export const OLD_KEY_ID = 'RAILWAY_PROD_V2';
export const NEW_KEY_ID = 'RENDER_PROD_V3';
const EXPECTED_ENC_VERSION = 1;
const REQUIRED_EXPECTED_PLAID_ENV = 'sandbox';
export const CONFIRM_TOKEN = 'ROTATE_PLAID_KEY_V2_TO_V3';
export const CONSTRAINTS_ATTESTATION_TOKEN = 'PLAID_PHASE1_CONSTRAINTS_VERIFIED';
// A count flag is an operator attestation, compared exactly with the database — not a limit. The
// ceiling only rejects typos (e.g. an extra digit) before anything is read.
const MAX_COUNT_FLAG = 1000;

const TOKEN_ROW_COLUMNS =
  'id, access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version';
const LINK_ATTEMPT_COLUMNS = 'id, status, expires_at, link_token_key_id, link_token_enc_version';

export interface TokenRow {
  id: string;
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

interface LinkAttemptRow {
  id: string;
  status: string;
  expires_at: string;
  link_token_key_id: string | null;
  link_token_enc_version: number | null;
}

// ---- Structured, allow-listed logging -----------------------------------------------------------

interface LogFields {
  id?: string;
  stage: string;
  outcome: string;
  /** Aggregate numbers only (row counts) — never a value read from a row. */
  counts?: Record<string, number>;
}

export function logEntry(fields: LogFields): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      id: fields.id,
      stage: fields.stage,
      outcome: fields.outcome,
      counts: fields.counts,
    })
  );
}

// ---- Storage state --------------------------------------------------------------------------------

export type StorageState =
  | { kind: 'plaintext_only' }
  | { kind: 'encrypted'; keyId: string; encVersion: number; plaintextAlsoPresent: boolean }
  | { kind: 'partial' }
  | { kind: 'missing_both' };

/** All five encrypted columns are classified together, never inferred from one of them (the same
 *  rule as dataService.ts's resolveAccessToken). */
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

/** 'v2' / 'v3' only for a complete representation at the expected version; every other state gets
 *  its own anomaly code so it is never collapsed into a generic "not V2". */
export type RowClass =
  | 'v2'
  | 'v3'
  | 'plaintext_only'
  | 'partial'
  | 'missing_both'
  | 'unexpected_key'
  | 'unexpected_version';

/** In-memory digest of a row's id, plaintext copy and five encrypted columns, so the final recount
 *  can prove each row is still byte-for-byte the state that was verified — any later change to a
 *  ciphertext, nonce, tag, key id, version or plaintext value is caught, not only changes to counts.
 *  Never logged, printed or stored. */
export function rowFingerprint(row: TokenRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.access_token,
        row.access_token_ciphertext,
        row.access_token_nonce,
        row.access_token_auth_tag,
        row.access_token_key_id,
        row.access_token_enc_version,
      ])
    )
    .digest('hex');
}

export function classifyRow(row: TokenRow): RowClass {
  const state = classifyStorageState(row);
  if (state.kind !== 'encrypted') return state.kind;
  if (state.encVersion !== EXPECTED_ENC_VERSION) return 'unexpected_version';
  if (state.keyId === OLD_KEY_ID) return 'v2';
  if (state.keyId === NEW_KEY_ID) return 'v3';
  return 'unexpected_key';
}

function toEnc(row: TokenRow): EncryptedAccessToken {
  return {
    ciphertextBase64: row.access_token_ciphertext as string,
    nonceBase64: row.access_token_nonce as string,
    authTagBase64: row.access_token_auth_tag as string,
    keyId: row.access_token_key_id as string,
    encVersion: row.access_token_enc_version as number,
  };
}

// ---- CLI parsing (pure, no I/O) ----------------------------------------------------------------

export type Mode = 'rotate' | 'verify-retirement';

export interface ParsedArgs {
  mode: Mode;
  expectedTotal: number;
  /** rotate mode only: how many rows the operator expects to still be on V2 right now. */
  expectedRemainingV2: number | null;
  expectedPlaintextCopies: number;
  expectedPlaidEnv: string;
  expectedSupabaseHost: string;
  apply: boolean;
}

export type ArgErrorCode =
  | 'unrecognized_argument'
  | 'repeated_flag'
  | 'missing_flag_value'
  | 'mode_required'
  | 'mode_invalid'
  | 'expected_total_required'
  | 'expected_total_invalid'
  | 'expected_remaining_v2_required'
  | 'expected_remaining_v2_invalid'
  | 'expected_remaining_v2_not_allowed'
  | 'expected_plaintext_copies_required'
  | 'expected_plaintext_copies_invalid'
  | 'expected_plaid_env_required'
  | 'expected_plaid_env_invalid'
  | 'expected_supabase_host_required'
  | 'expected_supabase_host_invalid'
  | 'constraints_confirmed_required'
  | 'constraints_confirmed_invalid'
  | 'apply_not_allowed_in_mode'
  | 'confirm_without_apply'
  | 'apply_requires_confirm';

export class ArgError extends Error {
  code: ArgErrorCode;
  constructor(code: ArgErrorCode, message: string) {
    // `message` is for an operator reading stderr only; the structured log uses `code` exclusively.
    super(message);
    this.code = code;
  }
}

const KNOWN_FLAGS = [
  'mode',
  'expected-total',
  'expected-remaining-v2',
  'expected-plaintext-copies',
  'expected-plaid-env',
  'expected-supabase-host',
  'constraints-confirmed',
  'confirm',
  'apply',
];

// A bare hostname (optionally with a port) — never a URL with a scheme, path or credentials.
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

function parseCount(raw: string | true | undefined, min: number, required: ArgErrorCode, invalid: ArgErrorCode, flag: string): number {
  if (typeof raw !== 'string') throw new ArgError(required, `--${flag} is required.`);
  // Canonical decimal only: no sign, no leading zeros, no whitespace, no exponent.
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new ArgError(invalid, `--${flag} must be a non-negative integer.`);
  const n = Number(raw);
  if (n < min || n > MAX_COUNT_FLAG) throw new ArgError(invalid, `--${flag} is out of range.`);
  return n;
}

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
      if (!arg.startsWith('--')) throw new ArgError('unrecognized_argument', 'Unrecognized argument.');
      key = arg.slice(2);
      if (!KNOWN_FLAGS.includes(key) || key === 'apply') throw new ArgError('unrecognized_argument', 'Unrecognized argument.');
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) throw new ArgError('missing_flag_value', `Missing value for --${key}.`);
      value = raw;
      i++;
    }

    if (seen.has(key)) throw new ArgError('repeated_flag', `--${key} was supplied more than once.`);
    seen.add(key);
    opts[key] = value;
  }

  const modeRaw = opts.mode;
  if (typeof modeRaw !== 'string') throw new ArgError('mode_required', '--mode is required: rotate or verify-retirement.');
  if (modeRaw !== 'rotate' && modeRaw !== 'verify-retirement') {
    throw new ArgError('mode_invalid', '--mode must be exactly "rotate" or "verify-retirement".');
  }
  const mode: Mode = modeRaw;

  const expectedTotal = parseCount(opts['expected-total'], 1, 'expected_total_required', 'expected_total_invalid', 'expected-total');

  let expectedRemainingV2: number | null = null;
  if (mode === 'rotate') {
    expectedRemainingV2 = parseCount(
      opts['expected-remaining-v2'],
      0,
      'expected_remaining_v2_required',
      'expected_remaining_v2_invalid',
      'expected-remaining-v2'
    );
    if (expectedRemainingV2 > expectedTotal) {
      throw new ArgError('expected_remaining_v2_invalid', '--expected-remaining-v2 cannot exceed --expected-total.');
    }
  } else if (opts['expected-remaining-v2'] !== undefined) {
    // verify-retirement always requires zero V2 rows; a count here would be a confused invocation.
    throw new ArgError('expected_remaining_v2_not_allowed', '--expected-remaining-v2 is only accepted with --mode rotate.');
  }

  const expectedPlaintextCopies = parseCount(
    opts['expected-plaintext-copies'],
    0,
    'expected_plaintext_copies_required',
    'expected_plaintext_copies_invalid',
    'expected-plaintext-copies'
  );
  if (expectedPlaintextCopies > expectedTotal) {
    throw new ArgError('expected_plaintext_copies_invalid', '--expected-plaintext-copies cannot exceed --expected-total.');
  }

  const plaidEnvRaw = opts['expected-plaid-env'];
  if (typeof plaidEnvRaw !== 'string') throw new ArgError('expected_plaid_env_required', '--expected-plaid-env is required.');
  if (plaidEnvRaw !== REQUIRED_EXPECTED_PLAID_ENV) {
    throw new ArgError('expected_plaid_env_invalid', `--expected-plaid-env must be exactly "${REQUIRED_EXPECTED_PLAID_ENV}".`);
  }

  const hostRaw = opts['expected-supabase-host'];
  if (typeof hostRaw !== 'string') throw new ArgError('expected_supabase_host_required', '--expected-supabase-host is required.');
  if (!HOST_RE.test(hostRaw)) {
    throw new ArgError('expected_supabase_host_invalid', '--expected-supabase-host must be a bare lowercase hostname.');
  }

  const constraintsRaw = opts['constraints-confirmed'];
  if (typeof constraintsRaw !== 'string') throw new ArgError('constraints_confirmed_required', '--constraints-confirmed is required.');
  if (constraintsRaw !== CONSTRAINTS_ATTESTATION_TOKEN) {
    throw new ArgError('constraints_confirmed_invalid', `--constraints-confirmed must be exactly ${CONSTRAINTS_ATTESTATION_TOKEN}.`);
  }

  const apply = opts.apply === true;
  const confirmRaw = opts.confirm;
  if (mode === 'verify-retirement' && (apply || confirmRaw !== undefined)) {
    throw new ArgError('apply_not_allowed_in_mode', 'verify-retirement never writes; --apply/--confirm are not accepted.');
  }
  if (!apply && confirmRaw !== undefined) {
    // A stray confirmation token on a dry run is refused rather than ignored, so a run is never
    // mistaken for an applied one (or vice versa) from its command line.
    throw new ArgError('confirm_without_apply', '--confirm is only accepted together with --apply.');
  }
  if (apply && confirmRaw !== CONFIRM_TOKEN) {
    throw new ArgError('apply_requires_confirm', `--apply requires --confirm ${CONFIRM_TOKEN} (exact match).`);
  }

  return {
    mode,
    expectedTotal,
    expectedRemainingV2,
    expectedPlaintextCopies,
    expectedPlaidEnv: plaidEnvRaw,
    expectedSupabaseHost: hostRaw,
    apply,
  };
}

// ---- Key-ring policy -----------------------------------------------------------------------------

export type KeyRingFailureCode =
  | 'key_ring_unavailable'
  | 'v2_key_missing'
  | 'v3_key_missing'
  | 'v3_not_current'
  | 'v2_v3_identical_keys';

/** A ring holding ONLY the V3 key: every post-write and retirement check decrypts with this, so a
 *  "verified" outcome can never secretly depend on V2 still being configured. */
export function v3OnlyKeyRing(full: KeyRing): KeyRing | null {
  const v3 = full.keys.get(NEW_KEY_ID);
  if (!v3) return null;
  return { currentKeyId: NEW_KEY_ID, keys: new Map([[NEW_KEY_ID, v3]]) };
}

export function checkKeyRing(mode: Mode): { failures: KeyRingFailureCode[]; keyRing: KeyRing | null } {
  const failures: KeyRingFailureCode[] = [];
  let keyRing: KeyRing;
  try {
    keyRing = getKeyRing();
  } catch {
    return { failures: ['key_ring_unavailable'], keyRing: null };
  }
  const v2 = keyRing.keys.get(OLD_KEY_ID);
  const v3 = keyRing.keys.get(NEW_KEY_ID);
  // verify-retirement deliberately does not need V2 — it is the check run before (or after) V2 is
  // removed — so V2's absence is only a failure for rotate.
  if (mode === 'rotate' && !v2) failures.push('v2_key_missing');
  if (!v3) failures.push('v3_key_missing');
  if (keyRing.currentKeyId !== NEW_KEY_ID) failures.push('v3_not_current');
  // Raw byte comparison, producing only a boolean: a V3 configured with V2's bytes would make the
  // whole rotation meaningless.
  if (v2 && v3 && v2.equals(v3)) failures.push('v2_v3_identical_keys');
  return { failures, keyRing };
}

// ---- Whole-table inventory (read-only) ---------------------------------------------------------------

export interface Inventory {
  rows: TokenRow[];
  counts: Record<RowClass, number> & { total: number; plaintextCopies: number; distinctNonces: number };
}

export class DbError extends Error {
  stage: string;
  constructor(stage: string) {
    super(`Database operation failed at ${stage}`);
    this.stage = stage;
  }
}

/** Reads every plaid_items row with an exact count, and refuses a page shorter than the count
 *  (PostgREST row caps would otherwise make "every row" silently mean "the first N rows"). */
export async function readInventory(): Promise<Inventory> {
  const { data, error, count } = await supabaseAdmin
    .from('plaid_items')
    .select(TOKEN_ROW_COLUMNS, { count: 'exact' })
    .order('id', { ascending: true });
  if (error) throw new DbError('inventory_read');
  const rows = (data ?? []) as TokenRow[];
  if (typeof count !== 'number' || count !== rows.length) throw new DbError('inventory_truncated');

  const counts = {
    total: rows.length,
    v2: 0,
    v3: 0,
    plaintext_only: 0,
    partial: 0,
    missing_both: 0,
    unexpected_key: 0,
    unexpected_version: 0,
    plaintextCopies: 0,
    distinctNonces: 0,
  };
  const nonces = new Set<string>();
  for (const row of rows) {
    counts[classifyRow(row)]++;
    if (row.access_token !== null) counts.plaintextCopies++;
    if (row.access_token_nonce !== null) nonces.add(row.access_token_nonce);
  }
  counts.distinctNonces = nonces.size;
  return { rows, counts };
}

export interface LinkTokenInventory {
  withToken: number;
  v2: number;
  v2Unexpired: number;
  v3: number;
  unexpectedKey: number;
  unexpectedVersion: number;
}

/** Hosted Link tokens are never rewritten here (see the design doc: they live at most 30 minutes
 *  and are erased by the app's own state machine) — they are only counted, so V2 retirement can be
 *  gated on none of them still referencing V2. */
export async function readLinkTokenInventory(now: Date = new Date()): Promise<LinkTokenInventory> {
  const { data, error, count } = await supabaseAdmin
    .from('plaid_link_attempts')
    .select(LINK_ATTEMPT_COLUMNS, { count: 'exact' })
    .not('link_token_key_id', 'is', null)
    .order('id', { ascending: true });
  if (error) throw new DbError('link_inventory_read');
  const rows = (data ?? []) as LinkAttemptRow[];
  if (typeof count !== 'number' || count !== rows.length) throw new DbError('link_inventory_truncated');

  const inv: LinkTokenInventory = { withToken: rows.length, v2: 0, v2Unexpired: 0, v3: 0, unexpectedKey: 0, unexpectedVersion: 0 };
  for (const row of rows) {
    if (row.link_token_enc_version !== EXPECTED_ENC_VERSION) {
      inv.unexpectedVersion++;
    } else if (row.link_token_key_id === OLD_KEY_ID) {
      inv.v2++;
      // Informational only (local clock vs. the database's): the retirement gate counts every V2
      // link token, expired or not, because readPlaidLinkAttempt still decrypts expired ones.
      const expiresAt = Date.parse(row.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) inv.v2Unexpired++;
    } else if (row.link_token_key_id === NEW_KEY_ID) {
      inv.v3++;
    } else {
      inv.unexpectedKey++;
    }
  }
  return inv;
}

// ---- Preflight ----------------------------------------------------------------------------------------

export type PreflightFailureCode =
  | KeyRingFailureCode
  | 'unexpected_plaid_environment'
  | 'supabase_host_unparseable'
  | 'unexpected_supabase_host'
  | 'unexpected_total_count'
  | 'unexpected_remaining_v2_count'
  | 'unexpected_plaintext_copy_count'
  | 'v2_rows_remaining'
  | 'plaintext_only_rows_present'
  | 'partial_rows_present'
  | 'missing_both_rows_present'
  | 'unexpected_key_rows_present'
  | 'unexpected_version_rows_present'
  | 'nonce_reuse_detected'
  | 'link_tokens_unexpected_key'
  | 'link_tokens_unexpected_version'
  | 'v2_link_tokens_remaining';

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailureCode[];
  keyRing: KeyRing | null;
  inventory: Inventory | null;
  linkTokens: LinkTokenInventory | null;
}

export async function runPreflight(args: ParsedArgs): Promise<PreflightResult> {
  const failures: PreflightFailureCode[] = [];

  if (env.plaidEnv !== args.expectedPlaidEnv) failures.push('unexpected_plaid_environment');

  // Which database this process is about to touch is proved before anything is read from it. The
  // host is compared, never logged.
  let host: string | null = null;
  try {
    host = new URL(env.supabaseUrl).host.toLowerCase();
  } catch {
    failures.push('supabase_host_unparseable');
  }
  if (host !== null && host !== args.expectedSupabaseHost) failures.push('unexpected_supabase_host');

  const keyCheck = checkKeyRing(args.mode);
  failures.push(...keyCheck.failures);

  // Nothing is read from a database that is not the expected one.
  if (failures.includes('unexpected_supabase_host') || failures.includes('supabase_host_unparseable')) {
    return { ok: false, failures, keyRing: keyCheck.keyRing, inventory: null, linkTokens: null };
  }

  const inventory = await readInventory();
  const linkTokens = await readLinkTokenInventory();
  const c = inventory.counts;

  if (c.total !== args.expectedTotal) failures.push('unexpected_total_count');
  if (c.plaintextCopies !== args.expectedPlaintextCopies) failures.push('unexpected_plaintext_copy_count');
  if (args.mode === 'rotate' && c.v2 !== args.expectedRemainingV2) failures.push('unexpected_remaining_v2_count');
  if (args.mode === 'verify-retirement' && c.v2 !== 0) failures.push('v2_rows_remaining');
  // Every row must be either V2 or V3 at the expected version. Anything else is refused outright —
  // never repaired, never skipped — and is a separate, reviewed problem.
  if (c.plaintext_only > 0) failures.push('plaintext_only_rows_present');
  if (c.partial > 0) failures.push('partial_rows_present');
  if (c.missing_both > 0) failures.push('missing_both_rows_present');
  if (c.unexpected_key > 0) failures.push('unexpected_key_rows_present');
  if (c.unexpected_version > 0) failures.push('unexpected_version_rows_present');
  const encryptedRows = c.v2 + c.v3 + c.unexpected_key + c.unexpected_version;
  if (c.distinctNonces !== encryptedRows) failures.push('nonce_reuse_detected');

  if (linkTokens.unexpectedKey > 0) failures.push('link_tokens_unexpected_key');
  if (linkTokens.unexpectedVersion > 0) failures.push('link_tokens_unexpected_version');
  if (args.mode === 'verify-retirement' && linkTokens.v2 > 0) failures.push('v2_link_tokens_remaining');

  return { ok: failures.length === 0, failures, keyRing: keyCheck.keyRing, inventory, linkTokens };
}

// ---- Errors / interruption ------------------------------------------------------------------------------

export class HaltError extends Error {
  targetId?: string;
  reason: string;
  constructor(targetId: string | undefined, reason: string) {
    super(`Halting: ${reason}`);
    this.targetId = targetId;
    this.reason = reason;
  }
}

/** Thrown the moment a SIGINT/SIGTERM is observed — distinct from HaltError, so an interrupt is
 *  never logged as a `halted:*` reason. */
export class InterruptedError extends Error {
  targetId?: string;
  constructor(targetId?: string) {
    super('Interrupted by SIGINT/SIGTERM');
    this.targetId = targetId;
  }
}

let interruptRequested = false;

function throwIfInterrupted(id?: string): void {
  if (interruptRequested) throw new InterruptedError(id);
}

/** Exposed only for tests, which cannot send this process a real OS signal. */
export function __setInterruptedForTests(value: boolean): void {
  interruptRequested = value;
}

function classifyDecryptError(err: unknown): string {
  if (err instanceof UnknownKeyIdError) return 'unknown_key';
  if (err instanceof UnsupportedEncryptionVersionError) return 'unsupported_version';
  if (err instanceof MalformedNonceError || err instanceof MalformedAuthTagError || err instanceof MalformedCiphertextError) {
    return 'malformed_ciphertext';
  }
  if (err instanceof GcmAuthenticationError) return 'crypto_mismatch';
  return 'decrypt_error';
}

function decryptOrHalt(id: string, stage: string, row: TokenRow, keyRing: KeyRing): string {
  try {
    return decryptAccessToken(toEnc(row), keyRing, id);
  } catch (err) {
    const reason = classifyDecryptError(err);
    logEntry({ id, stage, outcome: `failed:${reason}` });
    throw new HaltError(id, reason);
  }
}

// ---- DB helpers ------------------------------------------------------------------------------------------

async function rereadRow(id: string, stage: string): Promise<TokenRow | null> {
  const { data, error } = await supabaseAdmin.from('plaid_items').select(TOKEN_ROW_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new DbError(stage);
  return (data as TokenRow | null) ?? null;
}

/**
 * The guarded rotation update. Matches only: this exact id, still on V2 at version 1, and with the
 * same plaintext-copy PRESENCE that was just read (so a row whose plaintext appeared or vanished
 * meanwhile is never touched). It never filters on a ciphertext/nonce/tag/plaintext VALUE — those
 * would travel in the request URL and land in API logs (design doc §11: nonces are never logged).
 * That is safe because no application code path rewrites a stored access token (rows are only
 * inserted), so "still V2" can only change through this script, which converges on the same
 * plaintext — see the design doc's concurrency section.
 *
 * Updates ONLY the five encrypted columns: `access_token`, `status`, `updated_at` and everything
 * else are absent from the payload. Returns the number of rows the update matched.
 */
async function guardedRotateUpdate(id: string, prospective: EncryptedAccessToken, plaintextPresent: boolean): Promise<number> {
  let query = supabaseAdmin
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
    .eq('access_token_enc_version', EXPECTED_ENC_VERSION);
  query = plaintextPresent ? query.not('access_token', 'is', null) : query.is('access_token', null);
  const { data, error } = await query.select('id');
  if (error) throw new DbError('write');
  return (data ?? []).length;
}

// ---- Per-row verification of a stored V3 representation (zero writes) -----------------------------------

/**
 * Independently reclassifies `row` (never trusting a caller's earlier classification), requires the
 * plaintext copy to be exactly what it was before the run touched the row, and decrypts the STORED
 * value with the V3-only ring. `expectedToken` is the V2-decrypted token when this run decrypted
 * one; for a row already on V3 at the start there is none, and the plaintext copy (if any) is the
 * only cross-check available.
 */
function verifyStoredV3(
  id: string,
  row: TokenRow,
  v3Ring: KeyRing,
  plaintextBefore: string | null,
  expectedToken: string | null
): void {
  const cls = classifyRow(row);
  if (cls !== 'v3') {
    logEntry({ id, stage: 'verify_v3_state', outcome: `failed:${cls === 'v2' ? 'still_v2' : cls}` });
    throw new HaltError(id, cls === 'v2' ? 'still_v2' : cls);
  }
  if (row.access_token !== plaintextBefore) {
    // Appeared, vanished or changed — this script never writes that column, so something else did.
    logEntry({ id, stage: 'verify_v3_state', outcome: 'failed:plaintext_copy_changed' });
    throw new HaltError(id, 'plaintext_copy_changed');
  }
  const decrypted = decryptOrHalt(id, 'verify_v3_decrypt', row, v3Ring);
  if (expectedToken !== null && decrypted !== expectedToken) {
    logEntry({ id, stage: 'verify_v3_compare', outcome: 'failed:v3_token_mismatch' });
    throw new HaltError(id, 'v3_token_mismatch');
  }
  if (plaintextBefore !== null && decrypted !== plaintextBefore) {
    logEntry({ id, stage: 'verify_v3_compare', outcome: 'failed:v3_plaintext_mismatch' });
    throw new HaltError(id, 'v3_plaintext_mismatch');
  }
}

// ---- Per-row rotation ---------------------------------------------------------------------------------------

export type RowOutcome = 'already_v3_verified' | 'dry_run_verified' | 'rotated' | 'concurrent_rotation_verified';

/** `fingerprint` is rowFingerprint() of exactly the stored state this call verified. */
export interface RowResult {
  outcome: RowOutcome;
  fingerprint: string;
}

export async function rotateRow(id: string, apply: boolean, fullRing: KeyRing): Promise<RowResult> {
  const v3Ring = v3OnlyKeyRing(fullRing);
  if (!v3Ring) throw new HaltError(id, 'v3_key_missing');

  throwIfInterrupted(id);
  const initial = await rereadRow(id, 'reread_initial');
  throwIfInterrupted(id);
  if (!initial) {
    logEntry({ id, stage: 'reread_initial', outcome: 'failed:row_missing' });
    throw new HaltError(id, 'row_missing');
  }
  const plaintextBefore = initial.access_token;
  const cls = classifyRow(initial);

  if (cls === 'v3') {
    // Resume path: a previous (possibly interrupted) run already rotated this row. Never re-encrypt
    // or write; reverify what is stored.
    verifyStoredV3(id, initial, v3Ring, plaintextBefore, null);
    logEntry({ id, stage: 'done', outcome: 'already_v3_verified' });
    return { outcome: 'already_v3_verified', fingerprint: rowFingerprint(initial) };
  }
  if (cls !== 'v2') {
    logEntry({ id, stage: 'reread_initial', outcome: `failed:${cls}` });
    throw new HaltError(id, cls);
  }

  // Decrypt V2. For a row with a plaintext copy the two must agree — if they disagree, halt and
  // never pick one as authoritative. For the encrypted-only row (Hosted Link items never had a
  // plaintext copy) the V2 ciphertext is the only source, so its decryption is what gets carried
  // to V3 and is cross-checked through the full round trip below.
  const token = decryptOrHalt(id, 'decrypt_v2', initial, fullRing);
  if (plaintextBefore !== null && token !== plaintextBefore) {
    logEntry({ id, stage: 'decrypt_v2', outcome: 'failed:v2_plaintext_mismatch' });
    throw new HaltError(id, 'v2_plaintext_mismatch');
  }

  const prospective = encryptAccessToken(token, fullRing, id);
  if (prospective.keyId !== NEW_KEY_ID || prospective.encVersion !== EXPECTED_ENC_VERSION) {
    logEntry({ id, stage: 'prospective_v3', outcome: 'failed:unexpected_prospective_metadata' });
    throw new HaltError(id, 'unexpected_prospective_metadata');
  }
  let roundTrip: string;
  try {
    roundTrip = decryptAccessToken(prospective, v3Ring, id);
  } catch {
    roundTrip = '';
  }
  if (roundTrip !== token) {
    logEntry({ id, stage: 'prospective_v3', outcome: 'failed:local_round_trip_mismatch' });
    throw new HaltError(id, 'local_round_trip_mismatch');
  }

  if (!apply) {
    throwIfInterrupted(id);
    logEntry({ id, stage: 'done', outcome: 'dry_run_verified' });
    return { outcome: 'dry_run_verified', fingerprint: rowFingerprint(initial) };
  }

  throwIfInterrupted(id);
  logEntry({ id, stage: 'write', outcome: 'started' });
  const affected = await guardedRotateUpdate(id, prospective, plaintextBefore !== null);
  // If interrupted here the write may or may not have committed; the next run's initial reread
  // finds the real state (V3 → reverified with zero writes; still V2 → rotated again).
  throwIfInterrupted(id);
  if (affected > 1) {
    // Impossible for a primary-key filter; refuse to continue rather than reason about it.
    logEntry({ id, stage: 'write', outcome: 'failed:multiple_rows_affected' });
    throw new HaltError(id, 'multiple_rows_affected');
  }
  logEntry({ id, stage: 'write', outcome: affected === 1 ? 'committed' : 'no_rows_matched' });

  const after = await rereadRow(id, 'reread_after_write');
  throwIfInterrupted(id);
  if (!after) {
    logEntry({ id, stage: 'reread_after_write', outcome: 'failed:row_missing_after_write' });
    throw new HaltError(id, 'row_missing_after_write');
  }
  if (affected === 0 && classifyRow(after) === 'v2') {
    // Nothing matched and the row is still V2: its plaintext presence changed under us (the only
    // other guard). Halt; never retry with the discarded local ciphertext.
    logEntry({ id, stage: 'reread_after_write', outcome: 'failed:update_not_applied' });
    throw new HaltError(id, 'update_not_applied');
  }
  // Whether this run's write won or a concurrent run of this script got there first, what is now
  // STORED is what gets verified — never the local `prospective` object.
  verifyStoredV3(id, after, v3Ring, plaintextBefore, token);
  const outcome: RowOutcome = affected === 1 ? 'rotated' : 'concurrent_rotation_verified';
  logEntry({ id, stage: 'done', outcome });
  return { outcome, fingerprint: rowFingerprint(after) };
}

// ---- verify-retirement: every row decrypts with the V3-only ring, zero writes -------------------------------

/** Returns rowFingerprint() of each row as verified, keyed by id. */
export async function verifyAllWithV3Only(rows: TokenRow[], fullRing: KeyRing): Promise<Map<string, string>> {
  const v3Ring = v3OnlyKeyRing(fullRing);
  if (!v3Ring) throw new HaltError(undefined, 'v3_key_missing');
  const verified = new Map<string, string>();
  for (const listed of rows) {
    throwIfInterrupted(listed.id);
    // Fresh reread per row, so the gate reflects the database now, not the inventory snapshot.
    const row = await rereadRow(listed.id, 'verify_reread');
    throwIfInterrupted(listed.id);
    if (!row) {
      logEntry({ id: listed.id, stage: 'verify_reread', outcome: 'failed:row_missing' });
      throw new HaltError(listed.id, 'row_missing');
    }
    verifyStoredV3(listed.id, row, v3Ring, listed.access_token, null);
    logEntry({ id: listed.id, stage: 'done', outcome: 'v3_only_verified' });
    verified.set(listed.id, rowFingerprint(row));
  }
  return verified;
}

// ---- Signal handling ----------------------------------------------------------------------------------------

let signalHandlersInstalled = false;

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const onSignal = (signal: string) => {
    interruptRequested = true;
    logEntry({ stage: 'signal', outcome: `received_${signal.toLowerCase()}` });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

// ---- Orchestration --------------------------------------------------------------------------------------------

function inventoryCounts(p: PreflightResult): Record<string, number> {
  const c = p.inventory?.counts;
  const l = p.linkTokens;
  return {
    total: c?.total ?? -1,
    v2: c?.v2 ?? -1,
    v3: c?.v3 ?? -1,
    plaintext_copies: c?.plaintextCopies ?? -1,
    encrypted_only: c ? c.v2 + c.v3 - c.plaintextCopies : -1,
    anomalies: c ? c.plaintext_only + c.partial + c.missing_both + c.unexpected_key + c.unexpected_version : -1,
    distinct_nonces: c?.distinctNonces ?? -1,
    link_tokens_v2: l?.v2 ?? -1,
    link_tokens_v2_unexpired: l?.v2Unexpired ?? -1,
    link_tokens_v3: l?.v3 ?? -1,
  };
}

export type FinalCheckFailure =
  | 'row_set_changed'
  | 'row_changed_after_verification'
  | 'total_changed'
  | 'plaintext_copy_count_changed'
  | 'anomalous_rows_present'
  | 'nonce_reuse_detected'
  | 'row_shape_changed'
  | 'v2_rows_remaining'
  | 'non_v3_rows_present'
  | 'new_v2_link_tokens_created'
  | 'v2_link_tokens_remaining'
  | 'link_tokens_unexpected_key'
  | 'link_tokens_unexpected_version';

/**
 * The whole-table recount every mode runs before it may report success, so a success line can never
 * overlook an item inserted, deleted or changed — or a link token written under V2 — while the
 * per-row pass ran. `expect` is what the table must look like now:
 *   'unchanged'  (dry run)          the same V2/V3 split as at preflight;
 *   'all_v3'     (apply, retirement) nothing left on V2, every row on V3.
 * The row-id set must be identical to the preflight inventory (a delete plus an insert keeps the
 * total but is still a different table). A V2 link token count that GREW means some writer still
 * encrypts under V2 — the "missed writer" case — and fails every mode; retirement additionally
 * requires zero V2 link tokens.
 *
 * `verified` maps each row id to rowFingerprint() of the state the per-row pass verified; every row
 * must still match it exactly, so a change to any ciphertext, nonce, tag, key id, version or plaintext
 * value made after that row's verification is caught too. Fingerprints are compared in memory only.
 */
export async function finalRecheck(
  args: ParsedArgs,
  before: { inventory: Inventory; linkTokens: LinkTokenInventory },
  expect: 'unchanged' | 'all_v3',
  verified: ReadonlyMap<string, string>
): Promise<{ failures: FinalCheckFailure[]; inventory: Inventory; linkTokens: LinkTokenInventory }> {
  const inventory = await readInventory();
  const linkTokens = await readLinkTokenInventory();
  const c = inventory.counts;
  const b = before.inventory.counts;
  const failures: FinalCheckFailure[] = [];

  const idsBefore = before.inventory.rows.map((r) => r.id).join(',');
  const idsNow = inventory.rows.map((r) => r.id).join(','); // both ordered by id
  if (idsNow !== idsBefore) failures.push('row_set_changed');
  if (inventory.rows.some((r) => verified.get(r.id) !== rowFingerprint(r))) failures.push('row_changed_after_verification');
  if (c.total !== args.expectedTotal) failures.push('total_changed');
  if (c.plaintextCopies !== args.expectedPlaintextCopies) failures.push('plaintext_copy_count_changed');
  if (c.plaintext_only + c.partial + c.missing_both + c.unexpected_key + c.unexpected_version > 0) {
    failures.push('anomalous_rows_present');
  }
  if (c.distinctNonces !== c.total) failures.push('nonce_reuse_detected');
  if (expect === 'unchanged') {
    if (c.v2 !== b.v2 || c.v3 !== b.v3) failures.push('row_shape_changed');
  } else {
    if (c.v2 !== 0) failures.push('v2_rows_remaining');
    if (c.v3 !== c.total) failures.push('non_v3_rows_present');
  }
  if (linkTokens.v2 > before.linkTokens.v2) failures.push('new_v2_link_tokens_created');
  if (args.mode === 'verify-retirement' && linkTokens.v2 > 0) failures.push('v2_link_tokens_remaining');
  if (linkTokens.unexpectedKey > 0) failures.push('link_tokens_unexpected_key');
  if (linkTokens.unexpectedVersion > 0) failures.push('link_tokens_unexpected_version');
  return { failures, inventory, linkTokens };
}

async function finishWithRecheck(
  args: ParsedArgs,
  preflight: PreflightResult & { inventory: Inventory; linkTokens: LinkTokenInventory },
  expect: 'unchanged' | 'all_v3',
  verified: ReadonlyMap<string, string>,
  successOutcome: string,
  tally?: Record<string, number>
): Promise<number> {
  const recheck = await finalRecheck(args, preflight, expect, verified);
  throwIfInterrupted();
  const counts = inventoryCounts({ ...preflight, inventory: recheck.inventory, linkTokens: recheck.linkTokens });
  for (const f of recheck.failures) logEntry({ stage: 'final_check', outcome: `failed:${f}` });
  if (recheck.failures.length > 0) {
    logEntry({ stage: 'final_check', outcome: 'failed', counts });
    return 1;
  }
  logEntry({ stage: 'final_check', outcome: 'passed', counts });
  logEntry({ stage: 'done', outcome: successOutcome, counts: tally });
  return 0;
}

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
    logEntry({ stage: 'preflight', outcome: `started:${args.mode}${args.apply ? ':apply' : ':read_only'}` });
    const preflight = await runPreflight(args);
    throwIfInterrupted();
    if (preflight.inventory) logEntry({ stage: 'inventory', outcome: 'read', counts: inventoryCounts(preflight) });
    for (const failure of preflight.failures) logEntry({ stage: 'preflight', outcome: `failed:${failure}` });
    if (!preflight.ok || !preflight.keyRing || !preflight.inventory || !preflight.linkTokens) {
      logEntry({ stage: 'preflight', outcome: 'failed' });
      return 1;
    }
    logEntry({ stage: 'preflight', outcome: 'passed' });
    const checked = { ...preflight, inventory: preflight.inventory, linkTokens: preflight.linkTokens };

    if (args.mode === 'verify-retirement') {
      const verified = await verifyAllWithV3Only(preflight.inventory.rows, preflight.keyRing);
      throwIfInterrupted();
      // Recount after the per-row pass, so a row inserted under V2 (or a V2 link token created)
      // while the pass ran is caught here rather than missed.
      return await finishWithRecheck(args, checked, 'all_v3', verified, 'v2_retirement_gate_passed');
    }

    const tally: Record<RowOutcome, number> = {
      already_v3_verified: 0,
      dry_run_verified: 0,
      rotated: 0,
      concurrent_rotation_verified: 0,
    };
    const verified = new Map<string, string>();
    // Id order, halting on the first failure — rows after a failed one are left exactly as they are.
    for (const row of preflight.inventory.rows) {
      throwIfInterrupted(row.id);
      const result = await rotateRow(row.id, args.apply, preflight.keyRing);
      tally[result.outcome]++;
      verified.set(row.id, result.fingerprint);
    }
    throwIfInterrupted();

    // Same recount for the dry run as for apply: a dry run that "passed" while an item was added,
    // removed or changed, or while a writer created V2 link tokens, would be a false green light.
    return args.apply
      ? await finishWithRecheck(args, checked, 'all_v3', verified, 'rotation_complete', tally)
      : await finishWithRecheck(args, checked, 'unchanged', verified, 'dry_run_complete', tally);
  } catch (err) {
    if (err instanceof InterruptedError) {
      logEntry({ id: err.targetId, stage: 'run', outcome: 'interrupted' });
      return 1;
    }
    if (err instanceof HaltError) {
      logEntry({ id: err.targetId, stage: 'run', outcome: `halted:${err.reason}` });
      return 1;
    }
    if (err instanceof DbError) {
      logEntry({ stage: 'run', outcome: `halted:db_error:${err.stage}` });
      return 1;
    }
    logEntry({ stage: 'run', outcome: 'halted:unexpected_error' });
    return 1;
  }
}

/* istanbul ignore next -- exercised only when run as a process in manual use, not in unit tests */
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
