import { z } from 'zod';
import type { WorkBreak, WorkSchedule } from '@pulse/shared';

/**
 * The single zod schema for a WorkSchedule, derived field-for-field from the
 * shared type (the compile-time check at the bottom fails the build on drift).
 * Used by PUT /api/work-schedule before anything touches the database, and by
 * nothing else — the agent never sends a schedule.
 *
 * Dates and times here are LOCAL civil values: "YYYY-MM-DD" days and "HH:MM"
 * clock times. They are validated as strings and stored as strings — no Date,
 * no toISOString(), so no timezone can shift them (the Phase 1 lesson).
 */

/** Zero-padded 24h clock time. Zero-padding is what makes `start < end` string comparison chronologically sound. */
export const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const YYYYMMDD_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real calendar day (so "2026-02-30" fails, leap years handled).
 * Pure field arithmetic, mirroring lib/scoring/date-utils — never a Date.
 */
export function isValidLocalDate(yyyymmdd: string): boolean {
  if (!YYYYMMDD_REGEX.test(yyyymmdd)) return false;
  const year = Number(yyyymmdd.slice(0, 4));
  const month = Number(yyyymmdd.slice(5, 7));
  const day = Number(yyyymmdd.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

const breakSchema = z
  .object({
    label: z.string().max(60).optional(),
    start: z.string().regex(HHMM_REGEX, 'Break times must be zero-padded "HH:MM".'),
    end: z.string().regex(HHMM_REGEX, 'Break times must be zero-padded "HH:MM".'),
  })
  .refine((b) => b.start < b.end, { message: 'A break must start before it ends.' });

export const workScheduleSchema = z.object({
  // 0 = Sunday … 6 = Saturday, matching scoring's dayOfWeek(). Deduped and
  // sorted on the way in so the stored row is always canonical.
  workingDays: z
    .array(z.number().int().min(0).max(6), {
      invalid_type_error: 'workingDays must be numbers 0–6.',
    })
    .min(1, 'Select at least one working day.')
    .transform((days) => [...new Set(days)].sort((a, b) => a - b)),

  dailyHours: z
    .number()
    .positive('Daily hours must be greater than 0.')
    .max(24, 'Daily hours can be at most 24.'),

  vacationDates: z
    .array(
      z
        .string()
        .refine(isValidLocalDate, { message: 'Vacation dates must be real "YYYY-MM-DD" days.' }),
    )
    .max(366, 'At most 366 vacation dates.')
    .transform((dates) => [...new Set(dates)].sort()),

  // Persisted-but-unused by scoring (Phase 4c just stores them). Validated
  // tightly anyway so the jsonb column can't become a dumping ground.
  breaks: z.array(breakSchema).max(10, 'At most 10 breaks.').default([]),
});

export type ValidWorkSchedule = z.infer<typeof workScheduleSchema>;

// Compile-time guarantee the schema's output is a valid WorkSchedule. One
// direction only, deliberately: the output is *narrower* than the type
// (`breaks` is always present after the default), which is fine — every output
// is assignable to WorkSchedule, which is all the scoring engine needs.
type _SchemaProducesWorkSchedule = ValidWorkSchedule extends WorkSchedule ? true : never;
const _check: _SchemaProducesWorkSchedule = true;
void _check;

/** The work_schedules row shape as supabase-js reads/writes it. */
export interface WorkScheduleRow {
  user_id: string;
  working_days: number[];
  daily_hours: number;
  vacation_dates: string[]; // Postgres date[] arrives as "YYYY-MM-DD" strings
  breaks: WorkBreak[];
}

export function rowToSchedule(row: WorkScheduleRow): WorkSchedule {
  return {
    workingDays: row.working_days,
    // numeric can arrive as a string depending on the driver path; normalize.
    dailyHours: Number(row.daily_hours),
    vacationDates: row.vacation_dates,
    breaks: row.breaks,
  };
}

export function scheduleToRow(userId: string, schedule: ValidWorkSchedule): WorkScheduleRow {
  return {
    user_id: userId,
    working_days: schedule.workingDays,
    daily_hours: schedule.dailyHours,
    vacation_dates: schedule.vacationDates,
    breaks: schedule.breaks,
  };
}
