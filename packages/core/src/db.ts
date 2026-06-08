import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from './env.js';

let client: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses RLS — only ever used by the
 * ingestion API and worker, never exposed to end users.
 */
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getEnv();
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
