import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/notifications — the signed-in user's own notification inbox, newest
 * first. SESSION client (NOT service-role): migration 0013's RLS read-own policy
 * (`recipient_id = auth.uid()`) is what guarantees a user only ever sees their own
 * notifications — so this is NOT a service-role caller and adds nothing to the
 * enumeration. The explicit recipient_id filter is the app-level half of the same
 * defense-in-depth as the dashboard reads.
 *
 * Read-only this commit: mark-as-read (writing read_at) is deferred — it needs its
 * own recipient update-own policy + a read_at column grant, which we keep off the
 * member-write surface for now.
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
    .from('notifications')
    .select('id, type, title, body, created_at, read_at')
    .eq('recipient_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Could not load your notifications.' }, { status: 500 });
  }
  return NextResponse.json({ notifications: data ?? [] });
}
