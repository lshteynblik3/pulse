import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageTeam } from '@/lib/teams/manages';
import { loadTeamRecognitionEvents } from '@/lib/teams/recognition-load';
import { recognitionNotificationText } from '@/lib/teams/recognition';
import { isValidLocalDate } from '@/lib/work-schedule/schema';

export const dynamic = 'force-dynamic';

const ackBody = z.object({
  date: z.string().refine(isValidLocalDate, 'date must be YYYY-MM-DD'),
  eventKeys: z.array(z.string()).max(200),
});

/**
 * POST /api/teams/[teamId]/recognition/ack — the WRITER half of recognition, and
 * service-role caller #10. The manager's client fires this from an effect AFTER
 * the GET's cards actually render, sending the event_keys it displayed. This is
 * what makes "your manager has been told" literally true: the notification is
 * written exactly when (and only when) a manager saw the card (see the GET
 * docstring's biconditional).
 *
 * NEVER trusts the body. It re-runs session auth + canManageTeam, then RE-DERIVES
 * the team's current events server-side and accepts only event_keys that match a
 * real current event — a client cannot fabricate a notify for a non-event or for a
 * member it doesn't manage. Accepted events are written idempotently
 * (ON CONFLICT (recipient_id, event_key) DO NOTHING via upsert ignoreDuplicates),
 * so any number of re-POSTs yields exactly one notification per event.
 */
export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { teamId } = await params;
  if (!z.string().uuid().safeParse(teamId).success) {
    return NextResponse.json({ error: 'Team not found.' }, { status: 400 });
  }
  const parsed = ackBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { date, eventKeys } = parsed.data;

  // AUTHORIZATION FIRST — before any read or write.
  const admin = getSupabaseAdmin();
  const allowed = await canManageTeam(admin, user.id, teamId);
  if (!allowed) {
    return NextResponse.json({ error: 'Not authorized for this team.' }, { status: 403 });
  }

  try {
    // Re-derive server-side: the source of truth for what may be notified. A key
    // not in here (fabricated, stale, or another team's) is silently dropped.
    const events = await loadTeamRecognitionEvents(admin, teamId, user.id, date);
    const realByKey = new Map(events.map((e) => [e.eventKey, e] as const));
    const requested = new Set(eventKeys);

    const rows = events
      .filter((e) => requested.has(e.eventKey))
      .map((e) => {
        const note = recognitionNotificationText(e);
        return {
          recipient_id: e.recipientId,
          actor_id: user.id,
          type: 'recognition' as const,
          event_key: e.eventKey,
          title: note.title,
          body: note.body,
        };
      });

    if (rows.length > 0) {
      const { error } = await admin
        .from('notifications')
        // The UNIQUE (recipient_id, event_key) constraint + ignoreDuplicates makes
        // this insert-once: re-acks never duplicate.
        .upsert(rows, { onConflict: 'recipient_id,event_key', ignoreDuplicates: true });
      if (error) {
        return NextResponse.json({ error: 'Could not record recognition.' }, { status: 500 });
      }
    }

    // Report only counts (never echo any member data): how many were written-or-
    // confirmed, and how many requested keys matched no real current event.
    const rejected = eventKeys.filter((k) => !realByKey.has(k)).length;
    return NextResponse.json({ acknowledged: rows.length, rejected });
  } catch {
    return NextResponse.json({ error: 'Could not record recognition.' }, { status: 500 });
  }
}
