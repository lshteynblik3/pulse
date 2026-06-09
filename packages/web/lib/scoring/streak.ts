/**
 * currentStreak — how many consecutive working days the user has kept their
 * focus score up, walking backward from today.
 *
 * MISSING-DATA CONTRACT: the input is the days that HAVE a score. A date that is
 * absent from `scoredDays` means "no data for that day" (agent didn't report, or
 * the score couldn't be computed) — it is NOT a zero. Working days with no data
 * are forgiven up to once per rolling 14-working-day window; a second miss inside
 * that window breaks the streak. A missing day older than the earliest scored day
 * is treated as "before tracking began", not a miss, so the streak stays active.
 *
 * Only working days (schedule-aware) participate: weekends and vacation days are
 * skipped entirely — they neither count toward the streak nor break it.
 */

import type { ScoredDay, Streak, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { addDays, isWorkingDay } from './date-utils';

/** A working day at or above this score keeps the streak alive (SPEC.md). */
const STREAK_THRESHOLD = 60;

/**
 * At most one missing working day is forgiven per window of this many working
 * days. Two misses with fewer than this many working days between their
 * positions (inclusive) fall in one window and break the streak.
 */
const GRACE_WINDOW_WORKING_DAYS = 14;

export function currentStreak(
  scoredDays: ScoredDay[],
  today: string,
  schedule: WorkSchedule = DEFAULT_SCHEDULE,
): Streak {
  if (scoredDays.length === 0) {
    return { count: 0, endedOn: null, endReason: 'no_history' };
  }

  const scoreByDate = new Map<string, number>();
  let earliest = scoredDays[0]!.date;
  for (const day of scoredDays) {
    scoreByDate.set(day.date, day.score);
    if (day.date < earliest) earliest = day.date;
  }

  let count = 0;
  let workingDayPos = 0; // advances only on working days; 0 = most recent working day
  let lastMissPos: number | null = null; // position of the most recent forgiven miss
  let cursor = today;

  // `cursor` strictly decreases every iteration (even on skipped days), bounded
  // below by `earliest`, so this always terminates.
  while (cursor >= earliest) {
    if (!isWorkingDay(cursor, schedule)) {
      cursor = addDays(cursor, -1);
      continue;
    }

    const score = scoreByDate.get(cursor);

    if (score === undefined) {
      // Working day with no data. Forgive at most one miss per 14-working-day
      // window; checking only the nearest prior miss is sufficient because every
      // forgiven pair is kept > 13 apart (see the proof in the PR/notes).
      if (lastMissPos !== null && workingDayPos - lastMissPos < GRACE_WINDOW_WORKING_DAYS) {
        return { count, endedOn: cursor, endReason: 'missing_data' };
      }
      lastMissPos = workingDayPos;
      workingDayPos++;
      cursor = addDays(cursor, -1);
      continue;
    }

    if (score >= STREAK_THRESHOLD) {
      count++;
      workingDayPos++;
      cursor = addDays(cursor, -1);
      continue;
    }

    // Working day below threshold — the streak ends here.
    return { count, endedOn: cursor, endReason: 'low_score' };
  }

  // Walked past the earliest day we have data for without breaking: as far as we
  // can tell, the streak is still going.
  return { count, endedOn: null, endReason: 'active' };
}
