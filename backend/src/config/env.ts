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
  // (20260930120000 onward); nothing reads the evaluated states yet. Any other value, including
  // "false", leaves it off, and then no matching RPC is ever called.
  cardPaymentSyncEvaluationEnabled: parseOptInFlag(process.env.CARD_PAYMENT_SYNC_EVALUATION_ENABLED),
};
