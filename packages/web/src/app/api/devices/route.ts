import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/auth/server';

/**
 * GET /api/devices — list the signed-in user's ACTIVE paired devices.
 *
 * Session client only: the RLS select policy on device_tokens scopes the query
 * to user_id = auth.uid(), so a second user can never see (or even count) the
 * first user's devices. token_hash is deliberately not selected — no caller
 * needs it, including this one.
 *
 * Revoked rows are filtered out here (Phase 4g): they are KEPT in the table as
 * a deliberate audit trail (migration 0003: revoked_at is "set once, never
 * cleared"), but a settings list of credentials that can still post should show
 * only the ones that can.
 */
export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('device_tokens')
    .select('id, device_label, last_used_at, created_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Could not list devices.' }, { status: 500 });
  }

  return NextResponse.json({
    devices: (data ?? []).map((d) => ({
      id: d.id as string,
      deviceLabel: (d.device_label as string | null) ?? '(unnamed device)',
      lastUsedAt: d.last_used_at as string | null,
      createdAt: d.created_at as string,
    })),
  });
}
