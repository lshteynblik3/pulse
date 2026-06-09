import { describe, it, expect } from 'vitest';
import type { ScoredDay, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { currentStreak } from './streak';
import { addDays } from './date-utils';

// June 2026 reference: 08 Mon, 09 Tue, 10 Wed, 11 Thu, 12 Fri, 13 Sat, 14 Sun.

// Every day is a working day, so workingDayPos == calendar offset from today.
// Used by the grace-window tests to place misses at exact, legible positions.
const ALL_DAYS: WorkSchedule = { workingDays: [0, 1, 2, 3, 4, 5, 6], dailyHours: 8, vacationDates: [] };

/** Build ScoredDay[] from scores going backward from `today`; null = no data that day. */
function buildDays(today: string, scoresFromToday: (number | null)[]): ScoredDay[] {
  const days: ScoredDay[] = [];
  let cursor = today;
  for (const s of scoresFromToday) {
    if (s !== null) days.push({ date: cursor, score: s });
    cursor = addDays(cursor, -1);
  }
  return days;
}

describe('currentStreak — bounds', () => {
  it('no history', () => {
    expect(currentStreak([], '2026-06-09')).toEqual({
      count: 0,
      endedOn: null,
      endReason: 'no_history',
    });
  });

  it('a single good working day today', () => {
    expect(currentStreak([{ date: '2026-06-09', score: 70 }], '2026-06-09')).toEqual({
      count: 1,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('three consecutive good working days', () => {
    const days = [
      { date: '2026-06-08', score: 70 },
      { date: '2026-06-09', score: 80 },
      { date: '2026-06-10', score: 65 },
    ];
    expect(currentStreak(days, '2026-06-10')).toEqual({
      count: 3,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('score of exactly 60 counts; 59 breaks', () => {
    expect(currentStreak([{ date: '2026-06-09', score: 60 }], '2026-06-09').count).toBe(1);
    expect(currentStreak([{ date: '2026-06-09', score: 59 }], '2026-06-09')).toEqual({
      count: 0,
      endedOn: '2026-06-09',
      endReason: 'low_score',
    });
  });
});

describe('currentStreak — termination paths', () => {
  it('a low score breaks immediately, endedOn that day', () => {
    const days = [
      { date: '2026-06-08', score: 70 },
      { date: '2026-06-09', score: 50 },
      { date: '2026-06-10', score: 80 },
    ];
    expect(currentStreak(days, '2026-06-10')).toEqual({
      count: 1,
      endedOn: '2026-06-09',
      endReason: 'low_score',
    });
  });

  it('a second miss inside the grace window breaks with missing_data', () => {
    // ALL_DAYS: miss at pos 0 (today) is forgiven; miss at pos 13 is the second
    // miss only 13 working days later -> breaks. Trailing good day keeps pos 13 in range.
    const today = '2026-06-30';
    const days = buildDays(today, [null, ...Array<number>(12).fill(70), null, 70]);
    expect(currentStreak(days, today, ALL_DAYS)).toEqual({
      count: 12,
      endedOn: addDays(today, -13),
      endReason: 'missing_data',
    });
  });
});

describe('currentStreak — schedule behavior', () => {
  it('skips the weekend between two good days', () => {
    const days = [
      { date: '2026-06-05', score: 70 }, // Fri
      { date: '2026-06-08', score: 70 }, // Mon
    ];
    expect(currentStreak(days, '2026-06-08')).toEqual({
      count: 2, // Sat/Sun did not break it
      endedOn: null,
      endReason: 'active',
    });
  });

  it('starts from the most recent working day when today is a weekend', () => {
    const days = [
      { date: '2026-06-11', score: 70 }, // Thu
      { date: '2026-06-12', score: 70 }, // Fri
    ];
    // today is Sunday — walk back past Sun/Sat to Fri, then Thu.
    expect(currentStreak(days, '2026-06-14')).toEqual({
      count: 2,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('skips a vacation day without consuming the missing-data grace', () => {
    // Tue is vacation (skipped). Mon has no data (a real, forgiven miss). If the
    // vacation day were wrongly treated as a miss, Mon would be a 2nd miss one
    // working day later and break — proving vacation is skipped, not forgiven.
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, vacationDates: ['2026-06-09'] };
    const days = [
      { date: '2026-06-05', score: 70 }, // Fri
      { date: '2026-06-10', score: 70 }, // Wed
    ];
    expect(currentStreak(days, '2026-06-10', schedule)).toEqual({
      count: 2,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('counts only the working days of a custom schedule (Tue/Thu/Sat)', () => {
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, workingDays: [2, 4, 6] };
    const days = [
      { date: '2026-06-09', score: 70 }, // Tue
      { date: '2026-06-11', score: 70 }, // Thu
      { date: '2026-06-13', score: 70 }, // Sat
    ];
    // Mon/Wed/Fri are non-working: they neither count nor break.
    expect(currentStreak(days, '2026-06-13', schedule)).toEqual({
      count: 3,
      endedOn: null,
      endReason: 'active',
    });
  });
});

describe('currentStreak — grace window', () => {
  it('forgives a single missing working day; the miss itself does not count', () => {
    // [70, 70, _, 70, 70] from today -> the gap is forgiven, 4 good days counted.
    const today = '2026-06-30';
    const days = buildDays(today, [70, 70, null, 70, 70]);
    expect(currentStreak(days, today, ALL_DAYS)).toEqual({
      count: 4,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('forgives two misses exactly 14 working days apart (window is strictly < 14)', () => {
    // miss at pos 0, miss at pos 14: 14 apart -> both forgiven.
    const today = '2026-06-30';
    const days = buildDays(today, [null, ...Array<number>(13).fill(70), null, 70]);
    expect(currentStreak(days, today, ALL_DAYS)).toEqual({
      count: 14,
      endedOn: null,
      endReason: 'active',
    });
  });

  it('treats today-with-no-data as a forgivable miss, not a hard stop', () => {
    // No entry for today (Wed); the streak continues from the prior good days.
    const days = [
      { date: '2026-06-08', score: 70 }, // Mon
      { date: '2026-06-09', score: 70 }, // Tue
    ];
    expect(currentStreak(days, '2026-06-10')).toEqual({
      count: 2,
      endedOn: null,
      endReason: 'active',
    });
  });
});
