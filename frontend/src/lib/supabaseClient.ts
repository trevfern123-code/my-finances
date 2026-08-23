import { createClient } from '@supabase/supabase-js';

// Anon key only — safe for the browser. All Plaid and privileged data access
// goes through the Express backend, never through this client directly.
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);
