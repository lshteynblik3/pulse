/**
 * buildDayInsightContext — assemble the same 30-day / trend numbers the dashboard
 * shows, anchored on one day, from a window of that user's summaries.
 *
 * Pure (no I/O, no clock). Reuses the scoring engine + the dashboard's windowing
 * so the coach prompt — and the computed-tips fallback — see exactly the numbers
 * the user sees on their dashboard. The submit cron fetches 122 days ending on
 * `date` (fetchWindowStart) and passes them here; the same helper feeds the
 * dashboard's read-time fallback in a later step.
 */

import type { DailySummary, PeakHour, Streak, WorkSchedule } from '@pulse/shared';
import { averageScoreOverWorkingDays, currentStreak, peakHours } from '../../../lib/scoring';
import { addDays } from '../../../lib/scoring/date-utils';
import { buildScoredDays, PEAK_HOURS_WINDOW_DAYS } from '../dashboard/compute';

const DAYS_PER_WEEK = 7;

export interface DayInsightContext {
  /** The anchored day's summary, or null if the window has no row for that date. */
  summary: DailySummary | null;
  /** Top focus hours over the 30-day window; [] when there isn't enough data. */
  peakHours: PeakHour[];
  /** currentStreak's result — endReason 'no_history' means no streak yet. */
  streak: Streak;
  /** Avg working-day score this week (offsets 0–6), or null when none with data. */
  thisWeekAvg: number | null;
  /** Avg working-day score last week (offsets 7–13), or null when none with data. */
  lastWeekAvg: number | null;
}

export function buildDayInsightContext(
  summaries: DailySummary[],
  schedule: WorkSchedule,
  date: string,
): DayInsightContext {
  const summary = summaries.find((s) => s.date === date) ?? null;

  const peakStart = addDays(date, -(PEAK_HOURS_WINDOW_DAYS - 1));
  const windowPeaks = peakHours(
    summaries.filter((s) => s.date >= peakStart && s.date <= date),
    schedule,
  );

  const scoredDays = buildScoredDays(summaries, schedule, date);
  const streak = currentStreak(scoredDays, date, schedule);
  const thisWeekAvg = averageScoreOverWorkingDays(scoredDays, date, 0, DAYS_PER_WEEK - 1, schedule).average;
  const lastWeekAvg = averageScoreOverWorkingDays(
    scoredDays,
    date,
    DAYS_PER_WEEK,
    DAYS_PER_WEEK * 2 - 1,
    schedule,
  ).average;

  return { summary, peakHours: windowPeaks, streak, thisWeekAvg, lastWeekAvg };
}
