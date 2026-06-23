import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { DailySummary } from '@pulse/shared';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageUser } from '@/lib/teams/manages';
import { buildMemberDetail } from '@/lib/teams/member-detail';
import { getWorkSchedule } from '@/lib/work-schedule/loader';
import { fetchWindowStart } from '@/lib/dashboard/compute';
import { isValidLocalDate } from '@/lib/work-schedule/schema';
import { weekdayName } from '../../../../../../lib/scoring/date-utils';

export const dynamic = 'force-dynamic';

interface DailySummaryRow {
  user_id: string;
  date: string;
  active_minutes: number;
  focus_minutes: number;
  meeting_minutes: number;
  category_breakdown: DailySummary['categoryBreakdown'];
  focus_block_count: number;
  focus_block_minutes: number;
  hourly_focus_minutes: number[];
  tasks_completed: number;
  agent_version: string;
}

function rowToSummary(row: DailySummaryRow): DailySummary {
  return {
    userId: row.user_id,
    date: row.date,
    activeMinutes: row.active_minutes,
    focusMinutes: row.focus_minutes,
    meetingMinutes: row.meeting_minutes,
    categoryBreakdown: row.category_breakdown,
    focusBlockCount: row.focus_block_count,
    focusBlockMinutes: row.focus_block_minutes,
    hourlyFocusMinutes: row.hourly_focus_minutes,
    tasksCompleted: row.tasks_completed,
    agentVersion: row.agent_version,
  };
}

const viewBody = z.object({
  date: z.string().refine(isValidLocalDate, 'date must be YYYY-MM-DD'),
});

/**
 * POST /api/members/[memberId]/view — the manager drill-in. Service-role caller
 * #11, and the ONLY path that exposes an individual member's real metrics to a
 * manager. A deliberate POST, NEVER a GET: this module exports no GET, so prefetch
 * / link-unfurl (which only ever issue GETs) can never trigger a logged view of
 * someone's private detail.
 *
 * STRICT ORDER: session-auth → validate → canManageUser FIRST (the per-USER manages
 * check, run before ANY member-data read) → READ + ASSEMBLE in memory → write
 * access_logs → write the access notification → ONLY THEN serve.
 *
 * WHY READ PRECEDES THE WRITES (do not "tidy" this): the assembled detail does NOT
 * cross the wire until step 7 (after both writes are durable), so "served ⟹
 * logged+told" still holds — the surveillance-prevention direction is intact. But
 * by reading BEFORE writing, a member-data read failure 500s with NO log and NO
 * notification, so the employee never gets a false "your manager viewed you" for a
 * view that actually errored. Moving the writes earlier would reintroduce exactly
 * that false-positive accountability notice.
 *
 * NO-DATA STILL LOGS: a member with no summary for `date` yields a calm empty-state
 * payload — but the access_logs row and the access notification STILL fire. The
 * manager deliberately opened this member; the accountability event occurred
 * whether or not there was data to see. There is no path where "no data" skips the
 * log.
 */
export async function POST(request: Request, { params }: { params: Promise<{ memberId: string }> }) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const { memberId } = await params;
  if (!z.string().uuid().safeParse(memberId).success) {
    return NextResponse.json({ error: 'Member not found.' }, { status: 400 });
  }
  const parsed = viewBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const { date } = parsed.data;

  // 3. AUTHORIZATION FIRST — the per-USER check, before any member-data read.
  const admin = getSupabaseAdmin();
  const allowed = await canManageUser(admin, user.id, memberId);
  if (!allowed) {
    return NextResponse.json({ error: 'Not authorized to view this member.' }, { status: 403 });
  }

  try {
    // 4. READ + ASSEMBLE in memory (gated; not yet sent). A failure here 500s with
    //    no writes — see the docstring's false-positive-notice reasoning.
    const { data: memberRow, error: memberError } = await admin
      .from('users')
      .select('display_name, email')
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) {
      return NextResponse.json({ error: 'Could not open this member.' }, { status: 500 });
    }
    const name =
      (memberRow?.display_name as string | null) ??
      (memberRow?.email as string | undefined)?.split('@')[0] ??
      'This member';

    const { data: sumRows, error: sumError } = await admin
      .from('daily_summaries')
      .select('*')
      .eq('user_id', memberId)
      .gte('date', fetchWindowStart(date))
      .lte('date', date)
      .order('date', { ascending: true });
    if (sumError) {
      return NextResponse.json({ error: 'Could not open this member.' }, { status: 500 });
    }
    const { schedule } = await getWorkSchedule(admin, memberId);
    const detail = buildMemberDetail(
      { name, summaries: ((sumRows ?? []) as DailySummaryRow[]).map(rowToSummary), schedule },
      date,
    );

    // 5. access_logs — ONE ROW PER VIEW (the full audit). Before the detail is served.
    const { error: logError } = await admin.from('access_logs').insert({
      manager_id: user.id,
      viewed_user_id: memberId,
    });
    if (logError) {
      return NextResponse.json({ error: 'Could not open this member.' }, { status: 500 });
    }

    // 6. The access notification — NEUTRAL accountability, weekday-named, COALESCED to
    //    one per (manager, member, day) via the event_key + ON CONFLICT DO NOTHING.
    const { error: notifyError } = await admin.from('notifications').upsert(
      {
        recipient_id: memberId,
        actor_id: user.id,
        type: 'access' as const,
        event_key: `access:${user.id}:${memberId}:${date}`,
        title: 'Your manager viewed your activity',
        body: `Your manager viewed your detailed activity on ${weekdayName(date)}.`,
      },
      { onConflict: 'recipient_id,event_key', ignoreDuplicates: true },
    );
    if (notifyError) {
      return NextResponse.json({ error: 'Could not open this member.' }, { status: 500 });
    }

    // 7. Both records durable — now serve the already-assembled detail.
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json({ error: 'Could not open this member.' }, { status: 500 });
  }
}
