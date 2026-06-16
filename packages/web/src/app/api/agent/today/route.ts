import { NextResponse } from 'next/server';
import type { DailySummary } from '@pulse/shared';
import { authenticateDevice } from '@/lib/devices/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { buildAgentTodayPayload, singleDayWindowStart } from '@/lib/dashboard/compute';
import { isValidLocalDate } from '@/lib/work-schedule/schema';
import { getWorkSchedule } from '@/lib/work-schedule/loader';

// Computed on read, same as /api/dashboard — never serve a cached score.
export const dynamic = 'force-dynamic';

/** The columns scoring needs, as supabase-js returns them. */
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
 * GET /api/agent/today?date=YYYY-MM-DD — the agent popover's one read (4h):
 * that token's own user's score for the agent's local day, with the SAME band
 * copy the dashboard shows (scoreMessage — one source of truth), plus the
 * last-posted instant. The agent renders what it receives; no scoring math
 * exists agent-side.
 *
 * Auth is the shared authenticateDevice helper — the /api/ingest + /api/me
 * mechanism, same 401 contract. `date` comes from the AGENT (it is the client;
 * the server never derives "today" from its own clock), exactly like ingest
 * trusts the agent's local day.
 *
 * Service-role reads (no session exists on this route — the deferred auth
 * bridge is the only RLS alternative): daily_summaries and work_schedules,
 * BOTH pinned in app code to the token's own user_id. No parameter can name
 * another user. Enumerated in CLAUDE.md's service-role list.
 *
 * score: null means "no data for that day" — a legitimate state the popover
 * renders calmly, never a fake zero. Errors are 500s, never nulls.
 */
export async function GET(request: Request) {
  const device = await authenticateDevice(request);
  if (!device) {
    return NextResponse.json({ error: 'Invalid or missing device token.' }, { status: 401 });
  }

  const date = new URL(request.url).searchParams.get('date');
  if (!date || !isValidLocalDate(date)) {
    return NextResponse.json(
      { error: 'Pass the agent-local date as ?date=YYYY-MM-DD.' },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();

  // The scored day plus its full exclusive 30-day median lookback — 31 days,
  // not the dashboard's 122 (that window exists to score 92 days, not one).
  const { data, error } = await admin
    .from('daily_summaries')
    .select('*')
    .eq('user_id', device.userId)
    .gte('date', singleDayWindowStart(date))
    .lte('date', date)
    .order('date', { ascending: true });

  if (error) {
    return NextResponse.json({ error: 'Could not load your day.' }, { status: 500 });
  }

  const { data: deviceRows, error: deviceError } = await admin
    .from('device_tokens')
    .select('last_used_at')
    .eq('user_id', device.userId)
    .not('last_used_at', 'is', null)
    .order('last_used_at', { ascending: false })
    .limit(1);

  if (deviceError) {
    return NextResponse.json({ error: 'Could not load your day.' }, { status: 500 });
  }

  try {
    const { schedule } = await getWorkSchedule(admin, device.userId);
    const summaries = ((data ?? []) as DailySummaryRow[]).map(rowToSummary);
    const lastActivityAt = (deviceRows?.[0]?.last_used_at as string | undefined) ?? null;
    // Score shaping (raw score + /130 displayScore + non-working suppression) is
    // a pure, tested helper. No new data is read — same query, same userId.
    return NextResponse.json(buildAgentTodayPayload(summaries, schedule, date, lastActivityAt));
  } catch {
    return NextResponse.json({ error: 'Could not load your day.' }, { status: 500 });
  }
}
