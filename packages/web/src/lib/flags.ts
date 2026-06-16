/**
 * Build-time UI feature flags. NEXT_PUBLIC_ so the client bundle can read them.
 *
 * SHOW_TASKS — the "Tasks done" stat card. `DailySummary.tasksCompleted` has no
 * real source until Phase 7 PM integrations, so today it's a constant 0, and a
 * stat card reading "0" looks like failure (bad coach-tone) and quietly erodes
 * trust in the other numbers. Hidden by default; un-hide in Phase 7 by setting
 * NEXT_PUBLIC_SHOW_TASKS=true — a config flip, not a code change. The
 * DailySummary field itself stays exactly as-is (contract unchanged); this is a
 * UI-visibility flag only.
 */
export const SHOW_TASKS = process.env.NEXT_PUBLIC_SHOW_TASKS === 'true';
