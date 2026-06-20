import { describe, it, expect } from 'vitest';
import type { Category, DailySummary, Streak } from '@pulse/shared';
import { computedTips, type ComputedTipsInput } from './computed-tips';
import { insightsSchema, INSIGHT_TYPES } from './schema';

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

const active = (count: number): Streak => ({ count, endedOn: null, endReason: 'active' });

/** Every computedTips result must be schema-valid, 2–3 long, three-type only. */
function assertValid(result: ReturnType<typeof computedTips>) {
  expect(insightsSchema.safeParse({ insights: result }).success).toBe(true);
  expect(result.length).toBeGreaterThanOrEqual(2);
  expect(result.length).toBeLessThanOrEqual(3);
  for (const ins of result) expect(INSIGHT_TYPES).toContain(ins.type);
  // consistency was dropped — it must never appear.
  expect(result.some((i) => (i.type as string) === 'consistency')).toBe(false);
}

// 2026-06-15 is a Monday; its next working day 2026-06-16 is a Tuesday.
const DAYS = { coachedDate: '2026-06-15', nextWorkingDate: '2026-06-16' };
const RELATIVE = /\b(today|tomorrow|yesterday)\b/i;

describe('computedTips — always schema-valid', () => {
  it('normal day: peak + streak + meeting, each grounded in a real number', () => {
    const input: ComputedTipsInput = {
      summary: summary({ meetingMinutes: 60 }),
      peakHours: [
        { hour: 9, focusMinutes: 48 },
        { hour: 10, focusMinutes: 42 },
      ],
      streak: active(8),
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((i) => i.type))).toEqual(new Set(['peak-window', 'streak', 'meeting-load']));
    expect(result.find((i) => i.type === 'peak-window')!.body).toContain('9am');
    expect(result.find((i) => i.type === 'meeting-load')!.body).toContain('60');
    expect(result.find((i) => i.type === 'streak')!.body).toContain('8');
  });

  it('brand-new user: no peaks, no streak history — two valid tips, no invented pattern', () => {
    const input: ComputedTipsInput = {
      summary: summary({ activeMinutes: 45, focusMinutes: 25, meetingMinutes: 0, focusBlockCount: 0, focusBlockMinutes: 0 }),
      peakHours: [],
      streak: { count: 0, endedOn: null, endReason: 'no_history' },
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    expect(result).toHaveLength(2);
    expect(result.some((i) => i.type === 'peak-window')).toBe(false); // no peak data to cite
    expect(result.find((i) => i.type === 'streak')!.title).toBe('Your streak starts now');
    expect(result.find((i) => i.type === 'meeting-load')!.title).toBe('A clear calendar');
  });

  it('near-zero-activity day: zeros do not become punitive — two valid tips', () => {
    const input: ComputedTipsInput = {
      summary: summary({ activeMinutes: 8, focusMinutes: 0, meetingMinutes: 0, focusBlockCount: 0, focusBlockMinutes: 0 }),
      peakHours: [],
      streak: active(5),
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    expect(result).toHaveLength(2);
  });

  it('just-broken streak: supportive fresh-start tip that names the day (no ISO date)', () => {
    const input: ComputedTipsInput = {
      summary: summary({ meetingMinutes: 90 }),
      peakHours: [{ hour: 10, focusMinutes: 35 }],
      streak: { count: 0, endedOn: '2026-06-15', endReason: 'low_score' },
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    const streakTip = result.find((i) => i.type === 'streak')!;
    expect(streakTip.title).toBe('A fresh start');
    expect(streakTip.body).toContain('Monday'); // coached weekday, not a raw ISO date
    expect(streakTip.body).not.toContain('2026-06-15');
    expect(streakTip.body).not.toMatch(RELATIVE);
  });

  it('no-data day (null summary): still two valid tips, honest about the absence', () => {
    const input: ComputedTipsInput = {
      summary: null,
      peakHours: [],
      streak: { count: 0, endedOn: null, endReason: 'no_history' },
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.type)).toEqual(['streak', 'peak-window']);
    expect(result.find((i) => i.type === 'peak-window')!.title).toBe('More to come');
  });

  it('heavy meeting day: caps and stays supportive', () => {
    const input: ComputedTipsInput = {
      summary: summary({ meetingMinutes: 300 }),
      peakHours: [{ hour: 8, focusMinutes: 25 }],
      streak: active(4),
      ...DAYS,
    };
    const result = computedTips(input);
    assertValid(result);
    expect(result.find((i) => i.type === 'meeting-load')!.body).toContain('300');
  });
});

describe('computedTips — no relative time words (deterministic gate, independent of the bench)', () => {
  // Every branch: peak present; meeting 0 / <120 / 120-239 / >=240; streak
  // active>=2 / active==1 / active==0 / low_score / missing_data / no_history;
  // and the null-summary path.
  const cases: ComputedTipsInput[] = [
    { summary: summary({ meetingMinutes: 60 }), peakHours: [{ hour: 9, focusMinutes: 48 }], streak: active(8), ...DAYS },
    { summary: summary({ meetingMinutes: 0 }), peakHours: [], streak: active(0), ...DAYS },
    { summary: summary({ meetingMinutes: 150 }), peakHours: [], streak: { count: 1, endedOn: null, endReason: 'active' }, ...DAYS },
    { summary: summary({ meetingMinutes: 300 }), peakHours: [{ hour: 8, focusMinutes: 25 }], streak: active(4), ...DAYS },
    { summary: summary({ meetingMinutes: 90 }), peakHours: [], streak: { count: 0, endedOn: '2026-06-15', endReason: 'low_score' }, ...DAYS },
    { summary: summary({ meetingMinutes: 0 }), peakHours: [], streak: { count: 0, endedOn: '2026-06-15', endReason: 'missing_data' }, ...DAYS },
    { summary: null, peakHours: [], streak: { count: 0, endedOn: null, endReason: 'no_history' }, ...DAYS },
  ];

  it('emits ZERO today/tomorrow/yesterday across every branch, including null-summary', () => {
    for (const input of cases) {
      for (const tip of computedTips(input)) {
        expect(tip.title).not.toMatch(RELATIVE);
        expect(tip.body).not.toMatch(RELATIVE);
      }
    }
  });

  it('null-summary path renders a SENSIBLE day reference (the coached weekday), not blank/broken', () => {
    const result = computedTips({
      summary: null,
      peakHours: [],
      streak: { count: 0, endedOn: null, endReason: 'no_history' },
      ...DAYS,
    });
    const gettingStarted = result.find((i) => i.title === 'More to come')!;
    expect(gettingStarted.body).toContain('Monday'); // names the coached day
    expect(gettingStarted.body).not.toMatch(RELATIVE);
    expect(gettingStarted.body).not.toContain('this day');
    expect(gettingStarted.body.length).toBeGreaterThan(20);
  });
});
