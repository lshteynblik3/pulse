import { describe, it, expect } from 'vitest';
import type { Category, DailySummary } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { peakHours } from './peak-hours';

const ZERO_BREAKDOWN: Record<Category, number> = {
  development: 0,
  communication: 0,
  creative: 0,
  admin: 0,
  browser: 0,
  other: 0,
};

/** Build a 24-length hourly array from an {hour: minutes} map; all other hours 0. */
function hours(map: Record<number, number>): number[] {
  const arr = Array<number>(24).fill(0);
  for (const [hour, minutes] of Object.entries(map)) arr[Number(hour)] = minutes;
  return arr;
}

function summary(date: string, hourly: Record<number, number>): DailySummary {
  return {
    userId: 'u1',
    date,
    activeMinutes: 0,
    focusMinutes: 0,
    meetingMinutes: 0,
    categoryBreakdown: ZERO_BREAKDOWN,
    focusBlockCount: 0,
    focusBlockMinutes: 0,
    hourlyFocusMinutes: hours(hourly),
    tasksCompleted: 0,
    agentVersion: 'test',
  };
}

describe('peakHours', () => {
  it('returns [] for no summaries', () => {
    expect(peakHours([])).toEqual([]);
  });

  it('returns [] when every hour is zero', () => {
    expect(peakHours([summary('2026-06-09', {})])).toEqual([]);
  });

  it('sums hourlyFocusMinutes element-wise across working days, top n highest first', () => {
    const result = peakHours([
      summary('2026-06-08', { 9: 30, 14: 40 }), // Mon
      summary('2026-06-09', { 9: 20, 10: 15 }), // Tue
    ]);
    expect(result).toEqual([
      { hour: 9, focusMinutes: 50 }, // 30 + 20, element-wise
      { hour: 14, focusMinutes: 40 },
      { hour: 10, focusMinutes: 15 },
    ]);
  });

  it('respects n', () => {
    const result = peakHours(
      [summary('2026-06-08', { 9: 30, 14: 40 }), summary('2026-06-09', { 9: 20, 10: 15 })],
      DEFAULT_SCHEDULE,
      1,
    );
    expect(result).toEqual([{ hour: 9, focusMinutes: 50 }]);
  });

  it('returns fewer than n when too few hours have focus', () => {
    const result = peakHours([summary('2026-06-09', { 9: 30, 10: 10 })], DEFAULT_SCHEDULE, 3);
    expect(result).toHaveLength(2);
  });

  it('breaks ties toward the earlier hour', () => {
    const result = peakHours([summary('2026-06-09', { 8: 20, 15: 20 })], DEFAULT_SCHEDULE, 2);
    expect(result).toEqual([
      { hour: 8, focusMinutes: 20 },
      { hour: 15, focusMinutes: 20 },
    ]);
  });

  it('ignores weekends', () => {
    expect(peakHours([summary('2026-06-13', { 11: 100 })])).toEqual([]); // Saturday
  });

  it('ignores vacation days', () => {
    const schedule = { ...DEFAULT_SCHEDULE, vacationDates: ['2026-06-09'] };
    expect(peakHours([summary('2026-06-09', { 9: 100 })], schedule)).toEqual([]); // Tue, on vacation
  });
});
