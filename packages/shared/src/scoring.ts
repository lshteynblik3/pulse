/**
 * @pulse/shared — the scoring contract.
 *
 * The Phase 3 scoring engine lives in `web/lib/scoring`, but its *inputs and
 * outputs* belong here, next to {@link DailySummary}, for the same reason the
 * core data contract does: more than one package has to agree on these shapes.
 * The `web` app computes scores today; Phase 4 will build `ScoredDay[]` from the
 * `daily_summaries` table and pass it to the streak/trend functions. Keeping the
 * shapes in one place is what stops the producer and consumer from drifting.
 *
 * Types only — no logic, no I/O. All dates here are opaque "YYYY-MM-DD" strings
 * in the user's LOCAL day (never a UTC instant), matching {@link DailySummary.date}.
 */

/**
 * A user's working pattern, threaded through the scoring engine so "showing up"
 * and "consistency" are judged against the days the user actually works — not a
 * hardcoded Mon–Fri assumption.
 *
 * Phase 3 only consumes this as a parameter (defaulting to {@link DEFAULT_SCHEDULE}).
 * Phase 4 adds the settings UI + a table and passes each user's real schedule in.
 */
export interface WorkSchedule {
  /**
   * Which days of the week count as working days, as day-of-week numbers where
   * 0 = Sunday … 6 = Saturday (e.g. `[1,2,3,4,5]` = Mon–Fri, `[2,4,6]` = Tue/Thu/Sat).
   */
  workingDays: number[];

  /**
   * Expected hours worked on a working day. Carried for Phase 4 targets/goals;
   * the current scoring formula does not read it yet.
   */
  dailyHours: number;

  /**
   * Local calendar days the user is on vacation, each "YYYY-MM-DD". A vacation
   * day is treated as a non-working day everywhere: excluded from medians and
   * peak hours, and skipped (neither counted nor broken) by the streak walk.
   */
  vacationDates: string[];
}

/**
 * The schedule used until a user configures their own (Phase 4): a conventional
 * Mon–Fri, 8h day with no vacations. Every scoring function defaults to this.
 */
export const DEFAULT_SCHEDULE: WorkSchedule = {
  workingDays: [1, 2, 3, 4, 5],
  dailyHours: 8,
  vacationDates: [],
};

/**
 * The four explainable components behind a focus score, each normalized to 0–1
 * and left UNROUNDED so a Phase 4 "why this score?" tooltip can show the real
 * contribution of each part. See `web/lib/scoring/focus-score.ts` for the
 * weights and formula (mirrors SPEC.md "Scoring approach").
 */
export interface ScoreBreakdown {
  /** focusMinutes / activeMinutes, capped at 1. */
  focusRatio: number;
  /** focusBlockMinutes / 180 (caps at 3h of deep work), capped at 1. */
  blockScore: number;
  /** 1.0 up to 120 meeting min, sliding down to 0.3 at 300+. */
  meetingBalance: number;
  /** activeMinutes / personalMedian30d, capped at 1; 1.0 when no baseline yet. */
  consistency: number;
}

/** What {@link focusScore} returns: the 0–100 score plus the breakdown that produced it. */
export interface FocusScoreResult {
  /** Integer 0–100. */
  score: number;
  breakdown: ScoreBreakdown;
}

/** One of a user's most-focused hours of the day (see `peakHours`). */
export interface PeakHour {
  /** Local hour of day, 0–23 (0 = 00:00–01:00). */
  hour: number;
  /** Total focus minutes summed into this hour across the input window. */
  focusMinutes: number;
}

/**
 * A single day's computed focus score — the input unit for streak and trend.
 *
 * Presence is meaningful: a date that appears here has data; a date ABSENT from
 * a `ScoredDay[]` means "no data for that day" (the agent didn't report, or the
 * score couldn't be computed). The streak/trend functions rely on that.
 */
export interface ScoredDay {
  /** The local day this score is for, "YYYY-MM-DD". */
  date: string;
  /** The day's focus score, 0–100. */
  score: number;
}

/** The user's current focus streak (see `currentStreak`). */
export interface Streak {
  /** Number of qualifying working days (score ≥ 60) in the active streak. */
  count: number;
  /**
   * The working day that ended the streak ("YYYY-MM-DD"), or `null` when the
   * streak is still active or there's no history. Set only for `low_score` and
   * `missing_data`.
   */
  endedOn: string | null;
  /**
   * Why the streak stopped (or didn't):
   * - `active` — unbroken through all available history.
   * - `low_score` — a working day scored < 60.
   * - `missing_data` — a working day had no data beyond the allowed grace.
   * - `no_history` — no scored days at all.
   */
  endReason: 'active' | 'low_score' | 'missing_data' | 'no_history';
}

/** A week-over-week focus-score comparison (see `weekOverWeekTrend`). */
export interface Trend {
  /** Average focus score over working days (with data) in the 7-day window ending today. */
  thisWeek: number;
  /** Average focus score over working days (with data) in the prior 7-day window. */
  lastWeek: number;
  /** `thisWeek − lastWeek`. */
  delta: number;
  /** `delta` as a percentage of `lastWeek`. */
  percentChange: number;
}
