/**
 * Route-side resolver for the next working day, with a fallback warning.
 *
 * `nextWorkingDay` (in the pure scoring lib) stays log-free; this wrapper adds
 * the operational warn when the bounded scan fell back to the adjacent calendar
 * day — a degenerate schedule (empty workingDays, or a vacation run longer than
 * the scan window) that real schedules never hit. The warn carries the user_id,
 * which only the route/cron has, so logging belongs here rather than in the pure
 * helper or inline in the deeply-nested cron route. Both the submit cron and the
 * dashboard route call this.
 */

import type { WorkSchedule } from '@pulse/shared';
import { isWorkingDay, nextWorkingDay } from '../../../lib/scoring/date-utils';

export function resolveNextWorkingDay(date: string, schedule: WorkSchedule, userId: string): string {
  const next = nextWorkingDay(date, schedule);
  // The fallback is detectable: a real next working day passes isWorkingDay; the
  // adjacent-day fallback does not. Warn so we can confirm it stays unreachable.
  if (!isWorkingDay(next, schedule)) {
    console.warn('[insights] next-working-day fallback fired (no working day within scan window)', {
      userId,
      workingDays: schedule.workingDays,
      vacationDates: schedule.vacationDates,
    });
  }
  return next;
}
