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
};
