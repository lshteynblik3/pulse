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

/**
 * Average focus score over WORKING DAYS THAT HAVE DATA in the day-offset window
 * [endDate-endOffset, endDate-startOffset] (both offsets count backward from
 * endDate). Non-working days (weekend/vacation) are excluded entirely; a working
 * day with no scored entry is excluded too — NOT counted as a zero (the same
 * missing-data contract as streak.ts). Returns the average (null when no
 * qualifying day) AND the count of qualifying days, so a caller can show
 * "averaged over N days".
 *
 * This is THE single source of truth for that average: the week-over-week trend
 * and the dashboard's week summary both call it, so the two can never drift.
 */
export function averageScoreOverWorkingDays(
  scoredDays: ScoredDay[],
  endDate: string,
  startOffset: number,
  endOffset: number,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): { average: number | null; count: number } {
  const scoreByDate = new Map<string, number>();
  for (const day of scoredDays) scoreByDate.set(day.date, day.score);

  let sum = 0;
  let n = 0;
  for (let offset = startOffset; offset <= endOffset; offset++) {
    const date = addDays(endDate, -offset);
    if (!isWorkingDay(date, schedule)) continue;
    const score = scoreByDate.get(date);
    if (score === undefined) continue;
    sum += score;
    n++;
  }
  return { average: n === 0 ? null : sum / n, count: n };
}

export function weekOverWeekTrend(
  scoredDays: ScoredDay[],
  today: string,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): Trend | null {
  if (scoredDays.length === 0) return null;

  const thisWeek = averageScoreOverWorkingDays(scoredDays, today, 0, DAYS_PER_WEEK - 1, schedule).average;
  const lastWeek = averageScoreOverWorkingDays(
    scoredDays,
    today,
    DAYS_PER_WEEK,
    DAYS_PER_WEEK * 2 - 1,
    schedule,
  ).average;

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
