import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { DailySummary } from '@pulse/shared';
import { createServerClient } from '@/lib/auth/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { canManageTeam } from '@/lib/teams/manages';
import { computeTeamAggregate, type MemberWindow } from '@/lib/teams/aggregate';
import { fetchWindowStart } from '@/lib/dashboard/compute';
import { getWorkSchedule } from '@/lib/work-schedule/loader';
import { isValidLocalDate } from '@/lib/work-schedule/schema';

// Computed on read (no scores table) so a fresh summary or schedule edit shows up
// immediately — never serve a cached aggregate.
export const dynamic = 'force-dynamic';

/** A daily_summaries row as supabase-js returns it (snake_case). Mirrors the dashboard route's mapper. */
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

/**
 * GET /api/teams/[teamId]/aggregate?date=YYYY-MM-DD — team-level aggregates for a
 * team the SESSION manager is authorized to manage. Phase 6 commit 2; the first
 * consumer of the manages spine. Returns team scalars only (avg focus, avg meeting
 * load, active-streak count) behind a k=3 reporting-member floor — NEVER an
 * individual member's row, score, or identifier.
 *
 * AUTHORIZATION RUNS FIRST, BEFORE ANY DATA READ. The manager's identity comes
 * from the session (auth.getUser()), never the body; teamId is the path param —
 * the tamperable input — and canManageTeam gates on it. A member, or a manager
 * passing a team they don't manage, gets 403 and no data. Only after the gate
 * passes does the route touch the service-role client.
 *
 * Service-role reads (managers have no blanket RLS read on member rows — that's
 * the whole design): the team roster and each rostered member's summary window +
 * schedule, every read pinned to a member of a team the session user is verified
 * to manage. See CLAUDE.md service-role entry #9.
 *
 * `date` is the manager's client-local day (same discipline as /api/dashboard —
 * the server never derives "today"). Absence ≠ failure: a below-floor team is a
 * 200 suppressed answer, not an error; only a real DB/loader fault is a 500.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  // 1. Session identity — who is asking comes from the cookie session only.
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  // 2. Validate the tamperable inputs before doing anything with them.
  const { teamId } = await params;
  if (!z.string().uuid().safeParse(teamId).success) {
    return NextResponse.json({ error: 'Team not found.' }, { status: 400 });
  }
  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidLocalDate(date)) {
    return NextResponse.json(
      { error: 'Pass your local date as ?date=YYYY-MM-DD.' },
      { status: 400 },
    );
  }

  // 3. AUTHORIZATION FIRST — before any team data is read. canManageTeam derives
  //    the relationship from the session user's own row; a false here means 403
  //    with NO aggregate data in the body. This is the gate a manager must not be
  //    able to escape by editing teamId.
  const admin = getSupabaseAdmin();
  const allowed = await canManageTeam(admin, user.id, teamId);
  if (!allowed) {
    return NextResponse.json({ error: 'Not authorized for this team.' }, { status: 403 });
  }

  // 4. Gate passed — now (and only now) read team data via the service-role
  //    client. Every read below is pinned to this verified-managed team.
  const { data: roster, error: rosterError } = await admin
    .from('users')
    .select('id')
    .eq('team_id', teamId);
  if (rosterError) {
    return NextResponse.json({ error: 'Could not load the team.' }, { status: 500 });
  }

  // Per member: the same 122-day window + schedule the personal dashboard fetches,
  // so the team aggregate reuses the identical compute-on-read scoring. COST: this
  // runs the per-user scoring window once per member — debt item (c) × team size.
  // Acceptable for small teams; the team-scale fix (a scores table / batched
  // fetch) is deferred, not solved here.
  const windowStart = fetchWindowStart(date);
  const members: MemberWindow[] = [];
  try {
    for (const row of roster ?? []) {
      const memberId = row.id as string;
      const { data: sumRows, error: sumError } = await admin
        .from('daily_summaries')
        .select('*')
        .eq('user_id', memberId)
        .gte('date', windowStart)
        .lte('date', date)
        .order('date', { ascending: true });
      if (sumError) {
        return NextResponse.json({ error: 'Could not load the team.' }, { status: 500 });
      }
      const { schedule } = await getWorkSchedule(admin, memberId);
      members.push({ summaries: ((sumRows ?? []) as DailySummaryRow[]).map(rowToSummary), schedule });
    }

    const result = computeTeamAggregate(members, teamId, date);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Could not load the team.' }, { status: 500 });
  }
}
