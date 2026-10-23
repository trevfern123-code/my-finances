/**
 * Manually-invoked, guarded move of every existing Plaid Item's webhook URL (Plaid
 * `/item/webhook/update`) — the existing-Item half of the Railway → Render webhook migration in
 * PLAID_KEY_ROTATION_V2_TO_V3.md §5.3. New Items get their webhook from BACKEND_PUBLIC_URL at Link
 * time; Items linked earlier keep the URL they were created with until this runs.
 *
 * Exactly two webhook URLs are ever involved, both canonical `https://<host>/api/webhooks/plaid`:
 *   OWN       derived from this process's BACKEND_PUBLIC_URL (what plaidService registers on new
 *             Link tokens) — required and canonical, for both directions;
 *   PREVIOUS  `--approved-previous-webhook-url`, the old backend's URL as recorded in the runbook's
 *             parity matrix — required, and must differ from OWN.
 * `--target-role this-backend` moves Items PREVIOUS → OWN; `--target-role other-backend` is the
 * rollback, OWN → PREVIOUS. `--target-webhook-url` must repeat the role's target exactly (a second,
 * independent statement of intent, so a typo in either is refused rather than obeyed).
 *
 * Three phases, all fail-closed:
 *  1. Read-only classification of EVERY Item before anything changes: the stored external
 *     `plaid_item_id` must equal the `item_id` Plaid returns for the decrypted token (a stale or
 *     misassociated credential must never move some other Item's webhook), and each current webhook
 *     must be the target, the other approved URL, or none. Any third-party URL, any id mismatch, or a
 *     no-webhook count different from `--expected-no-webhook` halts here — no update is made.
 *  2. Apply only (`--apply --confirm UPDATE_PLAID_ITEM_WEBHOOKS`): `/item/webhook/update` for each
 *     Item still needing it, each followed by `/item/get` (item id and webhook both re-checked).
 *  3. Postflight at Plaid: every Item is re-read again; only if each still has its expected webhook
 *     (and id) — and the database Item set is unchanged — is `webhooks_on_target` logged. An earlier
 *     Item that changed again while a later one was being updated is caught here.
 *
 * "No webhook" as Plaid reports it: `/item/get` returns `item.webhook` as a nullable string, documented as
 * "Empty string if no webhook is set" (plaid-openapi 2020-09-14.yml). Both `""` and `null` mean none here;
 * a missing field or any non-string value halts (`malformed_webhook_field`) instead (canonicalReadWebhook).
 *
 * Items with NO webhook: the forward move updates them to OWN only when their number equals
 * `--expected-no-webhook` (0 refuses any). The dry run logs `source:none` with their internal row ids,
 * so the operator can record them; a rollback restores exactly those to "no webhook" (Plaid documents
 * `webhook: null` as removal) when they are listed in `--restore-no-webhook-ids`, and otherwise moves
 * them to PREVIOUS like any other Item on OWN.
 *
 * Never writes the database (token rows are only read, to decrypt each access token in-process with
 * no plaintext fallback). Never logs an access token, ciphertext, Plaid's external item_id, a webhook
 * URL, a host name or a raw error: lines are `{ts, id?, stage, outcome, counts?}` with fixed codes and
 * internal row ids only. Never imported by the server; does nothing unless run as the entrypoint.
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
  'id, plaid_item_id, status, access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface ItemRow {
  id: string;
  plaid_item_id: string;
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
  approvedPreviousWebhookUrl: string;
  expectedTotal: number;
  expectedNoWebhook: number;
  restoreNoWebhookIds: string[];
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

const KNOWN_FLAGS = [
  'target-webhook-url',
  'target-role',
  'approved-previous-webhook-url',
  'expected-total',
  'expected-no-webhook',
  'restore-no-webhook-ids',
  'expected-plaid-env',
  'expected-supabase-host',
  'confirm',
  'apply',
];
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

/** The webhook URL this process itself registers on new Link tokens (plaidService.ts builds it the
 *  same way), or null when BACKEND_PUBLIC_URL is unset or would not produce a canonical URL (e.g. a
 *  trailing slash, which would make plaidService register `//api/...`). */
export function ownWebhookUrl(): string | null {
  return env.backendPublicUrl ? canonicalWebhookUrl(`${env.backendPublicUrl}${WEBHOOK_PATH}`) : null;
}

function parseCount(raw: string | true | undefined, flag: string, min: number): number {
  if (typeof raw !== 'string') throw new ArgError(`${flag.replace(/-/g, '_')}_required`, `--${flag} is required.`);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || Number(raw) < min || Number(raw) > MAX_COUNT_FLAG) {
    throw new ArgError(`${flag.replace(/-/g, '_')}_invalid`, `--${flag} must be a canonical integer >= ${min}.`);
  }
  return Number(raw);
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

  const role = opts['target-role'];
  if (role !== 'this-backend' && role !== 'other-backend') {
    throw new ArgError('target_role_invalid', '--target-role must be exactly "this-backend" or "other-backend".');
  }

  const urlRaw = opts['target-webhook-url'];
  if (typeof urlRaw !== 'string') throw new ArgError('target_webhook_url_required', '--target-webhook-url is required.');
  const targetWebhookUrl = canonicalWebhookUrl(urlRaw);
  if (!targetWebhookUrl) {
    throw new ArgError('target_webhook_url_invalid', `--target-webhook-url must be exactly https://<lowercase host>${WEBHOOK_PATH}.`);
  }

  const prevRaw = opts['approved-previous-webhook-url'];
  if (typeof prevRaw !== 'string') {
    throw new ArgError('approved_previous_webhook_url_required', '--approved-previous-webhook-url is required (the parity matrix value).');
  }
  const approvedPreviousWebhookUrl = canonicalWebhookUrl(prevRaw);
  if (!approvedPreviousWebhookUrl) {
    throw new ArgError('approved_previous_webhook_url_invalid', `--approved-previous-webhook-url must be exactly https://<lowercase host>${WEBHOOK_PATH}.`);
  }

  const expectedTotal = parseCount(opts['expected-total'], 'expected-total', 1);
  const expectedNoWebhook = parseCount(opts['expected-no-webhook'], 'expected-no-webhook', 0);
  if (expectedNoWebhook > expectedTotal) throw new ArgError('expected_no_webhook_invalid', '--expected-no-webhook cannot exceed --expected-total.');

  let restoreNoWebhookIds: string[] = [];
  const restoreRaw = opts['restore-no-webhook-ids'];
  if (restoreRaw !== undefined) {
    if (role !== 'other-backend') {
      throw new ArgError('restore_only_on_rollback', '--restore-no-webhook-ids is only accepted with --target-role other-backend.');
    }
    restoreNoWebhookIds = String(restoreRaw).split(',');
    if (restoreNoWebhookIds.some((id) => !UUID_RE.test(id)) || new Set(restoreNoWebhookIds).size !== restoreNoWebhookIds.length) {
      throw new ArgError('restore_no_webhook_ids_invalid', '--restore-no-webhook-ids must be distinct lowercase plaid_items ids, comma-separated.');
    }
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

  return {
    targetWebhookUrl,
    targetRole: role,
    approvedPreviousWebhookUrl,
    expectedTotal,
    expectedNoWebhook,
    restoreNoWebhookIds,
    expectedPlaidEnv: plaidEnvRaw,
    expectedSupabaseHost: hostRaw,
    apply,
  };
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

export interface Plan {
  own: string;
  /** The URL each role moves Items TO, and the other approved URL it moves them FROM. */
  target: string;
  source: string;
}

export async function runPreflight(
  args: ParsedArgs
): Promise<{ failures: string[]; rows: ItemRow[] | null; keyRing: KeyRing | null; plan: Plan | null }> {
  const failures: string[] = [];
  if (env.plaidEnv !== args.expectedPlaidEnv) failures.push('unexpected_plaid_environment');

  let host: string | null = null;
  try {
    host = new URL(env.supabaseUrl).host.toLowerCase();
  } catch {
    failures.push('supabase_host_unparseable');
  }
  if (host !== null && host !== args.expectedSupabaseHost) failures.push('unexpected_supabase_host');

  // Both directions need this process's own URL: it is the target of the move and the only
  // acceptable source of the rollback.
  const own = ownWebhookUrl();
  let plan: Plan | null = null;
  if (own === null) {
    failures.push('own_webhook_url_unconfigured');
  } else if (args.approvedPreviousWebhookUrl === own) {
    failures.push('previous_equals_own');
  } else {
    plan =
      args.targetRole === 'this-backend'
        ? { own, target: own, source: args.approvedPreviousWebhookUrl }
        : { own, target: args.approvedPreviousWebhookUrl, source: own };
    // The explicit target must be exactly the role's target: a typo'd or arbitrary host is refused.
    if (args.targetWebhookUrl !== plan.target) {
      failures.push(args.targetRole === 'this-backend' ? 'target_is_not_this_backend' : 'target_is_not_approved_previous');
    }
  }

  let keyRing: KeyRing | null = null;
  try {
    keyRing = getKeyRing();
  } catch {
    failures.push('key_ring_unavailable');
  }

  if (failures.includes('unexpected_supabase_host') || failures.includes('supabase_host_unparseable')) {
    return { failures, rows: null, keyRing, plan };
  }
  const rows = await readItems();
  if (rows.length !== args.expectedTotal) failures.push('unexpected_total_count');
  // An Item being removed is frozen by the app (itemStatus.ts); it is not this tool's to touch.
  if (rows.some((r) => r.status === 'removing')) failures.push('item_being_removed');
  if (args.restoreNoWebhookIds.some((id) => !rows.some((r) => r.id === id))) failures.push('restore_id_not_found');
  return { failures, rows, keyRing, plan };
}

// ---- Plaid reads, bound to the stored external Item id -----------------------------------------------------------

/** `/item/get` for this row's token, refusing the answer unless it is about the Item this row says it
 *  is. Neither id is ever logged. */
async function readBoundItem(row: ItemRow, accessToken: string, stage: string): Promise<string | null> {
  let item: { item_id?: unknown; webhook?: unknown };
  try {
    item = (await plaidClient.itemGet({ access_token: accessToken })).data.item;
  } catch (err) {
    const reason = plaidFailureReason(err);
    logEntry({ id: row.id, stage, outcome: `failed:${reason}` });
    throw new HaltError(row.id, reason);
  }
  if (typeof item?.item_id !== 'string' || item.item_id !== row.plaid_item_id) {
    logEntry({ id: row.id, stage, outcome: 'failed:item_id_mismatch' });
    throw new HaltError(row.id, 'item_id_mismatch');
  }
  const webhook = canonicalReadWebhook(item.webhook);
  if (webhook === undefined) {
    logEntry({ id: row.id, stage, outcome: 'failed:malformed_webhook_field' });
    throw new HaltError(row.id, 'malformed_webhook_field');
  }
  return webhook;
}

/**
 * Plaid's `/item/get` `item.webhook` is a nullable string, documented as "Empty string if no webhook
 * is set" (plaid-openapi 2020-09-14.yml, Item.webhook). Both documented representations of "no
 * webhook" — `""` and `null` — become internal `null`, so classification, the post-update check after
 * a `webhook: null` removal, and the postflight all agree. Any other string is returned as-is (and is
 * then either one of the two approved URLs or refused as an unexpected source). A missing field or any
 * non-string value is NOT taken to mean "no webhook": it returns undefined and the caller halts.
 */
export function canonicalReadWebhook(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value === 'string') return value;
  return undefined;
}

// ---- Phase 1: classify every Item (read-only) ---------------------------------------------------------------------

export type SourceClass = 'on_target' | 'on_source' | 'none';

interface Classified {
  row: ItemRow;
  accessToken: string;
  source: SourceClass;
  /** What this Item's webhook must be when the run finishes: the target, or null (no webhook). */
  finalWebhook: string | null;
}

export async function classifyAll(rows: ItemRow[], keyRing: KeyRing, plan: Plan, args: ParsedArgs): Promise<Classified[]> {
  const classified: Classified[] = [];
  for (const row of rows) {
    throwIfInterrupted(row.id);
    const accessToken = resolveToken(row, keyRing);
    const webhook = await readBoundItem(row, accessToken, 'classify');
    throwIfInterrupted(row.id);
    let source: SourceClass;
    if (webhook === plan.target) source = 'on_target';
    else if (webhook === plan.source) source = 'on_source';
    else if (webhook === null) source = 'none';
    else {
      // A destination that is neither approved URL: never moved, in either direction.
      logEntry({ id: row.id, stage: 'classify', outcome: 'failed:unexpected_webhook_source' });
      throw new HaltError(row.id, 'unexpected_webhook_source');
    }
    const restoreToNone = args.restoreNoWebhookIds.includes(row.id);
    if (restoreToNone && source === 'on_target') {
      // A listed Item must be on OWN (to be restored) or already have no webhook (restored by an
      // earlier run of this rollback); one on PREVIOUS contradicts the operator's record.
      logEntry({ id: row.id, stage: 'classify', outcome: 'failed:restore_id_unexpected_state' });
      throw new HaltError(row.id, 'restore_id_unexpected_state');
    }
    // Rollback leaves a no-webhook Item as it is; the forward move gives it the target.
    const finalWebhook = restoreToNone || (source === 'none' && args.targetRole === 'other-backend') ? null : plan.target;
    logEntry({ id: row.id, stage: 'classify', outcome: `source:${source}${restoreToNone ? ':restore_to_none' : ''}` });
    classified.push({ row, accessToken, source, finalWebhook });
  }
  const none = classified.filter((c) => c.source === 'none').length;
  if (none !== args.expectedNoWebhook) {
    logEntry({ stage: 'classify', outcome: 'failed:unexpected_no_webhook_count', counts: { none } });
    throw new HaltError(undefined, 'unexpected_no_webhook_count');
  }
  return classified;
}

// ---- Phase 2: updates (apply only) --------------------------------------------------------------------------------

async function updateItem(c: Classified): Promise<void> {
  throwIfInterrupted(c.row.id);
  logEntry({ id: c.row.id, stage: 'webhook_update', outcome: c.finalWebhook === null ? 'started:remove' : 'started' });
  try {
    await plaidClient.itemWebhookUpdate({ access_token: c.accessToken, webhook: c.finalWebhook });
  } catch (err) {
    const reason = plaidFailureReason(err);
    logEntry({ id: c.row.id, stage: 'webhook_update', outcome: `failed:${reason}` });
    throw new HaltError(c.row.id, reason);
  }
  throwIfInterrupted(c.row.id);
  // Verified from a fresh /item/get (bound to the stored item id), never from the update's response.
  if ((await readBoundItem(c.row, c.accessToken, 'verify')) !== c.finalWebhook) {
    logEntry({ id: c.row.id, stage: 'verify', outcome: 'failed:webhook_not_applied' });
    throw new HaltError(c.row.id, 'webhook_not_applied');
  }
  logEntry({ id: c.row.id, stage: 'done', outcome: 'updated' });
}

// ---- Phase 3: postflight at Plaid ------------------------------------------------------------------------------------

async function postflight(classified: Classified[]): Promise<void> {
  for (const c of classified) {
    throwIfInterrupted(c.row.id);
    if ((await readBoundItem(c.row, c.accessToken, 'postflight')) !== c.finalWebhook) {
      logEntry({ id: c.row.id, stage: 'postflight', outcome: 'failed:webhook_changed_after_update' });
      throw new HaltError(c.row.id, 'webhook_changed_after_update');
    }
  }
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
    if (preflight.failures.length > 0 || !preflight.rows || !preflight.keyRing || !preflight.plan) {
      logEntry({ stage: 'preflight', outcome: 'failed' });
      return 1;
    }
    logEntry({ stage: 'preflight', outcome: 'passed', counts: { total: preflight.rows.length } });

    // Phase 1 completes for every Item before anything is changed.
    const classified = await classifyAll(preflight.rows, preflight.keyRing, preflight.plan, args);
    const pending = classified.filter((c) => (c.finalWebhook === null ? c.source !== 'none' : c.source !== 'on_target'));
    const counts = {
      total: classified.length,
      on_target: classified.filter((c) => c.source === 'on_target').length,
      on_source: classified.filter((c) => c.source === 'on_source').length,
      none: classified.filter((c) => c.source === 'none').length,
      to_update: pending.length,
    };
    logEntry({ stage: 'classify', outcome: 'passed', counts });

    if (args.apply) {
      for (const c of pending) await updateItem(c);
      // Phase 3: every Item re-read at Plaid after the last update — not just the database.
      await postflight(classified);
      logEntry({ stage: 'postflight', outcome: 'passed', counts: { total: classified.length } });
    }

    // The Item set must not have changed while the run went on: a new Item linked meanwhile was
    // never looked at (and may carry the old webhook).
    const finalRows = await readItems();
    if (finalRows.map((r) => r.id).join(',') !== preflight.rows.map((r) => r.id).join(',')) {
      logEntry({ stage: 'final_check', outcome: 'failed:item_set_changed', counts: { total: finalRows.length } });
      return 1;
    }
    logEntry({ stage: 'final_check', outcome: 'passed', counts: { total: finalRows.length } });
    logEntry({ stage: 'done', outcome: args.apply ? 'webhooks_on_target' : 'dry_run_complete', counts });
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
