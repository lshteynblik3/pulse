import type { DailySummary } from '@pulse/shared';
import { formatMinutes } from './format';

/** One stat card on the dashboard. Formatting is the UI's job, done here. */
export interface StatCard {
  label: string;
  value: string;
  detail?: string;
}

/**
 * The day's stat cards. Pure (no React) so the visibility logic is unit-tested
 * directly. `showTasks` gates the "Tasks done" card — see lib/flags SHOW_TASKS:
 * tasksCompleted has no real source until Phase 7, so a "0" card reads as
 * failure. The DailySummary field is untouched; this only chooses what to show.
 */
export function buildStatCards(summary: DailySummary, showTasks: boolean): StatCard[] {
  const cards: StatCard[] = [
    { label: 'Active time', value: formatMinutes(summary.activeMinutes) },
    { label: 'Focus time', value: formatMinutes(summary.focusMinutes) },
    { label: 'Meetings', value: formatMinutes(summary.meetingMinutes) },
    {
      label: 'Focus blocks',
      value: String(summary.focusBlockCount),
      detail: `${formatMinutes(summary.focusBlockMinutes)} inside blocks`,
    },
  ];
  if (showTasks) {
    cards.push({ label: 'Tasks done', value: String(summary.tasksCompleted) });
  }
  return cards;
}
