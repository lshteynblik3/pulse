/**
 * Display formatting for the dashboard — the UI's half of the rounding
 * contract. /api/dashboard passes scoring's raw values through untouched
 * (integer score aside); everything user-facing is rounded HERE, once.
 *
 * Same civil-date discipline as scoring: "YYYY-MM-DD" strings are split into
 * components and rebuilt with the LOCAL Date constructor — never parsed with
 * `new Date(string)` (which reads as UTC) — and the browser's "today" comes
 * from local Date components, never toISOString().
 *
 * Copy lives here too (score bands, streak reasons) so the supportive-coach
 * tone is unit-testable, not scattered through JSX.
 */

import type { Streak } from '@pulse/shared';

/** "YYYY-MM-DD" from a Date's LOCAL components — the client's civil day. */
export function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-constructor rebuild of a civil date — never `new Date(string)`. */
function toLocalDate(date: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** "Thursday, June 11" — the page heading. */
export function formatDateHeading(date: string): string {
  return toLocalDate(date).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** "June 8" — inline mentions like a streak's boundary day. */
export function formatDateShort(date: string): string {
  return toLocalDate(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

/** Shift a civil date by whole days, staying in local civil time (never UTC). */
export function shiftDate(date: string, days: number): string {
  const d = toLocalDate(date);
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/**
 * A relative tag for the date heading so it's always obvious which day you're
 * on: "Today" / "Yesterday" / "N days ago". null for the future (the date nav
 * caps at today, so that shouldn't happen — but never label a future day).
 */
export function relativeDayLabel(date: string, today: string): string | null {
  if (date === today) return 'Today';
  const diffDays = Math.round(
    (toLocalDate(today).getTime() - toLocalDate(date).getTime()) / 86_400_000,
  );
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1) return `${diffDays} days ago`;
  return null;
}

/** Minutes → "45m" / "2h" / "3h 25m", rounded to the nearest whole minute. */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** 0–1 fraction → "46%". */
export function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clockParts(hour: number): { num: number; period: 'AM' | 'PM' } {
  return { num: hour % 12 === 0 ? 12 : hour % 12, period: hour < 12 ? 'AM' : 'PM' };
}

/** Local hour 0–23 → its hour-long range: "9–10 AM", "11 AM–12 PM", "11 PM–12 AM". */
export function hourRangeLabel(hour: number): string {
  const start = clockParts(hour);
  const end = clockParts((hour + 1) % 24);
  return start.period === end.period
    ? `${start.num}–${end.num} ${end.period}`
    : `${start.num} ${start.period}–${end.num} ${end.period}`;
}

/** "9 AM" / "12 PM" — chart axis ticks. */
export function hourTickLabel(hour: number): string {
  const { num, period } = clockParts(hour);
  return `${num} ${period}`;
}

/**
 * Full ISO timestamp → "just now" / "4 minutes ago" / "2 hours ago" /
 * "3 days ago". `new Date(iso)` is fine HERE: these are real instants with a
 * timezone, not civil dates — the never-parse-strings rule guards YYYY-MM-DD.
 * `now` is injectable for tests; clock skew can't go negative.
 */
export function relativeTimeLabel(iso: string, now: Date = new Date()): string {
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Coach-toned read of the day. SPEC's premise: supportive, never punitive — a
 * low score is described honestly but warmly, never as failure.
 */
export function scoreMessage(score: number): string {
  if (score >= 80) return 'In the zone — a deep, focused day.';
  if (score >= 60) return 'A solid, focused day. Nice work.';
  if (score >= 40) return 'Steady going — every focused block counts.';
  return 'A lighter day. Those count too.';
}

/**
 * Gauge color by band: slate → soft purple → purple → green. Deliberately no
 * red anywhere on this scale — same product-values rule as the copy.
 */
export function scoreColor(score: number): string {
  if (score >= 80) return '#1a7f37';
  if (score >= 60) return '#6d4fe5';
  if (score >= 40) return '#8d77e0';
  return '#64748b';
}

/**
 * The streak's endReason in human terms (the playbook wants this visible, not
 * a silent reset). `endedOn` bounds the CURRENT streak: with count > 0 it's
 * the day before the run started; with count 0 it's what reset things.
 */
export function streakMessage(streak: Streak): string {
  const when = streak.endedOn ? ` on ${formatDateShort(streak.endedOn)}` : '';
  switch (streak.endReason) {
    case 'active':
      return streak.count > 0
        ? 'Going strong — every working day so far.'
        : 'Today is a fresh start.';
    case 'low_score':
      return streak.count > 0
        ? `Counting since a quieter day${when}.`
        : `A quieter day${when} reset things — today is a fresh start.`;
    case 'missing_data':
      return streak.count > 0
        ? `Counting since a day without data${when}.`
        : `A day without data${when} reset things — today is a fresh start.`;
    case 'no_history':
      return 'Your first streak starts with your first tracked day.';
  }
}
