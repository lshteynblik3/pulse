import { NextResponse } from 'next/server';
import { authenticateDevice } from '@/lib/devices/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

/**
 * GET /api/me — whoami for the desktop agent (Phase 4f).
 *
 * Authenticated ONLY by the device bearer token, via the same shared
 * authenticateDevice() that /api/ingest uses. Returns the paired account's
 * email and display name so the agent can show WHICH account it posts to —
 * this exists because an agent once posted happily to an account the user
 * wasn't looking at, and nothing in either UI could show the mismatch.
 *
 * Scope is structural: the response is derived solely from the token's own
 * user_id. There is no parameter to name a user, no list, no other shape of
 * query. The users read runs service-role (the agent has no session; RLS
 * deliberately blocks cross-user email reads) but is pinned to that one id.
 * Token values are never logged.
 */
export async function GET(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) {
    // Same 401 contract as ingest: the agent shows "pairing invalid."
    return NextResponse.json({ error: 'Invalid or missing device token.' }, { status: 401 });
  }

  const { data, error } = await getSupabaseAdmin()
    .from('users')
    .select('email, display_name')
    .eq('id', device.userId)
    .maybeSingle();

  if (error || !data) {
    // A valid token whose users row is missing is a server-side inconsistency,
    // not an auth failure — 500 so the agent treats it as transient, not as
    // "re-pair."
    return NextResponse.json({ error: 'Could not load the paired account.' }, { status: 500 });
  }

  return NextResponse.json({
    email: data.email as string,
    displayName: (data.display_name as string | null) ?? null,
  });
}
