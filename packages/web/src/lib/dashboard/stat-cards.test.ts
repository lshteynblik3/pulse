import { describe, it, expect } from 'vitest';
import type { DailySummary } from '@pulse/shared';
import { buildStatCards } from './stat-cards';

const SUMMARY: DailySummary = {
  userId: 'u1',
  date: '2026-06-16',
  activeMinutes: 300,
  focusMinutes: 180,
  meetingMinutes: 60,
  categoryBreakdown: {
    development: 120,
    communication: 60,
    creative: 0,
    admin: 0,
    browser: 0,
    entertainment: 0,
    other: 0,
  },
  focusBlockCount: 3,
  focusBlockMinutes: 90,
  hourlyFocusMinutes: Array(24).fill(0),
  tasksCompleted: 7,
  agentVersion: '0.2.0',
};

describe('buildStatCards', () => {
  it('omits the Tasks card when SHOW_TASKS is off (no fake "0" stat)', () => {
    const labels = buildStatCards(SUMMARY, false).map((c) => c.label);
    expect(labels).toEqual(['Active time', 'Focus time', 'Meetings', 'Focus blocks']);
    expect(labels).not.toContain('Tasks done');
  });

  it('includes the Tasks card with the real value when SHOW_TASKS is on', () => {
    const cards = buildStatCards(SUMMARY, true);
    expect(cards.map((c) => c.label)).toContain('Tasks done');
    expect(cards.find((c) => c.label === 'Tasks done')?.value).toBe('7');
  });

  it('formats minutes (not raw numbers) for the time cards', () => {
    const byLabel = Object.fromEntries(buildStatCards(SUMMARY, false).map((c) => [c.label, c]));
    expect(byLabel['Active time']?.value).toBe('5h');
    expect(byLabel['Focus time']?.value).toBe('3h');
    expect(byLabel['Focus blocks']?.detail).toBe('1h 30m inside blocks');
  });
});
