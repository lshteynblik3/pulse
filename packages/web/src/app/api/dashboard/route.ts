import { NextResponse } from 'next/server';
import type { DailySummary } from '@pulse/shared';
import { createServerClient } from '@/lib/auth/server';
import { computeDashboard, fetchWindowStart } from '@/lib/dashboard/compute';
import { isValidLocalDate } from '@/lib/work-schedule/schema';
import { getWorkSchedule } from '@/lib/work-schedule/loader';

// Scores are computed on read so a schedule edit shows up immediately — never
// serve a cached payload.
export const dynamic = 'force-dynamic';

/** A daily_summaries row as supabase-js returns it (snake_case columns). */
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
 * GET /api/dashboard?date=YYYY-MM-DD — the whole dashboard payload in one
 * response: today's summary + focus score, 30-day peak hours, streak, trend,
 * and whether the user is still on the default schedule.
 *
 * `date` is the CLIENT's local day. The server never derives "today" from its
 * own clock — server UTC vs user local is exactly the Phase 1 timezone bug.
 * The date is data, not identity: who is asking comes from the session only.
 *
 * Session client throughout (4b defense-in-depth): the explicit user_id filter
 * is the app-level half, RLS's `user_id = auth.uid()` SELECT policy the other.
 *
 * Absence vs failure: zero rows is a legitimate new-user state and returns a
 * clean empty payload (200). A query or loader error returns 500 — "the DB is
 * down" must never masquerade as "you have no data yet".
 */
export async function GET(request: Request) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidLocalDate(date)) {
    return NextResponse.json(
      { error: 'Pass your local date as ?date=YYYY-MM-DD.' },
      { status: 400 },
    );
  }

  // One windowed read: 122 days ending on the client's today, so every scored
  // day gets a full 30-day median lookback (see lib/dashboard/compute.ts).
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('*')
    .eq('user_id', user.id)
    .gte('date', fetchWindowStart(date))
    .lte('date', date)
    .order('date', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Could not load your dashboard.' }, { status: 500 });
  }

  try {
    const { schedule, isDefault } = await getWorkSchedule(supabase, user.id);
    const summaries = ((data ?? []) as DailySummaryRow[]).map(rowToSummary);
    return NextResponse.json(computeDashboard(summaries, schedule, isDefault, date));
  } catch {
    return NextResponse.json({ error: 'Could not load your dashboard.' }, { status: 500 });
  }
}
