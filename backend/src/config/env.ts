import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  frontendUrl: required('FRONTEND_URL'),

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
};
