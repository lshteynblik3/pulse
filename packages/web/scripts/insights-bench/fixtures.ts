/**
 * insights-bench — six DELIBERATELY UGLY fixtures, contract-shaped.
 *
 * The point of the bench is the hard cases, not a good day. Each fixture pairs a
 * contract `DailySummary` (today) with a `BenchContext` of 30-day/trend
 * aggregates. Absence is encoded structurally: a field that means "no data" is
 * null/empty here, and prompt.ts renders it in plain words ("none yet", "not
 * enough data yet") rather than a misleading 0. That's load-bearing for the
 * thin-data fixtures (new-user, near-zero) — read those raw outputs closely.
 *
 * The aggregates are HAND-AUTHORED (we don't wire in web/lib/scoring) so the
 * bench stays standalone; faithful contract shapes are what matter here.
 */

import type { Category, DailySummary, PeakHour, Streak } from '@pulse/shared';

/** 30-day / trend context for one fixture. null/empty fields => rendered as words. */
export interface BenchContext {
  /** Active streak, or null when there's no history at all. */
  streak: Streak | null;
  /** For a just-broken streak: the length (in days) that ended. Grounds the "streak" insight. */
  priorStreakDays?: number;
  /** Avg working-day score this week, or null when there's no baseline yet. */
  thisWeekAvg: number | null;
  /** Avg working-day score last week, or null when there's no baseline yet. */
  lastWeekAvg: number | null;
  /** Top focus hours over the window; empty when there isn't enough history. */
  peakHours: PeakHour[];
}

export interface BenchFixture {
  key: string;
  label: string;
  summary: DailySummary;
  context: BenchContext;
}

const DATE = '2026-06-15';
const USER = 'bench-user';
const AGENT = '0.5.0-bench';

/** Build a 24-length hourly-focus array from a sparse {hour: minutes} map. */
function hours(map: Record<number, number>): number[] {
  const arr = new Array<number>(24).fill(0);
  for (const [h, m] of Object.entries(map)) arr[Number(h)] = m;
  return arr;
}

/** Fill in every Category (0 default) so consumers never branch on undefined. */
function categories(partial: Partial<Record<Category, number>>): Record<Category, number> {
  return {
    development: 0,
    communication: 0,
    creative: 0,
    admin: 0,
    browser: 0,
    entertainment: 0,
    other: 0,
    ...partial,
  };
}

export const FIXTURES: BenchFixture[] = [
  {
    key: 'normal-productive',
    label: 'Normal productive day',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 380,
      focusMinutes: 250,
      meetingMinutes: 60,
      categoryBreakdown: categories({ development: 180, communication: 40, browser: 20, admin: 10 }),
      focusBlockCount: 4,
      focusBlockMinutes: 170,
      hourlyFocusMinutes: hours({ 9: 48, 10: 42, 11: 35, 14: 30, 15: 25, 16: 20 }),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      streak: { count: 8, endedOn: null, endReason: 'active' },
      thisWeekAvg: 78,
      lastWeekAvg: 72,
      peakHours: [
        { hour: 9, focusMinutes: 48 },
        { hour: 10, focusMinutes: 42 },
        { hour: 14, focusMinutes: 30 },
      ],
    },
  },
  {
    key: 'near-zero-activity',
    label: 'Near-zero-activity day (established user, very quiet day)',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 8,
      focusMinutes: 0,
      meetingMinutes: 0,
      categoryBreakdown: categories({ other: 8 }),
      focusBlockCount: 0,
      focusBlockMinutes: 0,
      hourlyFocusMinutes: hours({}),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      // History exists (established user); today simply hasn't broken the run yet.
      streak: { count: 5, endedOn: null, endReason: 'active' },
      thisWeekAvg: 66,
      lastWeekAvg: 70,
      peakHours: [
        { hour: 9, focusMinutes: 30 },
        { hour: 11, focusMinutes: 25 },
      ],
    },
  },
  {
    key: 'brand-new-user',
    label: 'Brand-new user (no 30-day baseline)',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 45,
      focusMinutes: 25,
      meetingMinutes: 0,
      categoryBreakdown: categories({ development: 25, browser: 20 }),
      focusBlockCount: 0,
      focusBlockMinutes: 0,
      hourlyFocusMinutes: hours({ 14: 15, 15: 10 }),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      // Nothing to compare against yet — every history-derived field is absent.
      streak: null,
      thisWeekAvg: null,
      lastWeekAvg: null,
      peakHours: [],
    },
  },
  {
    key: 'just-broken-streak',
    label: 'Just-broken streak (a long run ended today)',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 300,
      focusMinutes: 95,
      meetingMinutes: 90,
      categoryBreakdown: categories({ communication: 120, admin: 80, browser: 60, development: 40 }),
      focusBlockCount: 1,
      focusBlockMinutes: 28,
      hourlyFocusMinutes: hours({ 10: 18, 13: 12, 16: 10 }),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      streak: { count: 0, endedOn: DATE, endReason: 'low_score' },
      priorStreakDays: 11,
      thisWeekAvg: 58,
      lastWeekAvg: 75,
      peakHours: [
        { hour: 10, focusMinutes: 35 },
        { hour: 13, focusMinutes: 30 },
      ],
    },
  },
  {
    key: 'long-perfect-streak',
    label: 'Long perfect streak (strong day)',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 410,
      focusMinutes: 300,
      meetingMinutes: 30,
      categoryBreakdown: categories({ development: 240, creative: 40, communication: 20 }),
      focusBlockCount: 5,
      focusBlockMinutes: 205,
      hourlyFocusMinutes: hours({ 9: 55, 10: 50, 11: 40, 14: 35, 15: 30, 16: 25 }),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      streak: { count: 23, endedOn: null, endReason: 'active' },
      thisWeekAvg: 88,
      lastWeekAvg: 85,
      peakHours: [
        { hour: 9, focusMinutes: 55 },
        { hour: 10, focusMinutes: 50 },
        { hour: 11, focusMinutes: 40 },
      ],
    },
  },
  {
    key: 'five-hour-meeting-day',
    label: 'Five-hour-meeting day',
    summary: {
      userId: USER,
      date: DATE,
      activeMinutes: 360,
      focusMinutes: 120,
      meetingMinutes: 300,
      categoryBreakdown: categories({ communication: 300, development: 40, admin: 20 }),
      focusBlockCount: 0,
      focusBlockMinutes: 0,
      hourlyFocusMinutes: hours({ 8: 25, 12: 20, 16: 20 }),
      tasksCompleted: 0,
      agentVersion: AGENT,
    },
    context: {
      streak: { count: 4, endedOn: null, endReason: 'active' },
      thisWeekAvg: 70,
      lastWeekAvg: 72,
      peakHours: [
        { hour: 8, focusMinutes: 25 },
        { hour: 16, focusMinutes: 20 },
      ],
    },
  },
];
