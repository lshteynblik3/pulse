/**
 * computeDashboard — assemble the whole /api/dashboard payload from a window of
 * daily summaries. Pure like the scoring engine it drives: no I/O, no clock —
 * `today` is the CLIENT's local date, passed all the way through.
 *
 * WINDOWING INVARIANT: every scored day must see a FULL median lookback.
 * - We emit ScoredDay[] only for the most recent SCORED_WINDOW_DAYS (92).
 * - Each day D's consistency baseline is the median over [D−30, D−1] —
 *   trailing and EXCLUSIVE of D, so a day is judged against its past, never
 *   against itself.
 * - The route must therefore fetch FETCH_WINDOW_DAYS (92 + 30 = 122) so the
 *   oldest scored day's lookback is fully populated, not silently truncated.
 *   Streak and trend consume those old scores, so a truncated median there
 *   would quietly skew both.
 */

import type {
  DailySummary,
  FocusScoreResult,
  PeakHour,
  ScoredDay,
  Streak,
  Trend,
  WorkSchedule,
} from '@pulse/shared';
// lib/scoring lives outside src/ (no path alias maps it), so this module owns
// the one relative import across that boundary; routes import scoring only
// through here. date-utils is imported by file deliberately — the scoring
// index keeps it off the public surface, but window arithmetic needs addDays.
import {
  currentStreak,
  focusScore,
  peakHours,
  personalMedian30d,
  weekOverWeekTrend,
} from '../../../lib/scoring';
import { addDays } from '../../../lib/scoring/date-utils';

/** Days we emit scores for (ending on `today`) — what streak and trend can see. */
export const SCORED_WINDOW_DAYS = 92;

/** Trailing days (exclusive of the scored day) feeding each day's consistency median. */
export const MEDIAN_LOOKBACK_DAYS = 30;

/** Days the route must fetch so every scored day has a full median lookback. */
export const FETCH_WINDOW_DAYS = SCORED_WINDOW_DAYS + MEDIAN_LOOKBACK_DAYS;

/** Peak hours consider the most recent 30 days, per SPEC. */
export const PEAK_HOURS_WINDOW_DAYS = 30;

/** First date (inclusive) of the fetch window ending on `today`. */
export function fetchWindowStart(today: string): string {
  return addDays(today, -(FETCH_WINDOW_DAYS - 1));
}

/**
 * First date (inclusive) to fetch when scoring a SINGLE day (4h
 * /api/agent/today): the day itself plus its full exclusive median lookback.
 * Scoring one day needs 31 days, not FETCH_WINDOW_DAYS — that larger window
 * exists to score 92 days, which that endpoint doesn't do.
 */
export function singleDayWindowStart(date: string): string {
  return addDays(date, -MEDIAN_LOOKBACK_DAYS);
}

/**
 * What GET /api/dashboard returns. Web-internal (API ↔ dashboard page), NOT the
 * agent contract, so it lives here rather than in @pulse/shared.
 *
 * Absence vs failure: every field here has a meaningful empty value (null / []
 * / 'no_history') for a user with no data. A DB or loader failure must become
 * an HTTP 500 in the route — never this shape.
 */
export interface DashboardPayload {
  /** The client's local "today", echoed back. */
  date: string;
  today: {
    /** Stat cards + hourly chart read their fields straight off this. */
    summary: DailySummary | null;
    /** Focus gauge (score) + "why this score" breakdown. Null when summary is. */
    focus: FocusScoreResult | null;
  };
  /** Top focused hours over the 30-day window; [] when there's no data. */
  peakHours: PeakHour[];
  /** Full Streak object so the UI can show endReason, not a silent reset. */
  streak: Streak;
  trend: Trend | null;
  schedule: { isDefault: boolean };
  agent: {
    /**
     * Most recent successful agent post across the user's devices — max
     * device_tokens.last_used_at, supplied by the route (it isn't derivable
     * from summaries). Full ISO instant; null = no agent has ever posted.
     */
    lastActivityAt: string | null;
  };
}

/**
 * Score one day against its own trailing-30-day median (exclusive of the day).
 * Exported for /api/agent/today (4h), which scores exactly one day — the
 * lookback filtering lives HERE so no caller can get the window wrong.
 */
export function scoreDay(
  summary: DailySummary,
  all: DailySummary[],
  schedule: WorkSchedule,
): FocusScoreResult {
  const lookbackStart = addDays(summary.date, -MEDIAN_LOOKBACK_DAYS);
  const history = all.filter((h) => h.date >= lookbackStart && h.date < summary.date);
  return focusScore(summary, personalMedian30d(history, schedule));
}

/**
 * The ScoredDay[] the streak/trend functions consume: one entry per summary in
 * the scored window, each scored with a full lookback (see module doc). Days
 * absent from the result mean "no data" — the missing-data contract those
 * functions rely on — so we never fabricate entries.
 */
export function buildScoredDays(
  summaries: DailySummary[],
  schedule: WorkSchedule,
  today: string,
): ScoredDay[] {
  const scoredStart = addDays(today, -(SCORED_WINDOW_DAYS - 1));
  return summaries
    .filter((s) => s.date >= scoredStart && s.date <= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((s) => ({ date: s.date, score: scoreDay(s, summaries, schedule).score }));
}

export function computeDashboard(
  summaries: DailySummary[],
  schedule: WorkSchedule,
  isDefault: boolean,
  today: string,
  lastActivityAt: string | null = null,
): DashboardPayload {
  // A summary dated after `today` (clock skew, another device ahead of this
  // client's local day) is excluded by every window filter below.
  const todaySummary = summaries.find((s) => s.date === today) ?? null;
  const peakStart = addDays(today, -(PEAK_HOURS_WINDOW_DAYS - 1));
  const scoredDays = buildScoredDays(summaries, schedule, today);

  return {
    date: today,
    today: {
      summary: todaySummary,
      focus: todaySummary ? scoreDay(todaySummary, summaries, schedule) : null,
    },
    peakHours: peakHours(
      summaries.filter((s) => s.date >= peakStart && s.date <= today),
      schedule,
    ),
    streak: currentStreak(scoredDays, today, schedule),
    trend: weekOverWeekTrend(scoredDays, today, schedule),
    schedule: { isDefault },
    agent: { lastActivityAt },
  };
}
