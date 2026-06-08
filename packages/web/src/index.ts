// Throwaway import to prove the web app can consume the shared contract.
// Real Next.js app arrives in Phase 1.
import type { DailySummary } from '@pulse/shared';

const _exampleSummary: DailySummary = {
  userId: 'demo-user',
  date: '2026-06-07',
  activeMinutes: 190,
  focusMinutes: 120,
  meetingMinutes: 45,
  categoryBreakdown: {
    development: 120,
    communication: 30,
    creative: 0,
    admin: 15,
    browser: 20,
    other: 5,
  },
  focusBlockCount: 3,
  focusBlockMinutes: 90,
  hourlyFocusMinutes: Array(24).fill(0),
  tasksCompleted: 4,
  agentVersion: '0.0.0',
};

export { _exampleSummary };
