import { describe, it, expect } from 'vitest';
import type { Category, DailySummary } from '@pulse/shared';
import { buildInsightsUserMessage, type InsightContext } from './prompt';
import { insightsSchema } from './schema';

function categories(partial: Partial<Record<Category, number>> = {}): Record<Category, number> {
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

function summary(overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    userId: 'u1',
    date: '2026-06-15',
    activeMinutes: 380,
    focusMinutes: 250,
    meetingMinutes: 60,
    categoryBreakdown: categories({ development: 180 }),
    focusBlockCount: 4,
    focusBlockMinutes: 170,
    hourlyFocusMinutes: new Array(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 'test',
    ...overrides,
  };
}

describe('buildInsightsUserMessage', () => {
  it('renders a normal day in the benched labelled-line format (12-hour am/pm)', () => {
    const context: InsightContext = {
      peakHours: [
        { hour: 9, focusMinutes: 48 },
        { hour: 10, focusMinutes: 42 },
        { hour: 14, focusMinutes: 30 },
      ],
      streak: { count: 8, endedOn: null, endReason: 'active' },
      thisWeekAvg: 78,
      lastWeekAvg: 72,
      nextWorkingDate: '2026-06-16', // Tuesday (coached day 2026-06-15 is Monday)
    };

    const rendered = buildInsightsUserMessage(summary(), context);
    expect(rendered).toBe(
      [
        'Day coached: Monday',
        'Next working day: Tuesday',
        'Focus minutes: 250',
        'Active minutes: 380',
        'Focus blocks: 4 blocks, 170 minutes total',
        'Meeting minutes: 60',
        'Peak focus hours: 9am (48 min), 10am (42 min), 2pm (30 min)',
        'Current streak: 8 working days (active)',
        'This week average score: 78',
        'Last week average score: 72',
        'Week-over-week change: +6',
      ].join('\n'),
    );
    // Weekday names present, ISO "(working day)" date line gone.
    expect(rendered).toContain('Day coached: Monday');
    expect(rendered).toContain('Next working day: Tuesday');
    expect(rendered).not.toContain('(working day)');
    expect(rendered).not.toContain('2026-06-15');
  });

  it('spells absence in words on a thin-data day (no zeros leaking as real lows)', () => {
    const context: InsightContext = {
      peakHours: [],
      streak: { count: 0, endedOn: null, endReason: 'no_history' },
      thisWeekAvg: null,
      lastWeekAvg: null,
      nextWorkingDate: '2026-06-16',
    };
    const msg = buildInsightsUserMessage(
      summary({ activeMinutes: 0, focusMinutes: 0, meetingMinutes: 0, focusBlockCount: 0, focusBlockMinutes: 0 }),
      context,
    );

    expect(msg).toContain('Focus minutes: none — no focused time tracked today');
    expect(msg).toContain('Active minutes: none — almost no activity tracked today');
    expect(msg).toContain('Focus blocks: none — no 25-minute deep-work blocks today');
    expect(msg).toContain('Meeting minutes: none');
    expect(msg).toContain('Peak focus hours: not enough data yet');
    expect(msg).toContain('Current streak: none yet');
    expect(msg).toContain('This week average score: not enough data yet');
    expect(msg).toContain('Last week average score: not enough data yet');
    expect(msg).toContain('Week-over-week change: not enough data yet');
  });

  it('renders a just-broken streak with its end date and reason, no scolding', () => {
    const context: InsightContext = {
      peakHours: [{ hour: 16, focusMinutes: 20 }],
      streak: { count: 0, endedOn: '2026-06-15', endReason: 'low_score' },
      thisWeekAvg: 58,
      lastWeekAvg: 75,
      nextWorkingDate: '2026-06-16',
    };
    const msg = buildInsightsUserMessage(summary(), context);
    expect(msg).toContain('Current streak: none right now — a streak ended on 2026-06-15 after a low-scoring day');
    expect(msg).toContain('Peak focus hours: 4pm (20 min)');
    expect(msg).toContain('Week-over-week change: -17');
  });
});

describe('insightsSchema', () => {
  const valid = (n: 2 | 3) => ({
    insights: Array.from({ length: n }, (_, i) => ({
      type: (['peak-window', 'meeting-load', 'streak'] as const)[i % 3],
      title: 'Your mornings are sharp',
      body: 'You logged your deepest focus before noon — try protecting that window tomorrow.',
    })),
  });

  it('accepts 2 and 3 insights of valid types', () => {
    expect(insightsSchema.safeParse(valid(2)).success).toBe(true);
    expect(insightsSchema.safeParse(valid(3)).success).toBe(true);
  });

  it('rejects an unknown type (consistency was dropped)', () => {
    const bad = { insights: [{ ...valid(2).insights[0], type: 'consistency' }, valid(2).insights[1]] };
    expect(insightsSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects out-of-bounds counts (1 or 4 insights)', () => {
    expect(insightsSchema.safeParse({ insights: valid(2).insights.slice(0, 1) }).success).toBe(false);
    expect(insightsSchema.safeParse({ insights: valid(3).insights.concat(valid(3).insights) }).success).toBe(false);
  });

  it('rejects title/body length violations and unknown keys', () => {
    expect(insightsSchema.safeParse({ insights: [{ ...valid(2).insights[0], title: 'ok' }, valid(2).insights[1]] }).success).toBe(false);
    expect(insightsSchema.safeParse({ insights: [{ ...valid(2).insights[0], body: 'too short' }, valid(2).insights[1]] }).success).toBe(false);
    expect(insightsSchema.safeParse({ insights: [{ ...valid(2).insights[0], extra: 1 }, valid(2).insights[1]] }).success).toBe(false);
  });
});
