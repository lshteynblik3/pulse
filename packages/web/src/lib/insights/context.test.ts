import { describe, it, expect } from 'vitest';
import { DEFAULT_SCHEDULE, type Category, type DailySummary } from '@pulse/shared';
import { buildDayInsightContext } from './context';

function categories(partial: Partial<Record<Category, number>> = {}): Record<Category, number> {
  return {
    development: 0,
    communication: 0,
    creative: 0,
    admin: 0,
    browser: 0,
    entertainment: 0,
    other: 0,
    ...partial,
  };
}

function day(date: string, overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    userId: 'u1',
    date,
    activeMinutes: 300,
    focusMinutes: 220,
    meetingMinutes: 30,
    categoryBreakdown: categories({ development: 200 }),
    focusBlockCount: 3,
    focusBlockMinutes: 120,
    hourlyFocusMinutes: new Array(24).fill(0).map((_, h) => (h === 10 ? 45 : 0)),
    tasksCompleted: 0,
    agentVersion: 'test',
    ...overrides,
  };
}

describe('buildDayInsightContext (wiring sanity)', () => {
  it('anchors on the requested day and returns well-formed context shapes', () => {
    const summaries = [day('2026-06-15'), day('2026-06-16'), day('2026-06-17')];
    const ctx = buildDayInsightContext(summaries, DEFAULT_SCHEDULE, '2026-06-17');

    expect(ctx.summary?.date).toBe('2026-06-17');
    expect(Array.isArray(ctx.peakHours)).toBe(true);
    expect(['active', 'low_score', 'missing_data', 'no_history']).toContain(ctx.streak.endReason);
    expect(ctx.thisWeekAvg === null || typeof ctx.thisWeekAvg === 'number').toBe(true);
    expect(ctx.lastWeekAvg === null || typeof ctx.lastWeekAvg === 'number').toBe(true);
    // The 10:00 hourly peak should surface in the window peak hours.
    expect(ctx.peakHours.some((p) => p.hour === 10)).toBe(true);
  });

  it('returns summary=null when the window has no row for the anchored date', () => {
    const ctx = buildDayInsightContext([day('2026-06-15')], DEFAULT_SCHEDULE, '2026-06-17');
    expect(ctx.summary).toBeNull();
  });
});
