/**
 * weekOverWeekTrend — compares the user's average focus score this week against
 * last week, for the dashboard's "up 12% vs last week" line.
 *
 * Windows are calendar-based and anchored on `today`:
 *   thisWeek = today and the 6 days before it      (offsets 0–6)
 *   lastWeek = the 7 days before that               (offsets 7–13)
 *
 * Within each window we average the focus score of WORKING DAYS THAT HAVE DATA.
 * Non-working days (weekends/vacation) are excluded entirely; a working day with
 * no data is excluded too (NOT counted as a zero — see streak.ts for the same
 * missing-data contract).
 *
 * Returns `null` when a meaningful comparison can't be made: either window has no
 * working-day data, or last week averages to exactly 0 (percentChange would
 * divide by zero). One null instead of a half-populated Trend keeps Phase 4's
 * handling to a single path; see the PR notes for why not Infinity/null fields.
 *
 * The four fields are raw floats — scoring computes truth, presentation rounds.
 * Rounding here would also let `delta` and `thisWeek - lastWeek` disagree by 0.1.
 * Phase 4 formats at display time (e.g. `toFixed(1)`).
 */

import type { ScoredDay, Trend, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { addDays, isWorkingDay } from './date-utils';

const DAYS_PER_WEEK = 7;

export function weekOverWeekTrend(
  scoredDays: ScoredDay[],
  today: string,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): Trend | null {
  if (scoredDays.length === 0) return null;

  const scoreByDate = new Map<string, number>();
  for (const day of scoredDays) scoreByDate.set(day.date, day.score);

  // Average focus score over working days WITH DATA in [today-endOffset, today-startOffset].
  const windowAverage = (startOffset: number, endOffset: number): number | null => {
    let sum = 0;
    let n = 0;
    for (let offset = startOffset; offset <= endOffset; offset++) {
      const date = addDays(today, -offset);
      if (!isWorkingDay(date, schedule)) continue;
      const score = scoreByDate.get(date);
      if (score === undefined) continue;
      sum += score;
      n++;
    }
    return n === 0 ? null : sum / n;
  };

  const thisWeek = windowAverage(0, DAYS_PER_WEEK - 1);
  const lastWeek = windowAverage(DAYS_PER_WEEK, DAYS_PER_WEEK * 2 - 1);

  // No comparison if a window is empty, or last week is 0 (can't divide).
  if (thisWeek === null || lastWeek === null || lastWeek === 0) return null;

  const delta = thisWeek - lastWeek;
  return {
    thisWeek,
    lastWeek,
    delta,
    percentChange: (delta / lastWeek) * 100,
  };
}
