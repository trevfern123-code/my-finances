/**
 * Manually-invoked, guarded move of every existing Plaid Item's webhook URL (Plaid
 * `/item/webhook/update`) — the existing-Item half of the Railway → Render webhook migration in
 * PLAID_KEY_ROTATION_V2_TO_V3.md §5.3. New Items get their webhook from BACKEND_PUBLIC_URL at Link
 * time; Items linked earlier keep the URL they were created with until this runs.
 *
 * Read-only by default: without `--apply --confirm UPDATE_PLAID_ITEM_WEBHOOKS` it only reads each
 * Item's current webhook with `/item/get` and reports how many already point at the target. With
 * apply it calls `/item/webhook/update` for each Item not yet on the target, then re-reads the Item
 * with `/item/get` and requires the stored webhook to equal the target exactly.
 *
 * The same command with the previous URL and `--target-role other-backend` is the rollback.
 * Updating a webhook is idempotent and reversible; it does not change, rotate or invalidate the
 * access token, does not sync transactions, and does not touch the database (no Supabase write of any
 * kind — the token rows are only read, to decrypt each access token in-process).
 *
 * Never logs or prints an access token, ciphertext, the external Plaid item_id, the webhook URL or
 * any host name, or a raw error: every line is `{ts, id?, stage, outcome, counts?}` with fixed codes.
 * Like the rotation script it is fixed-purpose, never imported by the server, and does nothing unless
 * it is the process's own entrypoint.
 */

import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import { plaidClient } from '../config/plaid';
import { decryptAccessToken, getKeyRing, type KeyRing } from '../services/tokenEncryption';

export const CONFIRM_TOKEN = 'UPDATE_PLAID_ITEM_WEBHOOKS';
export const WEBHOOK_PATH = '/api/webhooks/plaid';
const REQUIRED_EXPECTED_PLAID_ENV = 'sandbox';
const MAX_COUNT_FLAG = 1000;
const ITEM_COLUMNS =
  'id, status, access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version';

interface ItemRow {
  id: string;
  status: string;
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

// ---- Logging ------------------------------------------------------------------------------------------

export function logEntry(fields: { id?: string; stage: string; outcome: string; counts?: Record<string, number> }): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), id: fields.id, stage: fields.stage, outcome: fields.outcome, counts: fields.counts }));
}

// ---- CLI parsing --------------------------------------------------------------------------------------

export type TargetRole = 'this-backend' | 'other-backend';

export interface ParsedArgs {
  targetWebhookUrl: string;
  targetRole: TargetRole;
  expectedTotal: number;
  expectedPlaidEnv: string;
  expectedSupabaseHost: string;
  apply: boolean;
}

export class ArgError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const KNOWN_FLAGS = ['target-webhook-url', 'target-role', 'expected-total', 'expected-plaid-env', 'expected-supabase-host', 'confirm', 'apply'];
const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;

/** The only accepted shape: `https://<lowercase host>[:port]/api/webhooks/plaid` — no credentials,
 *  query, fragment or trailing slash. Returns the canonical string, or null. */
export function canonicalWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== WEBHOOK_PATH || !HOST_RE.test(url.host)) return null;
  const canonical = `https://${url.host}${WEBHOOK_PATH}`;
  // Reject anything the URL parser had to normalise (case, default port, encoded characters …).
  return canonical === raw ? canonical : null;
}

/** The webhook URL this process itself registers on new Link tokens (plaidService.ts). */
export function ownWebhookUrl(): string | null {
  return env.backendPublicUrl ? `${env.backendPublicUrl}${WEBHOOK_PATH}` : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const opts: Record<string, string | true> = {};
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
    if (key in opts) throw new ArgError('repeated_flag', `--${key} was supplied more than once.`);
    opts[key] = value;
  }

  const urlRaw = opts['target-webhook-url'];
  if (typeof urlRaw !== 'string') throw new ArgError('target_webhook_url_required', '--target-webhook-url is required.');
  const targetWebhookUrl = canonicalWebhookUrl(urlRaw);
  if (!targetWebhookUrl) {
    throw new ArgError('target_webhook_url_invalid', `--target-webhook-url must be exactly https://<lowercase host>${WEBHOOK_PATH}.`);
  }

  const role = opts['target-role'];
  if (role !== 'this-backend' && role !== 'other-backend') {
    throw new ArgError('target_role_invalid', '--target-role must be exactly "this-backend" or "other-backend".');
  }

  const totalRaw = opts['expected-total'];
  if (typeof totalRaw !== 'string') throw new ArgError('expected_total_required', '--expected-total is required.');
  if (!/^[1-9][0-9]*$/.test(totalRaw) || Number(totalRaw) > MAX_COUNT_FLAG) {
    throw new ArgError('expected_total_invalid', '--expected-total must be a positive integer.');
  }

  const plaidEnvRaw = opts['expected-plaid-env'];
  if (plaidEnvRaw !== REQUIRED_EXPECTED_PLAID_ENV) {
    throw new ArgError('expected_plaid_env_invalid', `--expected-plaid-env must be exactly "${REQUIRED_EXPECTED_PLAID_ENV}".`);
  }

  const hostRaw = opts['expected-supabase-host'];
  if (typeof hostRaw !== 'string' || !HOST_RE.test(hostRaw)) {
    throw new ArgError('expected_supabase_host_invalid', '--expected-supabase-host must be a bare lowercase hostname.');
  }

  const apply = opts.apply === true;
  if (!apply && opts.confirm !== undefined) throw new ArgError('confirm_without_apply', '--confirm is only accepted together with --apply.');
  if (apply && opts.confirm !== CONFIRM_TOKEN) throw new ArgError('apply_requires_confirm', `--apply requires --confirm ${CONFIRM_TOKEN}.`);

  return { targetWebhookUrl, targetRole: role, expectedTotal: Number(totalRaw), expectedPlaidEnv: plaidEnvRaw, expectedSupabaseHost: hostRaw, apply };
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

let interruptRequested = false;
export function __setInterruptedForTests(value: boolean): void {
  interruptRequested = value;
}
function throwIfInterrupted(id?: string): void {
  if (interruptRequested) throw new HaltError(id, 'interrupted');
}

/** A Plaid error code is a fixed, documented identifier (e.g. ITEM_LOGIN_REQUIRED) and safe to log;
 *  anything that does not look like one is reported generically. */
export function plaidFailureReason(err: unknown): string {
  const code = (err as { response?: { data?: { error_code?: unknown } } })?.response?.data?.error_code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return `plaid_error:${code}`;
  if (typeof (err as { response?: { status?: unknown } })?.response?.status === 'number') return 'plaid_error';
  return 'plaid_unreachable';
}

// ---- Token resolution (same rules as dataService.resolveAccessToken, no plaintext fallback) ------------

function resolveToken(row: ItemRow, keyRing: KeyRing): string {
  const enc = [row.access_token_ciphertext, row.access_token_nonce, row.access_token_auth_tag, row.access_token_key_id, row.access_token_enc_version];
  const present = enc.filter((f) => f !== null).length;
  if (present === 5) {
    try {
      return decryptAccessToken(
        {
          ciphertextBase64: row.access_token_ciphertext as string,
          nonceBase64: row.access_token_nonce as string,
          authTagBase64: row.access_token_auth_tag as string,
          keyId: row.access_token_key_id as string,
          encVersion: row.access_token_enc_version as number,
        },
        keyRing,
        row.id
      );
    } catch {
      throw new HaltError(row.id, 'decrypt_failed');
    }
  }
  if (present > 0) throw new HaltError(row.id, 'partial');
  if (row.access_token === null) throw new HaltError(row.id, 'missing_both');
  return row.access_token;
}

// ---- Preflight ----------------------------------------------------------------------------------------------

async function readItems(): Promise<ItemRow[]> {
  const { data, error, count } = await supabaseAdmin.from('plaid_items').select(ITEM_COLUMNS, { count: 'exact' }).order('id', { ascending: true });
  if (error) throw new HaltError(undefined, 'db_error:inventory_read');
  const rows = (data ?? []) as ItemRow[];
  if (typeof count !== 'number' || count !== rows.length) throw new HaltError(undefined, 'db_error:inventory_truncated');
  return rows;
}

export async function runPreflight(args: ParsedArgs): Promise<{ failures: string[]; rows: ItemRow[] | null; keyRing: KeyRing | null }> {
  const failures: string[] = [];
  if (env.plaidEnv !== args.expectedPlaidEnv) failures.push('unexpected_plaid_environment');

  let host: string | null = null;
  try {
    host = new URL(env.supabaseUrl).host.toLowerCase();
  } catch {
    failures.push('supabase_host_unparseable');
  }
  if (host !== null && host !== args.expectedSupabaseHost) failures.push('unexpected_supabase_host');

  // The declared role is checked both ways, so neither the normal move nor the rollback can be run
  // with the other's URL by mistake.
  const own = ownWebhookUrl();
  if (args.targetRole === 'this-backend' && own !== args.targetWebhookUrl) failures.push('target_is_not_this_backend');
  if (args.targetRole === 'other-backend' && own === args.targetWebhookUrl) failures.push('target_is_this_backend');

  let keyRing: KeyRing | null = null;
  try {
    keyRing = getKeyRing();
  } catch {
    failures.push('key_ring_unavailable');
  }

  if (failures.includes('unexpected_supabase_host') || failures.includes('supabase_host_unparseable')) {
    return { failures, rows: null, keyRing };
  }
  const rows = await readItems();
  if (rows.length !== args.expectedTotal) failures.push('unexpected_total_count');
  // An Item being removed is frozen by the app (itemStatus.ts); it is not this tool's to touch.
  if (rows.some((r) => r.status === 'removing')) failures.push('item_being_removed');
  return { failures, rows, keyRing };
}

// ---- Per-item flow --------------------------------------------------------------------------------------------

export type ItemOutcome = 'already_target' | 'would_update' | 'updated';

async function currentWebhook(id: string, accessToken: string): Promise<string | null> {
  try {
    const response = await plaidClient.itemGet({ access_token: accessToken });
    return response.data.item.webhook ?? null;
  } catch (err) {
    throw new HaltError(id, plaidFailureReason(err));
  }
}

export async function processItem(row: ItemRow, keyRing: KeyRing, target: string, apply: boolean): Promise<ItemOutcome> {
  throwIfInterrupted(row.id);
  const accessToken = resolveToken(row, keyRing);
  const before = await currentWebhook(row.id, accessToken);
  throwIfInterrupted(row.id);
  if (before === target) {
    logEntry({ id: row.id, stage: 'done', outcome: 'already_target' });
    return 'already_target';
  }
  if (!apply) {
    logEntry({ id: row.id, stage: 'done', outcome: before === null ? 'would_update:no_webhook' : 'would_update' });
    return 'would_update';
  }

  logEntry({ id: row.id, stage: 'webhook_update', outcome: 'started' });
  try {
    await plaidClient.itemWebhookUpdate({ access_token: accessToken, webhook: target });
  } catch (err) {
    const reason = plaidFailureReason(err);
    logEntry({ id: row.id, stage: 'webhook_update', outcome: `failed:${reason}` });
    throw new HaltError(row.id, reason);
  }
  throwIfInterrupted(row.id);

  // Verified from a fresh /item/get, never from the update call's own response.
  const after = await currentWebhook(row.id, accessToken);
  if (after !== target) {
    logEntry({ id: row.id, stage: 'verify', outcome: 'failed:webhook_not_applied' });
    throw new HaltError(row.id, 'webhook_not_applied');
  }
  logEntry({ id: row.id, stage: 'done', outcome: 'updated' });
  return 'updated';
}

// ---- Orchestration ----------------------------------------------------------------------------------------------

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

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    logEntry({ stage: 'startup', outcome: `failed:${err instanceof ArgError ? err.code : 'invalid_arguments'}` });
    return 1;
  }
  installSignalHandlers();

  try {
    logEntry({ stage: 'preflight', outcome: `started:${args.targetRole}${args.apply ? ':apply' : ':read_only'}` });
    const preflight = await runPreflight(args);
    for (const f of preflight.failures) logEntry({ stage: 'preflight', outcome: `failed:${f}` });
    if (preflight.failures.length > 0 || !preflight.rows || !preflight.keyRing) {
      logEntry({ stage: 'preflight', outcome: 'failed' });
      return 1;
    }
    logEntry({ stage: 'preflight', outcome: 'passed', counts: { total: preflight.rows.length } });

    const tally: Record<ItemOutcome, number> = { already_target: 0, would_update: 0, updated: 0 };
    for (const row of preflight.rows) {
      tally[await processItem(row, preflight.keyRing, args.targetWebhookUrl, args.apply)]++;
    }

    // The item set must not have changed while the pass ran: a new Item linked meanwhile was never
    // looked at (and, before the cutover is complete, may carry the old webhook).
    const finalRows = await readItems();
    if (finalRows.map((r) => r.id).join(',') !== preflight.rows.map((r) => r.id).join(',')) {
      logEntry({ stage: 'final_check', outcome: 'failed:item_set_changed', counts: { total: finalRows.length } });
      return 1;
    }
    logEntry({ stage: 'final_check', outcome: 'passed', counts: { total: finalRows.length } });
    logEntry({ stage: 'done', outcome: args.apply ? 'webhooks_on_target' : 'dry_run_complete', counts: tally });
    return 0;
  } catch (err) {
    if (err instanceof HaltError) {
      logEntry({ id: err.targetId, stage: 'run', outcome: `halted:${err.reason}` });
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
