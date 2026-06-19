import { describe, it, expect } from 'vitest';
import { DEFAULT_SCHEDULE, type WorkSchedule } from '@pulse/shared';
import {
  addDays,
  dayOfWeek,
  isWorkingDay,
  nextWorkingDay,
  previousWorkingDay,
  weekdayName,
} from './date-utils';

describe('addDays', () => {
  it('adds and subtracts a single day', () => {
    expect(addDays('2026-06-09', 1)).toBe('2026-06-10');
    expect(addDays('2026-06-09', -1)).toBe('2026-06-08');
    expect(addDays('2026-06-09', 0)).toBe('2026-06-09');
  });

  it('crosses month boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); // 2026 is not a leap year
  });

  it('handles leap vs non-leap February', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // 2024 is a leap year
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not
  });

  it('crosses year boundaries', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles large offsets across leap and non-leap years', () => {
    expect(addDays('2024-01-01', 366)).toBe('2025-01-01'); // 2024 has 366 days
    expect(addDays('2026-01-01', 365)).toBe('2027-01-01'); // 2026 has 365 days
    expect(addDays('2026-01-01', -365)).toBe('2025-01-01'); // 2025 has 365 days
  });

  it('round-trips: addDays(addDays(d, n), -n) === d', () => {
    for (const d of ['2024-02-29', '2025-12-31', '2026-06-09', '2026-01-01']) {
      for (const n of [1, 7, 30, 365, -400]) {
        expect(addDays(addDays(d, n), -n)).toBe(d);
      }
    }
  });

  it('rejects malformed input', () => {
    expect(() => addDays('2026-6-9', 1)).toThrow();
    expect(() => addDays('06-09-2026', 1)).toThrow();
    expect(() => addDays('not-a-date', 1)).toThrow();
    expect(() => addDays('2026-13-01', 1)).toThrow();
  });
});

describe('dayOfWeek (0=Sun … 6=Sat)', () => {
  it('matches known dates', () => {
    expect(dayOfWeek('1970-01-01')).toBe(4); // Thursday — the algorithm's anchor
    expect(dayOfWeek('2026-06-07')).toBe(0); // Sunday
    expect(dayOfWeek('2026-06-08')).toBe(1); // Monday
    expect(dayOfWeek('2026-06-09')).toBe(2); // Tuesday (today's date)
    expect(dayOfWeek('2026-06-13')).toBe(6); // Saturday
  });
});

describe('isWorkingDay', () => {
  it('uses Mon–Fri under the default schedule', () => {
    expect(isWorkingDay('2026-06-09', DEFAULT_SCHEDULE)).toBe(true); // Tue
    expect(isWorkingDay('2026-06-07', DEFAULT_SCHEDULE)).toBe(false); // Sun
    expect(isWorkingDay('2026-06-13', DEFAULT_SCHEDULE)).toBe(false); // Sat
  });

  it('excludes vacation days even when they fall on a working weekday', () => {
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, vacationDates: ['2026-06-09'] };
    expect(isWorkingDay('2026-06-09', schedule)).toBe(false); // Tue, but on vacation
    expect(isWorkingDay('2026-06-10', schedule)).toBe(true); // Wed, not on vacation
  });

  it('honors a custom working-day set (Tue/Thu/Sat)', () => {
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, workingDays: [2, 4, 6] };
    expect(isWorkingDay('2026-06-09', schedule)).toBe(true); // Tue
    expect(isWorkingDay('2026-06-10', schedule)).toBe(false); // Wed
    expect(isWorkingDay('2026-06-11', schedule)).toBe(true); // Thu
    expect(isWorkingDay('2026-06-13', schedule)).toBe(true); // Sat
  });
});

describe('weekdayName', () => {
  it('maps civil dates to weekday names (pure, no Date/locale)', () => {
    expect(weekdayName('2026-06-12')).toBe('Friday');
    expect(weekdayName('2026-06-13')).toBe('Saturday');
    expect(weekdayName('2026-06-14')).toBe('Sunday');
    expect(weekdayName('2026-06-15')).toBe('Monday');
    expect(weekdayName('2026-06-11')).toBe('Thursday');
  });
});

describe('nextWorkingDay', () => {
  it('returns the next day when it is a working day (Mon -> Tue)', () => {
    expect(nextWorkingDay('2026-06-08', DEFAULT_SCHEDULE)).toBe('2026-06-09'); // Mon -> Tue
  });

  it('skips the weekend: Friday -> Monday (the case that motivated this fix)', () => {
    // 2026-06-12 is Friday; Sat 13 + Sun 14 are skipped.
    expect(nextWorkingDay('2026-06-12', DEFAULT_SCHEDULE)).toBe('2026-06-15'); // Mon
  });

  it('skips a vacation day', () => {
    const schedule: WorkSchedule = { ...DEFAULT_SCHEDULE, vacationDates: ['2026-06-10'] };
    // From Tue 09, Wed 10 is a weekday but on vacation -> Thu 11.
    expect(nextWorkingDay('2026-06-09', schedule)).toBe('2026-06-11');
  });

  it('falls back to the adjacent calendar day for a degenerate schedule (no working day in range)', () => {
    const degenerate: WorkSchedule = { ...DEFAULT_SCHEDULE, workingDays: [] };
    const result = nextWorkingDay('2026-06-08', degenerate);
    expect(result).toBe('2026-06-09'); // adjacent day fallback
    // The fallback is detectable: the returned day is NOT a working day (this is
    // what the caller checks before warning).
    expect(isWorkingDay(result, degenerate)).toBe(false);
  });
});

describe('previousWorkingDay', () => {
  it('skips the weekend: Monday -> Friday', () => {
    expect(previousWorkingDay('2026-06-15', DEFAULT_SCHEDULE)).toBe('2026-06-12'); // Mon -> Fri
  });

  it('falls back to the adjacent calendar day for a degenerate schedule', () => {
    const degenerate: WorkSchedule = { ...DEFAULT_SCHEDULE, workingDays: [] };
    const result = previousWorkingDay('2026-06-15', degenerate);
    expect(result).toBe('2026-06-14');
    expect(isWorkingDay(result, degenerate)).toBe(false);
  });
});
