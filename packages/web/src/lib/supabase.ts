import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only Supabase client using the service-role key.
 *
 * Phase 1 has no auth, so the API routes talk to the database with the
 * service-role key (which bypasses Row Level Security). This key is a secret and
 * must NEVER reach the browser — it only lives in server-side route handlers.
 * Real per-user access control arrives with auth + RLS in Phase 4.
 *
 * The client is created lazily (not at module load) so a missing env var fails a
 * request with a clear error rather than crashing `next build`.
 */
let client: SupabaseClient | undefined;

export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (see .env.example).',
    );
  }

  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
