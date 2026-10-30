import 'dotenv/config';
import { parseOptInFlag } from './flags';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const frontendUrl = required('FRONTEND_URL');

export const env = {
  port: Number(process.env.PORT ?? 4000),
  frontendUrl,

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  plaidClientId: required('PLAID_CLIENT_ID'),
  plaidSecret: required('PLAID_SECRET'),
  plaidEnv: (process.env.PLAID_ENV ?? 'sandbox') as 'sandbox' | 'development' | 'production',
  plaidProducts: (process.env.PLAID_PRODUCTS ?? 'transactions,auth').split(','),
  plaidCountryCodes: (process.env.PLAID_COUNTRY_CODES ?? 'US').split(','),

  // Optional: this backend's own public HTTPS URL (e.g. the Railway domain). When set, Plaid
  // Link is asked to register a webhook on every item so transactions/errors push to us instead
  // of relying only on manual refresh/sync. Left unset in local dev, where Plaid can't reach
  // localhost anyway.
  backendPublicUrl: process.env.BACKEND_PUBLIC_URL || null,

  // Where Plaid Hosted Link sends the user's browser tab when a Link session ends (Wave 1). A static
  // page of the frontend (frontend/public/plaid-link-complete.html); it carries nothing — the backend
  // gets the result from Plaid itself. Must also be allowed in the Plaid Dashboard.
  plaidHostedLinkCompletionRedirectUri:
    process.env.PLAID_HOSTED_LINK_COMPLETION_REDIRECT_URI ||
    `${frontendUrl.replace(/\/+$/, '')}/plaid-link-complete.html`,

  // Optional, default OFF (Financial Semantics Phase B, packet 2b-2a). When "true" (case-insensitive,
  // trimmed), every successful transaction sync ends with one best-effort card-payment matching
  // evaluation for the user (services/cardPaymentEvaluation.ts). Requires the Phase B matching migrations
  // (20260930120000 onward). Any other value, including "false", leaves it off, and then no matching
  // evaluation is ever requested. This flag controls the evaluation only. The evaluated states are
  // read, never written, by the role-aware read path (services/semanticReadPath.ts), which runs only
  // for a client at API level 2 or above and is independent of this flag.
  cardPaymentSyncEvaluationEnabled: parseOptInFlag(process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED),

  // Optional, default OFF (Financial Semantics Phase B, I3A-R packet 2-A). When "true", a user may change a
  // payment from its review: pair it with a current transaction, say it went to a card that is not linked,
  // dismiss a candidate, undo one of those, reject a suggestion, defer (POST /api/card-payment-recovery/actions).
  // OFF refuses that one endpoint and nothing else. It does NOT switch the protection off — the relink-review
  // guard is in the database evaluator and has no switch — and the review, the receipts and the refresh-only
  // retry stay available. Requires migration 20261009120000.
  cardPaymentRecoveryActionsEnabled: parseOptInFlag(process.env.CARD_PAYMENT_RECOVERY_ACTIONS_ENABLED),

  // Optional, default OFF (packet 2-A). When "true", this process runs the durable refresh worker
  // (workers/cardPaymentRecoveryWorker.ts): it brings an owner's card-payment figures up to date whenever the
  // database has registered that they are not, with no bank sync needed. Independent of
  // CARD_PAYMENT_SYNC_EVALUATION_ENABLED. It must be ON wherever migration 20261009120000 is applied and users
  // are served: that migration makes every user unreadable until evaluated again, and without a worker only a
  // sync evaluation or a user action does that. (A release gate, recorded in the packet note.)
  cardPaymentRecoveryWorkerEnabled: parseOptInFlag(process.env.CARD_PAYMENT_RECOVERY_WORKER_ENABLED),
};
