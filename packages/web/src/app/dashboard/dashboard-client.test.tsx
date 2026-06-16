// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { DashboardPayload } from '@/lib/dashboard/compute';
import DashboardClient from './dashboard-client';

// Matches REFRESH_MS in dashboard-client.tsx (the 5-min autorefresh cadence).
const REFRESH_MS = 5 * 60 * 1000;

function payloadFor(date: string): DashboardPayload {
  // summary: null keeps the render path light (EmptyHero) — these tests are
  // about WHICH date is fetched and WHEN, not the card rendering.
  return {
    date,
    today: { summary: null, focus: null, isWorkingDay: true },
    peakHours: [],
    streak: { count: 0, endedOn: null, endReason: 'no_history' },
    trend: null,
    schedule: { isDefault: false },
    agent: { lastActivityAt: null },
    // These autorefresh tests stay in Day view; an empty week satisfies the type.
    week: {
      start: date,
      end: date,
      score: null,
      workingDaysTracked: 0,
      workingDaysInWindow: 5,
      totalFocusMinutes: 0,
      avgFocusMinutes: null,
      totalFocusBlocks: 0,
      bestDay: null,
      peakHours: [],
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
let hidden = false;

function dateOfCall(i: number): string | null {
  const url = fetchMock.mock.calls[i]?.[0] as string;
  return new URL(url, 'http://localhost').searchParams.get('date');
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  fetchMock = vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(payloadFor(new URL(url, 'http://localhost').searchParams.get('date') ?? '')),
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DashboardClient autorefresh', () => {
  it('fetches the current viewed date on mount', async () => {
    render(<DashboardClient />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(dateOfCall(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await act(async () => {}); // flush the resolved fetch's state update
  });

  it('re-fetches the SAME viewed date on the 5-minute interval (never jumps to today)', async () => {
    render(<DashboardClient />);
    const first = dateOfCall(0);
    await act(async () => {
      vi.advanceTimersByTime(REFRESH_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dateOfCall(1)).toBe(first); // current view re-fetched, not a fresh "today"
  });

  it('pauses the interval while hidden and refreshes the same date on refocus', async () => {
    render(<DashboardClient />);
    const first = dateOfCall(0);

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(REFRESH_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // nothing fetched while hidden

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // one immediate refresh on refocus
    expect(dateOfCall(1)).toBe(first);
  });
});
