import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageTeam } from '@/lib/teams/manages';
import { loadTeamRecognitionEvents } from '@/lib/teams/recognition-load';
import { recognitionCardText } from '@/lib/teams/recognition';
import { isValidLocalDate } from '@/lib/work-schedule/schema';

export const dynamic = 'force-dynamic';

/**
 * GET /api/teams/[teamId]/recognition?date=YYYY-MM-DD — the manager's recognition
 * cards for a team they manage. A PURE READ: it WRITES NOTHING and is therefore
 * safe to prefetch (browser prefetch, link-unfurl bots, route prefetching).
 *
 * This GET/POST split is load-bearing for the trust guarantee. The employee
 * notification ("your manager has been told") must be true ⟺ a manager actually
 * saw the card. A GET that wrote notifications would fire on every prefetch/bot
 * hit, notifying employees when NO manager viewed — and the first spurious fire is
 * the harm, which idempotency cannot undo. So the notify rides the companion POST
 * /ack, which the manager's client fires only AFTER cards render. That makes
 * manager-saw ⟺ employee-told a BICONDITIONAL: the POST exists only because cards
 * rendered (saw ⟹ told), and a notification exists only via that POST (told ⟹ saw).
 *
 * Authorization runs FIRST (canManageTeam on the session identity, never the body);
 * teamId is the path param. Service-role reads (no blanket manager RLS) are pinned
 * to the verified team. Returns team-MEMBER recognition cards only — positive, named
 * good news — never an individual's score/row as data. See CLAUDE.md entry #10.
 */
export async function GET(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
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
  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidLocalDate(date)) {
    return NextResponse.json({ error: 'Pass your local date as ?date=YYYY-MM-DD.' }, { status: 400 });
  }

  // AUTHORIZATION FIRST — before any team data is read.
  const admin = getSupabaseAdmin();
  const allowed = await canManageTeam(admin, user.id, teamId);
  if (!allowed) {
    return NextResponse.json({ error: 'Not authorized for this team.' }, { status: 403 });
  }

  try {
    const events = await loadTeamRecognitionEvents(admin, teamId, user.id, date);
    // Cards carry the event_key (so the client can POST /ack the ones it rendered),
    // the member's name + the manager-facing copy. No write happens here.
    const cards = events.map((e) => ({
      eventKey: e.eventKey,
      type: e.type,
      name: e.name,
      eventDate: e.eventDate,
      ...recognitionCardText(e),
    }));
    return NextResponse.json({ teamId, date, cards });
  } catch {
    return NextResponse.json({ error: 'Could not load recognition.' }, { status: 500 });
  }
}
