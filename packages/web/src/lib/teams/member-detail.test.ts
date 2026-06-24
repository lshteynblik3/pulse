import { describe, expect, it } from 'vitest';
import type { Category, DailySummary } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { buildMemberDetail, type MemberDetailInput } from './member-detail';
import { scoreDay } from '../dashboard/compute';
import { addDays } from '../../../lib/scoring/date-utils';

const DATE = '2026-06-18'; // Thursday (working)
const SUNDAY = '2026-06-14'; // non-working

const ZERO: Record<Category, number> = {
  development: 0,
  communication: 0,
  creative: 0,
  admin: 0,
  browser: 0,
  entertainment: 0,
  other: 0,
};

function mk(date: string, { focus = 285, block = 240 }: Partial<{ focus: number; block: number }> = {}): DailySummary {
  const hourly = Array.from({ length: 24 }, () => 0);
  hourly[10] = 55;
  return {
    userId: 'u',
    date,
    activeMinutes: 300,
    focusMinutes: focus,
    meetingMinutes: 0,
    categoryBreakdown: { ...ZERO, development: focus },
    focusBlockCount: 5,
    focusBlockMinutes: block,
    hourlyFocusMinutes: hourly,
    tasksCompleted: 3,
    agentVersion: 'test',
  };
}

const input = (summaries: DailySummary[]): MemberDetailInput => ({ name: 'Alice', summaries, schedule: DEFAULT_SCHEDULE });

describe('buildMemberDetail', () => {
  it('reproduces the employee OWN scoreDay numbers (no parallel computation)', () => {
    const summaries = [mk(DATE)];
    const detail = buildMemberDetail(input(summaries), DATE);
    const own = scoreDay(mk(DATE), summaries, DEFAULT_SCHEDULE);

    expect(detail.score).toBe(own.score);
    expect(detail.breakdown).toEqual(own.breakdown);
    expect(detail.hasData).toBe(true);
    expect(detail.isWorkingDay).toBe(true);
    // displayScore is the /130 of the same raw score.
    expect(detail.displayScore).toBe(Math.min(130, Math.round(own.score * 1.3)));
  });

  it('exposes focus detail field-by-field — NO categoryBreakdown / tasksCompleted leak', () => {
    const detail = buildMemberDetail(input([mk(DATE)]), DATE);
    expect(detail.focus).toEqual({
      focusMinutes: 285,
      focusBlockCount: 5,
      focusBlockMinutes: 240,
      hourlyFocusMinutes: expect.any(Array),
    });
    // The payload (and its focus block) must not carry raw-activity-adjacent fields.
    expect(JSON.stringify(detail)).not.toContain('categoryBreakdown');
    expect(JSON.stringify(detail)).not.toContain('tasksCompleted');
    // And never a coaching/insights field.
    expect(detail).not.toHaveProperty('insights');
  });

  it('shows NO score on a non-working day, but still shows the focus shape if worked', () => {
    const detail = buildMemberDetail(input([mk(SUNDAY)]), SUNDAY);
    expect(detail.isWorkingDay).toBe(false);
    expect(detail.score).toBeNull();
    expect(detail.displayScore).toBeNull();
    expect(detail.breakdown).toBeNull();
    expect(detail.focus).not.toBeNull(); // a worked day off still shows the work
  });

  it('a no-data day is a calm empty payload, never a fabricated zero', () => {
    const detail = buildMemberDetail(input([]), DATE);
    expect(detail.hasData).toBe(false);
    expect(detail.score).toBeNull();
    expect(detail.focus).toBeNull();
    expect(detail.strengths).toEqual([]);
  });

  it('strengths are positive-only: a streak surfaces as a strength, never a critique', () => {
    // 5 consecutive working days → a 5-day streak event from the recognition engine.
    const summaries = [mk('2026-06-12'), mk('2026-06-15'), mk('2026-06-16'), mk('2026-06-17'), mk(DATE)];
    const detail = buildMemberDetail(input(summaries), DATE);
    expect(detail.strengths.some((s) => /streak/i.test(s))).toBe(true);
    // Nothing corrective ever appears.
    expect(detail.strengths.join(' ')).not.toMatch(/should|try to|improve|reduce|too many|low/i);
  });

  it('falls back to the strongest component when there is a score but no notable event', () => {
    // A single high working day: no streak/best/strong-week milestone, but a score → one component strength.
    const detail = buildMemberDetail(input([mk(DATE)]), DATE);
    expect(detail.strengths).toHaveLength(1);
    expect(detail.strengths[0]!.length).toBeGreaterThan(0);
  });
});
