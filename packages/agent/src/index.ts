// Throwaway import to prove the agent can consume the shared contract.
// Real agent code arrives in Phase 1.
import type { ActivityEvent, DailySummary } from '@pulse/shared';

const _exampleEvent: ActivityEvent = {
  appName: 'Visual Studio Code',
  category: 'development',
  startedAt: '2026-06-07T14:00:00.000Z',
  endedAt: '2026-06-07T14:25:00.000Z',
  idle: false,
};

const _exampleSummary: DailySummary = {
  userId: 'demo-user',
  date: '2026-06-07',
  activeMinutes: 25,
  focusMinutes: 25,
  meetingMinutes: 0,
  categoryBreakdown: {
    development: 25,
    communication: 0,
    creative: 0,
    admin: 0,
    browser: 0,
    other: 0,
  },
  focusBlockCount: 1,
  focusBlockMinutes: 25,
  hourlyFocusMinutes: Array(24).fill(0),
  tasksCompleted: 0,
  agentVersion: '0.0.0',
};

export { _exampleEvent, _exampleSummary };
