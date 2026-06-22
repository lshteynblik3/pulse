/**
 * Team aggregate — Phase 6 commit 2. PURE and unit-tested: the route does all the
 * I/O (auth, the manages gate, fetching each member's window + schedule) and hands
 * the per-member data here; this module computes team-level numbers only and
 * applies the k-anonymity floor. No I/O, no clock — `date` is the manager's
 * client-local day, passed through like the dashboard.
 *
 * It reuses the SAME compute-on-read scoring the personal dashboard uses
 * (buildScoredDays + computeWeekSummary + currentStreak) — never a parallel
 * formula — so a team average can't drift from the per-user numbers it summarises.
 *
 * PRIVACY: the result carries ONLY team-level scalars. No member id, no member
 * score, no per-member array ever appears in the returned object — the endpoint
 * exposes aggregates, never an individual's row.
 */

import type { DailySummary, WorkSchedule } from '@pulse/shared';
import { buildScoredDays, computeWeekSummary, WEEK_WINDOW_DAYS } from '../dashboard/compute';
// currentStreak is imported straight from scoring (like compute.ts does for its
// scoring imports) — the streak engine isn't re-exported through compute.ts.
import { currentStreak } from '../../../lib/scoring';
import { addDays } from '../../../lib/scoring/date-utils';

/**
 * K-ANONYMITY FLOOR. A FIXED system constant — deliberately NOT a setting, a
 * request parameter, or a team-/manager-configurable value. The whole point of
 * the floor is to protect members from the manager; if the manager (or anything
 * they control) could lower it, it would protect no one. Below this many
 * *reporting* members, the team view is suppressed rather than shown. Three is the
 * smallest group in which a single member's numbers aren't trivially isolable from
 * the average.
 */
export const K_ANON_FLOOR = 3;

/** The one suppressed-state message. States the RULE; never the live count. */
export const SUPPRESSED_MESSAGE =
  'Team averages need at least 3 reporting members to display.';

/** One enrolled team member's window of data, as the route fetched it. */
export interface MemberWindow {
  /**
   * The member's daily summaries over the dashboard FETCH window (122 days ending
   * on `date`), so each scored day gets a full median lookback. Only the trailing
   * 7 days feed the team aggregate, but scoring needs the longer history.
   */
  summaries: DailySummary[];
  /** The member's work schedule (DEFAULT_SCHEDULE if they never set one). */
  schedule: WorkSchedule;
}

export interface TeamWindow {
  /** First day of the rolling window (`end` − 6) and the last (the viewed day). */
  start: string;
  end: string;
}

/** Aggregates shown — present ONLY in the populated branch (see the invariant). */
export interface TeamAggregatePopulated {
  state: 'populated';
  teamId: string;
  date: string;
  window: TeamWindow;
  /** Members who reported in the window — ≥ K_ANON_FLOOR, the ONLY count exposed. */
  reportingMembers: number;
  /** Mean of reporting members' week focus scores (raw 0–100); null if none scorable. */
  avgFocusScore: number | null;
  /** Pooled avg daily meeting minutes across reporting members; null if no data. */
  avgMeetingMinutes: number | null;
  /** How many reporting members are currently on a streak. A count, no member named. */
  activeStreakCount: number;
}

/** The suppressed answer: the rule only — NO count, no aggregate value anywhere. */
export interface TeamAggregateSuppressed {
  state: 'suppressed';
  teamId: string;
  date: string;
  window: TeamWindow;
  message: string;
}

export type TeamAggregateResult = TeamAggregatePopulated | TeamAggregateSuppressed;

/**
 * Compute the team aggregate for the rolling 7-day window ending on `date`.
 *
 * STRUCTURAL INVARIANT (load-bearing for privacy): the reporting-member count is
 * computed FIRST, then we branch. Every average is computed ONLY inside the
 * populated branch, AFTER the floor passed. On the suppressed branch no average is
 * ever computed and none appears in the returned object — a below-floor team's
 * numbers never exist as a value, not even to be discarded later. This is why the
 * floor is enforced here in the pure core, not stripped at the route.
 */
export function computeTeamAggregate(
  members: MemberWindow[],
  teamId: string,
  date: string,
): TeamAggregateResult {
  const window: TeamWindow = { start: addDays(date, -(WEEK_WINDOW_DAYS - 1)), end: date };
  const inWindow = (d: string) => d >= window.start && d <= window.end;

  // Reporting = at least one daily_summary in the window. Keyed off who REPORTED,
  // never enrolled headcount — a 5-person team where 2 reported is still below
  // the floor. Computed FIRST, before any average.
  const reporting = members.filter((m) => m.summaries.some((s) => inWindow(s.date)));
  const reportingMembers = reporting.length;

  if (reportingMembers < K_ANON_FLOOR) {
    // Suppressed. NOTHING below the floor is computed past this line: no average,
    // no count in the payload. One message regardless of whether the shortfall is
    // transient (few reported) or structural (team < 3) — distinguishing them
    // would leak headcount by inference.
    return { state: 'suppressed', teamId, date, window, message: SUPPRESSED_MESSAGE };
  }

  // ── Populated branch: averages are computed ONLY here, after the floor. ──
  let focusScoreSum = 0;
  let focusScoreCount = 0; // members with a scorable working day in the window
  let meetingMinutesTotal = 0;
  let memberDaysWithData = 0; // pooled denominator for avg meeting minutes
  let activeStreakCount = 0;

  for (const m of reporting) {
    const scoredDays = buildScoredDays(m.summaries, m.schedule, date);

    // Week focus score = the SAME working-days-with-data average the dashboard's
    // week view shows. null when the member's only window data is non-working.
    const week = computeWeekSummary(m.summaries, scoredDays, m.schedule, date);
    if (week.score !== null) {
      focusScoreSum += week.score;
      focusScoreCount += 1;
    }

    // POOLED meeting load: sum minutes and days across ALL reporting members, then
    // divide once — NOT a mean of per-member averages. A member with more tracked
    // days weighs proportionally, which is the honest team-wide daily average.
    for (const s of m.summaries) {
      if (inWindow(s.date)) {
        meetingMinutesTotal += s.meetingMinutes;
        memberDaysWithData += 1;
      }
    }

    if (currentStreak(scoredDays, date, m.schedule).count > 0) activeStreakCount += 1;
  }

  return {
    state: 'populated',
    teamId,
    date,
    window,
    reportingMembers,
    avgFocusScore: focusScoreCount > 0 ? focusScoreSum / focusScoreCount : null,
    avgMeetingMinutes: memberDaysWithData > 0 ? meetingMinutesTotal / memberDaysWithData : null,
    activeStreakCount,
  };
}
