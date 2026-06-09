/**
 * peakHours — the hours of day a user is most focused, summed across a window of
 * daily summaries. Powers the dashboard's "you do your best work at…" callout.
 *
 * WORKING DAYS ONLY: only summaries on the user's working days contribute
 * (schedule-aware; weekends and vacation are skipped). A relaxed Saturday of deep
 * work shouldn't define the user's weekday peak.
 *
 * Hours with zero focus are never returned, so the result can be shorter than `n`
 * (or empty) when there isn't enough working-day data — callers should not assume
 * exactly `n` entries.
 */

import type { DailySummary, PeakHour, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { isWorkingDay } from './date-utils';

const HOURS_PER_DAY = 24;

/**
 * Sum `hourlyFocusMinutes` element-wise across the working-day summaries in
 * `summaries`, then return the top `n` hours by focus minutes (default 3),
 * highest first. Ties break toward the earlier hour for determinism. Returns
 * `[]` when no working day has any focus.
 */
export function peakHours(
  summaries: DailySummary[],
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
  n = 3,
): PeakHour[] {
  const totals = new Array<number>(HOURS_PER_DAY).fill(0);

  for (const summary of summaries) {
    if (!isWorkingDay(summary.date, schedule)) continue;
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      totals[hour]! += summary.hourlyFocusMinutes[hour] ?? 0;
    }
  }

  return totals
    .map((focusMinutes, hour) => ({ hour, focusMinutes }))
    .filter((entry) => entry.focusMinutes > 0)
    .sort((a, b) => b.focusMinutes - a.focusMinutes || a.hour - b.hour)
    .slice(0, Math.max(0, n));
}
