import { describe, it, expect } from 'vitest';
import type { DailySummary } from '@pulse/shared';
import { DEFAULT_SCHEDULE } from '@pulse/shared';
import { displayScore, scoreMessage } from './format';
import { buildAgentTodayPayload } from './compute';

const FRIDAY = '2026-06-12'; // working day under DEFAULT_SCHEDULE
const SATURDAY = '2026-06-13'; // non-working day

function summary(date: string): DailySummary {
  return {
    userId: 'u',
    date,
    activeMinutes: 300,
    focusMinutes: 220,
    meetingMinutes: 30,
    categoryBreakdown: {
      development: 200,
      communication: 20,
      creative: 0,
      admin: 0,
      browser: 0,
      entertainment: 0,
      other: 0,
    },
    focusBlockCount: 3,
    focusBlockMinutes: 90,
    hourlyFocusMinutes: Array(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 't',
  };
}

describe('buildAgentTodayPayload', () => {
  it('working day with data: raw score + the /130 displayScore + raw band copy', () => {
    const p = buildAgentTodayPayload([summary(FRIDAY)], DEFAULT_SCHEDULE, FRIDAY, '2026-06-12T17:00:00Z');
    expect(p.isWorkingDay).toBe(true);
    expect(p.score).not.toBeNull();
    // displayScore is applied to the raw score (not duplicated agent-side)…
    expect(p.displayScore).toBe(displayScore(p.score as number));
    // …and the band copy keys off the RAW score, never the /130 value.
    expect(p.message).toBe(scoreMessage(p.score as number));
    expect(p.lastActivityAt).toBe('2026-06-12T17:00:00Z');
  });

  it('NON-working day with data: no score, no displayScore — suppressed like the web view', () => {
    const p = buildAgentTodayPayload([summary(SATURDAY)], DEFAULT_SCHEDULE, SATURDAY, null);
    expect(p.isWorkingDay).toBe(false);
    expect(p.score).toBeNull();
    expect(p.displayScore).toBeNull();
    expect(p.message).toBeNull();
  });

  it('working day with NO data: nulls but still a working day (calm "no data" state)', () => {
    const p = buildAgentTodayPayload([], DEFAULT_SCHEDULE, FRIDAY, null);
    expect(p.isWorkingDay).toBe(true);
    expect(p.score).toBeNull();
    expect(p.displayScore).toBeNull();
    expect(p.message).toBeNull();
  });
});
