import { createBrowserClient } from '@supabase/ssr';

/**
 * The Supabase client for use in the browser ('use client' components).
 *
 * Only the public URL + anon key reach the browser; RLS is what protects data.
 * Used by the sign-in page to request a magic link.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
