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
  averageScoreOverWorkingDays,
  currentStreak,
  focusScore,
  peakHours,
  personalMedian30d,
  weekOverWeekTrend,
} from '../../../lib/scoring';
import { addDays, isWorkingDay } from '../../../lib/scoring/date-utils';
// Display helpers (Batch D): the agent popover's score is shaped HERE,
// server-side, because the Electron agent can't import web code — so the ×1.3
// displayScore is applied once (shared with the web render) before the wire.
import { displayScore, scoreMessage } from './format';

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
    /**
     * Whether the viewed day is a working day under the user's schedule (the
     * existing isWorkingDay, NOT a new model). The daily view suppresses the
     * score on a non-working day — a score there reads as judgment for a day
     * that shouldn't be judged. A derived display boolean, like schedule.isDefault.
     */
    isWorkingDay: boolean;
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
  /** Rolling-7-day rollup ending on `date` — the Day/Week toggle's Week view. */
  week: WeekSummary;
}

/** Days in the rolling week window (the viewed day + the 6 before it). */
export const WEEK_WINDOW_DAYS = 7;

/**
 * The week summary (Batch C). A rolling 7-day rollup ending on the viewed day —
 * an AGGREGATION of existing per-day scores, never a new formula. Web-internal,
 * like DashboardPayload. Presentation must stay scale-agnostic (no hardcoded
 * 0–100): the score flows through the same band helpers the daily view uses, so
 * a later scoring rescale propagates to both at once.
 */
export interface WeekSummary {
  /** First day of the window (`end` − 6) and the last (the viewed day). */
  start: string;
  end: string;
  /**
   * Average daily focus score over WORKING DAYS WITH DATA in the window — the
   * SAME `averageScoreOverWorkingDays` the week-over-week trend uses, so the two
   * can't drift. null when no working day in the window had data.
   */
  score: number | null;
  /** Working days WITH data — the "X" in "X of Y working days tracked". */
  workingDaysTracked: number;
  /** Working days in the window regardless of data — the "Y". */
  workingDaysInWindow: number;
  /** Summed across every day WITH data in the window (real activity is real). */
  totalFocusMinutes: number;
  /** totalFocusMinutes ÷ days-with-data; null when no day had data. */
  avgFocusMinutes: number | null;
  totalFocusBlocks: number;
  /**
   * The strongest day in the window — a CELEBRATION, never a ranking. There is
   * deliberately no "worst day" or per-day ordering. null when no day had data.
   */
  bestDay: { date: string; score: number } | null;
  /** Most-focused hours across the window (reuses the 30-day peakHours engine). */
  peakHours: PeakHour[];
}

/**
 * Aggregate the rolling 7-day window ending on `endDate`. Pure; reuses the
 * already-computed `scoredDays` (no re-scoring) and the same `summaries` the
 * per-day payload was built from — so the week summary costs ZERO extra queries.
 */
export function computeWeekSummary(
  summaries: DailySummary[],
  scoredDays: ScoredDay[],
  schedule: WorkSchedule,
  endDate: string,
): WeekSummary {
  const start = addDays(endDate, -(WEEK_WINDOW_DAYS - 1));
  const inWindow = (d: string) => d >= start && d <= endDate;

  const weekSummaries = summaries.filter((s) => inWindow(s.date));
  const weekScored = scoredDays.filter((s) => inWindow(s.date));

  // Score: the SAME average the week-over-week trend computes (offsets 0–6),
  // via the shared helper — single source of truth, can't drift.
  const { average: score, count: workingDaysTracked } = averageScoreOverWorkingDays(
    scoredDays,
    endDate,
    0,
    WEEK_WINDOW_DAYS - 1,
    schedule,
  );

  // Y: working days in the window regardless of whether they have data.
  let workingDaysInWindow = 0;
  for (let offset = 0; offset < WEEK_WINDOW_DAYS; offset++) {
    if (isWorkingDay(addDays(endDate, -offset), schedule)) workingDaysInWindow++;
  }

  const totalFocusMinutes = weekSummaries.reduce((acc, s) => acc + s.focusMinutes, 0);
  const totalFocusBlocks = weekSummaries.reduce((acc, s) => acc + s.focusBlockCount, 0);
  const avgFocusMinutes = weekSummaries.length === 0 ? null : totalFocusMinutes / weekSummaries.length;

  // Strongest tracked day (any day with data — a great Saturday still counts as
  // your best). A celebration callout, never a comparison against other days.
  const bestDay = weekScored.reduce<{ date: string; score: number } | null>(
    (best, d) => (best === null || d.score > best.score ? { date: d.date, score: d.score } : best),
    null,
  );

  return {
    start,
    end: endDate,
    score,
    workingDaysTracked,
    workingDaysInWindow,
    totalFocusMinutes,
    avgFocusMinutes,
    totalFocusBlocks,
    bestDay,
    peakHours: peakHours(weekSummaries, schedule),
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
      isWorkingDay: isWorkingDay(today, schedule),
    },
    peakHours: peakHours(
      summaries.filter((s) => s.date >= peakStart && s.date <= today),
      schedule,
    ),
    streak: currentStreak(scoredDays, today, schedule),
    trend: weekOverWeekTrend(scoredDays, today, schedule),
    schedule: { isDefault },
    agent: { lastActivityAt },
    // Same summaries + scoredDays the per-day payload used — no extra query.
    week: computeWeekSummary(summaries, scoredDays, schedule, today),
  };
}

/**
 * What GET /api/agent/today returns to the tray popover (4h + Batch D). The
 * Electron agent renders this verbatim — no scoring or rescaling agent-side.
 *
 * `score` is the RAW 0–100 value, sent so the popover can color/arc off raw
 * (those key on raw, like the web). `displayScore` is the /130 number to SHOW —
 * applied HERE via the shared displayScore, so web and tray show the same number
 * for the same raw score. `isWorkingDay` drives the popover's non-working-day
 * suppression, mirroring the web daily view's "Not a working day" state.
 */
export interface AgentTodayPayload {
  date: string;
  score: number | null;
  displayScore: number | null;
  message: string | null;
  isWorkingDay: boolean;
  lastActivityAt: string | null;
}

export function buildAgentTodayPayload(
  summaries: DailySummary[],
  schedule: WorkSchedule,
  date: string,
  lastActivityAt: string | null,
): AgentTodayPayload {
  const working = isWorkingDay(date, schedule);
  const todaySummary = summaries.find((s) => s.date === date) ?? null;
  // No score on a non-working day — a score there reads as judgment for a day
  // that shouldn't be judged (same suppression as the web daily view).
  const focus = working && todaySummary ? scoreDay(todaySummary, summaries, schedule) : null;
  return {
    date,
    score: focus ? focus.score : null,
    displayScore: focus ? displayScore(focus.score) : null,
    message: focus ? scoreMessage(focus.score) : null,
    isWorkingDay: working,
    lastActivityAt,
  };
}
