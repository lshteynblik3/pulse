import { describe, expect, it } from 'vitest';
import type { Category, DailySummary, WorkSchedule } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import {
  computeTeamAggregate,
  K_ANON_FLOOR,
  SUPPRESSED_MESSAGE,
  type MemberWindow,
} from './aggregate';
import { buildScoredDays, computeWeekSummary } from '../dashboard/compute';

const TEAM = 'team-1';
const DATE = '2026-06-18'; // Thursday; window 2026-06-12..18 (Sat 13 / Sun 14 off)

const ZERO_BREAKDOWN: Record<Category, number> = {
  development: 0,
  communication: 0,
  creative: 0,
  admin: 0,
  browser: 0,
  entertainment: 0,
  other: 0,
};

/** A scorable working-day summary: mostly-focused so the day clears the streak threshold. */
function summary(date: string, overrides: Partial<DailySummary> = {}): DailySummary {
  const hourly = Array.from({ length: 24 }, () => 0);
  hourly[10] = 55;
  hourly[14] = 50;
  return {
    userId: 'u',
    date,
    activeMinutes: 240,
    focusMinutes: 210,
    meetingMinutes: 0,
    categoryBreakdown: { ...ZERO_BREAKDOWN, development: 210, communication: 30 },
    focusBlockCount: 4,
    focusBlockMinutes: 180,
    hourlyFocusMinutes: hourly,
    tasksCompleted: 0,
    agentVersion: 'test',
    ...overrides,
  };
}

function member(summaries: DailySummary[], schedule: WorkSchedule = DEFAULT_SCHEDULE): MemberWindow {
  return { summaries, schedule };
}

describe('computeTeamAggregate — k-anonymity floor', () => {
  it('K_ANON_FLOOR is the fixed constant 3', () => {
    expect(K_ANON_FLOOR).toBe(3);
  });

  it('≥3 reporting members → populated, with the averages present', () => {
    const members = [member([summary(DATE)]), member([summary(DATE)]), member([summary(DATE)])];
    const result = computeTeamAggregate(members, TEAM, DATE);

    expect(result.state).toBe('populated');
    if (result.state !== 'populated') return;
    expect(result.reportingMembers).toBe(3);
    expect(result.window).toEqual({ start: '2026-06-12', end: DATE });

    // avgFocusScore equals a single member's week score (members are identical), so
    // the averaging is proven against the real scoring engine, not a magic number.
    const oneWeek = computeWeekSummary(
      [summary(DATE)],
      buildScoredDays([summary(DATE)], DEFAULT_SCHEDULE, DATE),
      DEFAULT_SCHEDULE,
      DATE,
    );
    expect(result.avgFocusScore).toBe(oneWeek.score);
    // A focused working day is on a streak.
    expect(result.activeStreakCount).toBe(3);
  });

  it('avgMeetingMinutes is POOLED (sum/days), not a mean of per-member averages', () => {
    // A: 2 window days, 60 + 0 meeting min. B: 1 day, 30. C: 1 day, 0.
    // Pooled = (60+0+30+0) / (2+1+1) = 22.5. Mean-of-means would be 20 — distinct.
    const a = member([
      summary('2026-06-17', { meetingMinutes: 60 }),
      summary(DATE, { meetingMinutes: 0 }),
    ]);
    const b = member([summary(DATE, { meetingMinutes: 30 })]);
    const c = member([summary(DATE, { meetingMinutes: 0 })]);
    const result = computeTeamAggregate([a, b, c], TEAM, DATE);

    expect(result.state).toBe('populated');
    if (result.state !== 'populated') return;
    expect(result.avgMeetingMinutes).toBe(22.5);
  });

  it('exactly 3 reporting (the boundary) → populated', () => {
    const members = [member([summary(DATE)]), member([summary(DATE)]), member([summary(DATE)])];
    expect(computeTeamAggregate(members, TEAM, DATE).state).toBe('populated');
  });

  it('<3 reporting → suppressed: the RULE message, and NO count fields exist', () => {
    const members = [member([summary(DATE)]), member([summary(DATE)])];
    const result = computeTeamAggregate(members, TEAM, DATE);

    expect(result.state).toBe('suppressed');
    if (result.state !== 'suppressed') return;
    expect(result.message).toBe(SUPPRESSED_MESSAGE);
    // The averages and the live count must not exist as values anywhere.
    expect(result).not.toHaveProperty('reportingMembers');
    expect(result).not.toHaveProperty('avgFocusScore');
    expect(result).not.toHaveProperty('avgMeetingMinutes');
    expect(result).not.toHaveProperty('activeStreakCount');
    // The window + ids are safe to echo.
    expect(result.window).toEqual({ start: '2026-06-12', end: DATE });
  });

  it('the floor counts REPORTING members, not enrolled headcount', () => {
    // 5 enrolled; 3 have NO summary in the window (empty, or older than start);
    // only 2 reported → suppressed despite a 5-person roster.
    const reportedA = member([summary(DATE)]);
    const reportedB = member([summary('2026-06-16')]);
    const empty = member([]);
    const stale = member([summary('2026-06-01')]); // before the window start
    const alsoStale = member([summary('2026-05-20')]);
    const result = computeTeamAggregate([reportedA, reportedB, empty, stale, alsoStale], TEAM, DATE);
    expect(result.state).toBe('suppressed');
  });

  it('a reporting-but-unscorable member (only a non-working day) counts toward the floor but contributes null to avgFocusScore', () => {
    // Two scorable members + one whose only window data is Sunday 2026-06-14.
    const scorable1 = member([summary(DATE)]);
    const scorable2 = member([summary(DATE)]);
    const sundayOnly = member([summary('2026-06-14')]); // non-working → week.score null
    const result = computeTeamAggregate([scorable1, scorable2, sundayOnly], TEAM, DATE);

    expect(result.state).toBe('populated');
    if (result.state !== 'populated') return;
    // All three counted for the floor…
    expect(result.reportingMembers).toBe(3);
    // …but avgFocusScore is the mean over the 2 SCORABLE members only (identical →
    // equals that single value), the Sunday-only member excluded as null.
    const oneWeek = computeWeekSummary(
      [summary(DATE)],
      buildScoredDays([summary(DATE)], DEFAULT_SCHEDULE, DATE),
      DEFAULT_SCHEDULE,
      DATE,
    );
    expect(result.avgFocusScore).toBe(oneWeek.score);
  });
});
