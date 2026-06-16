import { describe, it, expect } from 'vitest';
import type { DailySummary, ScoredDay, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { averageScoreOverWorkingDays } from '../../../lib/scoring';
import { computeWeekSummary } from './compute';

// A schedule where every weekday counts, to isolate the missing-data-vs-zero
// logic from weekend exclusion (which DEFAULT_SCHEDULE covers separately).
const ALL_DAYS: WorkSchedule = {
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  dailyHours: 8,
  vacationDates: [],
};

// Window for END is 2026-06-06 .. 2026-06-12. Under DEFAULT_SCHEDULE that's
// Sat, Sun, Mon–Fri (06-06 is a Saturday) — i.e. exactly 5 working days, as any
// 7 consecutive days must be.
const END = '2026-06-12';

function summary(date: string, focusMinutes: number, focusBlockCount = 0): DailySummary {
  return {
    userId: 'u',
    date,
    activeMinutes: focusMinutes,
    focusMinutes,
    meetingMinutes: 0,
    categoryBreakdown: {
      development: focusMinutes,
      communication: 0,
      creative: 0,
      admin: 0,
      browser: 0,
      entertainment: 0,
      other: 0,
    },
    focusBlockCount,
    focusBlockMinutes: focusBlockCount * 25,
    hourlyFocusMinutes: Array(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 't',
  };
}
const scored = (date: string, score: number): ScoredDay => ({ date, score });

describe('computeWeekSummary', () => {
  it('EXCLUDES a gap (no-row) working day from the score — not a zero', () => {
    // 06-11 has data; 06-12 (and the rest) are working days with NO row.
    const wk = computeWeekSummary([summary('2026-06-11', 200)], [scored('2026-06-11', 80)], ALL_DAYS, END);
    expect(wk.score).toBe(80); // averaged over the ONE tracked day — NOT (80+0)/2 = 40
    expect(wk.workingDaysTracked).toBe(1);
    expect(wk.workingDaysInWindow).toBe(7);
  });

  it('COUNTS a low-score tracked day in the average (low score is not missing data)', () => {
    const wk = computeWeekSummary(
      [summary('2026-06-11', 200), summary('2026-06-12', 50)],
      [scored('2026-06-11', 80), scored('2026-06-12', 20)],
      ALL_DAYS,
      END,
    );
    expect(wk.score).toBe(50); // (80 + 20) / 2 — the 20 genuinely drags it down
    expect(wk.workingDaysTracked).toBe(2);
  });

  it('aggregates totals, average focus minutes, blocks, and the strongest day', () => {
    const wk = computeWeekSummary(
      [summary('2026-06-10', 100, 1), summary('2026-06-11', 200, 3), summary('2026-06-12', 60, 0)],
      [scored('2026-06-10', 60), scored('2026-06-11', 90), scored('2026-06-12', 30)],
      ALL_DAYS,
      END,
    );
    expect(wk.score).toBe(60); // (60 + 90 + 30) / 3
    expect(wk.totalFocusMinutes).toBe(360);
    expect(wk.avgFocusMinutes).toBe(120); // 360 / 3 days with data
    expect(wk.totalFocusBlocks).toBe(4);
    expect(wk.bestDay).toEqual({ date: '2026-06-11', score: 90 });
  });

  it('excludes a non-working (weekend) day from the score but keeps its minutes in totals', () => {
    // 2026-06-06 is a Saturday (non-working under DEFAULT_SCHEDULE); 06-08 a Mon.
    const wk = computeWeekSummary(
      [summary('2026-06-06', 300), summary('2026-06-08', 100)],
      [scored('2026-06-06', 95), scored('2026-06-08', 50)],
      DEFAULT_SCHEDULE,
      END,
    );
    expect(wk.workingDaysInWindow).toBe(5); // any 7-day window has exactly 5 weekdays
    expect(wk.workingDaysTracked).toBe(1); // only Monday had data among working days
    expect(wk.score).toBe(50); // the Saturday 95 is NOT in the score
    expect(wk.totalFocusMinutes).toBe(400); // …but its 300 minutes are real activity
    expect(wk.bestDay).toEqual({ date: '2026-06-06', score: 95 }); // celebration is inclusive
  });

  it('an all-empty week is a calm null, never fake zeros', () => {
    const wk = computeWeekSummary([], [], ALL_DAYS, END);
    expect(wk.score).toBeNull();
    expect(wk.workingDaysTracked).toBe(0);
    expect(wk.totalFocusMinutes).toBe(0);
    expect(wk.avgFocusMinutes).toBeNull();
    expect(wk.totalFocusBlocks).toBe(0);
    expect(wk.bestDay).toBeNull();
    expect(wk.peakHours).toEqual([]);
    expect(wk.start).toBe('2026-06-06');
    expect(wk.end).toBe(END);
  });

  it('the week score is exactly the shared working-days average (no drift from trend)', () => {
    const scoredDays = [scored('2026-06-10', 60), scored('2026-06-11', 90), scored('2026-06-12', 30)];
    const summaries = [summary('2026-06-10', 100), summary('2026-06-11', 200), summary('2026-06-12', 60)];
    const wk = computeWeekSummary(summaries, scoredDays, ALL_DAYS, END);
    // Both the week summary and weekOverWeekTrend.thisWeek call this exact fn.
    expect(wk.score).toBe(averageScoreOverWorkingDays(scoredDays, END, 0, 6, ALL_DAYS).average);
  });
});
