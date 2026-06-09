/**
 * focusScore — turn one day's DailySummary into a 0–100 focus score plus the
 * four-part breakdown behind it. Mirrors SPEC.md "Scoring approach" exactly.
 *
 * The score blends four explainable, normalized (0–1) components:
 *   focusRatio     0.45   how much active time was actually focused work
 *   blockScore     0.30   deep-work minutes, capping at 3h
 *   meetingBalance 0.15   penalizes meeting overload past 2h
 *   consistency    0.10   today's active time vs the user's own recent median
 *
 * CONSISTENCY + NO BASELINE: consistency needs a personal median, which a new
 * user doesn't have yet. When `personalMedian30d` is `null` (or non-positive),
 * consistency is 1.0 — we don't punish someone for having no history. The median
 * itself is computed by {@link personalMedian30d}, kept separate so this function
 * stays a pure formula with no schedule dependency.
 */

import type { DailySummary, FocusScoreResult, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { isWorkingDay } from './date-utils';

const WEIGHTS = { focusRatio: 0.45, blockScore: 0.3, meetingBalance: 0.15, consistency: 0.1 };

/** Caps deep-work credit at 3 hours; minutes beyond this don't raise the score. */
const DEEP_WORK_CAP_MINUTES = 180;

/** Meeting load below this is "balanced" (full credit). */
const MEETING_OK_MINUTES = 120;
/** At/above this, meeting balance bottoms out. */
const MEETING_MAX_MINUTES = 300;
/** Floor that meetingBalance slides down to at MEETING_MAX_MINUTES. */
const MEETING_FLOOR = 0.3;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Meeting balance: 1.0 up to {@link MEETING_OK_MINUTES}, sliding linearly down to
 * {@link MEETING_FLOOR} at {@link MEETING_MAX_MINUTES}, then flat.
 */
function meetingBalance(meetingMinutes: number): number {
  if (meetingMinutes <= MEETING_OK_MINUTES) return 1;
  if (meetingMinutes >= MEETING_MAX_MINUTES) return MEETING_FLOOR;
  const span = MEETING_MAX_MINUTES - MEETING_OK_MINUTES;
  const drop = (1 - MEETING_FLOOR) * ((meetingMinutes - MEETING_OK_MINUTES) / span);
  return 1 - drop;
}

/**
 * The user's median active-minutes over their working days, used as the
 * consistency baseline. Computed over WORKING DAYS ONLY (schedule-aware):
 * weekends and vacation days are excluded entirely — not counted as zeros — so a
 * normal weekend never drags the baseline down.
 *
 * `history` is whatever window the caller passes (typically the trailing ~30
 * daily summaries). A date absent from `history` is simply not counted. Returns
 * `null` when there are no working-day summaries to compute from, which
 * {@link focusScore} reads as "no baseline → consistency 1.0".
 */
export function personalMedian30d(
  history: DailySummary[],
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): number | null {
  const values = history
    .filter((s) => isWorkingDay(s.date, schedule))
    .map((s) => s.activeMinutes)
    .sort((a, b) => a - b);

  if (values.length === 0) return null;

  // Indices are in-bounds here (length > 0); the `!`s satisfy noUncheckedIndexedAccess.
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[mid - 1]! + values[mid]!) / 2 : values[mid]!;
}

/**
 * Compute the focus score for a single day. Pure: same inputs → same output, no
 * I/O, no clock. Pass the consistency baseline in via `personalMedian30d`
 * (`null` for a user with no working-day history yet).
 */
export function focusScore(
  summary: DailySummary,
  personalMedian30d: number | null,
): FocusScoreResult {
  const focusRatio = clamp01(summary.focusMinutes / Math.max(summary.activeMinutes, 1));
  const blockScore = clamp01(summary.focusBlockMinutes / DEEP_WORK_CAP_MINUTES);
  const balance = meetingBalance(summary.meetingMinutes);
  const consistency =
    personalMedian30d && personalMedian30d > 0
      ? clamp01(summary.activeMinutes / personalMedian30d)
      : 1;

  const score = Math.round(
    100 *
      (WEIGHTS.focusRatio * focusRatio +
        WEIGHTS.blockScore * blockScore +
        WEIGHTS.meetingBalance * balance +
        WEIGHTS.consistency * consistency),
  );

  return {
    score,
    breakdown: { focusRatio, blockScore, meetingBalance: balance, consistency },
  };
}
