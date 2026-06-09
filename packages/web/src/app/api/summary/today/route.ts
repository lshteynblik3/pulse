import { NextResponse } from 'next/server';
import type { DailySummary } from '@pulse/shared';
import { getSupabaseAdmin } from '@/lib/supabase';

// Always read fresh from the database.
export const dynamic = 'force-dynamic';

/**
 * GET /api/summary/today
 *
 * Returns the most recent DailySummary as `{ summary }` (or `{ summary: null }`
 * when there's no data yet). Phase 2 is still pre-auth and single-user, so we
 * return the latest row by date. Per-user scoping and selecting the viewer's own
 * local "today" arrive with auth in Phase 4.
 *
 * The `date` is whatever local day the agent computed and sent — the server does
 * no timezone math on it.
 */
export async function GET() {
  const { data, error } = await getSupabaseAdmin()
    .from('daily_summaries')
    .select('*')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ summary: null });
  }

  // Map the snake_case row back to the camelCase DailySummary contract.
  const summary: DailySummary = {
    userId: data.user_id,
    date: data.date,
    activeMinutes: data.active_minutes,
    focusMinutes: data.focus_minutes,
    meetingMinutes: data.meeting_minutes,
    categoryBreakdown: data.category_breakdown,
    focusBlockCount: data.focus_block_count,
    focusBlockMinutes: data.focus_block_minutes,
    hourlyFocusMinutes: data.hourly_focus_minutes,
    tasksCompleted: data.tasks_completed,
    agentVersion: data.agent_version,
  };

  return NextResponse.json({ summary });
}
