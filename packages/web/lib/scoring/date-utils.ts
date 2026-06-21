/**
 * Date helpers for the scoring engine — the bedrock everything else stands on.
 *
 * THE RULE: a date is an opaque "YYYY-MM-DD" civil day string. We NEVER build a
 * `Date`, never call `toISOString()`, and never round-trip through UTC — that's
 * exactly the class of bug that made Phase 1's "today" land on the wrong day for
 * non-UTC users. Instead we convert the calendar fields to an integer day number
 * with pure arithmetic (the standard civil↔days algorithm), do the math on
 * integers, and format back. No timezone or DST exists in this world, so none
 * can shift a day.
 */

import type { WorkSchedule } from '@pulse/shared';

/** Integer division truncating toward zero (matches the reference algorithm's C++ `/`). */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

interface Civil {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

/** Parse "YYYY-MM-DD" into integer fields, rejecting anything malformed. */
function parse(yyyymmdd: string): Civil {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!match) {
    throw new Error(`Invalid date, expected "YYYY-MM-DD": ${JSON.stringify(yyyymmdd)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Date out of range: ${yyyymmdd}`);
  }
  return { year, month, day };
}

function format({ year, month, day }: Civil): string {
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * Days since 1970-01-01 for a civil date. Pure integer math (Howard Hinnant's
 * `days_from_civil`), valid for any proleptic-Gregorian date and leap-year
 * correct. No `Date`, so no timezone.
 */
function daysFromCivil({ year, month, day }: Civil): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = idiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = idiv(153 * (month + (month > 2 ? -3 : 9)) + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of {@link daysFromCivil}: a day number back to a civil date. */
function civilFromDays(serial: number): Civil {
  const z = serial + 719468;
  const era = idiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365); // [0, 399]
  const year = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100)); // [0, 365]
  const mp = idiv(5 * doy + 2, 153); // [0, 11]
  const day = doy - idiv(153 * mp + 2, 5) + 1; // [1, 31]
  const month = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/**
 * Return the civil date `n` days after `yyyymmdd` (negative `n` goes backward),
 * as "YYYY-MM-DD". Crosses month/year/leap boundaries correctly because it
 * operates on the integer day number, not on calendar fields.
 */
export function addDays(yyyymmdd: string, n: number): string {
  return format(civilFromDays(daysFromCivil(parse(yyyymmdd)) + n));
}

/**
 * Day of week for a civil date: 0 = Sunday … 6 = Saturday. Derived from the day
 * number (1970-01-01, day 0, was a Thursday = 4), so it matches `WorkSchedule.workingDays`
 * and never touches `Date.getDay()` / a timezone.
 */
export function dayOfWeek(yyyymmdd: string): number {
  const serial = daysFromCivil(parse(yyyymmdd));
  return ((serial % 7) + 4 + 7) % 7;
}

/**
 * Is this civil day a working day under the given schedule? The single gate the
 * rest of the scoring engine uses to include/exclude a day. A vacation day is
 * never a working day, regardless of weekday.
 */
export function isWorkingDay(yyyymmdd: string, schedule: WorkSchedule): boolean {
  if (schedule.vacationDates.includes(yyyymmdd)) return false;
  return schedule.workingDays.includes(dayOfWeek(yyyymmdd));
}

/** Weekday names indexed by {@link dayOfWeek} (0 = Sunday … 6 = Saturday). */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * The weekday name for a civil date, e.g. "Thursday". Pure — derived from
 * {@link dayOfWeek}, never `Date`/locale, so it can't shift across a timezone.
 * Used to name days in coaching insights so they never say "today"/"tomorrow"
 * (which rot when an insight is read on a later day).
 */
export function weekdayName(yyyymmdd: string): string {
  // dayOfWeek always returns 0–6, so the index is always in range.
  return WEEKDAY_NAMES[dayOfWeek(yyyymmdd)]!;
}

/** Default cap for the working-day scan — generous enough for any real vacation
 *  run, small enough that a degenerate schedule can't spin. */
const MAX_WORKING_DAY_SCAN = 14;

/**
 * The next working day strictly AFTER `yyyymmdd` under `schedule` — skips
 * weekends and vacation dates (via {@link isWorkingDay}). Scans up to `maxScan`
 * days; if NO working day is found in range (a degenerate schedule: empty
 * `workingDays`, or a vacation run longer than the window), falls back to the
 * adjacent calendar day. That fallback is unreachable with a real schedule; the
 * caller detects it (the result is not a working day) and warns — see
 * `lib/insights/dates.ts`.
 */
export function nextWorkingDay(
  yyyymmdd: string,
  schedule: WorkSchedule,
  maxScan: number = MAX_WORKING_DAY_SCAN,
): string {
  for (let i = 1; i <= maxScan; i++) {
    const candidate = addDays(yyyymmdd, i);
    if (isWorkingDay(candidate, schedule)) return candidate;
  }
  return addDays(yyyymmdd, 1); // fallback: adjacent calendar day (see docstring)
}

/** The previous working day strictly BEFORE `yyyymmdd` — symmetric to
 *  {@link nextWorkingDay}, same scan cap and adjacent-day fallback. */
export function previousWorkingDay(
  yyyymmdd: string,
  schedule: WorkSchedule,
  maxScan: number = MAX_WORKING_DAY_SCAN,
): string {
  for (let i = 1; i <= maxScan; i++) {
    const candidate = addDays(yyyymmdd, -i);
    if (isWorkingDay(candidate, schedule)) return candidate;
  }
  return addDays(yyyymmdd, -1); // fallback: adjacent calendar day
}
