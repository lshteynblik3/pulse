/**
 * The coach system prompt (the cacheable prefix) and the worker-side
 * user-message builder for the Phase 5 insights worker.
 *
 * SYSTEM_PROMPT is FROZEN — it's the prompt the model bench validated, ported
 * verbatim. (Note: at ~400 tokens it's below Haiku's 4096-token prompt-cache
 * minimum, so the worker gets the Batch -50% only, no cache savings — expected,
 * not a bug.)
 *
 * buildInsightsUserMessage renders one user's real aggregates into the SAME
 * labelled-plain-lines format the bench validated: plain lines (not JSON, so the
 * input format doesn't bleed into the output we parse), times in 12-hour am/pm,
 * and absence spelled in words ("none yet", "not enough data yet") so the model
 * can't read a bare 0 as a real low result. The submit cron computes the context
 * from a window of daily summaries (via lib/scoring) and passes it here.
 */

import type { DailySummary, PeakHour, Streak } from '@pulse/shared';
import { weekdayName } from '../../../lib/scoring/date-utils';

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

/**
 * The 30-day/trend aggregates that accompany a day's summary in the user message.
 * Computed by the submit cron from the same lib/scoring helpers the dashboard
 * uses, so the coach sees the same numbers the user does.
 */
export interface InsightContext {
  /** Top focus hours over the window; [] when there isn't enough history. */
  peakHours: PeakHour[];
  /** currentStreak's result — endReason 'no_history' means no streak yet. */
  streak: Streak;
  /** Avg working-day score this week, or null when there's no baseline yet. */
  thisWeekAvg: number | null;
  /** Avg working-day score last week, or null when there's no baseline yet. */
  lastWeekAvg: number | null;
  /**
   * The user's next working day after the coached day (computed by the route via
   * resolveNextWorkingDay, which skips weekends + vacations). Rendered as a
   * weekday name so the coach can say "on Monday" instead of "tomorrow".
   */
  nextWorkingDate: string;
}

/** Format a 0–23 local hour as lowercase 12-hour am/pm (0 -> "12am", 14 -> "2pm").
 *  Exported so the computed-tips fallback renders times identically (one source
 *  of the am/pm format — no drift between the LLM input and the fallback). */
export function formatHour(h: number): string {
  const period = h < 12 ? 'am' : 'pm';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}${period}`;
}

/** Render the streak line, spelling absence in plain words. */
function streakLine(streak: Streak): string {
  if (streak.endReason === 'no_history') return 'Current streak: none yet';
  if (streak.endReason === 'active') return `Current streak: ${streak.count} working days (active)`;
  // A streak that just ended (low_score / missing_data). No date: the coached day
  // is already named at top via "Day coached", and a streak-end date would inject
  // a third day the coaching doesn't need (computedTips drops it too, for parity).
  const why = streak.endReason === 'low_score' ? ' after a low-scoring day' : ' after a day with no data';
  return `Current streak: none right now — a streak ended${why}`;
}

/** Build the labelled-plain-lines user message for one user's day. */
export function buildInsightsUserMessage(summary: DailySummary, context: InsightContext): string {
  const focusMin =
    summary.focusMinutes === 0 ? 'none — no focused time tracked' : `${summary.focusMinutes}`;
  const activeMin =
    summary.activeMinutes === 0 ? 'none — almost no activity tracked' : `${summary.activeMinutes}`;
  const blocks =
    summary.focusBlockCount === 0
      ? 'none — no 25-minute deep-work blocks'
      : `${summary.focusBlockCount} blocks, ${summary.focusBlockMinutes} minutes total`;
  const meetings = summary.meetingMinutes === 0 ? 'none' : `${summary.meetingMinutes}`;
  const peaks =
    context.peakHours.length === 0
      ? 'not enough data yet'
      : context.peakHours.map((p) => `${formatHour(p.hour)} (${p.focusMinutes} min)`).join(', ');

  const thisWeek = context.thisWeekAvg === null ? 'not enough data yet' : `${context.thisWeekAvg}`;
  const lastWeek = context.lastWeekAvg === null ? 'not enough data yet' : `${context.lastWeekAvg}`;
  const wow =
    context.thisWeekAvg === null || context.lastWeekAvg === null
      ? 'not enough data yet'
      : `${context.thisWeekAvg - context.lastWeekAvg >= 0 ? '+' : ''}${context.thisWeekAvg - context.lastWeekAvg}`;

  return [
    // Weekday names only (no ISO date) so the model echoes "Thursday"/"Monday"
    // and can never compute a relative "today"/"tomorrow" from an absolute date.
    `Day coached: ${weekdayName(summary.date)}`,
    `Next working day: ${weekdayName(context.nextWorkingDate)}`,
    `Focus minutes: ${focusMin}`,
    `Active minutes: ${activeMin}`,
    `Focus blocks: ${blocks}`,
    `Meeting minutes: ${meetings}`,
    `Peak focus hours: ${peaks}`,
    streakLine(context.streak),
    `This week average score: ${thisWeek}`,
    `Last week average score: ${lastWeek}`,
    `Week-over-week change: ${wow}`,
  ].join('\n');
}
