/**
 * computedTips — the deterministic, no-LLM coaching tips.
 *
 * This is BOTH the free-tier path (no LLM in the free path — hard rule) AND the
 * per-user paid fallback when the LLM output is missing/unparseable/invalid. Pure
 * functions over already-computed data (peak hours, streak, meeting load), in the
 * scoring-engine style: no I/O, no clock, no network. Output is the SAME
 * {type,title,body} three-type shape as the LLM path and passes the SAME frozen
 * insightsSchema, so the dashboard renders both identically.
 *
 * Grounding by construction: every tip cites a real input (a peak hour, a meeting
 * minute count, a streak count/date) or is honestly about the ABSENCE of data
 * ("not enough data yet") — never invented praise. Tone mirrors the dashboard's
 * coach rule: supportive, never punitive, no red.
 */

import type { DailySummary, PeakHour, Streak, Trend } from '@pulse/shared';
import type { Insight } from './schema';
import { formatHour } from './prompt';

export interface ComputedTipsInput {
  /** The viewed day's summary; null when there's no data for that day at all. */
  summary: DailySummary | null;
  /** Top focus hours over the window; [] when there isn't enough history. */
  peakHours: PeakHour[];
  /** currentStreak's result — endReason 'no_history' means no streak yet. */
  streak: Streak;
  /**
   * Reserved. The dashboard/cron already compute the week-over-week trend, so it
   * rides along in the input, but it is NOT surfaced as a tip: there is no
   * `trend` insight type (the same reason `consistency` was dropped), and folding
   * it under another type would be ungrounded-by-type. Wire a type first.
   */
  trend?: Trend | null;
}

/** Peak-window tip — only when there's real peak data to cite. */
function peakWindowTip(peaks: PeakHour[]): Insight | null {
  const first = peaks[0];
  if (!first) return null;
  const second = peaks[1];
  const windows = second
    ? `${formatHour(first.hour)} and ${formatHour(second.hour)}`
    : formatHour(first.hour);
  return {
    type: 'peak-window',
    title: 'Your sharpest hours',
    body: `Your focus peaks around ${windows}. Try to guard that window for your most demanding work tomorrow.`,
  };
}

/** Meeting-load tip — grounded in today's real meeting minutes (0 is a real datum). */
function meetingLoadTip(summary: DailySummary): Insight {
  const m = summary.meetingMinutes;
  if (m === 0) {
    return {
      type: 'meeting-load',
      title: 'A clear calendar',
      body: 'No meetings today — a wide-open runway for focused, uninterrupted work whenever you are ready.',
    };
  }
  if (m >= 240) {
    return {
      type: 'meeting-load',
      title: 'A heavy meeting day',
      body: `You spent ${m} minutes in meetings today. On days this full, protecting even one short focus block afterward helps you reset.`,
    };
  }
  if (m >= 120) {
    return {
      type: 'meeting-load',
      title: 'A meeting-heavy stretch',
      body: `${m} minutes went to meetings today. Blocking a little quiet time around them helps keep your deep work intact.`,
    };
  }
  return {
    type: 'meeting-load',
    title: 'A balanced meeting load',
    body: `Just ${m} minutes in meetings today left plenty of room around them — a good shape for getting into deep work.`,
  };
}

/** Streak tip — always producible, grounded in the streak's count/reason/date. */
function streakTip(streak: Streak): Insight {
  switch (streak.endReason) {
    case 'active':
      if (streak.count >= 2) {
        return {
          type: 'streak',
          title: "You're on a roll",
          body: `That's ${streak.count} working days in a row above your focus bar. Keep showing up — that rhythm is what compounds.`,
        };
      }
      if (streak.count === 1) {
        return {
          type: 'streak',
          title: 'A streak in the making',
          body: 'You are one working day into a new streak. Show up again tomorrow and it starts to build.',
        };
      }
      return {
        type: 'streak',
        title: 'Ready when you are',
        body: 'No active streak yet today. A single focused working day is all it takes to start one.',
      };
    case 'low_score':
      return {
        type: 'streak',
        title: 'A fresh start',
        body: `Your streak reset${streak.endedOn ? ` on ${streak.endedOn}` : ''} — that happens to everyone. Today is a clean slate to begin a new one.`,
      };
    case 'missing_data':
      return {
        type: 'streak',
        title: 'Pick up where you left off',
        body: `A gap${streak.endedOn ? ` on ${streak.endedOn}` : ''} paused your streak. No worries — one focused working day starts a fresh one.`,
      };
    case 'no_history':
    default:
      return {
        type: 'streak',
        title: 'Your streak starts now',
        body: 'You are just getting started. String together a few focused working days and your first streak will show up here.',
      };
  }
}

/** Honest no-data filler so a day with no summary still yields two valid insights. */
function gettingStartedTip(): Insight {
  return {
    type: 'peak-window',
    title: 'More to come',
    body: 'There is no activity tracked for this day yet. Once you log some focused time, your peak hours and trends will appear here.',
  };
}

/**
 * Produce 2–3 schema-valid insights from already-computed data. Every branch
 * yields 2 or 3; the final slice caps defensively so a future tip can't overflow.
 */
export function computedTips(input: ComputedTipsInput): Insight[] {
  const { summary, peakHours, streak } = input;
  const tips: Insight[] = [];

  if (summary) {
    const peak = peakWindowTip(peakHours);
    if (peak) tips.push(peak);
    tips.push(streakTip(streak));
    tips.push(meetingLoadTip(summary));
  } else {
    // No data for the day: streak state is still meaningful; pad with an honest
    // "more to come" rather than inventing a metric.
    tips.push(streakTip(streak));
    tips.push(gettingStartedTip());
  }

  return tips.slice(0, 3);
}
