import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// Always read fresh from the database.
export const dynamic = 'force-dynamic';

/**
 * GET /api/summary/today
 *
 * Returns total tracked minutes per app_name for "today". Phase 1 is single-user
 * and has no auth, so "today" is the server's local calendar day and all rows
 * count. Per-user scoping and the user's own timezone arrive in Phase 4.
 *
 * Aggregation is done in JS (sum of ended_at − started_at, grouped by app_name)
 * to keep Phase 1 to a single table with no extra views or RPC functions.
 */
export async function GET() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfDay);
  startOfTomorrow.setDate(startOfDay.getDate() + 1);

  const { data, error } = await getSupabaseAdmin()
    .from('raw_events')
    .select('app_name, started_at, ended_at')
    .gte('started_at', startOfDay.toISOString())
    .lt('started_at', startOfTomorrow.toISOString());

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const minutesByApp = new Map<string, number>();
  for (const row of data ?? []) {
    const ms = new Date(row.ended_at).getTime() - new Date(row.started_at).getTime();
    if (!Number.isFinite(ms) || ms <= 0) continue; // skip bad/zero-length rows
    const minutes = ms / 60_000;
    minutesByApp.set(row.app_name, (minutesByApp.get(row.app_name) ?? 0) + minutes);
  }

  const apps = [...minutesByApp.entries()]
    .map(([appName, minutes]) => ({ appName, minutes: Math.round(minutes * 10) / 10 }))
    .sort((a, b) => b.minutes - a.minutes);

  const totalMinutes = Math.round(apps.reduce((sum, a) => sum + a.minutes, 0) * 10) / 10;

  // YYYY-MM-DD for the local day.
  const date = `${startOfDay.getFullYear()}-${String(startOfDay.getMonth() + 1).padStart(2, '0')}-${String(startOfDay.getDate()).padStart(2, '0')}`;

  return NextResponse.json({ date, totalMinutes, apps });
}
