import { describe, it, expect } from 'vitest';
import type { ScoredDay, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { weekOverWeekTrend } from './trend';

// today = 2026-06-30 (Tue). Mon–Fri working days in each window:
//   thisWeek (06-24..06-30): Wed 24, Thu 25, Fri 26, Mon 29, Tue 30
//   lastWeek (06-17..06-23): Wed 17, Thu 18, Fri 19, Mon 22, Tue 23
const TODAY = '2026-06-30';

describe('weekOverWeekTrend — bounds', () => {
  it('empty input → null', () => {
    expect(weekOverWeekTrend([], TODAY)).toBeNull();
  });

  it('only this week has data → null', () => {
    expect(weekOverWeekTrend([{ date: '2026-06-30', score: 80 }], TODAY)).toBeNull();
  });

  it('only last week has data → null', () => {
    expect(weekOverWeekTrend([{ date: '2026-06-23', score: 80 }], TODAY)).toBeNull();
  });

  it('last week averages to 0 → null (no divide-by-zero comparison)', () => {
    const days: ScoredDay[] = [
      { date: '2026-06-30', score: 80 }, // this week has data
      { date: '2026-06-23', score: 0 }, // last week all zero
      { date: '2026-06-22', score: 0 },
    ];
    expect(weekOverWeekTrend(days, TODAY)).toBeNull();
  });
});

describe('weekOverWeekTrend — moving cases', () => {
  it('positive trend; excludes weekends and working days with no data', () => {
    const days: ScoredDay[] = [
      { date: '2026-06-30', score: 80 }, // Tue (this week)
      { date: '2026-06-29', score: 80 }, // Mon (this week)
      { date: '2026-06-27', score: 100 }, // Sat — must be excluded
      { date: '2026-06-28', score: 100 }, // Sun — must be excluded
      // 06-24/25/26 are working but absent → excluded, not counted as 0
      { date: '2026-06-23', score: 60 }, // Tue (last week)
      { date: '2026-06-22', score: 60 }, // Mon (last week)
    ];
    const trend = weekOverWeekTrend(days, TODAY)!;
    expect(trend.thisWeek).toBe(80); // weekends ignored → avg of 80,80
    expect(trend.lastWeek).toBe(60);
    expect(trend.delta).toBe(20);
    expect(trend.percentChange).toBeCloseTo(33.333, 2); // (20/60)*100, raw
  });

  it('negative trend (direction-of-comparison check)', () => {
    const days: ScoredDay[] = [
      { date: '2026-06-30', score: 50 },
      { date: '2026-06-29', score: 50 },
      { date: '2026-06-23', score: 90 },
      { date: '2026-06-22', score: 90 },
    ];
    const trend = weekOverWeekTrend(days, TODAY)!;
    expect(trend.thisWeek).toBe(50);
    expect(trend.lastWeek).toBe(90);
    expect(trend.delta).toBe(-40);
    expect(trend.percentChange).toBeCloseTo(-44.444, 2); // (-40/90)*100, raw
  });

  it('computes both averages correctly over several working days', () => {
    const days: ScoredDay[] = [
      { date: '2026-06-24', score: 70 }, // Wed
      { date: '2026-06-25', score: 80 }, // Thu
      { date: '2026-06-26', score: 90 }, // Fri
      { date: '2026-06-17', score: 40 }, // Wed
      { date: '2026-06-18', score: 50 }, // Thu
      { date: '2026-06-19', score: 60 }, // Fri
    ];
    expect(weekOverWeekTrend(days, TODAY)).toEqual({
      thisWeek: 80, // (70+80+90)/3
      lastWeek: 50, // (40+50+60)/3
      delta: 30,
      percentChange: 60,
    });
  });

  it('honors a custom schedule when choosing which days to average', () => {
    // Tue/Thu/Sat only. In each window pick those working days that have data.
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, workingDays: [2, 4, 6] };
    const days: ScoredDay[] = [
      { date: '2026-06-30', score: 90 }, // Tue (this week)
      { date: '2026-06-29', score: 10 }, // Mon — not a working day here, excluded
      { date: '2026-06-23', score: 70 }, // Tue (last week)
    ];
    const trend = weekOverWeekTrend(days, TODAY, schedule)!;
    expect(trend.thisWeek).toBe(90); // Mon 06-29 excluded by schedule
    expect(trend.lastWeek).toBe(70);
    expect(trend.delta).toBe(20);
    expect(trend.percentChange).toBeCloseTo(28.571, 2); // (20/70)*100, raw
  });
});
