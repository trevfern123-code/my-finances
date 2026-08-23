import { createClient } from '@supabase/supabase-js';
import { env } from './env';

// Service-role client: full database access, bypasses RLS. Server-side only —
// this key must never be sent to or reachable from the frontend.
export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
