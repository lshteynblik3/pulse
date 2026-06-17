import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/auth/server';
import { generatePairingCode, PAIRING_CODE_TTL_MS } from '@/lib/devices/pairing';

/**
 * POST /api/devices/pair/issue — mint a pairing code for the signed-in user.
 *
 * Runs entirely on the user's SESSION client (anon key + cookies): the RLS
 * insert policy on pairing_codes ("with check user_id = auth.uid()") is what
 * guarantees a user can only issue codes bound to themselves. No service-role.
 *
 * Returns 401 (not a redirect) when unauthenticated — this is fetched from the
 * settings page client component, where a redirect response would be useless.
 */
export async function POST() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  // The code is the primary key; a collision is a ~1-in-10^11 event but costs
  // nothing to retry rather than surface as a 500.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();

    const { error } = await supabase
      .from('pairing_codes')
      .insert({ code, user_id: user.id, expires_at: expiresAt });

    if (!error) {
      return NextResponse.json({ code, expiresAt }, { status: 200 });
    }
    if (error.code !== '23505') {
      // Anything but a unique-key collision is a real failure.
      return NextResponse.json({ error: 'Could not issue a pairing code.' }, { status: 500 });
    }
  }
  return NextResponse.json({ error: 'Could not issue a pairing code.' }, { status: 500 });
}
