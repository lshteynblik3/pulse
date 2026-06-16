// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { DailySummary, FocusScoreResult } from '@pulse/shared';
import type { DashboardPayload, WeekSummary } from '@/lib/dashboard/compute';
import DashboardClient from './dashboard-client';

const EMPTY_WEEK: WeekSummary = {
  start: '2026-06-07',
  end: '2026-06-13',
  score: null,
  workingDaysTracked: 0,
  workingDaysInWindow: 5,
  totalFocusMinutes: 0,
  avgFocusMinutes: null,
  totalFocusBlocks: 0,
  bestDay: null,
  peakHours: [],
};

// 2026-06-13 is a Saturday — a non-working day under the default schedule.
const SATURDAY = '2026-06-13';

function daySummary(): DailySummary {
  return {
    userId: 'u',
    date: SATURDAY,
    activeMinutes: 200,
    focusMinutes: 150,
    meetingMinutes: 0,
    categoryBreakdown: {
      development: 150,
      communication: 0,
      creative: 0,
      admin: 0,
      browser: 0,
      entertainment: 0,
      other: 0,
    },
    focusBlockCount: 2,
    focusBlockMinutes: 60,
    hourlyFocusMinutes: Array(24).fill(0),
    tasksCompleted: 0,
    agentVersion: 't',
  };
}

const FOCUS: FocusScoreResult = {
  score: 72,
  breakdown: { focusRatio: 0.8, blockScore: 0.5, meetingBalance: 1, consistency: 1 },
};

function makePayload(today: DashboardPayload['today']): DashboardPayload {
  return {
    date: SATURDAY,
    today,
    peakHours: [],
    streak: { count: 0, endedOn: null, endReason: 'no_history' },
    trend: null,
    schedule: { isDefault: false },
    agent: { lastActivityAt: null },
    week: EMPTY_WEEK,
  };
}

function mockFetch(payload: DashboardPayload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DashboardClient — non-working day display', () => {
  it('non-working day with NO data shows "Not a working day" and no score', async () => {
    mockFetch(makePayload({ summary: null, focus: null, isWorkingDay: false }));
    render(<DashboardClient />);

    expect(await screen.findByText(/not a working day/i)).not.toBeNull();
    // No score hero: the "Why this score" breakdown heading must be absent.
    expect(screen.queryByText(/why this score/i)).toBeNull();
    // No activity cards either (there's no summary).
    expect(screen.queryByText('Active time')).toBeNull();
    // The stubbed affordance is present but disabled (does nothing).
    const stub = screen.getByRole('button', { name: /mark as working day/i });
    expect(stub).not.toBeNull();
    expect((stub as HTMLButtonElement).disabled).toBe(true);
  });

  it('non-working day WITH a summary shows the activity but suppresses the score', async () => {
    // focus is present in the payload (the engine still computes it) — the view
    // must still NOT render a score on a non-working day.
    mockFetch(makePayload({ summary: daySummary(), focus: FOCUS, isWorkingDay: false }));
    render(<DashboardClient />);

    expect(await screen.findByText(/worked on a day off/i)).not.toBeNull();
    // Activity IS shown (stat cards render their labels).
    expect(screen.getByText('Active time')).not.toBeNull();
    expect(screen.getByText('Focus time')).not.toBeNull();
    // …but the score is suppressed: no "Why this score" breakdown.
    expect(screen.queryByText(/why this score/i)).toBeNull();
  });

  it('a WORKING day with data still shows the score (unchanged)', async () => {
    mockFetch(makePayload({ summary: daySummary(), focus: FOCUS, isWorkingDay: true }));
    render(<DashboardClient />);

    // The score hero renders — "Why this score" breakdown is present.
    expect(await screen.findByText(/why this score/i)).not.toBeNull();
    expect(screen.queryByText(/not a working day/i)).toBeNull();
    expect(screen.queryByText(/worked on a day off/i)).toBeNull();
  });
});
