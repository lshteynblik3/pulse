import { describe, it, expect } from 'vitest';
import { DEFAULT_SCHEDULE, type WorkSchedule } from '@pulse/shared';
import { addDays, dayOfWeek, isWorkingDay } from './date-utils';

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
