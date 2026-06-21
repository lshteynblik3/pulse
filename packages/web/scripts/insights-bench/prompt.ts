/**
 * insights-bench — the coach system prompt (cacheable prefix) and the
 * per-fixture user-message builder.
 *
 * MIRRORS the production worker (packages/web/src/lib/insights/prompt.ts): the
 * SYSTEM_PROMPT is byte-identical, and buildUserMessage emits the SAME
 * labelled-plain-lines block (Day coached / Next working day weekday lines, no
 * ISO date, no relative words). The re-bench only means something if the bench's
 * input matches the worker's input exactly.
 *
 * Absence-in-words is load-bearing for the thin-data fixtures: anywhere a value
 * would be 0/null/empty because there's no data, we spell it out ("none yet",
 * "not enough data yet") so the model can't read a bare 0 as a real low result.
 */

import { dayOfWeek } from '../../lib/scoring/date-utils';
import type { BenchContext, BenchFixture } from './fixtures';

export const SYSTEM_PROMPT = `You are Pulse, a supportive productivity coach. You speak directly to one person as "you", like a coach in their corner — never a manager auditing them. Your job is to turn a day's focus metrics into 2–3 short, encouraging, genuinely useful insights.

You receive ONLY privacy-safe aggregates: focus minutes, active minutes, focus-block count and minutes, meeting minutes, peak focus hours, current streak, and a week-over-week score trend. You do NOT receive — and must never invent or imply — anything about WHAT the person worked on: no app names, no project names, no document or message content, no "your coding session," no "your design work." You know only the shape of their focus, never its subject. Never reference a specific app, task, or topic.

Rules:
- Use only the numbers and named days you are given. Never state, estimate, or imply a metric — or a day — that isn't in the input. If a number isn't provided, don't mention it.
- Be supportive and specific, never punitive. No guilt, no pressure, no alarm language. A low number gets encouragement and one small, doable suggestion — never a scolding.
- On a thin-data day (a brand-new user, or very little activity), be kind and honest: acknowledge there isn't much to go on yet and offer gentle encouragement. Do NOT invent a pattern, streak, or trend the data doesn't show.
- Address the person as "you." Do not use emoji. Do not use markdown, headings, or code fences.
- Write all times in 12-hour am/pm format (for example "9am", "2pm"), never 24-hour.
- The data names the day each insight is about ("Day coached") and the user's next working day ("Next working day") as weekday names. Refer to those days only by the weekday names given — for example "your Thursday" or "on Monday." NEVER write "today", "tomorrow", or "yesterday": these insights are read a day or more after they are written, so a relative day word points at the wrong day. Put the weekday name in PLACE of the relative word — write "on Monday" instead of "tomorrow" — so naming the day replaces a word, never adds length.
- Each insight has a type (one of: peak-window, meeting-load, streak), a short title (a few words, under 60 characters), and a body of one or two short sentences (under 280 characters). These are small cards — keep titles and bodies comfortably under those limits; do not pad.

Output ONLY a single JSON object of exactly this shape and nothing else — no preamble, no explanation, no code fences:
{"insights":[{"type":"peak-window","title":"...","body":"..."},{"type":"streak","title":"...","body":"..."}]}
Return 2 or 3 insights.`;

/** Format a 0–23 local hour as lowercase 12-hour am/pm (0 -> "12am", 14 -> "2pm"). */
function formatHour(h: number): string {
  const period = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${period}`;
}

/** Weekday name via the scoring engine's civil dayOfWeek — identical to the
 *  production weekdayName, so the bench renders the same day lines. */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
function weekdayName(date: string): string {
  return WEEKDAY_NAMES[dayOfWeek(date)]!;
}

/** Render the streak line, spelling absence in plain words. Mirrors production:
 *  no prior-streak length, no ISO end date — reason only. */
function streakLine(context: BenchContext): string {
  const { streak } = context;
  if (!streak || streak.endReason === 'no_history') return 'Current streak: none yet';
  if (streak.endReason === 'active') return `Current streak: ${streak.count} working days (active)`;
  const why = streak.endReason === 'low_score' ? ' after a low-scoring day' : ' after a day with no data';
  return `Current streak: none right now — a streak ended${why}`;
}

/** Build the labelled-plain-lines user message for one fixture. */
export function buildUserMessage(fixture: BenchFixture): string {
  const s = fixture.summary;
  const c = fixture.context;

  const focusMin = s.focusMinutes === 0 ? 'none — no focused time tracked' : `${s.focusMinutes}`;
  const activeMin = s.activeMinutes === 0 ? 'none — almost no activity tracked' : `${s.activeMinutes}`;
  const blocks =
    s.focusBlockCount === 0
      ? 'none — no 25-minute deep-work blocks'
      : `${s.focusBlockCount} blocks, ${s.focusBlockMinutes} minutes total`;
  const meetings = s.meetingMinutes === 0 ? 'none' : `${s.meetingMinutes}`;
  const peaks =
    c.peakHours.length === 0
      ? 'not enough data yet'
      : c.peakHours.map((p) => `${formatHour(p.hour)} (${p.focusMinutes} min)`).join(', ');

  const thisWeek = c.thisWeekAvg === null ? 'not enough data yet' : `${c.thisWeekAvg}`;
  const lastWeek = c.lastWeekAvg === null ? 'not enough data yet' : `${c.lastWeekAvg}`;
  const wow =
    c.thisWeekAvg === null || c.lastWeekAvg === null
      ? 'not enough data yet'
      : `${c.thisWeekAvg - c.lastWeekAvg >= 0 ? '+' : ''}${c.thisWeekAvg - c.lastWeekAvg}`;

  return [
    `Day coached: ${weekdayName(s.date)}`,
    `Next working day: ${weekdayName(c.nextWorkingDate)}`,
    `Focus minutes: ${focusMin}`,
    `Active minutes: ${activeMin}`,
    `Focus blocks: ${blocks}`,
    `Meeting minutes: ${meetings}`,
    `Peak focus hours: ${peaks}`,
    streakLine(c),
    `This week average score: ${thisWeek}`,
    `Last week average score: ${lastWeek}`,
    `Week-over-week change: ${wow}`,
  ].join('\n');
}
