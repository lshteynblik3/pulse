import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SCHEDULE, type WorkSchedule } from '@pulse/shared';
import { rowToSchedule, type WorkScheduleRow } from './schema';

/**
 * Load a user's stored work schedule, falling back to the one shared
 * DEFAULT_SCHEDULE when they've never saved one. This is the 4c "integration
 * with scoring": the returned `schedule` is exactly the WorkSchedule shape every
 * scoring function already accepts — 4d wires it through; nothing calls it from
 * the scoring path yet.
 *
 * Returns `isDefault` alongside the schedule (rather than a bare WorkSchedule)
 * so GET /api/work-schedule and future scoring callers share one code path and
 * one definition of "unconfigured user". Scoring callers just use `.schedule`.
 *
 * Takes the caller's Supabase client: routes pass the session client so the
 * query runs under RLS, and the explicit `user_id` filter is the app-level half
 * of the 4b defense-in-depth pattern.
 */
export async function getWorkSchedule(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ schedule: WorkSchedule; isDefault: boolean }> {
  const { data, error } = await supabase
    .from('work_schedules')
    .select('user_id, working_days, daily_hours, vacation_dates, breaks')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load work schedule: ${error.message}`);
  }
  if (!data) {
    return { schedule: DEFAULT_SCHEDULE, isDefault: true };
  }
  return { schedule: rowToSchedule(data as unknown as WorkScheduleRow), isDefault: false };
}
