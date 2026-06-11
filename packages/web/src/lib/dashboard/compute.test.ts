import { describe, expect, it } from 'vitest';
import type { DailySummary, WorkSchedule } from '@pulse/shared';
import { addDays } from '../../../lib/scoring/date-utils';
import {
  FETCH_WINDOW_DAYS,
  SCORED_WINDOW_DAYS,
  buildScoredDays,
  computeDashboard,
  fetchWindowStart,
} from './compute';

const TODAY = '2026-06-11';

// Every day is a working day, so weekday placement never affects the math the
// tests hand-compute. (Schedule-gating itself is covered by lib/scoring tests.)
const ALL_DAYS: WorkSchedule = { workingDays: [0, 1, 2, 3, 4, 5, 6], dailyHours: 8, vacationDates: [] };

function makeSummary(date: string, overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    userId: 'user-1',
    date,
    activeMinutes: 0,
    focusMinutes: 0,
    meetingMinutes: 0,
    categoryBreakdown: { development: 0, communication: 0, creative: 0, admin: 0, browser: 0, other: 0 },
    focusBlockCount: 0,
    focusBlockMinutes: 0,
    hourlyFocusMinutes: new Array<number>(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 'test',
    ...overrides,
  };
}

function hourly(hour: number, minutes: number): number[] {
  const h = new Array<number>(24).fill(0);
  h[hour] = minutes;
  return h;
}

describe('fetchWindowStart', () => {
  it('reaches back exactly FETCH_WINDOW_DAYS including today', () => {
    expect(fetchWindowStart(TODAY)).toBe(addDays(TODAY, -(FETCH_WINDOW_DAYS - 1)));
  });
});

describe('computeDashboard — empty state (absence, not failure)', () => {
  it('returns clean empty values for a user with no summaries at all', () => {
    const payload = computeDashboard([], ALL_DAYS, true, TODAY);
    expect(payload.date).toBe(TODAY);
    expect(payload.today.summary).toBeNull();
    expect(payload.today.focus).toBeNull();
    expect(payload.peakHours).toEqual([]);
    expect(payload.streak).toEqual({ count: 0, endedOn: null, endReason: 'no_history' });
    expect(payload.trend).toBeNull();
    expect(payload.schedule.isDefault).toBe(true);
  });
});

describe("computeDashboard — today's score", () => {
  it('scores today with consistency 1.0 when there is no history', () => {
    // focusRatio 0.5, blockScore 0, meetingBalance 1, consistency 1 (no baseline)
    // → round(100 × (0.225 + 0 + 0.15 + 0.1)) = round(47.5) = 48
    const payload = computeDashboard(
      [makeSummary(TODAY, { activeMinutes: 100, focusMinutes: 50 })],
      ALL_DAYS,
      false,
      TODAY,
    );
    expect(payload.today.summary?.date).toBe(TODAY);
    expect(payload.today.focus?.score).toBe(48);
    expect(payload.schedule.isDefault).toBe(false);
  });

  it("median is trailing and EXCLUSIVE of the scored day — today doesn't count toward its own baseline", () => {
    // Baseline = yesterday only (200), NOT median(100, 200) = 150.
    // consistency 100/200 = 0.5 → round(100 × (0.45 + 0 + 0.15 + 0.05)) = 65.
    // Were today wrongly included: 100/150 → score 67.
    const payload = computeDashboard(
      [
        makeSummary(addDays(TODAY, -1), { activeMinutes: 200 }),
        makeSummary(TODAY, { activeMinutes: 100, focusMinutes: 100 }),
      ],
      ALL_DAYS,
      false,
      TODAY,
    );
    expect(payload.today.focus?.score).toBe(65);
  });

  it('a summary dated after today is ignored everywhere', () => {
    const payload = computeDashboard(
      [makeSummary(addDays(TODAY, 1), { activeMinutes: 500, focusMinutes: 500 })],
      ALL_DAYS,
      false,
      TODAY,
    );
    expect(payload.today.summary).toBeNull();
    expect(buildScoredDays([makeSummary(addDays(TODAY, 1))], ALL_DAYS, TODAY)).toEqual([]);
  });
});

describe('buildScoredDays — windowing invariant', () => {
  it('with a full 122-day fetch, the OLDEST scored day gets a full 30-day median, not a truncated one', () => {
    // The 30 lookback-only days (today−121 … today−92) have activeMinutes 200;
    // the 92 scored days (today−91 … today) have activeMinutes 100, focus 100.
    const summaries: DailySummary[] = [];
    for (let offset = FETCH_WINDOW_DAYS - 1; offset >= 0; offset--) {
      const date = addDays(TODAY, -offset);
      summaries.push(
        offset >= SCORED_WINDOW_DAYS
          ? makeSummary(date, { activeMinutes: 200 })
          : makeSummary(date, { activeMinutes: 100, focusMinutes: 100 }),
      );
    }

    const scored = buildScoredDays(summaries, ALL_DAYS, TODAY);

    // Only the most recent 92 days are scored — never the lookback-only days.
    expect(scored).toHaveLength(SCORED_WINDOW_DAYS);
    const oldestScoredDate = addDays(TODAY, -(SCORED_WINDOW_DAYS - 1));
    expect(scored.every((d) => d.date >= oldestScoredDate && d.date <= TODAY)).toBe(true);

    // The oldest scored day's lookback is exactly the 30 lookback-only days, all
    // present: median 200 → consistency 100/200 = 0.5 → score 65. A truncated
    // (empty) lookback would yield consistency 1.0 → score 70.
    expect(scored[0]).toEqual({ date: oldestScoredDate, score: 65 });
  });

  it('emits no entry for days without data (the missing-data contract)', () => {
    const scored = buildScoredDays(
      [makeSummary(TODAY, { activeMinutes: 100, focusMinutes: 100 })],
      ALL_DAYS,
      TODAY,
    );
    expect(scored).toHaveLength(1);
    expect(scored[0]?.date).toBe(TODAY);
  });
});

describe('computeDashboard — peak hours window', () => {
  it('only the last 30 days feed peak hours', () => {
    const payload = computeDashboard(
      [
        // Inside the fetch window but OUTSIDE the 30-day peak window.
        makeSummary(addDays(TODAY, -40), { hourlyFocusMinutes: hourly(9, 120) }),
        makeSummary(addDays(TODAY, -5), { hourlyFocusMinutes: hourly(14, 60) }),
      ],
      ALL_DAYS,
      false,
      TODAY,
    );
    expect(payload.peakHours).toEqual([{ hour: 14, focusMinutes: 60 }]);
  });
});

describe('computeDashboard — streak and trend over the scored days', () => {
  it('14 identical strong days → 14-day streak and a flat trend', () => {
    // Each day: focusRatio 1, no blocks, no meetings, consistency 1 → score 70.
    const summaries = Array.from({ length: 14 }, (_, i) =>
      makeSummary(addDays(TODAY, -i), { activeMinutes: 100, focusMinutes: 100 }),
    );
    const payload = computeDashboard(summaries, ALL_DAYS, false, TODAY);

    expect(payload.streak.count).toBe(14);
    expect(payload.streak.endReason).toBe('active');
    expect(payload.trend).toEqual({ thisWeek: 70, lastWeek: 70, delta: 0, percentChange: 0 });
  });
});
