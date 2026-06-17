import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/auth/server';

/**
 * DELETE /api/devices/:id — revoke a device token. The next agent flush with
 * that token gets a 401; no grace period.
 *
 * Session client only — no service-role. Migration 0003's UPDATE policy plus
 * the column-level grant mean the authenticated role can set exactly one column
 * (revoked_at) on exactly its own rows. Another user's device id matches zero
 * rows here and returns the same 404 as a nonexistent id — no enumeration.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Device not found.' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('device_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .is('revoked_at', null) // revoking twice is also a 404, not an error
    .select('id');

  if (error) {
    return NextResponse.json({ error: 'Could not revoke device.' }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: 'Device not found.' }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
