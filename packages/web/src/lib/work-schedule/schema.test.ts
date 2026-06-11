import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import {
  isValidLocalDate,
  rowToSchedule,
  scheduleToRow,
  workScheduleSchema,
} from './schema';

/** A known-good payload tests start from, overriding one field at a time. */
const valid = {
  workingDays: [1, 2, 3, 4, 5],
  dailyHours: 8,
  vacationDates: ['2026-07-03', '2026-07-06'],
  breaks: [{ label: 'Lunch', start: '12:00', end: '12:45' }],
};

describe('workScheduleSchema — accepts', () => {
  it('a full valid schedule', () => {
    const parsed = workScheduleSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('the shared DEFAULT_SCHEDULE (one source of truth must validate)', () => {
    const parsed = workScheduleSchema.parse(DEFAULT_SCHEDULE);
    expect(parsed.workingDays).toEqual(DEFAULT_SCHEDULE.workingDays);
    expect(parsed.breaks).toEqual([]); // default applied for the absent field
  });

  it('a missing breaks field, defaulting to []', () => {
    const { breaks: _omitted, ...withoutBreaks } = valid;
    expect(workScheduleSchema.parse(withoutBreaks).breaks).toEqual([]);
  });

  it('an unlabeled break', () => {
    const parsed = workScheduleSchema.parse({
      ...valid,
      breaks: [{ start: '15:00', end: '15:15' }],
    });
    expect(parsed.breaks[0].label).toBeUndefined();
  });

  it('boundary dailyHours of 24', () => {
    expect(workScheduleSchema.parse({ ...valid, dailyHours: 24 }).dailyHours).toBe(24);
  });
});

describe('workScheduleSchema — normalizes', () => {
  it('dedupes and sorts workingDays', () => {
    const parsed = workScheduleSchema.parse({ ...valid, workingDays: [5, 1, 3, 1, 5] });
    expect(parsed.workingDays).toEqual([1, 3, 5]);
  });

  it('dedupes and sorts vacationDates', () => {
    const parsed = workScheduleSchema.parse({
      ...valid,
      vacationDates: ['2026-12-24', '2026-07-03', '2026-12-24'],
    });
    expect(parsed.vacationDates).toEqual(['2026-07-03', '2026-12-24']);
  });
});

describe('workScheduleSchema — rejects', () => {
  it('an empty workingDays with the human-readable message the UI shows', () => {
    const result = workScheduleSchema.safeParse({ ...valid, workingDays: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Select at least one working day.');
    }
  });

  it('out-of-range or fractional weekday numbers', () => {
    expect(workScheduleSchema.safeParse({ ...valid, workingDays: [7] }).success).toBe(false);
    expect(workScheduleSchema.safeParse({ ...valid, workingDays: [-1] }).success).toBe(false);
    expect(workScheduleSchema.safeParse({ ...valid, workingDays: [1.5] }).success).toBe(false);
  });

  it('dailyHours of 0, negative, or > 24', () => {
    expect(workScheduleSchema.safeParse({ ...valid, dailyHours: 0 }).success).toBe(false);
    expect(workScheduleSchema.safeParse({ ...valid, dailyHours: -1 }).success).toBe(false);
    expect(workScheduleSchema.safeParse({ ...valid, dailyHours: 24.5 }).success).toBe(false);
  });

  it('malformed or impossible vacation dates', () => {
    for (const bad of ['2026-7-03', '07/03/2026', '2026-02-30', '2026-13-01', '2026-00-10']) {
      expect(workScheduleSchema.safeParse({ ...valid, vacationDates: [bad] }).success).toBe(false);
    }
  });

  it('more than 366 vacation dates', () => {
    // 367 distinct real days spanning 2026 + the start of 2027.
    const dates: string[] = [];
    for (let month = 1; month <= 12 && dates.length < 367; month++) {
      for (let day = 1; day <= 28 && dates.length < 367; day++) {
        dates.push(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      }
    }
    for (let day = 1; dates.length < 367; day++) {
      dates.push(`2027-01-${String(day).padStart(2, '0')}`);
    }
    expect(workScheduleSchema.safeParse({ ...valid, vacationDates: dates }).success).toBe(false);
  });

  it('non-zero-padded or out-of-range break times (hand-crafted PUTs, not just the time picker)', () => {
    for (const bad of ['9:00', '24:00', '12:60', '12-30', '12:3', 'noon']) {
      const result = workScheduleSchema.safeParse({
        ...valid,
        breaks: [{ start: bad, end: '13:00' }],
      });
      expect(result.success, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it('a break that starts at or after its end', () => {
    expect(
      workScheduleSchema.safeParse({ ...valid, breaks: [{ start: '12:00', end: '12:00' }] })
        .success,
    ).toBe(false);
    expect(
      workScheduleSchema.safeParse({ ...valid, breaks: [{ start: '13:00', end: '12:00' }] })
        .success,
    ).toBe(false);
  });

  it('more than 10 breaks', () => {
    const breaks = Array.from({ length: 11 }, (_, i) => ({
      start: `${String(i + 8).padStart(2, '0')}:00`,
      end: `${String(i + 8).padStart(2, '0')}:30`,
    }));
    expect(workScheduleSchema.safeParse({ ...valid, breaks }).success).toBe(false);
  });
});

describe('isValidLocalDate', () => {
  it('handles leap years', () => {
    expect(isValidLocalDate('2024-02-29')).toBe(true); // divisible by 4
    expect(isValidLocalDate('2026-02-29')).toBe(false); // not a leap year
    expect(isValidLocalDate('2000-02-29')).toBe(true); // divisible by 400
    expect(isValidLocalDate('1900-02-29')).toBe(false); // divisible by 100, not 400
  });
});

describe('row mapping', () => {
  it('round-trips a schedule through the row shape', () => {
    const parsed = workScheduleSchema.parse(valid);
    const row = scheduleToRow('user-1', parsed);
    expect(row.user_id).toBe('user-1');
    expect(rowToSchedule(row)).toEqual(parsed);
  });

  it('normalizes a numeric daily_hours that arrives as a string', () => {
    const row = { ...scheduleToRow('user-1', workScheduleSchema.parse(valid)), daily_hours: '7.5' };
    expect(rowToSchedule(row as never).dailyHours).toBe(7.5);
  });
});
